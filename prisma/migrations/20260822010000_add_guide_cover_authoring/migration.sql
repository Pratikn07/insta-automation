CREATE TYPE "presentation_category_design_status" AS ENUM (
  'ready',
  'needs_review',
  'inactive'
);

CREATE TYPE "resource_cover_status" AS ENUM (
  'draft',
  'approved',
  'published',
  'retired'
);

CREATE TYPE "resource_cover_render_status" AS ENUM (
  'not_rendered',
  'rendering',
  'ready',
  'failed'
);

CREATE TYPE "resource_cover_suggestion_confidence" AS ENUM (
  'high',
  'medium',
  'low'
);

CREATE TYPE "guide_cover_orphan_cleanup_status" AS ENUM (
  'pending',
  'claimed',
  'deleted',
  'needs_review'
);

CREATE TABLE "presentation_category" (
  "id" UUID NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "collection_label" TEXT NOT NULL,
  "default_kicker" TEXT NOT NULL,
  "template_key" TEXT NOT NULL,
  "palette_key" TEXT NOT NULL,
  "illustration_key" TEXT NOT NULL,
  "design_status" "presentation_category_design_status" NOT NULL DEFAULT 'needs_review',
  "next_edition_number" INTEGER NOT NULL DEFAULT 1,
  "sort_order" INTEGER,
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "presentation_category_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "presentation_category_slug_check"
    CHECK (
      "slug" = lower("slug")
      AND "slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
      AND char_length("slug") BETWEEN 1 AND 64
    ),
  CONSTRAINT "presentation_category_name_check"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 64),
  CONSTRAINT "presentation_category_collection_label_check"
    CHECK (char_length(btrim("collection_label")) BETWEEN 1 AND 16),
  CONSTRAINT "presentation_category_default_kicker_check"
    CHECK (char_length(btrim("default_kicker")) BETWEEN 1 AND 32),
  CONSTRAINT "presentation_category_visual_keys_check"
    CHECK (
      "template_key" ~ '^[a-z0-9_]+$'
      AND "palette_key" ~ '^[a-z0-9_]+$'
      AND "illustration_key" ~ '^[a-z0-9_]+$'
      AND char_length("template_key") BETWEEN 1 AND 64
      AND char_length("palette_key") BETWEEN 1 AND 64
      AND char_length("illustration_key") BETWEEN 1 AND 64
    ),
  CONSTRAINT "presentation_category_next_edition_check"
    CHECK ("next_edition_number" BETWEEN 1 AND 1000000),
  CONSTRAINT "presentation_category_sort_order_check"
    CHECK ("sort_order" IS NULL OR "sort_order" >= 0),
  CONSTRAINT "presentation_category_audit_identity_check"
    CHECK (btrim("created_by") <> '' AND btrim("updated_by") <> '')
);

CREATE UNIQUE INDEX "presentation_category_slug_ci_key"
  ON "presentation_category" (lower("slug"));
CREATE UNIQUE INDEX "presentation_category_name_ci_key"
  ON "presentation_category" (lower("name"));
CREATE INDEX "presentation_category_status_sort_idx"
  ON "presentation_category" ("design_status", "sort_order", "name");

CREATE TABLE "resource_presentation" (
  "resource_id" UUID NOT NULL,
  "category_id" UUID NOT NULL,
  "edition_number" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "resource_presentation_pkey" PRIMARY KEY ("resource_id"),
  CONSTRAINT "resource_presentation_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "resource_presentation_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "presentation_category"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "resource_presentation_edition_number_check"
    CHECK ("edition_number" IS NULL OR "edition_number" BETWEEN 1 AND 1000000)
);

CREATE INDEX "resource_presentation_category_id_idx"
  ON "resource_presentation" ("category_id");
CREATE UNIQUE INDEX "resource_presentation_category_edition_key"
  ON "resource_presentation" ("category_id", "edition_number")
  WHERE "edition_number" IS NOT NULL;

