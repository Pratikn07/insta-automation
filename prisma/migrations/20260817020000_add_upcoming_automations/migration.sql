-- Local automation preparations for posts scheduled inside Instagram. Instagram
-- does not expose its native scheduled queue; these rows wait for the published
-- media to appear and then become ordinary post-scoped keywords.

CREATE TYPE "upcoming_automation_status" AS ENUM ('waiting', 'bound', 'needs_attention', 'cancelled');

CREATE TABLE "upcoming_automations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trigger_word" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "public_reply" TEXT NOT NULL,
    "gate_message" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "status" "upcoming_automation_status" NOT NULL DEFAULT 'waiting',
    "matched_media_id" TEXT,
    "keyword_id" UUID,
    "error_code" TEXT,
    "created_by" TEXT NOT NULL,
    "last_attempt_at" TIMESTAMPTZ(3),
    "retried_at" TIMESTAMPTZ(3),
    "bound_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upcoming_automations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "upcoming_automations_trigger_word_check"
      CHECK ("trigger_word" ~ '^[A-Z0-9]+$' AND char_length("trigger_word") BETWEEN 1 AND 60),
    CONSTRAINT "upcoming_automations_public_reply_check"
      CHECK (char_length("public_reply") BETWEEN 1 AND 280),
    CONSTRAINT "upcoming_automations_gate_message_check"
      CHECK (char_length("gate_message") BETWEEN 1 AND 1000),
    CONSTRAINT "upcoming_automations_bound_lifecycle_check"
      CHECK ("status" != 'bound' OR ("matched_media_id" IS NOT NULL AND "bound_at" IS NOT NULL)),
    CONSTRAINT "upcoming_automations_cancelled_lifecycle_check"
      CHECK ("status" != 'cancelled' OR "cancelled_at" IS NOT NULL)
);

CREATE INDEX "upcoming_automations_resource_id_idx" ON "upcoming_automations"("resource_id");
CREATE INDEX "upcoming_automations_keyword_id_idx" ON "upcoming_automations"("keyword_id");
CREATE INDEX "upcoming_automations_status_created_at_idx" ON "upcoming_automations"("status", "created_at");

-- Historical keywords may reuse a word. Only simultaneously unresolved future
-- setups reserve it, so one post can never steal another post's guide.
CREATE UNIQUE INDEX "upcoming_automations_open_trigger_word_key"
ON "upcoming_automations"("trigger_word")
WHERE "status" IN ('waiting', 'needs_attention');

ALTER TABLE "upcoming_automations"
  ADD CONSTRAINT "upcoming_automations_resource_id_fkey"
  FOREIGN KEY ("resource_id") REFERENCES "resources"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "upcoming_automations"
  ADD CONSTRAINT "upcoming_automations_keyword_id_fkey"
  FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The browser never receives direct access. The service-role-backed admin API
-- is the only management path.
ALTER TABLE "upcoming_automations" ENABLE ROW LEVEL SECURITY;
