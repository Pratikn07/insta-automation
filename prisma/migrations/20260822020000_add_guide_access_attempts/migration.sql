CREATE TYPE "guide_access_attempt_state" AS ENUM (
  'awaiting_request',
  'checking_follow',
  'awaiting_follow',
  'delivering',
  'delivered',
  'needs_review',
  'expired'
);

CREATE TYPE "guide_follow_result" AS ENUM ('follower', 'non_follower', 'unknown');
CREATE TYPE "guide_cover_exposure" AS ENUM (
  'not_shown',
  'accepted',
  'uncertain',
  'failed'
);
CREATE TYPE "guide_action_token_action" AS ENUM ('request_guide', 'check_follow');
CREATE TYPE "guide_action_token_status" AS ENUM (
  'active',
  'consumed',
  'expired',
  'cancelled'
);

CREATE TABLE "guide_access_attempt" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "resource_id" UUID NOT NULL,
  "cover_version_id" UUID,
  "state" "guide_access_attempt_state" NOT NULL DEFAULT 'awaiting_request',
  "last_follow_result" "guide_follow_result" NOT NULL DEFAULT 'unknown',
  "last_follow_checked_at" TIMESTAMPTZ(3),
  "follow_check_count" INTEGER NOT NULL DEFAULT 0,
  "follow_response_count" INTEGER NOT NULL DEFAULT 0,
  "cover_exposure" "guide_cover_exposure" NOT NULL DEFAULT 'not_shown',
  "cover_provider_message_id" TEXT,
  "messaging_window_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guide_access_attempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guide_access_attempt_follow_counts_check" CHECK (
    "follow_check_count" >= 0
    AND "follow_check_count" <= 3
    AND "follow_response_count" >= 0
    AND "follow_response_count" <= 2
  ),
  CONSTRAINT "guide_access_attempt_cover_exposure_check" CHECK (
    ("cover_exposure" = 'not_shown' AND "cover_provider_message_id" IS NULL)
    OR
    ("cover_exposure" = 'accepted'
      AND NULLIF("cover_provider_message_id", '') IS NOT NULL)
    OR
    "cover_exposure" = 'uncertain'
    OR
    ("cover_exposure" = 'failed' AND "cover_provider_message_id" IS NULL)
  ),
  CONSTRAINT "guide_access_attempt_state_follow_result_check" CHECK (
    ("state" IN ('awaiting_request', 'checking_follow')
      AND "last_follow_result" = 'unknown')
    OR
    ("state" = 'awaiting_follow' AND "last_follow_result" = 'non_follower')
    OR
    ("state" IN ('delivering', 'delivered')
      AND "last_follow_result" = 'follower')
    OR
    "state" IN ('needs_review', 'expired')
  ),
  CONSTRAINT "guide_access_attempt_messaging_window_check"
    CHECK ("messaging_window_expires_at" > "created_at"),
  CONSTRAINT "guide_access_attempt_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "guide_access_attempt_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "guide_access_attempt_cover_version_id_fkey"
    FOREIGN KEY ("cover_version_id") REFERENCES "resource_cover_version"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "guide_access_attempt_conversation_id_idx"
  ON "guide_access_attempt" ("conversation_id");
CREATE INDEX "guide_access_attempt_resource_id_idx"
  ON "guide_access_attempt" ("resource_id");
CREATE INDEX "guide_access_attempt_cover_version_id_idx"
  ON "guide_access_attempt" ("cover_version_id");

CREATE UNIQUE INDEX "guide_access_attempt_active_conversation_key"
  ON "guide_access_attempt" ("conversation_id")
  WHERE "state" IN (
    'awaiting_request',
    'checking_follow',
    'awaiting_follow',
    'delivering',
    'needs_review'
  );

CREATE INDEX "guide_access_attempt_expiring_idx"
  ON "guide_access_attempt" ("messaging_window_expires_at", "id")
  WHERE "state" IN (
    'awaiting_request',
    'checking_follow',
    'awaiting_follow',
    'delivering',
    'needs_review'
  );

CREATE TABLE "guide_action_token" (
  "id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "action" "guide_action_token_action" NOT NULL,
  "status" "guide_action_token_status" NOT NULL DEFAULT 'active',
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guide_action_token_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guide_action_token_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "guide_action_token_consumption_check" CHECK (
    ("status" = 'consumed' AND "consumed_at" IS NOT NULL)
    OR
    ("status" IN ('active', 'expired', 'cancelled') AND "consumed_at" IS NULL)
  ),
  CONSTRAINT "guide_action_token_attempt_id_fkey"
    FOREIGN KEY ("attempt_id") REFERENCES "guide_access_attempt"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "guide_action_token_attempt_id_status_idx"
  ON "guide_action_token" ("attempt_id", "status");
CREATE INDEX "guide_action_token_active_expires_at_idx"
  ON "guide_action_token" ("expires_at", "id")
  WHERE "status" = 'active';

ALTER TABLE "guide_access_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guide_action_token" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "guide_access_attempt" FROM anon;
    REVOKE ALL ON TABLE "guide_action_token" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "guide_access_attempt" FROM authenticated;
    REVOKE ALL ON TABLE "guide_action_token" FROM authenticated;
  END IF;
END
$$;
