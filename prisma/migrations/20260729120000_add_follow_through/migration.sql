-- Second, later follow reading per conversation: does a guide recipient who
-- followed actually stay followed? Kept separate from follow_rechecked_at so the
-- two measurements can be compared rather than overwriting each other.
ALTER TABLE "conversations" ADD COLUMN "follow_through_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "follow_through_is_follower" BOOLEAN;

-- The worker scans for converted conversations old enough for a second reading.
CREATE INDEX "conversations_follow_through_at_idx" ON "conversations"("follow_through_at");
