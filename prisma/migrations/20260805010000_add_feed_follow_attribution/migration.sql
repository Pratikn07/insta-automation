-- Meta exposes a cumulative lifetime `follows` insight for regular FEED media.
-- These anchors and daily snapshots preserve that raw evidence without mixing
-- it into ReelMeta, whose metrics and API support are different.
CREATE TABLE "feed_post_meta" (
  "media_id" TEXT NOT NULL,
  "media_type" TEXT,
  "media_product_type" TEXT,
  "caption" TEXT,
  "permalink" TEXT,
  "thumbnail_url" TEXT,
  "posted_at" TIMESTAMPTZ(3),
  "baseline_follows" INTEGER,
  "baseline_captured_at" TIMESTAMPTZ(3),
  "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "feed_post_meta_pkey" PRIMARY KEY ("media_id"),
  CONSTRAINT "feed_post_meta_baseline_follows_check"
    CHECK ("baseline_follows" IS NULL OR "baseline_follows" >= 0)
);

CREATE TABLE "feed_follow_daily_snapshot" (
  "media_id" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "follows" INTEGER,
  "status" TEXT NOT NULL,

  CONSTRAINT "feed_follow_daily_snapshot_pkey" PRIMARY KEY ("media_id", "day"),
  CONSTRAINT "feed_follow_daily_snapshot_media_id_fkey"
    FOREIGN KEY ("media_id") REFERENCES "feed_post_meta"("media_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feed_follow_daily_snapshot_value_check" CHECK (
    ("status" = 'ok' AND "follows" IS NOT NULL AND "follows" >= 0)
    OR ("status" IN ('unavailable', 'failed') AND "follows" IS NULL)
  )
);

CREATE TABLE "feed_follow_collector_state" (
  "scope" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ(3) NOT NULL,
  "last_attempt_at" TIMESTAMPTZ(3),
  "last_completed_at" TIMESTAMPTZ(3),
  "last_status" TEXT,
  "eligible_count" INTEGER NOT NULL DEFAULT 0,
  "written_count" INTEGER NOT NULL DEFAULT 0,
  "unavailable_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "feed_follow_collector_state_pkey" PRIMARY KEY ("scope"),
  CONSTRAINT "feed_follow_collector_state_scope_check" CHECK ("scope" = 'feed'),
  CONSTRAINT "feed_follow_collector_state_status_check"
    CHECK ("last_status" IS NULL OR "last_status" IN ('running', 'success', 'partial', 'failed')),
  CONSTRAINT "feed_follow_collector_state_counts_check" CHECK (
    "eligible_count" >= 0
    AND "written_count" >= 0
    AND "unavailable_count" >= 0
    AND "failed_count" >= 0
  )
);

CREATE INDEX "feed_post_meta_posted_at_idx" ON "feed_post_meta"("posted_at");
CREATE INDEX "feed_follow_daily_snapshot_day_idx" ON "feed_follow_daily_snapshot"("day");

-- These tables are backend-only and accessed through Prisma's server-side
-- database role. Enabling RLS with no anon/authenticated policies denies direct
-- Data API access while the table owner retains the backend path.
ALTER TABLE "feed_post_meta" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feed_follow_daily_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feed_follow_collector_state" ENABLE ROW LEVEL SECURITY;
