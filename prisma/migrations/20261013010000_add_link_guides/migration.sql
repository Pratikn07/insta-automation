-- Link guides: a guide can send one DM with a button to a page on our site instead of
-- running the follow gate. Additive only: every existing guide becomes `gated`, which is
-- exactly how it behaves today.

-- ALTER TYPE ... ADD VALUE stays outside the transaction below, matching
-- 20260927010000_guide_audience_decision_origin. Nothing in this file uses the new value.
ALTER TYPE "conversation_state" ADD VALUE IF NOT EXISTS 'link_sent';

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TYPE "guide_delivery_mode" AS ENUM ('gated', 'link');
CREATE TYPE "guide_link_channel" AS ENUM ('private_reply', 'dm');
CREATE TYPE "guide_link_shape" AS ENUM ('card', 'text');
CREATE TYPE "guide_link_send_status" AS ENUM ('pending', 'sent', 'failed');

ALTER TABLE "resources"
  ADD COLUMN "delivery_mode" "guide_delivery_mode" NOT NULL DEFAULT 'gated',
  ADD COLUMN "link_url" TEXT,
  ADD COLUMN "link_button_label" VARCHAR(20),
  ADD COLUMN "link_card_title" VARCHAR(80),
  ADD COLUMN "link_card_subtitle" VARCHAR(80);

CREATE TABLE "guide_link_send" (
    "id" UUID NOT NULL,
    "token" VARCHAR(16) NOT NULL,
    "conversation_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "keyword_id" UUID NOT NULL,
    "media_id" TEXT,
    "ig_user_id" TEXT NOT NULL,
    "channel" "guide_link_channel" NOT NULL,
    "shape" "guide_link_shape" NOT NULL,
    "status" "guide_link_send_status" NOT NULL DEFAULT 'pending',
    "provider_message_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "guide_link_send_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "guide_link_send_token_key" ON "guide_link_send"("token");
CREATE INDEX "guide_link_send_conversation_id_idx" ON "guide_link_send"("conversation_id");
CREATE INDEX "guide_link_send_resource_id_idx" ON "guide_link_send"("resource_id");
CREATE INDEX "guide_link_send_keyword_id_idx" ON "guide_link_send"("keyword_id");
CREATE INDEX "guide_link_send_media_id_created_at_idx" ON "guide_link_send"("media_id", "created_at");

CREATE TABLE "guide_link_click" (
    "id" UUID NOT NULL,
    "send_id" UUID NOT NULL,
    "clicked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destination_url" TEXT NOT NULL,
    "is_bot" BOOLEAN NOT NULL,
    "ua_family" VARCHAR(32) NOT NULL,

    CONSTRAINT "guide_link_click_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "guide_link_click_send_id_is_bot_idx" ON "guide_link_click"("send_id", "is_bot");

ALTER TABLE "guide_link_send"
    ADD CONSTRAINT "guide_link_send_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guide_link_send"
    ADD CONSTRAINT "guide_link_send_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guide_link_send"
    ADD CONSTRAINT "guide_link_send_keyword_id_fkey"
    FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guide_link_click"
    ADD CONSTRAINT "guide_link_click_send_id_fkey"
    FOREIGN KEY ("send_id") REFERENCES "guide_link_send"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "guide_link_send" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guide_link_click" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "guide_link_send" FROM anon;
    REVOKE ALL ON TABLE "guide_link_click" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "guide_link_send" FROM authenticated;
    REVOKE ALL ON TABLE "guide_link_click" FROM authenticated;
  END IF;
END
$$;

COMMIT;
