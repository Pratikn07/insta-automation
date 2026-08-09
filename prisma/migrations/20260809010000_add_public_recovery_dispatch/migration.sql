-- One authority for public recovery dispatch across prospective and historical paths.
CREATE TYPE "public_recovery_source_kind" AS ENUM ('prospective', 'historical');
CREATE TYPE "public_recovery_dispatch_state" AS ENUM (
  'reserved',
  'dispatch_started',
  'sent',
  'uncertain',
  'released'
);

-- Prospective recovery previously had only timestamps for ownership. Add the same
-- unguessable fencing token used by historical candidates before any ledger cutover.
ALTER TABLE "dm_recovery_reminder" ADD COLUMN "claim_token" UUID;
UPDATE "dm_recovery_reminder"
SET "claim_token" = gen_random_uuid()
WHERE "status" = 'sending'
  AND "claim_token" IS NULL;

ALTER TABLE "dm_recovery_reminder"
  ADD CONSTRAINT "dm_recovery_reminder_claim_complete_check"
  CHECK (
    ("claim_token" IS NULL AND "claimed_at" IS NULL AND "claim_expires_at" IS NULL)
    OR
    ("claim_token" IS NOT NULL AND "claimed_at" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
  );

CREATE UNIQUE INDEX "dm_recovery_reminder_claim_token_key"
  ON "dm_recovery_reminder" ("claim_token");

CREATE TABLE "public_recovery_dispatch" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "reservation_token" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ig_user_id" TEXT NOT NULL,
  "source_kind" "public_recovery_source_kind" NOT NULL,
  "source_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "campaign_id" UUID,
  "state" "public_recovery_dispatch_state" NOT NULL,
  "reserved_at" TIMESTAMPTZ(3) NOT NULL,
  "lease_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "dispatch_started_at" TIMESTAMPTZ(3),
  "sent_at" TIMESTAMPTZ(3),
  "released_at" TIMESTAMPTZ(3),
  "provider_reply_id" TEXT,
  "terminal_reason" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "public_recovery_dispatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_recovery_dispatch_attempt_number_check"
    CHECK ("attempt_number" > 0),
  CONSTRAINT "public_recovery_dispatch_lease_order_check"
    CHECK ("lease_expires_at" >= "reserved_at"),
  CONSTRAINT "public_recovery_dispatch_source_campaign_check"
    CHECK (
      ("source_kind" = 'prospective' AND "campaign_id" IS NULL)
      OR ("source_kind" = 'historical' AND "campaign_id" IS NOT NULL)
    ),
  CONSTRAINT "public_recovery_dispatch_state_shape_check"
    CHECK (
      (
        "state" = 'reserved'
        AND "dispatch_started_at" IS NULL
        AND "sent_at" IS NULL
        AND "released_at" IS NULL
        AND "provider_reply_id" IS NULL
        AND "terminal_reason" IS NULL
      )
      OR (
        "state" = 'dispatch_started'
        AND "dispatch_started_at" IS NOT NULL
        AND "sent_at" IS NULL
        AND "released_at" IS NULL
        AND "provider_reply_id" IS NULL
        AND "terminal_reason" IS NULL
      )
      OR (
        "state" = 'sent'
        AND "dispatch_started_at" IS NOT NULL
        AND "sent_at" IS NOT NULL
        AND "released_at" IS NULL
        AND NULLIF("provider_reply_id", '') IS NOT NULL
        AND "terminal_reason" IS NULL
      )
      OR (
        "state" = 'uncertain'
        AND "dispatch_started_at" IS NOT NULL
        AND "sent_at" IS NULL
        AND "released_at" IS NULL
        AND "provider_reply_id" IS NULL
        AND NULLIF("terminal_reason", '') IS NOT NULL
      )
      OR (
        "state" = 'released'
        AND "sent_at" IS NULL
        AND "released_at" IS NOT NULL
        AND "provider_reply_id" IS NULL
        AND NULLIF("terminal_reason", '') IS NOT NULL
      )
    )
);

ALTER TABLE "public_recovery_dispatch"
  ADD CONSTRAINT "public_recovery_dispatch_ig_user_id_fkey"
  FOREIGN KEY ("ig_user_id") REFERENCES "ig_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public_recovery_dispatch"
  ADD CONSTRAINT "public_recovery_dispatch_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "recovery_campaign"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill only attempts that consumed dispatch/cooldown authority or are active.
