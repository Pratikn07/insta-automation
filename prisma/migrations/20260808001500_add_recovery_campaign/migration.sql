-- Historical recovery campaigns (Feature 4, design §36).
--
-- Selection must be REPRODUCIBLE. A campaign freezes its candidate list at
-- approval time rather than re-running a query during the send, because the
-- underlying data moves: ig_users.inferred_origin is rewritten continuously,
-- conversations complete, and people reply. A campaign that re-selected mid-send
-- could contact somebody the owner never approved.
--
-- These are deliberately SEPARATE from dm_recovery_reminder. Historical candidates
-- must not enter the prospective Feature 2 experiment (§36) — mixing them would
-- corrupt the treatment/control comparison that decides whether reminders work.

CREATE TYPE "recovery_campaign_phase" AS ENUM ('confirmed_failure', 'unknown_read_pilot');

-- draft -> awaiting_approval -> running -> (paused) -> completed | cancelled.
-- Approval is what freezes selection, so a campaign cannot move back to draft.
CREATE TYPE "recovery_campaign_state" AS ENUM (
  'draft',
  'awaiting_approval',
  'running',
  'paused',
  'completed',
  'cancelled'
);

CREATE TYPE "recovery_candidate_arm" AS ENUM ('treatment', 'holdout');

-- `suppressed` covers a final safety recheck that failed between selection and
-- send. `send_uncertain` is never retried automatically: the comment may have
-- posted, and a retry would double-post publicly.
CREATE TYPE "recovery_candidate_outcome" AS ENUM (
  'pending',
  'sent',
  'send_failed',
  'send_uncertain',
  'suppressed',
  'cancelled',
  'holdout_withheld'
);

CREATE TABLE "recovery_campaign" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phase" "recovery_campaign_phase" NOT NULL,
    "state" "recovery_campaign_state" NOT NULL DEFAULT 'draft',
    -- Which selector produced this list. Editing filters creates a NEW version
    -- rather than mutating an approved snapshot (§37).
    "selection_version" TEXT NOT NULL,
    -- No candidate may be drawn from data after this instant, so a re-run of the
    -- same version reproduces the same list.
    "source_data_cutoff" TIMESTAMPTZ(3) NOT NULL,
    -- Owner-approved age range for the original comment.
    "comment_from" TIMESTAMPTZ(3),
    "comment_to" TIMESTAMPTZ(3),
    "holdout_percent" INTEGER NOT NULL DEFAULT 50,
    "copy_version" TEXT NOT NULL,
    -- Conservative launch defaults (§39). Not permanent throughput limits.
    "batch_size" INTEGER NOT NULL DEFAULT 1,
    "hourly_cap" INTEGER NOT NULL DEFAULT 3,
    "daily_cap" INTEGER NOT NULL DEFAULT 10,
    "candidate_count" INTEGER NOT NULL DEFAULT 0,
    "excluded_count" INTEGER NOT NULL DEFAULT 0,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "paused_at" TIMESTAMPTZ(3),
    "pause_reason" TEXT,
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_campaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recovery_candidate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    -- The canonical intent this candidate speaks for. Feature 3 guarantees one
    -- intent per person-keyword window, which is what stops the same person being
    -- contacted twice for one request.
    "intent_id" UUID NOT NULL,
    "ig_user_id" TEXT NOT NULL,
    "conversation_id" UUID,
    "keyword_id" UUID NOT NULL,
    -- The comment the public reply will be posted on. Rechecked immediately before
    -- send, because a deleted comment must suppress rather than redirect (§34).
    "comment_id" TEXT NOT NULL,
    "media_id" TEXT,
    "comment_at" TIMESTAMPTZ(3) NOT NULL,
    -- Frozen at selection: the keyword may be renamed and the copy revised, but an
    -- approved campaign sends what the owner approved.
    "keyword_snapshot" TEXT NOT NULL,
    "public_reply_text" TEXT NOT NULL,
    -- Why this row was eligible, e.g. gate_exhausted or gate_sent_no_read.
    "evidence" TEXT NOT NULL,
    -- Same reasoning as dm_recovery_reminder: ig_users.inferred_origin is mutable
    -- and retired when the name changes, so a campaign records what it believed.
    "audience_origin" TEXT,
    "audience_origin_confidence" TEXT,
    "arm" "recovery_candidate_arm" NOT NULL,
    "outcome" "recovery_candidate_outcome" NOT NULL DEFAULT 'pending',
    "eligible_at" TIMESTAMPTZ(3) NOT NULL,
    "claimed_at" TIMESTAMPTZ(3),
    "claim_expires_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "public_reply_id" TEXT,
    "suppression_reason" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    -- Measured after the fact: did the reminder actually recover the request?
    "later_inbound_at" TIMESTAMPTZ(3),
    "later_completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_candidate_pkey" PRIMARY KEY ("id")
);

