-- CreateEnum
CREATE TYPE "resource_message_type" AS ENUM ('text', 'image', 'pdf');

-- CreateEnum
CREATE TYPE "conversation_state" AS ENUM ('awaiting_done', 'completed', 'expired');

-- CreateTable
CREATE TABLE "keywords" (
    "id" UUID NOT NULL,
    "keyword" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "public_reply" TEXT NOT NULL,
    "gate_message" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resources" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_messages" (
    "id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "type" "resource_message_type" NOT NULL,
    "body" TEXT,
    "media_url" TEXT,

    CONSTRAINT "resource_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "ig_user_id" TEXT NOT NULL,
    "keyword_id" UUID NOT NULL,
    "state" "conversation_state" NOT NULL DEFAULT 'awaiting_done',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_log" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "keywords_keyword_key" ON "keywords"("keyword");

-- CreateIndex
CREATE UNIQUE INDEX "resource_messages_resource_id_order_key" ON "resource_messages"("resource_id", "order");

-- CreateIndex
CREATE INDEX "conversations_ig_user_id_state_idx" ON "conversations"("ig_user_id", "state");

-- CreateIndex
CREATE INDEX "conversations_state_created_at_idx" ON "conversations"("state", "created_at");

-- CreateIndex
CREATE INDEX "event_log_kind_created_at_idx" ON "event_log"("kind", "created_at");

-- AddForeignKey
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_messages" ADD CONSTRAINT "resource_messages_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
