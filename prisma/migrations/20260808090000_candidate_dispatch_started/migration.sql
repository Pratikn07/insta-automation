-- QA-08 + QA-10: tell "claimed and preparing" apart from "dispatch has started".
--
-- `claim_token` alone could not answer "has this row consumed a send slot?". Claiming
-- stamps last_attempt_at, so a row merely being prepared looked identical to one already
-- dispatching. Two consequences:
--
--   1. Two workers each holding a claim each counted the OTHER as in-flight, so with a
--      cap of 1 neither could reserve the last slot and the campaign stalled.
--   2. A row could not be handed back safely after a pre-dispatch failure, because
--      nothing recorded whether Meta had been contacted. Lease reconciliation therefore
--      called every expired lease `send_uncertain`, including ones that never dispatched.
--
-- Set inside the capacity reservation, under the dm_recovery_control lock, immediately
-- before the Graph call. A row with claim_token set and dispatch_started_at null is
-- provably pre-network and safe to release.
ALTER TABLE "recovery_candidate"
  ADD COLUMN "dispatch_started_at" TIMESTAMPTZ(3);

-- Dispatch cannot have started without a claim to start it under, and a finalised row
-- keeps its dispatch timestamp as the audit trail of when the comment was attempted.
ALTER TABLE "recovery_candidate" ADD CONSTRAINT "chk_candidate_dispatch_needs_claim"
  CHECK (
    "dispatch_started_at" IS NULL
    OR "claim_token" IS NOT NULL
    OR "outcome" <> 'pending'
  );

-- Capacity counting reads this per campaign and globally, over a rolling window.
CREATE INDEX "recovery_candidate_dispatch_started_idx"
  ON "recovery_candidate" ("dispatch_started_at");
