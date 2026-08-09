-- A single Instagram comment can match more than one configured keyword. Keep
-- replay protection per comment-keyword association without discarding either
-- requested guide from the audit history.
ALTER TABLE "journey_trigger" ADD COLUMN "keyword_id" UUID;

UPDATE "journey_trigger" AS jt
SET "keyword_id" = ji."keyword_id"
FROM "journey_intent" AS ji
WHERE ji."id" = jt."intent_id";

ALTER TABLE "journey_trigger" ALTER COLUMN "keyword_id" SET NOT NULL;

DROP INDEX "journey_trigger_comment_id_key";
CREATE UNIQUE INDEX "journey_trigger_comment_keyword_key"
  ON "journey_trigger" ("comment_id", "keyword_id");

-- The denormalized keyword must always be the keyword owned by the trigger's
-- intent. The composite FK enforces that invariant for live and backfilled rows.
CREATE UNIQUE INDEX "journey_intent_id_keyword_key"
  ON "journey_intent" ("id", "keyword_id");

ALTER TABLE "journey_trigger"
  DROP CONSTRAINT "journey_trigger_intent_id_fkey";

ALTER TABLE "journey_trigger"
  ADD CONSTRAINT "journey_trigger_intent_id_keyword_id_fkey"
  FOREIGN KEY ("intent_id", "keyword_id")
  REFERENCES "journey_intent" ("id", "keyword_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