CREATE TABLE "resource_cover_suggestion" (
  "id" UUID NOT NULL,
  "resource_id" UUID NOT NULL,
  "suggested_category_id" UUID NOT NULL,
  "headline" TEXT NOT NULL,
  "supporting_line" TEXT NOT NULL,
  "closing_line" TEXT NOT NULL,
  "alternative_description" TEXT NOT NULL,
  "confidence" "resource_cover_suggestion_confidence" NOT NULL,
  "warnings" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "prompt_version" TEXT NOT NULL,
  "normalized_source_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "resource_cover_suggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resource_cover_suggestion_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "resource_cover_suggestion_suggested_category_id_fkey"
    FOREIGN KEY ("suggested_category_id") REFERENCES "presentation_category"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "resource_cover_suggestion_copy_check"
    CHECK (
      char_length(btrim("headline")) BETWEEN 1 AND 56
      AND char_length(btrim("supporting_line")) BETWEEN 1 AND 90
      AND char_length(btrim("closing_line")) BETWEEN 1 AND 64
      AND char_length(btrim("alternative_description")) BETWEEN 1 AND 240
    ),
  CONSTRAINT "resource_cover_suggestion_warnings_check"
    CHECK (jsonb_typeof("warnings") = 'array' AND jsonb_array_length("warnings") <= 8),
  CONSTRAINT "resource_cover_suggestion_provider_check"
    CHECK (
      char_length(btrim("provider")) BETWEEN 1 AND 40
      AND char_length(btrim("model")) BETWEEN 1 AND 80
      AND char_length(btrim("prompt_version")) BETWEEN 1 AND 40
    ),
  CONSTRAINT "resource_cover_suggestion_source_hash_check"
    CHECK ("normalized_source_hash" ~ '^[a-f0-9]{64}$')
);

CREATE INDEX "resource_cover_suggestion_resource_id_idx"
  ON "resource_cover_suggestion" ("resource_id");
CREATE INDEX "resource_cover_suggestion_category_id_idx"
  ON "resource_cover_suggestion" ("suggested_category_id");
CREATE UNIQUE INDEX "resource_cover_suggestion_resource_source_key"
  ON "resource_cover_suggestion" ("resource_id", "normalized_source_hash");

CREATE TABLE "resource_cover_version" (
  "id" UUID NOT NULL,
  "resource_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" "resource_cover_status" NOT NULL DEFAULT 'draft',
  "render_status" "resource_cover_render_status" NOT NULL DEFAULT 'not_rendered',
  "category_id" UUID NOT NULL,
  "edition_number" INTEGER,
  "template_key" TEXT NOT NULL,
  "palette_key" TEXT NOT NULL,
  "illustration_key" TEXT NOT NULL,
  "kicker" TEXT NOT NULL,
  "collection_label" TEXT NOT NULL,
  "headline" TEXT NOT NULL,
  "supporting_line" TEXT NOT NULL,
  "closing_line" TEXT NOT NULL,
  "alternative_description" TEXT NOT NULL,
  "suggestion_id" UUID,
  "content_hash" TEXT,
  "dm_storage_path" TEXT,
  "generic_storage_path" TEXT,
  "render_error_code" TEXT,
  "approved_by" TEXT,
  "approved_at" TIMESTAMPTZ(3),
  "published_by" TEXT,
  "published_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "resource_cover_version_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resource_cover_version_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "resource_cover_version_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "presentation_category"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "resource_cover_version_suggestion_id_fkey"
    FOREIGN KEY ("suggestion_id") REFERENCES "resource_cover_suggestion"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "resource_cover_version_revision_check"
    CHECK ("revision" BETWEEN 1 AND 1000000),
  CONSTRAINT "resource_cover_version_edition_check"
    CHECK ("edition_number" IS NULL OR "edition_number" BETWEEN 1 AND 1000000),
  CONSTRAINT "resource_cover_version_visual_keys_check"
    CHECK (
      "template_key" ~ '^[a-z0-9_]+$'
      AND "palette_key" ~ '^[a-z0-9_]+$'
      AND "illustration_key" ~ '^[a-z0-9_]+$'
      AND char_length("template_key") BETWEEN 1 AND 64
      AND char_length("palette_key") BETWEEN 1 AND 64
      AND char_length("illustration_key") BETWEEN 1 AND 64
    ),
  CONSTRAINT "resource_cover_version_copy_check"
    CHECK (
      char_length(btrim("kicker")) BETWEEN 1 AND 32
      AND char_length(btrim("collection_label")) BETWEEN 1 AND 16
      AND char_length(btrim("headline")) BETWEEN 1 AND 56
      AND char_length(btrim("supporting_line")) BETWEEN 1 AND 90
      AND char_length(btrim("closing_line")) BETWEEN 1 AND 64
      AND char_length(btrim("alternative_description")) BETWEEN 1 AND 240
    ),
  CONSTRAINT "resource_cover_version_hash_check"
    CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "resource_cover_version_render_error_check"
    CHECK (
      "render_error_code" IS NULL OR "render_error_code" IN (
        'cover_asset_missing',
        'cover_invalid_input',
        'cover_invalid_visual_key',
        'cover_render_failed',
        'cover_text_overflow'
      )
    ),
  CONSTRAINT "resource_cover_version_approval_check"
    CHECK (
      ("status" = 'draft' AND "approved_at" IS NULL AND "approved_by" IS NULL)
      OR (
        "status" IN ('approved', 'published', 'retired')
        AND "approved_at" IS NOT NULL
        AND btrim("approved_by") <> ''
      )
    ),
  CONSTRAINT "resource_cover_version_ready_render_check"
    CHECK (
      "render_status" <> 'ready'
      OR (
        "content_hash" IS NOT NULL
        AND "dm_storage_path" = format(
          'guide-cover/%s/%s/%s/dm.png',
          "resource_id",
          "id",
          "content_hash"
        )
        AND (
          "generic_storage_path" IS NULL
          OR "generic_storage_path" = format(
            'guide-cover/%s/%s/%s/generic.png',
            "resource_id",
            "id",
            "content_hash"
          )
        )
      )
    ),
  CONSTRAINT "resource_cover_version_published_check"
    CHECK (
      "status" <> 'published'
      OR (
        "render_status" = 'ready'
        AND "edition_number" IS NOT NULL
        AND "content_hash" IS NOT NULL
        AND "dm_storage_path" IS NOT NULL
        AND "published_at" IS NOT NULL
        AND btrim("published_by") <> ''
      )
    ),
  CONSTRAINT "resource_cover_version_publish_identity_check"
    CHECK (
      ("published_at" IS NULL AND "published_by" IS NULL)
      OR ("published_at" IS NOT NULL AND btrim("published_by") <> '')
    )
);

