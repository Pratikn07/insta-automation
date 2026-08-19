-- Meta's daily follows/unfollows ledger (`follows_and_unfollows`), one row per
-- Pacific analytics day.
--
-- followers_count gives an exact NET figure, which cannot separate a day that
-- gained 400 and lost 380 from one that gained 20. This metric is the only
-- source that reports both sides.
--
-- `follows`/`unfollows` are nullable and paired with `status` (the same shape
-- feed_follow_daily_snapshot uses): Meta returns an empty data set rather than 0
-- when a figure is unavailable, so a day it declines to answer is recorded as
-- 'unavailable' instead of being left missing. Without that row the backfill
-- would re-request the same dead day on every tick forever.

CREATE TABLE "follower_churn_day_snapshot" (
    "day" DATE NOT NULL,
    "follows" INTEGER,
    "unfollows" INTEGER,
    "status" TEXT NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follower_churn_day_snapshot_pkey" PRIMARY KEY ("day"),
    CONSTRAINT "follower_churn_day_snapshot_status_check"
      CHECK ("status" IN ('ok', 'unavailable')),
    -- An 'ok' row must actually carry both sides; a half ledger would render as
    -- "0 unfollows", which reads as a fact rather than as missing data.
    CONSTRAINT "follower_churn_day_snapshot_ok_is_complete_check"
      CHECK (
        "status" <> 'ok'
        OR ("follows" IS NOT NULL AND "unfollows" IS NOT NULL)
      ),
    CONSTRAINT "follower_churn_day_snapshot_non_negative_check"
      CHECK (
        ("follows" IS NULL OR "follows" >= 0)
        AND ("unfollows" IS NULL OR "unfollows" >= 0)
      )
);
