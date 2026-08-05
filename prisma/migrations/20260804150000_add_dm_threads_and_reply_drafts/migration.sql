-- Real DM history, plus versioned AI reply drafts awaiting owner approval.
--
-- `conversations` models an AUTOMATION JOURNEY (one keyword, one gate, one guide)
-- and never held the participant's own words, so it cannot answer "what did this
-- person actually say, and what should we reply?". These tables add that history
-- alongside it; `conversations` keeps its current meaning untouched.
--
-- Written by hand rather than via `prisma migrate dev` for two reasons: the
-- partial unique index at the bottom cannot be expressed in Prisma schema, and a
-- generated diff also picked up pre-existing drift unrelated to this change
-- (`conversations_follow_through_at_idx`, created by migration 20260729120000 but
-- never declared in schema.prisma). That drift is deliberately left alone.

CREATE TYPE "dm_direction" AS ENUM ('inbound', 'outbound');

CREATE TYPE "dm_message_type" AS ENUM ('text', 'image', 'video', 'audio', 'file', 'unknown');

-- Where an outbound message came from. Lets the drawer separate "the bot sent this
-- gate" from "the owner approved this reply", and anchors the AI audit trail.
CREATE TYPE "dm_message_source" AS ENUM ('instagram_user', 'keyword_automation', 'guide_automation', 'ai_approved', 'manual_external', 'unknown');

CREATE TYPE "reply_draft_status" AS ENUM ('queued', 'generating', 'pending_approval', 'generation_failed', 'dismissed', 'superseded', 'sending', 'sent', 'send_failed', 'send_uncertain');

CREATE TABLE "dm_thread" (
    "id" UUID NOT NULL,
    "ig_account_id" TEXT NOT NULL,
    "ig_user_id" TEXT NOT NULL,
    "username" TEXT,
    "name" TEXT,
    -- A plain column, not a foreign key: dm_message already references dm_thread,
    -- and a second FK back would make every inbound insert a circular write.
    "latest_inbound_message_id" UUID,
    -- True from the moment an inbound lands until an automation or the owner
    -- answers it. The Conversations "Needs reply" filter reads exactly this.
    "needs_reply" BOOLEAN NOT NULL DEFAULT false,
    "last_message_at" TIMESTAMP(3) NOT NULL,
    "last_inbound_at" TIMESTAMP(3),
    "last_outbound_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dm_thread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dm_message" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    -- Meta's `mid`. Unique, so replaying a webhook cannot double-insert — this is
    -- the entire idempotency story for inbound capture.
    "instagram_message_id" TEXT,
    "direction" "dm_direction" NOT NULL,
    "type" "dm_message_type" NOT NULL,
    "source" "dm_message_source" NOT NULL,
    "text" TEXT,
    "media_url" TEXT,
    -- Meta's own timestamp, not ours: ordering must survive a delayed webhook.
    "instagram_timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dm_message_pkey" PRIMARY KEY ("id")
);

-- The three text columns are deliberately separate. `suggested_text` is what the
-- model produced and is never rewritten; `working_text` is the owner's editable
-- copy; `approved_text` is the exact string a human authorised. Collapsing them
-- would destroy the answer to "what did the owner actually approve?".
CREATE TABLE "reply_draft" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    -- The inbound this replies to. A newer inbound makes the draft stale by
    -- definition, and approval is refused rather than sending a late answer.
    "inbound_message_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "reply_draft_status" NOT NULL DEFAULT 'queued',
    "suggested_text" TEXT,
    "working_text" TEXT,
    "approved_text" TEXT,
    "rationale" TEXT,
    "confidence" TEXT,
    "warnings" JSONB,
    "model_id" TEXT,
    "runtime_thread_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "retry_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "superseded_by_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reply_draft_pkey" PRIMARY KEY ("id")
);

-- One thread per (account, participant).
CREATE UNIQUE INDEX "dm_thread_ig_account_id_ig_user_id_key" ON "dm_thread"("ig_account_id", "ig_user_id");
CREATE INDEX "dm_thread_needs_reply_last_inbound_at_idx" ON "dm_thread"("needs_reply", "last_inbound_at");
CREATE INDEX "dm_thread_last_message_at_idx" ON "dm_thread"("last_message_at");
CREATE INDEX "dm_thread_last_inbound_at_idx" ON "dm_thread"("last_inbound_at");

CREATE UNIQUE INDEX "dm_message_instagram_message_id_key" ON "dm_message"("instagram_message_id");
CREATE INDEX "dm_message_thread_id_instagram_timestamp_idx" ON "dm_message"("thread_id", "instagram_timestamp");
CREATE INDEX "dm_message_direction_instagram_timestamp_idx" ON "dm_message"("direction", "instagram_timestamp");

CREATE UNIQUE INDEX "reply_draft_thread_id_revision_key" ON "reply_draft"("thread_id", "revision");
CREATE INDEX "reply_draft_status_next_attempt_at_idx" ON "reply_draft"("status", "next_attempt_at");
CREATE INDEX "reply_draft_thread_id_created_at_idx" ON "reply_draft"("thread_id", "created_at");

ALTER TABLE "dm_message" ADD CONSTRAINT "dm_message_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "dm_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reply_draft" ADD CONSTRAINT "reply_draft_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "dm_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- THE invariant of this feature, and the reason this migration is hand-written:
-- at most one live draft per thread. Prisma cannot express a partial unique
-- index, so without this the database would happily hold two pending drafts for
-- one participant and the owner could approve both.
--
-- `sending` is deliberately EXCLUDED from the guarded set. A draft mid-flight to
-- Instagram has an unknown outcome; it must not be superseded by a new inbound,
-- and it must not block the next draft once it settles.
CREATE UNIQUE INDEX "reply_draft_one_active_per_thread"
ON "reply_draft" ("thread_id")
WHERE "status" IN ('queued', 'generating', 'pending_approval');
