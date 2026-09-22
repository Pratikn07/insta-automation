BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- This provenance is intentionally separate from the Gemini historical-recovery
-- columns on ig_users. It records only a bounded verdict/evidence and a hash of
-- the identity snapshot; raw profile fields and provider responses never enter
-- either durable table.
CREATE TYPE "guide_audience_origin" AS ENUM ('south_asian', 'us_western', 'other', 'unknown');
CREATE TYPE "guide_audience_confidence" AS ENUM ('high', 'low');
CREATE TYPE "guide_audience_decision_kind" AS ENUM ('block', 'defer');
CREATE TYPE "guide_audience_action_source" AS ENUM ('comment', 'dm', 'quick_reply', 'postback', 'redelivery');
CREATE TYPE "guide_audience_defer_reason" AS ENUM (
  'identity_unavailable',
  'identity_changed',
  'provider_unavailable',
  'provider_timeout',
  'invalid_provider_response',
  'persistence_failed'
);

CREATE TABLE "guide_audience_classification" (
  "id" UUID NOT NULL,
  "ig_user_id" TEXT NOT NULL,
  "identity_hash" CHAR(64) NOT NULL,
  "origin" "guide_audience_origin" NOT NULL,
  "confidence" "guide_audience_confidence" NOT NULL,
  "evidence" VARCHAR(200) NOT NULL,
  "provider" VARCHAR(64) NOT NULL,
  "model_id" VARCHAR(160) NOT NULL,
  "method" VARCHAR(64) NOT NULL,
  "classified_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guide_audience_classification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guide_audience_classification_ig_user_id_fkey"
    FOREIGN KEY ("ig_user_id") REFERENCES "ig_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "guide_audience_classification_ig_user_id_identity_hash_method_key"
  ON "guide_audience_classification"("ig_user_id", "identity_hash", "method");
CREATE INDEX "guide_audience_classification_ig_user_id_classified_at_idx"
  ON "guide_audience_classification"("ig_user_id", "classified_at");

CREATE TABLE "guide_audience_decision" (
  "id" UUID NOT NULL,
  "ig_user_id" TEXT NOT NULL,
  "identity_hash" CHAR(64) NOT NULL,
  "kind" "guide_audience_decision_kind" NOT NULL,
  "source" "guide_audience_action_source" NOT NULL,
  "conversation_id" UUID,
  "comment_id" TEXT,
  "inbound_message_id" UUID,
  "resource_id" UUID,
  "classification_id" UUID,
  "defer_reason" "guide_audience_defer_reason",
  "provider" VARCHAR(64) NOT NULL,
  "model_id" VARCHAR(160) NOT NULL,
  "method" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guide_audience_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guide_audience_decision_ig_user_id_fkey"
    FOREIGN KEY ("ig_user_id") REFERENCES "ig_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "guide_audience_decision_classification_id_fkey"
    FOREIGN KEY ("classification_id") REFERENCES "guide_audience_classification"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "guide_audience_decision_ig_user_id_created_at_idx"
  ON "guide_audience_decision"("ig_user_id", "created_at");
CREATE INDEX "guide_audience_decision_kind_created_at_idx"
  ON "guide_audience_decision"("kind", "created_at");

-- These decisions are service-only safety/audit data. Explicitly enable RLS and
-- revoke exposed Data API roles, matching the existing durable guide tables.
ALTER TABLE "guide_audience_classification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guide_audience_decision" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "guide_audience_classification" FROM anon;
    REVOKE ALL ON TABLE "guide_audience_decision" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "guide_audience_classification" FROM authenticated;
    REVOKE ALL ON TABLE "guide_audience_decision" FROM authenticated;
  END IF;
END
$$;

COMMIT;
