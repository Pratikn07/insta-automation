-- A reviewed campaign is identified by the complete normalized selector configuration,
-- not merely by a human label. Nullable columns keep pre-PR2 drafts readable; the PR2
-- approval path requires them before a campaign can run.
ALTER TABLE "recovery_campaign"
  ADD COLUMN "selection_fingerprint" TEXT,
  ADD COLUMN "eligibility_policy_version" TEXT,
  ADD COLUMN "western_only" BOOLEAN,
  ADD COLUMN "inbound_window_hours" INTEGER NOT NULL DEFAULT 48,
  ADD COLUMN "completion_window_hours" INTEGER NOT NULL DEFAULT 48,
  ADD CONSTRAINT "recovery_campaign_inbound_window_hours_check"
    CHECK ("inbound_window_hours" >= 24 AND "inbound_window_hours" <= 720),
  ADD CONSTRAINT "recovery_campaign_completion_window_hours_check"
    CHECK ("completion_window_hours" >= 24 AND "completion_window_hours" <= 720);

CREATE UNIQUE INDEX "recovery_campaign_selection_fingerprint_key"
  ON "recovery_campaign" ("selection_fingerprint");

-- The candidate keeps the original primary comment for backwards-compatible reads.
-- These fields explain why it was primary and record the exact approved source used
-- when dispatch begins.
ALTER TABLE "recovery_candidate"
  ADD COLUMN "source_choice_reason" TEXT,
  ADD COLUMN "dispatch_comment_id" TEXT;

-- Every comment source the owner approved, newest first. Fallback may walk only this
-- list; it can never discover and use an unreviewed comment during dispatch.
CREATE TABLE "recovery_candidate_source" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "candidate_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "comment_id" TEXT NOT NULL,
  "media_id" TEXT,
  "received_at" TIMESTAMPTZ(3) NOT NULL,
  "choice_reason" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "recovery_candidate_source_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recovery_candidate_source_position_check" CHECK ("position" >= 0),
  CONSTRAINT "recovery_candidate_source_comment_id_check"
    CHECK (NULLIF(BTRIM("comment_id"), '') IS NOT NULL),
  CONSTRAINT "recovery_candidate_source_choice_reason_check"
    CHECK (NULLIF(BTRIM("choice_reason"), '') IS NOT NULL),
  CONSTRAINT "recovery_candidate_source_candidate_id_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "recovery_candidate"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "recovery_candidate_source_candidate_id_position_key"
  ON "recovery_candidate_source" ("candidate_id", "position");
CREATE UNIQUE INDEX "recovery_candidate_source_candidate_id_comment_id_key"
  ON "recovery_candidate_source" ("candidate_id", "comment_id");
CREATE INDEX "recovery_candidate_source_comment_id_idx"
  ON "recovery_candidate_source" ("comment_id");

-- Backend-only approval evidence. Browser roles receive no direct table access.
ALTER TABLE "recovery_candidate_source" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "recovery_candidate_source" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "recovery_candidate_source" FROM authenticated;
  END IF;
END
$$;
