-- CreateEnum
CREATE TYPE "dm_recovery_trigger_kind" AS ENUM ('no_confirmed_read', 'settings_blocked');

-- CreateEnum
CREATE TYPE "dm_recovery_status" AS ENUM ('waiting', 'control', 'suppressed', 'sending', 'sent', 'send_failed', 'send_uncertain', 'tracking_unavailable', 'cancelled');

-- CreateEnum
CREATE TYPE "dm_recovery_cohort" AS ENUM ('treatment', 'control', 'not_applicable');

-- AlterTable
ALTER TABLE "dm_message" ADD COLUMN "seen_at" TIMESTAMPTZ(3),
ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "gate_queue" ADD COLUMN "media_id" TEXT,
ADD COLUMN "claimed_at" TIMESTAMPTZ(3),
ADD COLUMN "claim_expires_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "dm_recovery_reminder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "ig_user_id" TEXT NOT NULL,
    "keyword_id" UUID NOT NULL,
    "keyword_snapshot" TEXT NOT NULL,
    "template_version" TEXT NOT NULL,
    "public_reply_text" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "media_id" TEXT,
    "gate_dm_message_id" UUID,
    "instagram_gate_message_id" TEXT,
    "trigger_kind" "dm_recovery_trigger_kind" NOT NULL,
    "status" "dm_recovery_status" NOT NULL,
    "cohort" "dm_recovery_cohort" NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "eligible_at" TIMESTAMPTZ(3) NOT NULL,
    "seen_at" TIMESTAMPTZ(3),
    "seen_received_at" TIMESTAMPTZ(3),
    "engaged_at" TIMESTAMPTZ(3),
    "engaged_received_at" TIMESTAMPTZ(3),
    "first_engagement_kind" TEXT,
    "replied_at" TIMESTAMPTZ(3),
    "replied_received_at" TIMESTAMPTZ(3),
    "reacted_at" TIMESTAMPTZ(3),
    "postback_at" TIMESTAMPTZ(3),
    "suppressed_at" TIMESTAMPTZ(3),
    "suppression_reason" TEXT,
    "claimed_at" TIMESTAMPTZ(3),
    "claim_expires_at" TIMESTAMPTZ(3),
    "next_attempt_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
    "public_reply_id" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "last_error_category" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dm_recovery_reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_recovery_control" (
    "id" INTEGER NOT NULL DEFAULT 1 CHECK ("id" = 1),
    "circuit_open" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "opened_at" TIMESTAMPTZ(3),
    "reset_at" TIMESTAMPTZ(3),
    "reset_by" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dm_recovery_control_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dm_recovery_reminder_comment_id_key" ON "dm_recovery_reminder"("comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "dm_recovery_reminder_instagram_gate_message_id_key" ON "dm_recovery_reminder"("instagram_gate_message_id");

-- Partial unique index: at most one sending claim per user
CREATE UNIQUE INDEX "dm_recovery_reminder_ig_user_sending_key" ON "dm_recovery_reminder"("ig_user_id") WHERE "status" = 'sending';

-- CreateIndexes for queries
CREATE INDEX "dm_recovery_reminder_status_eligible_at_next_attempt_at_idx" ON "dm_recovery_reminder"("status", "eligible_at", "next_attempt_at");
CREATE INDEX "dm_recovery_reminder_ig_user_id_sent_at_idx" ON "dm_recovery_reminder"("ig_user_id", "sent_at");
CREATE INDEX "dm_recovery_reminder_ig_user_id_keyword_id_status_idx" ON "dm_recovery_reminder"("ig_user_id", "keyword_id", "status");
CREATE INDEX "dm_recovery_reminder_cohort_eligible_at_idx" ON "dm_recovery_reminder"("cohort", "eligible_at");

-- AddForeignKey
ALTER TABLE "dm_recovery_reminder" ADD CONSTRAINT "dm_recovery_reminder_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dm_recovery_reminder" ADD CONSTRAINT "dm_recovery_reminder_ig_user_id_fkey" FOREIGN KEY ("ig_user_id") REFERENCES "ig_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dm_recovery_reminder" ADD CONSTRAINT "dm_recovery_reminder_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dm_recovery_reminder" ADD CONSTRAINT "dm_recovery_reminder_gate_dm_message_id_fkey" FOREIGN KEY ("gate_dm_message_id") REFERENCES "dm_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed Singleton Control
INSERT INTO "dm_recovery_control" ("id", "circuit_open", "updated_at") VALUES (1, false, NOW()) ON CONFLICT ("id") DO NOTHING;

-- Enable Row Level Security
ALTER TABLE "dm_recovery_reminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dm_recovery_control" ENABLE ROW LEVEL SECURITY;
