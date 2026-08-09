-- One lock/check shared by every table contributing to the owner-reviewed hash.
-- Legacy campaigns have no fingerprint and remain readable; their running rows were
-- paused by the preceding migration and cannot pass final policy authorization.
CREATE OR REPLACE FUNCTION assert_recovery_manifest_mutable(target_campaign_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  target_state TEXT;
  target_fingerprint TEXT;
BEGIN
  SELECT "state"::text, "selection_fingerprint"
    INTO target_state, target_fingerprint
  FROM "recovery_campaign"
  WHERE "id" = target_campaign_id
  FOR UPDATE;

  -- A parent/candidate cascade has already made the owner row invisible. Allow the
  -- cascade so deleting the complete aggregate remains possible.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF target_fingerprint IS NOT NULL
     AND target_state NOT IN ('draft', 'awaiting_approval') THEN
    RAISE EXCEPTION 'reviewed campaign manifest is immutable after approval (%)', target_campaign_id
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_recovery_campaign_manifest_fields_mutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_recovery_manifest_mutable(OLD."id");
  RETURN NEW;
END;
$$;

CREATE TRIGGER recovery_campaign_manifest_fields_mutable_before_seal
BEFORE UPDATE OF
  "phase", "selection_version", "source_data_cutoff", "comment_from", "comment_to",
  "selection_limit", "holdout_percent", "copy_version", "candidate_count",
  "excluded_count", "selection_fingerprint", "eligibility_policy_version",
  "western_only", "inbound_window_hours", "completion_window_hours", "decision_hash"
ON "recovery_campaign"
FOR EACH ROW
EXECUTE FUNCTION enforce_recovery_campaign_manifest_fields_mutable();

CREATE OR REPLACE FUNCTION enforce_recovery_candidate_manifest_mutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_recovery_manifest_mutable(
    CASE WHEN TG_OP = 'INSERT' THEN NEW."campaign_id" ELSE OLD."campaign_id" END
  );
  IF TG_OP = 'UPDATE' AND NEW."campaign_id" <> OLD."campaign_id" THEN
    PERFORM assert_recovery_manifest_mutable(NEW."campaign_id");
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER recovery_candidate_manifest_mutable_before_seal
BEFORE INSERT OR DELETE OR UPDATE OF
  "campaign_id", "campaign_phase", "intent_id", "ig_user_id", "conversation_id",
  "keyword_id", "comment_id", "media_id", "comment_at", "keyword_snapshot",
  "public_reply_text", "evidence", "selection_position", "source_choice_reason",
  "audience_origin", "audience_origin_confidence", "arm", "eligible_at"
ON "recovery_candidate"
FOR EACH ROW
EXECUTE FUNCTION enforce_recovery_candidate_manifest_mutable();

CREATE OR REPLACE FUNCTION enforce_recovery_exclusion_manifest_mutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_recovery_manifest_mutable(
    CASE WHEN TG_OP = 'INSERT' THEN NEW."campaign_id" ELSE OLD."campaign_id" END
  );
  IF TG_OP = 'UPDATE' AND NEW."campaign_id" <> OLD."campaign_id" THEN
    PERFORM assert_recovery_manifest_mutable(NEW."campaign_id");
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER recovery_selection_exclusion_manifest_mutable_before_seal
BEFORE INSERT OR UPDATE OR DELETE ON "recovery_selection_exclusion"
FOR EACH ROW
EXECUTE FUNCTION enforce_recovery_exclusion_manifest_mutable();

DROP TRIGGER IF EXISTS recovery_candidate_source_mutable_before_seal
  ON "recovery_candidate_source";
DROP FUNCTION IF EXISTS enforce_recovery_candidate_source_mutable();

CREATE OR REPLACE FUNCTION enforce_recovery_source_manifest_mutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_candidate_id UUID;
  target_campaign_id UUID;
BEGIN
  target_candidate_id := CASE
    WHEN TG_OP = 'INSERT' THEN NEW."candidate_id"
    ELSE OLD."candidate_id"
  END;
  SELECT "campaign_id" INTO target_campaign_id
  FROM "recovery_candidate"
  WHERE "id" = target_candidate_id;
  IF FOUND THEN
    PERFORM assert_recovery_manifest_mutable(target_campaign_id);
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."candidate_id" <> OLD."candidate_id" THEN
    SELECT "campaign_id" INTO target_campaign_id
    FROM "recovery_candidate"
    WHERE "id" = NEW."candidate_id";
    IF FOUND THEN
      PERFORM assert_recovery_manifest_mutable(target_campaign_id);
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER recovery_candidate_source_manifest_mutable_before_seal
BEFORE INSERT OR UPDATE OR DELETE ON "recovery_candidate_source"
FOR EACH ROW
EXECUTE FUNCTION enforce_recovery_source_manifest_mutable();
