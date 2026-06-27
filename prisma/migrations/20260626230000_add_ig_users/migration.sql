-- CreateTable
CREATE TABLE "ig_users" (
    "id" TEXT NOT NULL,
    "username" TEXT,
    "name" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ig_users_pkey" PRIMARY KEY ("id")
);
