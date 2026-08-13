BEGIN;

CREATE TYPE "historical_audience_segment" AS ENUM (
  'western',
  'other',
  'unknown_cue',
  'unknown_generic',
  'unknown_no_name',
  'south_asian'
);

ALTER TABLE "ig_users"
  ADD COLUMN "audience_segment" "historical_audience_segment";

ALTER TABLE "recovery_candidate"
  ADD COLUMN "audience_segment" "historical_audience_segment";

ALTER TABLE "recovery_campaign"
  ADD COLUMN "audience_segment" "historical_audience_segment",
  ADD COLUMN "rollout_group_id" UUID,
  ADD COLUMN "rollout_group_hourly_cap" INTEGER,
  ADD CONSTRAINT "recovery_campaign_rollout_group_shape_check"
    CHECK (
      ("rollout_group_id" IS NULL AND "rollout_group_hourly_cap" IS NULL)
      OR (
        "rollout_group_id" IS NOT NULL
        AND "rollout_group_hourly_cap" IS NOT NULL
        AND "rollout_group_hourly_cap" BETWEEN 1 AND 1000
      )
    );

CREATE INDEX "ig_users_audience_segment_origin_method_idx"
  ON "ig_users"("audience_segment", "origin_method");

CREATE INDEX "recovery_campaign_rollout_group_id_state_idx"
  ON "recovery_campaign"("rollout_group_id", "state");

DROP TRIGGER IF EXISTS recovery_candidate_manifest_mutable_before_seal
  ON "recovery_candidate";

CREATE TRIGGER recovery_candidate_manifest_mutable_before_seal
BEFORE INSERT OR DELETE OR UPDATE OF
  "campaign_id", "campaign_phase", "intent_id", "ig_user_id", "conversation_id",
  "keyword_id", "comment_id", "media_id", "comment_at", "keyword_snapshot",
  "public_reply_text", "evidence", "selection_position", "source_choice_reason",
  "audience_origin", "audience_origin_method", "audience_origin_confidence",
  "audience_segment", "arm", "eligible_at"
ON "recovery_candidate"
FOR EACH ROW
EXECUTE FUNCTION enforce_recovery_candidate_manifest_mutable();

DROP TRIGGER IF EXISTS recovery_campaign_manifest_fields_mutable_before_seal
  ON "recovery_campaign";

CREATE TRIGGER recovery_campaign_manifest_fields_mutable_before_seal
BEFORE UPDATE OF
  "phase", "selection_version", "source_data_cutoff", "comment_from", "comment_to",
  "selection_limit", "holdout_percent", "copy_version", "candidate_count",
  "excluded_count", "selection_fingerprint", "eligibility_policy_version",
  "western_only", "inbound_window_hours", "completion_window_hours", "decision_hash",
  "audience_segment", "rollout_group_id", "rollout_group_hourly_cap"
ON "recovery_campaign"
FOR EACH ROW
EXECUTE FUNCTION enforce_recovery_campaign_manifest_fields_mutable();

COMMIT;
