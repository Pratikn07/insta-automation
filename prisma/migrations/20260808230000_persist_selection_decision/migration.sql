-- QA-14: make the reviewed selection the thing that sends.
--
-- Selection ran twice: once for the dry run the owner read, and again for `--write`,
-- which is what actually created the campaign. Every predicate in between is live —
-- gate_queue status, keyword text and active flag, inferred_origin, a conversation
-- completing — so the list that was reviewed and the list that was written could
-- differ, with nothing detecting it.
--
-- The draft campaign and its candidates were already a faithful snapshot of the
-- INCLUSIONS, and approval already promotes them without re-deriving anything. What was
-- missing is that the reviewed artifact was never persisted at all, and that exclusions
-- existed only as counts in an in-memory report — so "who was left out, and why" could
-- not be audited, before or after approval.
--
-- Two additions close it: every decision is now written, and a hash makes two selections
-- comparable so drift can be proven rather than assumed.

-- The canonical hash of every decision this selection made, inclusions and exclusions
-- alike, ordered by intent. Re-running with the same cutoff and filters must produce the
-- same hash; a different one means the underlying data moved, and the diff is reviewable
-- rather than silent.
--
-- Nullable because campaigns created before this migration have no recorded decision set
-- and cannot have one reconstructed — the predicates that produced them are not
-- historised anywhere.
ALTER TABLE "recovery_campaign" ADD COLUMN "decision_hash" TEXT;

-- One row per intent the selection considered and did NOT include.
--
-- Kept separate from recovery_candidate rather than as a nullable-outcome row there:
-- every worker query, cap count, and unique index on that table assumes a row is
-- something we intend to contact. An excluded intent is the opposite, and mixing the two
-- would put "never contact this person" rows inside the table the send path reads.
CREATE TABLE "recovery_selection_exclusion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "ig_user_id" TEXT NOT NULL,
    "keyword_id" UUID NOT NULL,
    -- The decision, verbatim from decideEligibility or the pipeline stage that dropped
    -- it: gate_never_accepted, replied_since_request, outside_age_window,
    -- wrong_phase_for_campaign, older_request_same_person, beyond_stage_cap, and so on.
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_selection_exclusion_pkey" PRIMARY KEY ("id")
);

-- An intent is excluded once per campaign, for one reason. The pipeline applies its
-- stages in order and records the first that dropped the row, so a second row for the
-- same intent would mean two stages both claimed it.
CREATE UNIQUE INDEX "recovery_selection_exclusion_campaign_intent_key"
  ON "recovery_selection_exclusion" ("campaign_id", "intent_id");

-- The review query: "why was this cohort only 1,007 people?"
CREATE INDEX "recovery_selection_exclusion_campaign_reason_idx"
  ON "recovery_selection_exclusion" ("campaign_id", "reason");

-- CASCADE with the campaign: an exclusion record has no meaning without the selection
-- that produced it, and a cancelled draft should take its whole decision set with it.
ALTER TABLE "recovery_selection_exclusion" ADD CONSTRAINT "recovery_selection_exclusion_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "recovery_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, matching recovery_candidate: the intent is the evidence for the decision.
ALTER TABLE "recovery_selection_exclusion" ADD CONSTRAINT "recovery_selection_exclusion_intent_id_fkey"
  FOREIGN KEY ("intent_id") REFERENCES "journey_intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "recovery_selection_exclusion" ADD CONSTRAINT "recovery_selection_exclusion_keyword_id_fkey"
  FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Service role only, like every other table here. No policies, so anon and
-- authenticated have no access.
ALTER TABLE "recovery_selection_exclusion" ENABLE ROW LEVEL SECURITY;
