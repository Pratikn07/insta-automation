-- AlterTable
ALTER TABLE "ig_users" ADD COLUMN "is_follower" BOOLEAN,
ADD COLUMN "follower_count" INTEGER,
ADD COLUMN "is_verified" BOOLEAN,
ADD COLUMN "follow_checked_at" TIMESTAMP(3);
