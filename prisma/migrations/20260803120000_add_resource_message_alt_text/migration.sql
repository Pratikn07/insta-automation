-- The words inside an image guide.
--
-- Needed because 25 of 128 resource_messages are images whose only identifier is
-- a UUID filename: `image/309de7b2-7846-4e74-9182-c12171116862.png` says nothing
-- about what the page contains. Seven resources are image-ONLY, so they carry
-- zero queryable text — including `Picky`, which is not a tips post but a
-- 10-page designed "Toddler Feeding Handbook (Ages 1-3)". It had been delivered
-- to 6 users while the text-only `Sleep` went to 747: the best asset in the
-- library was unreachable because nothing could read it.
--
-- Lives on resource_messages, NOT resources, so the text sits on the same row as
-- the media_url it describes — one row = one page = that page's words. Ordering,
-- delivery and cascade-delete all keep working untouched; sendMedia still sends
-- the image and never reads this column.
--
-- Nullable: text rows don't need it (their words are already in `body`), and
-- images stay valid before anyone transcribes them. Null therefore means
-- "not transcribed yet", which is exactly the backlog query for the remaining
-- image-only guides.
ALTER TABLE "resource_messages" ADD COLUMN "alt_text" TEXT;

-- Finds untranscribed image rows (the backlog) without scanning text rows.
-- Partial so it stays tiny — it indexes only the 25 image rows, not all 128.
CREATE INDEX "resource_messages_image_alt_text_idx"
  ON "resource_messages" ("resource_id")
  WHERE "type" = 'image' AND "alt_text" IS NULL;
