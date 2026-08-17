-- CreateEnum
CREATE TYPE "dm_recovery_timing_arm" AS ENUM (
  'two_hour',
  'six_hour',
  'no_reminder'
);

-- AlterTable: nullable so legacy recovery rows keep their original meaning.
ALTER TABLE "dm_recovery_reminder"
  ADD COLUMN "experiment_version_snapshot" TEXT,
  ADD COLUMN "timing_arm" "dm_recovery_timing_arm";

-- A v2 assignment is complete and internally consistent at insertion. The
-- control is terminal; treatment rows may progress through non-control states.
ALTER TABLE "dm_recovery_reminder"
  ADD CONSTRAINT "dm_recovery_reminder_v2_assignment_check"
  CHECK (
    "experiment_version_snapshot" IS DISTINCT FROM 'read-recovery-timing-v2'
    OR (
      "accepted_at" IS NOT NULL
      AND "timing_arm" IS NOT NULL
      AND (
        (
          "timing_arm" IN ('two_hour', 'six_hour')
          AND "cohort" = 'treatment'
          AND "status" <> 'control'
        )
        OR (
          "timing_arm" = 'no_reminder'
          AND "cohort" = 'control'
          AND "status" = 'control'
        )
      )
    )
  ) NOT VALID;

ALTER TABLE "dm_recovery_reminder"
  VALIDATE CONSTRAINT "dm_recovery_reminder_v2_assignment_check";

-- Neither application code nor an operator may re-bucket an enrolled follower,
-- move their acceptance/eligibility clocks, or retrofit a legacy row into v2.
CREATE OR REPLACE FUNCTION protect_dm_recovery_v2_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD."experiment_version_snapshot" = 'read-recovery-timing-v2'
    OR NEW."experiment_version_snapshot" = 'read-recovery-timing-v2'
  ) AND (
    NEW."experiment_version_snapshot" IS DISTINCT FROM OLD."experiment_version_snapshot"
    OR NEW."timing_arm" IS DISTINCT FROM OLD."timing_arm"
    OR NEW."accepted_at" IS DISTINCT FROM OLD."accepted_at"
    OR NEW."eligible_at" IS DISTINCT FROM OLD."eligible_at"
  ) THEN
    RAISE EXCEPTION 'v2_assignment_is_immutable (%)', OLD."id"
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER dm_recovery_reminder_v2_assignment_immutable
BEFORE UPDATE OF
  "experiment_version_snapshot", "timing_arm", "accepted_at", "eligible_at"
ON "dm_recovery_reminder"
FOR EACH ROW
EXECUTE FUNCTION protect_dm_recovery_v2_assignment();

-- Date-scoped experiment reporting filters on version first, then acceptance.
CREATE INDEX "dm_recovery_reminder_experiment_version_accepted_at_idx"
  ON "dm_recovery_reminder" ("experiment_version_snapshot", "accepted_at");
