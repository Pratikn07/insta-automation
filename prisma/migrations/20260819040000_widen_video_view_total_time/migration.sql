-- video_view_total_time is CUMULATIVE watch time in milliseconds over a reel's
-- entire life, so it only ever grows. A reel around 140k reach crosses INT4's
-- 2,147,483,647 ceiling in roughly seven weeks.
--
-- The failure is not a lost column, it is a lost ROW: every metric for a reel
-- shares one insert, so once this value overflows, that reel stops being
-- snapshotted entirely — views, reach, likes, interactions, all of it. And the
-- reels that overflow first are by definition the biggest ones.
--
-- Observed on 2026-08-19: the three largest reels on the account (113k-147k
-- reach) had no successful snapshot for 25, 37 and 47 days respectively, and
-- the highest stored value was 2,146,586,698 — 99.96% of the ceiling. That also
-- silently starved spikeService, which reads reach from this table to name the
-- reels behind a follower spike, so the biggest reels could never be candidates.
--
-- Widening is safe in place: INT4 -> INT8 is a binary-coercible widening that
-- Postgres performs without a table rewrite, and no code reads this column
-- (verified: the only reader is spikeService, selecting media_id, captured_at
-- and reach).

ALTER TABLE "reel_performance_snapshot"
  ALTER COLUMN "video_view_total_time" TYPE BIGINT;
