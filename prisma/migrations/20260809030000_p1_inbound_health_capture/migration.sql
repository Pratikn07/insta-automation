-- The webhook endpoint acknowledges before handlers run, so handler failure cannot ask
-- Meta to replay a missed opt-out. The inbound message row itself is the durable safety
-- inbox: new inbound rows remain pending until health classification succeeds.
ALTER TABLE "dm_message"
  ADD COLUMN "campaign_health_captured_at" TIMESTAMPTZ(3),
  ADD COLUMN "campaign_health_capture_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "campaign_health_next_attempt_at" TIMESTAMPTZ(3),
  ADD COLUMN "campaign_health_last_error" TEXT,
  ADD CONSTRAINT "dm_message_campaign_health_capture_attempts_check"
    CHECK ("campaign_health_capture_attempts" >= 0);

-- Historical recovery has not been enabled. Existing inbound rows therefore predate any
-- historical public contact and cannot be a response to one; mark them settled so the
-- first worker tick does not rescan the complete message archive.
UPDATE "dm_message"
SET "campaign_health_captured_at" = "created_at"
WHERE "direction" = 'inbound';

CREATE INDEX "dm_message_campaign_health_capture_due_idx"
  ON "dm_message" (
    "direction",
    "campaign_health_captured_at",
    "campaign_health_next_attempt_at"
  );
