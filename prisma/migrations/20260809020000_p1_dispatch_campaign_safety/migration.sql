-- Distributed ownership for the historical worker. The two columns are one lease:
-- either both are present or neither is, so a partial write cannot strand the worker.
ALTER TABLE "dm_recovery_control"
  ADD COLUMN "historical_tick_token" UUID,
  ADD COLUMN "historical_tick_expires_at" TIMESTAMPTZ(3),
  ADD CONSTRAINT "dm_recovery_control_historical_tick_lease_check"
    CHECK (
      ("historical_tick_token" IS NULL AND "historical_tick_expires_at" IS NULL)
      OR
      ("historical_tick_token" IS NOT NULL AND "historical_tick_expires_at" IS NOT NULL)
    );

CREATE TYPE "recovery_campaign_batch_status" AS ENUM (
  'active',
  'completed',
  'expired'
);

CREATE TYPE "recovery_campaign_health_kind" AS ENUM (
  'complaint',
  'opt_out',
  'block',
  'negative_reply',
  'classifier_anomaly'
);

CREATE TABLE "recovery_campaign_batch_run" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "campaign_id" UUID NOT NULL,
  "tick_token" UUID NOT NULL,
  "allowance" INTEGER NOT NULL,
  "consumed" INTEGER NOT NULL DEFAULT 0,
  "status" "recovery_campaign_batch_status" NOT NULL DEFAULT 'active',
  "started_at" TIMESTAMPTZ(3) NOT NULL,
  "lease_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "ended_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "recovery_campaign_batch_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recovery_campaign_batch_run_allowance_check"
    CHECK ("allowance" > 0),
  CONSTRAINT "recovery_campaign_batch_run_consumed_check"
    CHECK ("consumed" >= 0 AND "consumed" <= "allowance"),
  CONSTRAINT "recovery_campaign_batch_run_lease_order_check"
    CHECK ("lease_expires_at" >= "started_at"),
  CONSTRAINT "recovery_campaign_batch_run_status_shape_check"
    CHECK (
      ("status" = 'active' AND "ended_at" IS NULL)
      OR
      ("status" IN ('completed', 'expired') AND "ended_at" IS NOT NULL)
    ),
  CONSTRAINT "recovery_campaign_batch_run_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "recovery_campaign"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "recovery_campaign_batch_run_campaign_id_tick_token_key"
  ON "recovery_campaign_batch_run" ("campaign_id", "tick_token");
CREATE UNIQUE INDEX "recovery_campaign_batch_run_active_campaign_key"
  ON "recovery_campaign_batch_run" ("campaign_id")
  WHERE "status" = 'active';
CREATE INDEX "recovery_campaign_batch_run_status_lease_expires_at_idx"
  ON "recovery_campaign_batch_run" ("status", "lease_expires_at");

CREATE TABLE "recovery_campaign_health_observation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "campaign_id" UUID NOT NULL,
  "kind" "recovery_campaign_health_kind" NOT NULL,
  "source_key" TEXT NOT NULL,
  "observed_at" TIMESTAMPTZ(3) NOT NULL,
  "safe_detail" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "recovery_campaign_health_observation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recovery_campaign_health_observation_source_key_check"
    CHECK (NULLIF(BTRIM("source_key"), '') IS NOT NULL),
  CONSTRAINT "recovery_campaign_health_observation_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "recovery_campaign"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "recovery_campaign_health_observation_campaign_id_source_key_key"
  ON "recovery_campaign_health_observation" ("campaign_id", "source_key");
CREATE INDEX "recovery_campaign_health_observation_campaign_id_kind_observed_at_idx"
  ON "recovery_campaign_health_observation" ("campaign_id", "kind", "observed_at");

-- These are backend safety records. Browser roles receive no direct table access.
ALTER TABLE "recovery_campaign_batch_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_campaign_health_observation" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "recovery_campaign_batch_run" FROM anon;
    REVOKE ALL ON TABLE "recovery_campaign_health_observation" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "recovery_campaign_batch_run" FROM authenticated;
    REVOKE ALL ON TABLE "recovery_campaign_health_observation" FROM authenticated;
  END IF;
END
$$;
