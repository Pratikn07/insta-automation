-- Canonical journey intents.
--
-- One person commenting the same keyword twice creates two conversations today.
-- Webhook idempotency does not help: those are two DIFFERENT Meta comment ids
-- expressing one request. Measured on production, 342 of 423 repeat triggers
-- (80.9%) arrived within 48 hours of each other — each one a duplicate gate DM
-- and an extra row inflating the "no reply" counts.
--
-- `journey_intent` owns a person-keyword request for a 48-hour window and points
-- at the single conversation responsible for it. `journey_trigger` keeps every
-- originating comment, so nothing is lost: the aliases stop driving automation
-- but remain auditable. Nothing is ever deleted.

-- The reconciled relationship between an alias journey and its canonical owner.
-- `recovered` means a sibling journey completed the request; `superseded` means
-- none did and this row simply is not the owner.
CREATE TYPE "journey_reconciled_state" AS ENUM ('canonical', 'recovered', 'superseded');

-- What one trigger did when it arrived. `replayed_comment` is the exact-duplicate
-- webhook case the unique index below absorbs; the others describe a genuinely
-- new comment landing on an existing, new, or finished intent.
CREATE TYPE "journey_trigger_disposition" AS ENUM (
  'new_journey',
  'reused_active',
  'already_completed_recently',
  'replayed_comment'
);

CREATE TABLE "journey_intent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ig_user_id" TEXT NOT NULL,
    "keyword_id" UUID NOT NULL,
    -- The conversation that owns automation for this window. Nullable only so
    -- reconciliation can insert an intent before choosing its canonical row.
    "canonical_conversation_id" UUID,
    "window_started_at" TIMESTAMPTZ(3) NOT NULL,
    -- Refreshed by every attached trigger. The 48-hour boundary is measured from
    -- THIS, not from window_started_at, so a person re-asking keeps one journey
    -- alive rather than opening a second.
    "last_trigger_at" TIMESTAMPTZ(3) NOT NULL,
    "window_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "reconciled_state" "journey_reconciled_state" NOT NULL DEFAULT 'canonical',
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journey_intent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journey_trigger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "intent_id" UUID NOT NULL,
    -- The conversation this trigger opened or attached to. Nullable because a
    -- replayed comment attaches to an intent without creating a conversation.
    "conversation_id" UUID,
    "comment_id" TEXT NOT NULL,
    "media_id" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "trigger_kind" TEXT NOT NULL,
    "disposition" "journey_trigger_disposition" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journey_trigger_pkey" PRIMARY KEY ("id")
);

-- Back-references on the conversation. All nullable: every existing row predates
-- reconciliation, and a null here means "not yet reconciled", never "no owner".
ALTER TABLE "conversations"
  ADD COLUMN "canonical_intent_id" UUID,
  ADD COLUMN "reconciliation_reason" TEXT,
  ADD COLUMN "reconciled_at" TIMESTAMPTZ(3);

-- window_expires_at is derived from last_trigger_at and must never precede it,
-- or a live intent would look expired and a second journey would open.
ALTER TABLE "journey_intent" ADD CONSTRAINT "chk_intent_window_ordering"
  CHECK ("window_expires_at" >= "last_trigger_at");

-- A trigger cannot predate the window it belongs to.
ALTER TABLE "journey_intent" ADD CONSTRAINT "chk_intent_trigger_after_start"
  CHECK ("last_trigger_at" >= "window_started_at");

-- Exactly one intent owns a given person-keyword window. This is the constraint
-- the concurrent-first-trigger case relies on: two simultaneous comments race to
-- insert, one wins, the loser reads the winner's row and attaches to it.
CREATE UNIQUE INDEX "journey_intent_person_keyword_window_key"
  ON "journey_intent" ("ig_user_id", "keyword_id", "window_started_at");

-- A Meta comment id maps to exactly one trigger, so a redelivered webhook cannot
-- create a second one. This is the exact-replay guard.
CREATE UNIQUE INDEX "journey_trigger_comment_id_key" ON "journey_trigger" ("comment_id");

-- Resolution reads the newest window for a person-keyword pair on every comment.
CREATE INDEX "journey_intent_person_keyword_last_trigger_idx"
  ON "journey_intent" ("ig_user_id", "keyword_id", "last_trigger_at" DESC);
CREATE INDEX "journey_intent_reconciled_state_idx" ON "journey_intent" ("reconciled_state");
CREATE INDEX "journey_trigger_intent_id_received_at_idx"
  ON "journey_trigger" ("intent_id", "received_at");
CREATE INDEX "conversations_canonical_intent_id_idx" ON "conversations" ("canonical_intent_id");

ALTER TABLE "journey_intent" ADD CONSTRAINT "journey_intent_keyword_id_fkey"
  FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL rather than CASCADE: losing the canonical conversation must not delete
-- the intent and with it the record of every trigger that asked for the guide.
ALTER TABLE "journey_intent" ADD CONSTRAINT "journey_intent_canonical_conversation_id_fkey"
  FOREIGN KEY ("canonical_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "journey_trigger" ADD CONSTRAINT "journey_trigger_intent_id_fkey"
  FOREIGN KEY ("intent_id") REFERENCES "journey_intent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "journey_trigger" ADD CONSTRAINT "journey_trigger_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_canonical_intent_id_fkey"
  FOREIGN KEY ("canonical_intent_id") REFERENCES "journey_intent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Reached only through the service role, exactly like every other table here.
-- No policies are created, so anon and authenticated have no access at all.
ALTER TABLE "journey_intent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journey_trigger" ENABLE ROW LEVEL SECURITY;