-- Approval must record WHO and WHEN together, or the audit trail is unusable.
ALTER TABLE "recovery_campaign" ADD CONSTRAINT "chk_campaign_approval_complete"
  CHECK (("approved_by" IS NULL) = ("approved_at" IS NULL));

-- A running campaign has been approved. This is the constraint that makes
-- "approval freezes selection" (§37) enforceable rather than merely intended.
ALTER TABLE "recovery_campaign" ADD CONSTRAINT "chk_campaign_running_is_approved"
  CHECK ("state" IN ('draft', 'awaiting_approval', 'cancelled') OR "approved_at" IS NOT NULL);

ALTER TABLE "recovery_campaign" ADD CONSTRAINT "chk_campaign_holdout_range"
  CHECK ("holdout_percent" >= 0 AND "holdout_percent" <= 100);

-- A confirmed send must carry the reply id Meta returned. Without it there is no
-- evidence the comment posted, and "sent" would be an unverifiable claim.
ALTER TABLE "recovery_candidate" ADD CONSTRAINT "chk_candidate_sent_has_reply_id"
  CHECK ("outcome" <> 'sent' OR ("public_reply_id" IS NOT NULL AND "sent_at" IS NOT NULL));

ALTER TABLE "recovery_candidate" ADD CONSTRAINT "chk_candidate_claim_ordering"
  CHECK ("claimed_at" IS NULL OR "claim_expires_at" IS NULL OR "claim_expires_at" >= "claimed_at");

-- ONE candidate per intent per campaign. This is the anti-duplicate invariant: the
-- eligible pool measured 608 intents with zero duplicates, and this turns that
-- measurement into something the database enforces.
CREATE UNIQUE INDEX "recovery_candidate_campaign_intent_key"
  ON "recovery_candidate" ("campaign_id", "intent_id");

-- One public recovery per person per campaign, independent of intent, so a person
-- with two eligible keywords cannot be contacted twice by one campaign.
CREATE UNIQUE INDEX "recovery_candidate_campaign_person_key"
  ON "recovery_candidate" ("campaign_id", "ig_user_id");

CREATE INDEX "recovery_candidate_outcome_eligible_at_idx"
  ON "recovery_candidate" ("outcome", "eligible_at");
CREATE INDEX "recovery_candidate_ig_user_id_sent_at_idx"
  ON "recovery_candidate" ("ig_user_id", "sent_at");
CREATE INDEX "recovery_campaign_state_idx" ON "recovery_campaign" ("state");

ALTER TABLE "recovery_candidate" ADD CONSTRAINT "recovery_candidate_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "recovery_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT: the intent is the candidate's justification for existing, so it must
-- not vanish underneath an approved campaign.
ALTER TABLE "recovery_candidate" ADD CONSTRAINT "recovery_candidate_intent_id_fkey"
  FOREIGN KEY ("intent_id") REFERENCES "journey_intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "recovery_candidate" ADD CONSTRAINT "recovery_candidate_keyword_id_fkey"
  FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "recovery_candidate" ADD CONSTRAINT "recovery_candidate_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Service role only, like every other table here. No policies, so anon and
-- authenticated have no access.
ALTER TABLE "recovery_campaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_candidate" ENABLE ROW LEVEL SECURITY;