CREATE UNIQUE INDEX "resource_cover_version_resource_revision_key"
  ON "resource_cover_version" ("resource_id", "revision");
CREATE UNIQUE INDEX "resource_cover_version_one_published_key"
  ON "resource_cover_version" ("resource_id")
  WHERE "status" = 'published';
CREATE INDEX "resource_cover_version_category_id_idx"
  ON "resource_cover_version" ("category_id");
CREATE INDEX "resource_cover_version_suggestion_id_idx"
  ON "resource_cover_version" ("suggestion_id");
CREATE INDEX "resource_cover_version_status_idx"
  ON "resource_cover_version" ("resource_id", "status", "revision" DESC);

CREATE TABLE "guide_cover_orphan" (
  "id" UUID NOT NULL,
  "resource_id" UUID NOT NULL,
  "cover_version_id" UUID NOT NULL,
  "content_hash" TEXT NOT NULL,
  "rendition" TEXT NOT NULL,
  "storage_path" TEXT NOT NULL,
  "status" "guide_cover_orphan_cleanup_status" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" TIMESTAMPTZ(3),
  "claim_expires_at" TIMESTAMPTZ(3),
  "last_error_code" TEXT,
  "deleted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guide_cover_orphan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guide_cover_orphan_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "guide_cover_orphan_cover_version_id_fkey"
    FOREIGN KEY ("cover_version_id") REFERENCES "resource_cover_version"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "guide_cover_orphan_content_hash_check"
    CHECK ("content_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "guide_cover_orphan_rendition_check"
    CHECK ("rendition" IN ('dm_cover', 'generic_card')),
  CONSTRAINT "guide_cover_orphan_storage_path_check"
    CHECK (
      "storage_path" = format(
        'guide-cover/%s/%s/%s/%s.png',
        "resource_id",
        "cover_version_id",
        "content_hash",
        CASE "rendition" WHEN 'dm_cover' THEN 'dm' ELSE 'generic' END
      )
    ),
  CONSTRAINT "guide_cover_orphan_attempts_check"
    CHECK ("attempts" BETWEEN 0 AND 10),
  CONSTRAINT "guide_cover_orphan_claim_check"
    CHECK (
      (
        "status" = 'claimed'
        AND "claimed_at" IS NOT NULL
        AND "claim_expires_at" > "claimed_at"
      )
      OR (
        "status" <> 'claimed'
        AND "claimed_at" IS NULL
        AND "claim_expires_at" IS NULL
      )
    ),
  CONSTRAINT "guide_cover_orphan_deleted_check"
    CHECK (("status" = 'deleted') = ("deleted_at" IS NOT NULL)),
  CONSTRAINT "guide_cover_orphan_error_code_check"
    CHECK (
      "last_error_code" IS NULL OR "last_error_code" IN (
        'storage_delete_failed',
        'storage_outcome_unknown',
        'storage_path_invalid',
        'storage_path_live'
      )
    )
);

CREATE UNIQUE INDEX "guide_cover_orphan_storage_path_key"
  ON "guide_cover_orphan" ("storage_path");
CREATE INDEX "guide_cover_orphan_resource_id_idx"
  ON "guide_cover_orphan" ("resource_id");
CREATE INDEX "guide_cover_orphan_cover_version_id_idx"
  ON "guide_cover_orphan" ("cover_version_id");
CREATE INDEX "guide_cover_orphan_pending_idx"
  ON "guide_cover_orphan" ("next_attempt_at", "created_at", "id")
  WHERE "status" = 'pending';
CREATE INDEX "guide_cover_orphan_expired_claim_idx"
  ON "guide_cover_orphan" ("claim_expires_at", "id")
  WHERE "status" = 'claimed';

ALTER TABLE "presentation_category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource_presentation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource_cover_suggestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource_cover_version" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guide_cover_orphan" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "presentation_category" FROM "anon", "authenticated";
REVOKE ALL ON TABLE "resource_presentation" FROM "anon", "authenticated";
REVOKE ALL ON TABLE "resource_cover_suggestion" FROM "anon", "authenticated";
REVOKE ALL ON TABLE "resource_cover_version" FROM "anon", "authenticated";
REVOKE ALL ON TABLE "guide_cover_orphan" FROM "anon", "authenticated";

INSERT INTO "presentation_category" (
  "id", "slug", "name", "collection_label", "default_kicker",
  "template_key", "palette_key", "illustration_key", "design_status",
  "next_edition_number", "sort_order", "created_by", "updated_by"
) VALUES
  (
    '10000000-0000-4000-8000-000000000001', 'bedtime', 'Bedtime', 'SLEEP',
    'A TINY WIN FOR TONIGHT', 'warm_editorial_corner_v1', 'bedtime_blush_v1',
    'bedtime_window_house_v1', 'ready', 1, 10, 'system:approved_v1', 'system:approved_v1'
  ),
  (
    '10000000-0000-4000-8000-000000000002', 'potty-training', 'Potty Training', 'POTTY',
    'A LITTLE STEP FOR TODAY', 'warm_editorial_corner_v1', 'potty_sunlit_v1',
    'potty_sunlit_ritual_v1', 'ready', 1, 20, 'system:approved_v1', 'system:approved_v1'
  ),
  (
    '10000000-0000-4000-8000-000000000003', 'recipes', 'Recipes', 'RECIPES',
    'A LITTLE WIN AT THE TABLE', 'warm_editorial_corner_v1', 'recipes_corner_table_v1',
    'recipes_corner_bowl_v1', 'ready', 1, 30, 'system:approved_v1', 'system:approved_v1'
  ),
  (
    '10000000-0000-4000-8000-000000000004', 'montessori-activities',
    'Montessori-inspired Activities', 'LEARNING', 'PURPOSEFUL PLAY FOR TODAY',
    'editorial_right_panel_v1', 'montessori_discovery_v1', 'discovery_tray_right_v1',
    'ready', 1, 40, 'system:approved_v1', 'system:approved_v1'
  )
ON CONFLICT ("id") DO NOTHING;

DO $$
DECLARE
  matched_categories INTEGER;
BEGIN
  WITH expected (
    id, slug, name, collection_label, default_kicker, template_key, palette_key,
    illustration_key, sort_order
  ) AS (
    VALUES
      (
        '10000000-0000-4000-8000-000000000001'::uuid, 'bedtime', 'Bedtime', 'SLEEP',
        'A TINY WIN FOR TONIGHT', 'warm_editorial_corner_v1', 'bedtime_blush_v1',
        'bedtime_window_house_v1', 10
      ),
      (
        '10000000-0000-4000-8000-000000000002'::uuid, 'potty-training',
        'Potty Training', 'POTTY', 'A LITTLE STEP FOR TODAY',
        'warm_editorial_corner_v1', 'potty_sunlit_v1', 'potty_sunlit_ritual_v1', 20
      ),
      (
        '10000000-0000-4000-8000-000000000003'::uuid, 'recipes', 'Recipes',
        'RECIPES', 'A LITTLE WIN AT THE TABLE', 'warm_editorial_corner_v1',
        'recipes_corner_table_v1', 'recipes_corner_bowl_v1', 30
      ),
      (
        '10000000-0000-4000-8000-000000000004'::uuid, 'montessori-activities',
        'Montessori-inspired Activities', 'LEARNING', 'PURPOSEFUL PLAY FOR TODAY',
        'editorial_right_panel_v1', 'montessori_discovery_v1',
        'discovery_tray_right_v1', 40
      )
  )
  SELECT count(*) INTO matched_categories
  FROM expected
  JOIN "presentation_category" category
    ON category."id" = expected.id
   AND category."slug" = expected.slug
   AND category."name" = expected.name
   AND category."collection_label" = expected.collection_label
   AND category."default_kicker" = expected.default_kicker
   AND category."template_key" = expected.template_key
   AND category."palette_key" = expected.palette_key
   AND category."illustration_key" = expected.illustration_key
   AND category."design_status" = 'ready'
   AND category."sort_order" = expected.sort_order;

  IF matched_categories <> 4 THEN
    RAISE EXCEPTION 'approved guide-cover category seed mismatch';
  END IF;
END $$;
