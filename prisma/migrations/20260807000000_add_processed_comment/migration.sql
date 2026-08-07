-- One row per comment webhook we have acted on. The primary key is the
-- idempotency guard: the insert either wins or raises, so two concurrent
-- deliveries of the same comment cannot both proceed to send.
CREATE TABLE "processed_comment" (
    "comment_id" TEXT NOT NULL,
    "ig_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_comment_pkey" PRIMARY KEY ("comment_id")
);

-- Supports pruning by age.
CREATE INDEX "processed_comment_created_at_idx" ON "processed_comment"("created_at");

-- Backend-only, like every other table here: the trusted database connection
-- reaches it, the Data API does not.
ALTER TABLE "processed_comment" ENABLE ROW LEVEL SECURITY;
