-- QA-03: a candidate's evidence must match its campaign's phase.
--
-- The selector now filters by phase, but that is a code rule and code regresses. This
-- makes a mismatched row impossible to write at all.
--
-- Verified before the fix: a production campaign labelled `unknown_read_pilot` held
-- 988 gate_sent_no_read rows AND 2 gate_exhausted rows. The phase decides the copy
-- ("I couldn't send your guide" vs "I sent your guide"), the approval, the rollout
-- sequencing, and how the results read — so a mixed campaign makes all four untrue.
--
-- Denormalised onto the candidate because a CHECK constraint cannot read another
-- table. Written by the selector from the campaign it is creating, and kept honest by
-- the trigger below rather than by trust.

ALTER TABLE "recovery_candidate"
  ADD COLUMN "campaign_phase" "recovery_campaign_phase";

-- Backfill from the owning campaign so the constraint can be validated. Both existing
-- campaigns are cancelled, so this only makes history consistent.
UPDATE "recovery_candidate" rc
SET "campaign_phase" = c."phase"
FROM "recovery_campaign" c
WHERE c."id" = rc."campaign_id";

ALTER TABLE "recovery_candidate"
  ALTER COLUMN "campaign_phase" SET NOT NULL;

-- The invariant, applied only to rows that can still be sent.
--
-- My first version validated against every row and FAILED in production, because the
-- mixed rows this constraint exists to prevent already exist: 4 gate_exhausted rows
-- sit inside cancelled `unknown_read_pilot` campaigns. That is precisely the QA-03
-- defect, recorded as history.
--
-- Rewriting that history would be worse than tolerating it. Those campaigns were
-- cancelled BECAUSE they were wrong, and the record of what was drafted is the audit
-- trail. So the constraint governs live outcomes and lets terminal ones keep what they
-- actually were.
--
-- `cancelled` and `suppressed` are the only exemptions. A `sent` row must still match:
-- something was posted publicly, and its phase decided the words used.
ALTER TABLE "recovery_candidate" ADD CONSTRAINT "chk_candidate_phase_matches_evidence"
  CHECK (
    "outcome" IN ('cancelled', 'suppressed')
    OR ("campaign_phase" = 'confirmed_failure' AND "evidence" = 'gate_exhausted')
    OR ("campaign_phase" = 'unknown_read_pilot' AND "evidence" = 'gate_sent_no_read')
  );

-- The denormalised column must equal the campaign's own phase. A CHECK cannot span
-- tables, so this is the trigger that keeps them from drifting.
CREATE OR REPLACE FUNCTION "recovery_candidate_phase_matches_campaign"()
RETURNS TRIGGER AS $$
DECLARE
  campaign_phase_value "recovery_campaign_phase";
BEGIN
  SELECT "phase" INTO campaign_phase_value
  FROM "recovery_campaign" WHERE "id" = NEW."campaign_id";

  IF campaign_phase_value IS DISTINCT FROM NEW."campaign_phase" THEN
    RAISE EXCEPTION
      'candidate campaign_phase % does not match campaign % phase %',
      NEW."campaign_phase", NEW."campaign_id", campaign_phase_value;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_recovery_candidate_phase_matches_campaign"
  BEFORE INSERT OR UPDATE OF "campaign_phase", "campaign_id" ON "recovery_candidate"
  FOR EACH ROW EXECUTE FUNCTION "recovery_candidate_phase_matches_campaign"();
