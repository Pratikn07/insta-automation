-- Make the square rendition publishable.
--
-- Instagram's generic-template image slot centre-crops to roughly 1:1, so a card needs a
-- square source. The renderer has produced `square_card` since 2026-08-23, but nothing could
-- publish one: the orphan rendition CHECK listed only dm_cover and generic_card, and orphan
-- recording happens BEFORE the upload, so publication failed at the first step.
--
-- Three changes, and they have to land together.

-- 1. Accept the rendition.
ALTER TABLE "guide_cover_orphan"
  DROP CONSTRAINT "guide_cover_orphan_rendition_check";
ALTER TABLE "guide_cover_orphan"
  ADD CONSTRAINT "guide_cover_orphan_rendition_check"
    CHECK ("rendition" IN ('dm_cover', 'generic_card', 'square_card'));

-- 2. Name every rendition's filename explicitly.
--
-- This was `CASE rendition WHEN 'dm_cover' THEN 'dm' ELSE 'generic' END`. That ELSE is why
-- step 1 could not ship alone: widening the rendition list would have let a square be filed
-- at `generic.png` — accepted, wrong, and sharing a storage path with the generic card.
--
-- The CASE now has no ELSE on purpose. An unmatched rendition yields NULL, `format` yields
-- NULL, and a NULL CHECK expression PASSES in Postgres, so on its own this would be weaker
-- rather than stricter. It is sound only because the constraint above enumerates exactly the
-- three values this CASE covers. Neither constraint may be relaxed without the other.
ALTER TABLE "guide_cover_orphan"
  DROP CONSTRAINT "guide_cover_orphan_storage_path_check";
ALTER TABLE "guide_cover_orphan"
  ADD CONSTRAINT "guide_cover_orphan_storage_path_check"
    CHECK ("storage_path" = format(
      'guide-cover/%s/%s/%s/%s.png',
      "resource_id", "cover_version_id", "content_hash",
      CASE "rendition"
        WHEN 'dm_cover' THEN 'dm'
        WHEN 'generic_card' THEN 'generic'
        WHEN 'square_card' THEN 'square'
      END
    ));

-- 3. Let a published cover carry a square path.
--
-- A new column rather than reusing `generic_storage_path`: that column's CHECK pins it to
-- `generic.png`, so reuse would force the square to occupy the retired generic card's
-- filename and leave two renditions sharing one namespace. Nullable, because every cover
-- published before today has a dm path and no square.
ALTER TABLE "resource_cover_version"
  ADD COLUMN "square_storage_path" TEXT;

ALTER TABLE "resource_cover_version"
  DROP CONSTRAINT "resource_cover_version_ready_render_check";
ALTER TABLE "resource_cover_version"
  ADD CONSTRAINT "resource_cover_version_ready_render_check"
    CHECK (
      "render_status" <> 'ready'
      OR (
        "content_hash" IS NOT NULL
        AND "dm_storage_path" = format(
          'guide-cover/%s/%s/%s/dm.png', "resource_id", "id", "content_hash")
        AND (
          "generic_storage_path" IS NULL
          OR "generic_storage_path" = format(
            'guide-cover/%s/%s/%s/generic.png', "resource_id", "id", "content_hash")
        )
        AND (
          "square_storage_path" IS NULL
          OR "square_storage_path" = format(
            'guide-cover/%s/%s/%s/square.png', "resource_id", "id", "content_hash")
        )
      )
    );
