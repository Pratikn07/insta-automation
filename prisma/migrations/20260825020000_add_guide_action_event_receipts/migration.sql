BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TYPE "guide_action_event_source" AS ENUM ('quick_reply', 'postback');

CREATE TABLE "guide_action_event_receipt" (
    "id" UUID NOT NULL,
    "token_id" UUID NOT NULL,
    "source" "guide_action_event_source" NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "event_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guide_action_event_receipt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "guide_action_event_receipt_token_id_idx"
    ON "guide_action_event_receipt"("token_id");

ALTER TABLE "guide_action_event_receipt"
    ADD CONSTRAINT "guide_action_event_receipt_token_id_fkey"
    FOREIGN KEY ("token_id") REFERENCES "guide_action_token"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "guide_action_event_receipt" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "guide_action_event_receipt" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "guide_action_event_receipt" FROM authenticated;
  END IF;
END
$$;

COMMIT;
