CREATE TYPE "reply_draft_kind" AS ENUM ('reply', 'engagement_follow_up');

ALTER TYPE "reply_draft_status" ADD VALUE 'expired';

ALTER TABLE "conversations" ADD COLUMN "engagement_follow_up_scheduled_at" TIMESTAMP(3);

ALTER TABLE "reply_draft"
  ADD COLUMN "kind" "reply_draft_kind" NOT NULL DEFAULT 'reply',
  ADD COLUMN "source_conversation_id" UUID,
  ADD COLUMN "eligible_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "expires_at" TIMESTAMP(3),
  ADD COLUMN "prompt_version" INTEGER;

ALTER TABLE "reply_draft" ADD CONSTRAINT "reply_draft_follow_up_fields_check"
  CHECK (
    "kind" <> 'engagement_follow_up'
    OR ("source_conversation_id" IS NOT NULL AND "expires_at" IS NOT NULL)
  );

ALTER TABLE "reply_draft" ADD CONSTRAINT "reply_draft_source_conversation_id_fkey"
  FOREIGN KEY ("source_conversation_id") REFERENCES "conversations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "reply_draft_source_conversation_id_kind_idx"
  ON "reply_draft"("source_conversation_id", "kind");

UPDATE "reply_draft"
  SET "status" = 'superseded'
  WHERE "prompt_version" IS NULL
    AND "status" IN ('queued', 'generating', 'pending_approval', 'generation_failed');
