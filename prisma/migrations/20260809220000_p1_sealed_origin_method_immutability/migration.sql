-- audience_origin_method was added after the sealed-manifest trigger. Include it in
-- the trigger's explicit UPDATE OF list so the method used to authorize public contact
-- cannot be changed or cleared after the owner has approved the frozen snapshot.
BEGIN;

DROP TRIGGER IF EXISTS recovery_candidate_manifest_mutable_before_seal
  ON "recovery_candidate";

CREATE TRIGGER recovery_candidate_manifest_mutable_before_seal
BEFORE INSERT OR DELETE OR UPDATE OF
  "campaign_id", "campaign_phase", "intent_id", "ig_user_id", "conversation_id",
  "keyword_id", "comment_id", "media_id", "comment_at", "keyword_snapshot",
  "public_reply_text", "evidence", "selection_position", "source_choice_reason",
  "audience_origin", "audience_origin_method", "audience_origin_confidence", "arm", "eligible_at"
ON "recovery_candidate"
FOR EACH ROW
EXECUTE FUNCTION enforce_recovery_candidate_manifest_mutable();

COMMIT;
