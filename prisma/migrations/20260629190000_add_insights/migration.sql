-- CreateTable
CREATE TABLE "reel_meta" (
    "media_id" TEXT NOT NULL,
    "caption" TEXT,
    "permalink" TEXT,
    "thumbnail_url" TEXT,
    "media_url" TEXT,
    "posted_at" TIMESTAMP(3),
    "media_audio_type" TEXT,
    "video_unavailable" BOOLEAN NOT NULL DEFAULT false,
    "manual_audio_type" TEXT,
    "manual_lang_override" TEXT,
    "manual_note" TEXT,
    "us_fit_score" INTEGER,
    "confidence" TEXT,
    "scored_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reel_meta_pkey" PRIMARY KEY ("media_id")
);

-- CreateTable
CREATE TABLE "reel_content_profile" (
    "media_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "accent_score" INTEGER,
    "setting_score" INTEGER,
    "cultural_score" INTEGER,
    "hook_archetype" TEXT,
    "on_screen_lang" TEXT,
    "audio_vibe" TEXT,
    "cost_usd" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_content_profile_pkey" PRIMARY KEY ("media_id")
);

-- CreateTable
CREATE TABLE "reel_performance_snapshot" (
    "id" UUID NOT NULL,
    "media_id" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER,
    "reach" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saved" INTEGER,
    "total_interactions" INTEGER,
    "avg_watch_time_ms" INTEGER,
    "video_view_total_time" INTEGER,
    "skip_rate" DOUBLE PRECISION,
    "raw" JSONB,

    CONSTRAINT "reel_performance_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geo_demographic_snapshot" (
    "id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timeframe" TEXT NOT NULL DEFAULT 'last_90_days',
    "counts" JSONB NOT NULL,
    "us_pct" DOUBLE PRECISION,
    "in_pct" DOUBLE PRECISION,
    "total_counted" INTEGER,

    CONSTRAINT "geo_demographic_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gemini_job" (
    "media_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gemini_job_pkey" PRIMARY KEY ("media_id")
);

-- CreateTable
CREATE TABLE "experiment" (
    "id" UUID NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "variable" TEXT NOT NULL,
    "reel_media_ids" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'running',
    "baseline_us_pct" DOUBLE PRECISION,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_at" TIMESTAMP(3),
    "measured_us_pct" DOUBLE PRECISION,
    "conclusion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "experiment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reel_meta_us_fit_score_idx" ON "reel_meta"("us_fit_score");

-- CreateIndex
CREATE INDEX "reel_performance_snapshot_media_id_captured_at_idx" ON "reel_performance_snapshot"("media_id", "captured_at");

-- CreateIndex
CREATE INDEX "geo_demographic_snapshot_stage_captured_at_idx" ON "geo_demographic_snapshot"("stage", "captured_at");

-- CreateIndex
CREATE INDEX "gemini_job_status_next_attempt_at_idx" ON "gemini_job"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "experiment_status_idx" ON "experiment"("status");

-- AddForeignKey
ALTER TABLE "reel_content_profile" ADD CONSTRAINT "reel_content_profile_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "reel_meta"("media_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_performance_snapshot" ADD CONSTRAINT "reel_performance_snapshot_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "reel_meta"("media_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gemini_job" ADD CONSTRAINT "gemini_job_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "reel_meta"("media_id") ON DELETE CASCADE ON UPDATE CASCADE;
