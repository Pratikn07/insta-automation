-- The post's own publish date, snapshotted onto the keyword when it is attached.
--
-- Needed because a cold DM carries no media context: when several posts share a
-- word (SLEEP is live on 6), something has to rank them, and "newest post wins"
-- is the chosen inference. Keyword.created_at would mean "when you attached it",
-- which makes an old reel count as newest; reel_meta.posted_at covers reels only
-- (140 reels, 0 carousels), so it cannot date a carousel-scoped keyword.
--
-- Nullable, and null on every existing global row — those are ranked last.
ALTER TABLE "keywords" ADD COLUMN "media_posted_at" TIMESTAMP(3);

-- The cold-DM fallback orders post-scoped candidates for one word by this date.
CREATE INDEX "keywords_keyword_media_posted_at_idx" ON "keywords"("keyword", "media_posted_at");
