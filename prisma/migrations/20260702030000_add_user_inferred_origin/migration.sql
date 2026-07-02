-- AlterTable
ALTER TABLE "ig_users" ADD COLUMN "inferred_origin" TEXT,
ADD COLUMN "origin_confidence" TEXT,
ADD COLUMN "origin_method" TEXT,
ADD COLUMN "origin_evidence" TEXT,
ADD COLUMN "origin_checked_at" TIMESTAMP(3);
