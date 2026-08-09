ALTER TABLE "settings_blocked_verification"
  ADD CONSTRAINT "settings_blocked_verification_signature_check"
    CHECK ("graph_code" >= 0 AND "graph_subcode" >= 0),
  ADD CONSTRAINT "settings_blocked_verification_version_check"
    CHECK (
      "version" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      AND "evidence_reference" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$'
      AND POSITION('..' IN "evidence_reference") = 0
    ),
  ADD CONSTRAINT "settings_blocked_verification_context_check"
    CHECK (
      NULLIF(BTRIM("verifier_identity"), '') IS NOT NULL
      AND LENGTH("verifier_identity") <= 200
      AND NULLIF(BTRIM("controlled_account_context"), '') IS NOT NULL
      AND LENGTH("controlled_account_context") <= 200
      AND NULLIF(BTRIM("api_version"), '') IS NOT NULL
      AND LENGTH("api_version") <= 64
    );

CREATE OR REPLACE FUNCTION reject_new_legacy_settings_evidence()
RETURNS trigger AS $$
BEGIN
  IF NEW."settings_evidence_legacy" = true THEN
    RAISE EXCEPTION 'new settings-blocked reminders require verified evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dm_recovery_reminder_no_new_legacy_settings_evidence
BEFORE INSERT ON "dm_recovery_reminder"
FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_settings_evidence();
