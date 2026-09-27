-- The verdict now lives on the decision row itself. It previously lived only on
-- guide_audience_classification, reachable through a nullable classification_id
-- with ON DELETE SET NULL — so dropping that table first would have blinded the
-- audit trail. This migration is additive; the drop is a separate follow-up.

-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it,
-- so this statement is intentionally outside the BEGIN block below and this
-- migration writes no row using the new value.
ALTER TYPE "guide_audience_decision_kind" ADD VALUE IF NOT EXISTS 'allow_unverified';

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "guide_audience_decision"
  ADD COLUMN IF NOT EXISTS "origin" "guide_audience_origin",
  ADD COLUMN IF NOT EXISTS "confidence" "guide_audience_confidence";

COMMIT;
