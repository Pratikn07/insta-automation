CREATE TYPE "journey_public_acknowledgement_state" AS ENUM (
  'pending',
  'confirmed',
  'failed',
  'uncertain'
);

CREATE TABLE "journey_source_event" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "comment_id" TEXT NOT NULL,
  "media_id" TEXT,
  "first_received_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journey_source_event_pkey" PRIMARY KEY ("id")
);

-- Do not silently pick a media identity if historical associations disagree
-- about which Instagram object one globally unique comment belongs to.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "journey_trigger"
    WHERE "media_id" IS NOT NULL
    GROUP BY "comment_id"
    HAVING COUNT(DISTINCT "media_id") > 1
  ) THEN
    RAISE EXCEPTION 'journey source event migration found contradictory media identity';
  END IF;
END $$;

CREATE UNIQUE INDEX "journey_source_event_comment_id_key"
  ON "journey_source_event" ("comment_id");

INSERT INTO "journey_source_event" (
  "comment_id", "media_id", "first_received_at", "created_at", "updated_at"
)
SELECT
  jt."comment_id",
  MAX(jt."media_id"),
  MIN(jt."received_at"),
  MIN(jt."created_at"),
  MAX(jt."created_at")
FROM "journey_trigger" jt
GROUP BY jt."comment_id";

ALTER TABLE "journey_trigger"
  ADD COLUMN "source_event_id" UUID,
  ADD COLUMN "source_event_log_id" UUID,
  ADD COLUMN "public_acknowledgement_state" "journey_public_acknowledgement_state" NOT NULL DEFAULT 'pending',
  ADD COLUMN "acknowledgement_reply_id" TEXT,
  ADD COLUMN "acknowledgement_error_category" TEXT,
  ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "journey_trigger" jt
SET "source_event_id" = se."id"
FROM "journey_source_event" se
WHERE se."comment_id" = jt."comment_id";

-- Preserve the exact best-effort keyword_matched observation when one exists.
-- UUIDs are compared as text so malformed legacy JSON cannot abort the migration.
UPDATE "journey_trigger" jt
SET "source_event_log_id" = (
  SELECT e."id"
  FROM "event_log" e
  WHERE e."kind" = 'keyword_matched'
    AND e."payload"->>'commentId' = jt."comment_id"
    AND (
      jt."conversation_id" IS NULL
      OR e."payload"->>'conversationId' = jt."conversation_id"::text
    )
  ORDER BY e."created_at" ASC, e."id" ASC
  LIMIT 1
);

UPDATE "journey_trigger" jt
SET
  "public_acknowledgement_state" = CASE
    WHEN EXISTS (
      SELECT 1
      FROM "event_log" e
      JOIN "journey_source_event" se ON se."id" = jt."source_event_id"
      WHERE e."kind" = 'public_reply_sent'
        AND e."payload"->>'commentId' = se."comment_id"
        AND (
          jt."conversation_id" IS NULL
          OR e."payload"->>'conversationId' = jt."conversation_id"::text
        )
    ) THEN 'confirmed'::"journey_public_acknowledgement_state"
    WHEN EXISTS (
      SELECT 1
      FROM "event_log" e
      JOIN "journey_source_event" se ON se."id" = jt."source_event_id"
      WHERE e."kind" = 'public_reply_failed'
        AND e."payload"->>'commentId' = se."comment_id"
        AND (
          jt."conversation_id" IS NULL
          OR e."payload"->>'conversationId' = jt."conversation_id"::text
        )
    ) THEN 'failed'::"journey_public_acknowledgement_state"
    ELSE 'pending'::"journey_public_acknowledgement_state"
  END,
  "acknowledgement_error_category" = (
    SELECT e."payload"->>'category'
    FROM "event_log" e
    JOIN "journey_source_event" se ON se."id" = jt."source_event_id"
    WHERE e."kind" = 'public_reply_failed'
      AND e."payload"->>'commentId' = se."comment_id"
      AND (
        jt."conversation_id" IS NULL
        OR e."payload"->>'conversationId' = jt."conversation_id"::text
      )
    ORDER BY e."created_at" DESC, e."id" DESC
    LIMIT 1
  );

ALTER TABLE "journey_trigger" ALTER COLUMN "source_event_id" SET NOT NULL;

DROP INDEX "journey_trigger_comment_keyword_key";
ALTER TABLE "journey_trigger"
  DROP COLUMN "comment_id",
  DROP COLUMN "media_id";

CREATE UNIQUE INDEX "journey_trigger_source_intent_key"
  ON "journey_trigger" ("source_event_id", "intent_id");
CREATE UNIQUE INDEX "journey_trigger_source_keyword_key"
  ON "journey_trigger" ("source_event_id", "keyword_id");

ALTER TABLE "journey_trigger"
  ADD CONSTRAINT "journey_trigger_source_event_id_fkey"
  FOREIGN KEY ("source_event_id") REFERENCES "journey_source_event"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journey_trigger"
  ADD CONSTRAINT "journey_trigger_source_event_log_id_fkey"
  FOREIGN KEY ("source_event_log_id") REFERENCES "event_log"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "journey_source_event" ENABLE ROW LEVEL SECURITY;
