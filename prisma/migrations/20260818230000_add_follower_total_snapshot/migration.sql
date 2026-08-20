-- The account's true follower total (followers_count), captured per snapshot tick.
--
-- The follower chart currently derives its daily bars from follower_demographics,
-- which only counts followers Meta has demographic data for, within its top ~45
-- countries, and which Meta refreshes irregularly. That makes every bar an
-- undercount and turns any skipped refresh into one wide multi-day catch-up bar.
-- Diffing this column instead gives an exact daily net-add series.
--
-- No backfill is possible: Instagram exposes only the CURRENT followers_count,
-- never its history, so this series necessarily begins at the first tick after
-- deploy.

CREATE TABLE "follower_total_snapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "followers_total" INTEGER NOT NULL,

    CONSTRAINT "follower_total_snapshot_pkey" PRIMARY KEY ("id"),
    -- A negative or absurd total means the Graph response was mangled, not that
    -- the account shrank to nothing. Reject it at the boundary so a bad row can
    -- never render as a cliff in the chart.
    CONSTRAINT "follower_total_snapshot_followers_total_check"
      CHECK ("followers_total" >= 0)
);

CREATE INDEX "follower_total_snapshot_captured_at_idx"
  ON "follower_total_snapshot" ("captured_at");
