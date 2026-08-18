CREATE TYPE "guide_delivery_trigger_kind" AS ENUM (
  'inbound_reply',
  'explicit_redelivery',
  'follow_recovery'
);

CREATE TYPE "guide_delivery_status" AS ENUM (
  'planned',
  'sending',
  'failed',
  'needs_review',
  'completed',
  'cancelled'
);

CREATE TYPE "guide_delivery_unit_origin" AS ENUM (
  'resource_step',
  'redelivery_intro'
);

CREATE TYPE "guide_delivery_unit_kind" AS ENUM ('text', 'image', 'file');
CREATE TYPE "guide_delivery_unit_status" AS ENUM (
  'pending',
  'sending',
  'sent',
  'retryable',
  'failed',
  'uncertain',
  'cancelled'
);
CREATE TYPE "guide_delivery_failure_disposition" AS ENUM ('transient', 'permanent');

CREATE TABLE "guide_delivery" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL,
  "resource_id" UUID NOT NULL,
  "thread_id" UUID,
  "trigger_kind" "guide_delivery_trigger_kind" NOT NULL,
  "trigger_id" UUID NOT NULL,
  "triggered_at" TIMESTAMPTZ(3) NOT NULL,
  "send_window_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "follower_at_trigger" BOOLEAN,
  "status" "guide_delivery_status" NOT NULL DEFAULT 'planned',
  "failure_code" TEXT,
  "next_attempt_at" TIMESTAMPTZ(3),
  "claim_token" UUID,
  "claimed_at" TIMESTAMPTZ(3),
  "claim_expires_at" TIMESTAMPTZ(3),
  "started_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "cancelled_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guide_delivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guide_delivery_send_window_order_check"
    CHECK ("send_window_expires_at" > "triggered_at"),
  CONSTRAINT "guide_delivery_claim_complete_check" CHECK (
    ("claim_token" IS NULL AND "claimed_at" IS NULL AND "claim_expires_at" IS NULL)
    OR
    ("claim_token" IS NOT NULL AND "claimed_at" IS NOT NULL
      AND "claim_expires_at" IS NOT NULL AND "claim_expires_at" > "claimed_at")
  ),
  CONSTRAINT "guide_delivery_retry_shape_check" CHECK (
    "next_attempt_at" IS NULL OR "status" = 'failed'
  ),
  CONSTRAINT "guide_delivery_terminal_timestamps_check" CHECK (
    ("status" = 'completed' AND "completed_at" IS NOT NULL AND "cancelled_at" IS NULL)
    OR
    ("status" = 'cancelled' AND "cancelled_at" IS NOT NULL AND "completed_at" IS NULL)
    OR
    ("status" NOT IN ('completed', 'cancelled')
      AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
  ),
  CONSTRAINT "guide_delivery_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "guide_delivery_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "guide_delivery_thread_id_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "dm_thread"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "guide_delivery_claim_token_key"
  ON "guide_delivery" ("claim_token");
CREATE UNIQUE INDEX "guide_delivery_trigger_kind_trigger_id_key"
  ON "guide_delivery" ("trigger_kind", "trigger_id");
CREATE INDEX "guide_delivery_conversation_id_idx"
  ON "guide_delivery" ("conversation_id");
CREATE INDEX "guide_delivery_resource_id_idx"
  ON "guide_delivery" ("resource_id");
CREATE INDEX "guide_delivery_thread_id_idx"
  ON "guide_delivery" ("thread_id");

CREATE INDEX "guide_delivery_due_idx"
  ON "guide_delivery" ("next_attempt_at", "created_at", "id")
  WHERE "claim_token" IS NULL
    AND ("status" = 'planned'
      OR ("status" = 'failed' AND "next_attempt_at" IS NOT NULL));

CREATE INDEX "guide_delivery_expired_claim_idx"
  ON "guide_delivery" ("claim_expires_at", "id")
  WHERE "claim_token" IS NOT NULL;

CREATE INDEX "guide_delivery_thread_review_idx"
  ON "guide_delivery" ("thread_id", "created_at" DESC)
  WHERE "status" = 'needs_review';

CREATE TABLE "guide_delivery_unit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "delivery_id" UUID NOT NULL,
  "resource_message_id" UUID,
  "position" INTEGER NOT NULL,
  "origin" "guide_delivery_unit_origin" NOT NULL,
  "kind" "guide_delivery_unit_kind" NOT NULL,
  "text_snapshot" TEXT,
  "media_url_snapshot" TEXT,
  "content_fingerprint" CHAR(64) NOT NULL,
  "status" "guide_delivery_unit_status" NOT NULL DEFAULT 'pending',
  "failure_disposition" "guide_delivery_failure_disposition",
  "provider_message_id" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "sending_at" TIMESTAMPTZ(3),
  "sent_at" TIMESTAMPTZ(3),
  "owner_confirmed_at" TIMESTAMPTZ(3),
  "owner_retry_authorized_at" TIMESTAMPTZ(3),
  "owner_retry_consumed_at" TIMESTAMPTZ(3),
  "error_category" TEXT,
  "error_http_status" INTEGER,
  "error_graph_code" INTEGER,
  "error_graph_subcode" INTEGER,
  "error_trace_id" TEXT,
  "error_transport_code" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guide_delivery_unit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guide_delivery_unit_position_check" CHECK ("position" >= 0),
  CONSTRAINT "guide_delivery_unit_payload_shape_check" CHECK (
    ("kind" = 'text' AND "text_snapshot" IS NOT NULL AND "media_url_snapshot" IS NULL)
    OR
    ("kind" IN ('image', 'file') AND "text_snapshot" IS NULL
      AND "media_url_snapshot" IS NOT NULL)
  ),
  CONSTRAINT "guide_delivery_unit_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "guide_delivery_unit_state_timestamps_check" CHECK (
    ("status" = 'pending' AND "sending_at" IS NULL AND "sent_at" IS NULL
      AND "owner_confirmed_at" IS NULL)
    OR
    ("status" = 'sending' AND "sending_at" IS NOT NULL AND "sent_at" IS NULL
      AND "owner_confirmed_at" IS NULL)
    OR
    ("status" IN ('retryable', 'failed', 'uncertain') AND "sending_at" IS NOT NULL
      AND "sent_at" IS NULL AND "owner_confirmed_at" IS NULL)
    OR
    ("status" = 'sent' AND "sending_at" IS NOT NULL AND "sent_at" IS NOT NULL)
    OR
    ("status" = 'cancelled' AND "sent_at" IS NULL AND "owner_confirmed_at" IS NULL)
  ),
  CONSTRAINT "guide_delivery_unit_sent_state_check" CHECK (
    "status" <> 'sent'
    OR NULLIF("provider_message_id", '') IS NOT NULL
    OR "owner_confirmed_at" IS NOT NULL
  ),
  CONSTRAINT "guide_delivery_unit_owner_retry_order_check" CHECK (
    "owner_retry_consumed_at" IS NULL
    OR ("owner_retry_authorized_at" IS NOT NULL
      AND "owner_retry_consumed_at" >= "owner_retry_authorized_at")
  ),
  CONSTRAINT "guide_delivery_unit_delivery_id_fkey"
    FOREIGN KEY ("delivery_id") REFERENCES "guide_delivery"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "guide_delivery_unit_resource_message_id_fkey"
    FOREIGN KEY ("resource_message_id") REFERENCES "resource_messages"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "guide_delivery_unit_delivery_id_position_key"
  ON "guide_delivery_unit" ("delivery_id", "position");
CREATE INDEX "guide_delivery_unit_resource_message_id_idx"
  ON "guide_delivery_unit" ("resource_message_id");
CREATE INDEX "guide_delivery_unit_delivery_id_status_position_idx"
  ON "guide_delivery_unit" ("delivery_id", "status", "position");

ALTER TABLE "guide_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guide_delivery_unit" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "guide_delivery" FROM anon;
    REVOKE ALL ON TABLE "guide_delivery_unit" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "guide_delivery" FROM authenticated;
    REVOKE ALL ON TABLE "guide_delivery_unit" FROM authenticated;
  END IF;
END
$$;
