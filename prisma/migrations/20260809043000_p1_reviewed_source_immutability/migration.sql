-- Public fallback may use only the source set the owner actually reviewed. Serialize
-- every source insert/update through the parent campaign row and reject it once the
-- approval transaction has sealed the campaign. The row lock closes the approval
-- scan/commit phantom: a concurrent writer either commits before verification or waits
-- until approval commits and is rejected.
CREATE OR REPLACE FUNCTION enforce_recovery_candidate_source_mutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_campaign_id UUID;
  source_campaign_state TEXT;
BEGIN
  SELECT campaign."id", campaign."state"::text
    INTO source_campaign_id, source_campaign_state
  FROM "recovery_candidate" candidate
  JOIN "recovery_campaign" campaign ON campaign."id" = candidate."campaign_id"
  WHERE candidate."id" = CASE WHEN TG_OP = 'INSERT' THEN NEW."candidate_id" ELSE OLD."candidate_id" END
  FOR UPDATE OF campaign;

  IF FOUND AND source_campaign_state NOT IN ('draft', 'awaiting_approval') THEN
    RAISE EXCEPTION 'reviewed source set is immutable after campaign approval (%)', source_campaign_id
      USING ERRCODE = '55000';
  END IF;

  -- Moving a source between candidates must also validate and lock the destination.
  IF TG_OP = 'UPDATE' AND NEW."candidate_id" <> OLD."candidate_id" THEN
    SELECT campaign."id", campaign."state"::text
      INTO source_campaign_id, source_campaign_state
    FROM "recovery_candidate" candidate
    JOIN "recovery_campaign" campaign ON campaign."id" = candidate."campaign_id"
    WHERE candidate."id" = NEW."candidate_id"
    FOR UPDATE OF campaign;

    IF FOUND AND source_campaign_state NOT IN ('draft', 'awaiting_approval') THEN
      RAISE EXCEPTION 'reviewed source set is immutable after campaign approval (%)', source_campaign_id
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER recovery_candidate_source_mutable_before_seal
BEFORE INSERT OR UPDATE ON "recovery_candidate_source"
FOR EACH ROW
EXECUTE FUNCTION enforce_recovery_candidate_source_mutable();
