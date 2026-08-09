-- The experiment's leading observation is fixed at 24 hours; completion is measured
-- at 48 hours. Campaign rows still persist both values so the reviewed snapshot and
-- decision hash carry the exact measurement policy.
ALTER TABLE "recovery_campaign"
  ALTER COLUMN "inbound_window_hours" SET DEFAULT 24;
