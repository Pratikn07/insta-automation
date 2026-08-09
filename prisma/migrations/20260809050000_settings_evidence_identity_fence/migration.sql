CREATE UNIQUE INDEX "settings_blocked_verification_identity_key"
  ON "settings_blocked_verification" ("id", "version", "graph_code", "graph_subcode");

ALTER TABLE "dm_recovery_reminder"
  DROP CONSTRAINT "dm_recovery_reminder_settings_verification_id_fkey",
  ADD CONSTRAINT "dm_recovery_reminder_settings_verification_identity_fkey"
  FOREIGN KEY (
    "settings_verification_id",
    "settings_verification_version",
    "settings_graph_code",
    "settings_graph_subcode"
  )
  REFERENCES "settings_blocked_verification"(
    "id",
    "version",
    "graph_code",
    "graph_subcode"
  ) ON DELETE RESTRICT ON UPDATE CASCADE;
