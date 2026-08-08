-- QA-02: make a candidate claim exclusive.
--
-- Reproduced against real Postgres before this migration: two concurrent
-- claimCandidate calls on one row BOTH succeeded. The predicate matched
-- (id, outcome='pending', arm='treatment') and left the row `pending`, so the second
-- update matched the same row and overwrote the first lease. Both callers received the
-- candidate and both would have posted the same public comment on a real person's post.
-- The first finaliser wins, which does nothing about the second comment already live.
--
-- Two changes make it exclusive:
--
--  1. `claim_token` — a value the winner generates and every subsequent write must
--     present. A stale claimant cannot finalise or release the winner's lease, which
--     the old `id + pending` finaliser predicate allowed.
--  2. a partial unique index on the row while claimed, so the database itself refuses
--     a second live claim rather than trusting the predicate to be written correctly.

ALTER TABLE "recovery_candidate"
  ADD COLUMN "claim_token" UUID;

-- Attempt bookkeeping (QA-10, needed here because the claim path owns it): a
-- retryable failure previously just released the claim, so a rate limit could retry
-- every tick forever with no record.
ALTER TABLE "recovery_candidate"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "recovery_candidate"
  ADD COLUMN "last_attempt_at" TIMESTAMPTZ(3);
ALTER TABLE "recovery_candidate"
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(3);

-- A claim is exactly the three fields together: token, claimed time, and expiry. Any
-- partial combination means a bug wrote one without the others, and a claim missing
-- its token cannot be safely finalised by anyone.
ALTER TABLE "recovery_candidate" ADD CONSTRAINT "chk_candidate_claim_complete"
  CHECK (
    ("claim_token" IS NULL AND "claimed_at" IS NULL AND "claim_expires_at" IS NULL)
    OR ("claim_token" IS NOT NULL AND "claimed_at" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
  );

-- One live claim per candidate, enforced by the database rather than by the WHERE
-- clause being correct. A pending row with a token is claimed; releasing or finalising
-- clears the token and frees the row.
CREATE UNIQUE INDEX "recovery_candidate_single_live_claim"
  ON "recovery_candidate" ("id")
  WHERE "claim_token" IS NOT NULL;

-- The worker scans for due rows by (outcome, eligible_at) and must skip claimed ones.
CREATE INDEX "recovery_candidate_claimable_idx"
  ON "recovery_candidate" ("outcome", "arm", "eligible_at")
  WHERE "claim_token" IS NULL;
