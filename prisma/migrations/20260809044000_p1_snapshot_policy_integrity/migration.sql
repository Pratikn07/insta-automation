-- The staged cap changes membership and therefore belongs to the reviewed selector
-- identity. Null means no cap and is retained for backward compatibility.
ALTER TABLE "recovery_campaign"
  ADD COLUMN "selection_limit" INTEGER,
  ADD CONSTRAINT "recovery_campaign_selection_limit_check"
    CHECK ("selection_limit" IS NULL OR "selection_limit" > 0);

-- 20260809040000 introduced existing campaigns with a 48-hour inbound value before
-- the experiment was fixed at 24 hours. Legacy campaigns have no fingerprint, so they
-- can be normalized without changing a reviewed PR2 manifest.
UPDATE "recovery_campaign"
SET "inbound_window_hours" = 24
WHERE "selection_fingerprint" IS NULL;

-- A legacy running campaign has neither the complete reviewed manifest nor approved
-- fallback source rows required by the PR2 worker. Stop it explicitly rather than let
-- deployment turn every pending row into a terminal source-set exhaustion.
UPDATE "recovery_campaign"
SET
  "state" = 'paused',
  "paused_at" = CURRENT_TIMESTAMP,
  "pause_reason" = 'migration:legacy_unverified_snapshot',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "state" = 'running'
  AND "selection_fingerprint" IS NULL;
