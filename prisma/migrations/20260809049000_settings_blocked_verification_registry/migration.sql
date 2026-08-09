CREATE TABLE "settings_blocked_verification" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "version" TEXT NOT NULL,
  "graph_code" INTEGER NOT NULL,
  "graph_subcode" INTEGER NOT NULL,
  "semantic_category" TEXT NOT NULL,
  "verified_at" TIMESTAMPTZ(3) NOT NULL,
  "valid_until" TIMESTAMPTZ(3) NOT NULL,
  "verifier_identity" TEXT NOT NULL,
  "controlled_account_context" TEXT NOT NULL,
  "api_version" TEXT NOT NULL,
  "evidence_reference" TEXT NOT NULL,
  "evidence_sha256" CHAR(64) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "retired_at" TIMESTAMPTZ(3),
  "retirement_reason" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settings_blocked_verification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "settings_blocked_verification_window_check"
    CHECK ("valid_until" > "verified_at"),
  CONSTRAINT "settings_blocked_verification_category_check"
    CHECK ("semantic_category" = 'settings_blocked'),
  CONSTRAINT "settings_blocked_verification_hash_check"
    CHECK ("evidence_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "settings_blocked_verification_lifecycle_check"
    CHECK (
      ("active" = true AND "retired_at" IS NULL AND "retirement_reason" IS NULL)
      OR ("active" = false AND "retired_at" IS NULL AND "retirement_reason" IS NULL)
      OR ("active" = false AND "retired_at" IS NOT NULL AND NULLIF(BTRIM("retirement_reason"), '') IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "settings_blocked_verification_version_key"
  ON "settings_blocked_verification" ("version");
CREATE UNIQUE INDEX "settings_blocked_verification_graph_code_graph_subcode_version_key"
  ON "settings_blocked_verification" ("graph_code", "graph_subcode", "version");
CREATE UNIQUE INDEX "settings_blocked_verification_one_active_signature_key"
  ON "settings_blocked_verification" ("graph_code", "graph_subcode")
  WHERE "active" = true AND "retired_at" IS NULL;
CREATE INDEX "settings_blocked_verification_signature_active_valid_idx"
  ON "settings_blocked_verification" ("graph_code", "graph_subcode", "active", "valid_until");

ALTER TABLE "settings_blocked_verification" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION protect_settings_blocked_verification_evidence()
RETURNS trigger AS $$
BEGIN
  IF NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."graph_code" IS DISTINCT FROM OLD."graph_code"
     OR NEW."graph_subcode" IS DISTINCT FROM OLD."graph_subcode"
     OR NEW."semantic_category" IS DISTINCT FROM OLD."semantic_category"
     OR NEW."verified_at" IS DISTINCT FROM OLD."verified_at"
     OR NEW."valid_until" IS DISTINCT FROM OLD."valid_until"
     OR NEW."verifier_identity" IS DISTINCT FROM OLD."verifier_identity"
     OR NEW."controlled_account_context" IS DISTINCT FROM OLD."controlled_account_context"
     OR NEW."api_version" IS DISTINCT FROM OLD."api_version"
     OR NEW."evidence_reference" IS DISTINCT FROM OLD."evidence_reference"
     OR NEW."evidence_sha256" IS DISTINCT FROM OLD."evidence_sha256"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'settings-blocked verification evidence is immutable (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settings_blocked_verification_evidence_immutable
BEFORE UPDATE ON "settings_blocked_verification"
FOR EACH ROW EXECUTE FUNCTION protect_settings_blocked_verification_evidence();

ALTER TABLE "dm_recovery_reminder"
  ADD COLUMN "settings_evidence_legacy" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "settings_verification_id" UUID,
  ADD COLUMN "settings_verification_version" TEXT,
  ADD COLUMN "settings_graph_code" INTEGER,
  ADD COLUMN "settings_graph_subcode" INTEGER,
  ADD COLUMN "settings_classified_at" TIMESTAMPTZ(3),
  ADD COLUMN "settings_evidence_reference" TEXT,
  ADD COLUMN "settings_evidence_sha256" CHAR(64);

-- Existing settings candidates cannot be retroactively attributed to evidence
-- that was never captured. Mark them explicitly instead of fabricating proof.
UPDATE "dm_recovery_reminder"
SET "settings_evidence_legacy" = true
WHERE "trigger_kind" = 'settings_blocked';

ALTER TABLE "dm_recovery_reminder"
  ADD CONSTRAINT "dm_recovery_reminder_settings_verification_id_fkey"
  FOREIGN KEY ("settings_verification_id")
  REFERENCES "settings_blocked_verification"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "dm_recovery_reminder_settings_evidence_shape_check"
  CHECK (
    (
      "trigger_kind" = 'no_confirmed_read'
      AND "settings_evidence_legacy" = false
      AND "settings_verification_id" IS NULL
      AND "settings_verification_version" IS NULL
      AND "settings_graph_code" IS NULL
      AND "settings_graph_subcode" IS NULL
      AND "settings_classified_at" IS NULL
      AND "settings_evidence_reference" IS NULL
      AND "settings_evidence_sha256" IS NULL
    )
    OR (
      "trigger_kind" = 'settings_blocked'
      AND "settings_evidence_legacy" = true
      AND "settings_verification_id" IS NULL
      AND "settings_verification_version" IS NULL
      AND "settings_graph_code" IS NULL
      AND "settings_graph_subcode" IS NULL
      AND "settings_classified_at" IS NULL
      AND "settings_evidence_reference" IS NULL
      AND "settings_evidence_sha256" IS NULL
    )
    OR (
      "trigger_kind" = 'settings_blocked'
      AND "settings_evidence_legacy" = false
      AND "settings_verification_id" IS NOT NULL
      AND NULLIF(BTRIM("settings_verification_version"), '') IS NOT NULL
      AND "settings_graph_code" IS NOT NULL
      AND "settings_graph_subcode" IS NOT NULL
      AND "settings_classified_at" IS NOT NULL
      AND NULLIF(BTRIM("settings_evidence_reference"), '') IS NOT NULL
      AND "settings_evidence_sha256" ~ '^[0-9a-f]{64}$'
    )
  );

CREATE INDEX "dm_recovery_reminder_settings_verification_id_trigger_kind_status_idx"
  ON "dm_recovery_reminder" ("settings_verification_id", "trigger_kind", "status");

CREATE OR REPLACE FUNCTION protect_dm_recovery_settings_evidence()
RETURNS trigger AS $$
BEGIN
  IF NEW."settings_evidence_legacy" IS DISTINCT FROM OLD."settings_evidence_legacy"
     OR NEW."settings_verification_id" IS DISTINCT FROM OLD."settings_verification_id"
     OR NEW."settings_verification_version" IS DISTINCT FROM OLD."settings_verification_version"
     OR NEW."settings_graph_code" IS DISTINCT FROM OLD."settings_graph_code"
     OR NEW."settings_graph_subcode" IS DISTINCT FROM OLD."settings_graph_subcode"
     OR NEW."settings_classified_at" IS DISTINCT FROM OLD."settings_classified_at"
     OR NEW."settings_evidence_reference" IS DISTINCT FROM OLD."settings_evidence_reference"
     OR NEW."settings_evidence_sha256" IS DISTINCT FROM OLD."settings_evidence_sha256" THEN
    RAISE EXCEPTION 'settings-blocked reminder evidence is immutable (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dm_recovery_reminder_settings_evidence_immutable
BEFORE UPDATE ON "dm_recovery_reminder"
FOR EACH ROW EXECUTE FUNCTION protect_dm_recovery_settings_evidence();