-- A legacy `sent` row without a provider id is conservative uncertainty, never a
-- confirmed send that can be retried.
INSERT INTO "public_recovery_dispatch" (
  "reservation_token", "ig_user_id", "source_kind", "source_id",
  "attempt_number", "campaign_id", "state", "reserved_at",
  "lease_expires_at", "dispatch_started_at", "sent_at", "released_at",
  "provider_reply_id", "terminal_reason", "created_at", "updated_at"
)
SELECT
  COALESCE(r."claim_token", gen_random_uuid()),
  r."ig_user_id",
  'prospective'::"public_recovery_source_kind",
  r."id",
  GREATEST(r."attempts", 1),
  NULL,
  CASE
    WHEN r."status" = 'sent' AND NULLIF(r."public_reply_id", '') IS NOT NULL
      THEN 'sent'::"public_recovery_dispatch_state"
    WHEN r."status" IN ('sent', 'send_uncertain')
      THEN 'uncertain'::"public_recovery_dispatch_state"
    ELSE 'dispatch_started'::"public_recovery_dispatch_state"
  END,
  COALESCE(r."last_attempt_at", r."sent_at", r."claimed_at", r."created_at"),
  COALESCE(
    r."claim_expires_at",
    COALESCE(r."last_attempt_at", r."sent_at", r."claimed_at", r."created_at") + INTERVAL '15 minutes'
  ),
  COALESCE(r."last_attempt_at", r."sent_at", r."claimed_at", r."created_at"),
  CASE
    WHEN r."status" = 'sent' AND NULLIF(r."public_reply_id", '') IS NOT NULL
      THEN r."sent_at"
    ELSE NULL
  END,
  NULL,
  CASE
    WHEN r."status" = 'sent' AND NULLIF(r."public_reply_id", '') IS NOT NULL
      THEN r."public_reply_id"
    ELSE NULL
  END,
  CASE
    WHEN r."status" = 'send_uncertain' THEN COALESCE(r."last_error_category", 'legacy_send_uncertain')
    WHEN r."status" = 'sent' AND NULLIF(r."public_reply_id", '') IS NULL THEN 'legacy_missing_provider_reply_id'
    ELSE NULL
  END,
  r."created_at",
  r."updated_at"
FROM "dm_recovery_reminder" r
WHERE r."status" IN ('sent', 'send_uncertain', 'sending');

INSERT INTO "public_recovery_dispatch" (
  "reservation_token", "ig_user_id", "source_kind", "source_id",
  "attempt_number", "campaign_id", "state", "reserved_at",
  "lease_expires_at", "dispatch_started_at", "sent_at", "released_at",
  "provider_reply_id", "terminal_reason", "created_at", "updated_at"
)
SELECT
  COALESCE(c."claim_token", gen_random_uuid()),
  c."ig_user_id",
  'historical'::"public_recovery_source_kind",
  c."id",
  GREATEST(c."attempts", 1),
  c."campaign_id",
  CASE
    WHEN c."outcome" = 'sent' AND NULLIF(c."public_reply_id", '') IS NOT NULL
      THEN 'sent'::"public_recovery_dispatch_state"
    WHEN c."outcome" IN ('sent', 'send_uncertain')
      THEN 'uncertain'::"public_recovery_dispatch_state"
    WHEN c."dispatch_started_at" IS NULL
      THEN 'reserved'::"public_recovery_dispatch_state"
    ELSE 'dispatch_started'::"public_recovery_dispatch_state"
  END,
  COALESCE(c."last_attempt_at", c."dispatch_started_at", c."sent_at", c."claimed_at", c."created_at"),
  COALESCE(
    c."claim_expires_at",
    COALESCE(c."last_attempt_at", c."dispatch_started_at", c."sent_at", c."claimed_at", c."created_at") + INTERVAL '15 minutes'
  ),
  CASE
    WHEN c."outcome" IN ('sent', 'send_uncertain') OR c."dispatch_started_at" IS NOT NULL
      THEN COALESCE(c."dispatch_started_at", c."sent_at", c."last_attempt_at", c."created_at")
    ELSE NULL
  END,
  CASE
    WHEN c."outcome" = 'sent' AND NULLIF(c."public_reply_id", '') IS NOT NULL
      THEN c."sent_at"
    ELSE NULL
  END,
  NULL,
  CASE
    WHEN c."outcome" = 'sent' AND NULLIF(c."public_reply_id", '') IS NOT NULL
      THEN c."public_reply_id"
    ELSE NULL
  END,
  CASE
    WHEN c."outcome" = 'send_uncertain' THEN COALESCE(c."suppression_reason", 'legacy_send_uncertain')
    WHEN c."outcome" = 'sent' AND NULLIF(c."public_reply_id", '') IS NULL THEN 'legacy_missing_provider_reply_id'
    ELSE NULL
  END,
  c."created_at",
  c."updated_at"
FROM "recovery_candidate" c
WHERE c."outcome" IN ('sent', 'send_uncertain')
   OR (c."outcome" = 'pending' AND c."claim_token" IS NOT NULL);

-- Never choose an active winner silently during migration. Operators must reconcile
-- the collision before deploying a schema that authorizes public contact.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public_recovery_dispatch"
    WHERE "state" IN ('reserved', 'dispatch_started')
    GROUP BY "ig_user_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'public recovery backfill contains multiple active attempts for one person';
  END IF;
END
$$;

CREATE UNIQUE INDEX "public_recovery_dispatch_reservation_token_key"
  ON "public_recovery_dispatch" ("reservation_token");
CREATE UNIQUE INDEX "public_recovery_dispatch_source_attempt_key"
  ON "public_recovery_dispatch" ("source_kind", "source_id", "attempt_number");
CREATE UNIQUE INDEX "public_recovery_dispatch_active_person_key"
  ON "public_recovery_dispatch" ("ig_user_id")
  WHERE "state" IN ('reserved', 'dispatch_started');
CREATE INDEX "public_recovery_dispatch_capacity_idx"
  ON "public_recovery_dispatch" ("state", "reserved_at");
CREATE INDEX "public_recovery_dispatch_person_cooldown_idx"
  ON "public_recovery_dispatch" ("ig_user_id", "sent_at");
CREATE INDEX "public_recovery_dispatch_campaign_capacity_idx"
  ON "public_recovery_dispatch" ("campaign_id", "state", "reserved_at");

ALTER TABLE "public_recovery_dispatch" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "public_recovery_dispatch" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "public_recovery_dispatch" FROM authenticated;
  END IF;
END
$$;
