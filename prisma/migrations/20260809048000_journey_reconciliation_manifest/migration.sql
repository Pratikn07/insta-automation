CREATE TABLE "journey_reconciliation_run" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "source_cutoff" TIMESTAMPTZ(3) NOT NULL,
  "query_version" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "approved_manifest_run_id" UUID,
  "resume_position" INTEGER NOT NULL DEFAULT 0,
  "resume_cursor" TEXT,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(3),
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journey_reconciliation_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "journey_reconciliation_run_mode_check"
    CHECK ("mode" IN ('dry_run', 'write')),
  CONSTRAINT "journey_reconciliation_run_status_check"
    CHECK ("status" IN ('running', 'completed', 'failed')),
  CONSTRAINT "journey_reconciliation_run_resume_position_check"
    CHECK ("resume_position" >= 0),
  CONSTRAINT "journey_reconciliation_run_approval_check"
    CHECK (
      ("mode" = 'dry_run' AND "approved_manifest_run_id" IS NULL)
      OR ("mode" = 'write' AND "approved_manifest_run_id" IS NOT NULL)
    )
);

CREATE TABLE "journey_reconciliation_window" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "window_key" TEXT NOT NULL,
  "input_fingerprint" TEXT NOT NULL,
  "proposed_canonical_id" UUID NOT NULL,
  "evidence_choice" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "conflict_reason" TEXT,
  "intent_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journey_reconciliation_window_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "journey_reconciliation_window_position_check" CHECK ("position" >= 0)
);

CREATE INDEX "journey_reconciliation_run_mode_status_created_at_idx"
  ON "journey_reconciliation_run" ("mode", "status", "created_at");
CREATE UNIQUE INDEX "journey_reconciliation_window_run_position_key"
  ON "journey_reconciliation_window" ("run_id", "position");
CREATE UNIQUE INDEX "journey_reconciliation_window_run_key"
  ON "journey_reconciliation_window" ("run_id", "window_key");
CREATE INDEX "journey_reconciliation_window_result_conflict_reason_idx"
  ON "journey_reconciliation_window" ("result", "conflict_reason");

ALTER TABLE "journey_reconciliation_run"
  ADD CONSTRAINT "journey_reconciliation_run_approved_manifest_run_id_fkey"
  FOREIGN KEY ("approved_manifest_run_id")
  REFERENCES "journey_reconciliation_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journey_reconciliation_window"
  ADD CONSTRAINT "journey_reconciliation_window_run_id_fkey"
  FOREIGN KEY ("run_id")
  REFERENCES "journey_reconciliation_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "journey_reconciliation_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journey_reconciliation_window" ENABLE ROW LEVEL SECURITY;
