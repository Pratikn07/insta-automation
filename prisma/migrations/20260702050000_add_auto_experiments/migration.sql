-- AlterTable
ALTER TABLE "experiment" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "media_id" TEXT,
ADD COLUMN "us_fit_score" INTEGER,
ADD COLUMN "cultural_cues" TEXT[],
ADD COLUMN "baseline_engaged_us_pct" DOUBLE PRECISION,
ADD COLUMN "measured_engaged_us_pct" DOUBLE PRECISION,
ADD COLUMN "window_reach_share" DOUBLE PRECISION,
ADD COLUMN "suggested_verdict" TEXT,
ADD COLUMN "attribution_confidence" TEXT,
ADD COLUMN "measured_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "experiment_origin_media_id_idx" ON "experiment"("origin", "media_id");
