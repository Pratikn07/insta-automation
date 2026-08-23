import { describe, expect, it } from "vitest";

import {
  copyFromCategory,
  deriveGuideCoverEditorState,
} from "./guideCoverEditorState";
import type {
  PresentationCategory,
  ResourceCoverVersion,
  ResourcePresentationResponse,
} from "./types";

const category: PresentationCategory = {
  id: "10000000-0000-4000-8000-000000000001",
  slug: "bedtime",
  name: "Bedtime",
  collectionLabel: "SLEEP",
  defaultKicker: "A TINY WIN FOR TONIGHT",
  templateKey: "warm_editorial_corner_v1",
  paletteKey: "bedtime_blush_v1",
  illustrationKey: "bedtime_window_house_v1",
  designStatus: "ready",
  nextEditionNumber: 18,
  sortOrder: 1,
  createdBy: "creator@tinysoho.com",
  updatedBy: "creator@tinysoho.com",
  createdAt: "2026-08-22T12:00:00.000Z",
  updatedAt: "2026-08-22T12:00:00.000Z",
};

const inactiveCategory: PresentationCategory = {
  ...category,
  id: "10000000-0000-4000-8000-000000000009",
  slug: "archive",
  name: "Archive",
  collectionLabel: "ARCHIVE",
  defaultKicker: "A TINY WIN FROM BEFORE",
  designStatus: "inactive",
  nextEditionNumber: 2,
  sortOrder: null,
};

const cover = (overrides: Partial<ResourceCoverVersion>): ResourceCoverVersion => ({
  id: "30000000-0000-4000-8000-000000000001",
  resourceId: "20000000-0000-4000-8000-000000000001",
  revision: 1,
  status: "draft",
  renderStatus: "not_rendered",
  categoryId: category.id,
  editionNumber: null,
  templateKey: category.templateKey,
  paletteKey: category.paletteKey,
  illustrationKey: category.illustrationKey,
  kicker: category.defaultKicker,
  collectionLabel: category.collectionLabel,
  headline: "Bedtime can feel softer",
  supportingLine: "A calmer bedtime, one small shift at a time.",
  closingLine: "Prepared for calmer evenings.",
  alternativeDescription: "A TinySoho bedtime guide cover.",
  suggestionId: null,
  contentHash: null,
  dmStoragePath: null,
  genericStoragePath: null,
  renderErrorCode: null,
  approvedBy: null,
  approvedAt: null,
  publishedBy: null,
  publishedAt: null,
  createdAt: "2026-08-22T12:00:00.000Z",
  updatedAt: "2026-08-22T12:00:00.000Z",
  ...overrides,
});

const response = (
  overrides: Partial<ResourcePresentationResponse>,
): ResourcePresentationResponse => ({
  presentation: {
    resourceId: "20000000-0000-4000-8000-000000000001",
    categoryId: category.id,
    editionNumber: null,
    createdAt: "2026-08-22T12:00:00.000Z",
    updatedAt: "2026-08-22T12:00:00.000Z",
  },
  coverVersions: [],
  ...overrides,
});

describe("deriveGuideCoverEditorState", () => {
  it("returns an empty state when a resource has no presentation or covers", () => {
    expect(
      deriveGuideCoverEditorState({ presentation: null, coverVersions: [] }, [category]),
    ).toMatchObject({
      phase: "not_configured",
      selectedCategory: null,
      workingCover: null,
    });
  });

  it("selects the matching category and the draft cover revision", () => {
    const withDraft = response({ coverVersions: [cover({ revision: 3, status: "draft" })] });

    expect(deriveGuideCoverEditorState(withDraft, [category])).toMatchObject({
      phase: "draft",
      selectedCategory: category,
      workingCover: { revision: 3 },
      previewEditionNumber: 18,
    });
  });

  it("derives an approved phase from an approved cover", () => {
    const withApproved = response({
      coverVersions: [cover({ revision: 4, status: "approved" })],
    });

    expect(deriveGuideCoverEditorState(withApproved, [category])).toMatchObject({
      phase: "approved",
      workingCover: { revision: 4 },
    });
  });

  it("prefers a working draft over an older published cover", () => {
    const withDraftAndPublished = response({
      coverVersions: [
        cover({ revision: 5, status: "published", editionNumber: 17 }),
        cover({ revision: 6, status: "draft" }),
      ],
      presentation: {
        resourceId: "20000000-0000-4000-8000-000000000001",
        categoryId: category.id,
        editionNumber: 17,
        createdAt: "2026-08-22T12:00:00.000Z",
        updatedAt: "2026-08-22T12:00:00.000Z",
      },
    });

    expect(deriveGuideCoverEditorState(withDraftAndPublished, [category])).toMatchObject({
      phase: "draft",
      workingCover: { revision: 6 },
      previewEditionNumber: 17,
    });
  });

  it("falls back to the published cover and its allocated edition", () => {
    const withPublished = response({
      presentation: {
        resourceId: "20000000-0000-4000-8000-000000000001",
        categoryId: category.id,
        editionNumber: 17,
        createdAt: "2026-08-22T12:00:00.000Z",
        updatedAt: "2026-08-22T12:00:00.000Z",
      },
      coverVersions: [cover({ revision: 5, status: "published", editionNumber: 17 })],
    });

    expect(deriveGuideCoverEditorState(withPublished, [category])).toMatchObject({
      phase: "published",
      workingCover: { revision: 5 },
      previewEditionNumber: 17,
    });
  });

  it("honors the embedded current category when it is inactive and absent from the active list", () => {
    const withInactivePublished = response({
      presentation: {
        resourceId: "20000000-0000-4000-8000-000000000001",
        categoryId: inactiveCategory.id,
        editionNumber: 9,
        category: inactiveCategory,
        createdAt: "2026-08-22T12:00:00.000Z",
        updatedAt: "2026-08-22T12:00:00.000Z",
      },
      coverVersions: [
        cover({
          revision: 8,
          status: "published",
          categoryId: inactiveCategory.id,
          editionNumber: 9,
        }),
      ],
    });

    expect(deriveGuideCoverEditorState(withInactivePublished, [category])).toMatchObject({
      phase: "published",
      selectedCategory: inactiveCategory,
      workingCover: { revision: 8, categoryId: inactiveCategory.id },
      previewEditionNumber: 9,
    });
  });

  it("does not turn a retired server cover into a local conflict phase", () => {
    const withRetired = response({ coverVersions: [cover({ status: "retired" })] });

    expect(deriveGuideCoverEditorState(withRetired, [category])).toMatchObject({
      phase: "not_configured",
      workingCover: null,
    });
  });
});

describe("copyFromCategory", () => {
  it("returns the registered example copy for a built-in category", () => {
    expect(copyFromCategory(category)).toEqual({
      headline: "Bedtime can feel softer",
      supportingLine: "A calmer bedtime, one small shift at a time.",
      closingLine: "Prepared for calmer evenings.",
      alternativeDescription:
        "Blush TinySoho sleep guide cover with a moonlit house illustration.",
    });
  });

  it("provides bounded deterministic copy for a category without a registered example", () => {
    const customCategory = { ...category, slug: "travel", name: "Travel" };

    expect(copyFromCategory(customCategory)).toEqual({
      headline: "Travel",
      supportingLine: "A simple guide for calmer family moments.",
      closingLine: "Made with care by TinySoho.",
      alternativeDescription: "A warm editorial TinySoho guide cover.",
    });
  });
});
