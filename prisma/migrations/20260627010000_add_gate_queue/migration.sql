-- CreateTable
CREATE TABLE "gate_queue" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "ig_user_id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "gate_message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "comment_at" TIMESTAMP(3) NOT NULL,
    "next_attempt_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gate_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gate_queue_status_next_attempt_at_idx" ON "gate_queue"("status", "next_attempt_at");
