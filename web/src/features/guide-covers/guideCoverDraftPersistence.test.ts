import { describe, expect, it } from "vitest";

import {
  buildDraftSaveIntent,
  classifyPatchReconciliation,
  copyFromCover,
  createInitialGuideCoverEditor,
  mergeCreateSuccess,
  type GuideCoverEditorModel,
} from "./guideCoverDraftPersistence";
import type {
  PresentationCategory,
  ResourceCoverVersion,
  ResourcePresentationResponse,
} from "./types";

const copy = {
  headline: "Bedtime can feel softer",
  supportingLine: "A calmer bedtime, one small shift at a time.",
  closingLine: "Prepared for calmer evenings.",
  alternativeDescription: "A blush guide cover with a moonlit house.",
};

function cover(overrides: Partial<ResourceCoverVersion> = {}): ResourceCoverVersion {
  return {
    id: "cover-1",
    resourceId: "resource-1",
    revision: 1,
    status: "draft",
    renderStatus: "not_rendered",
    categoryId: "category-1",
    editionNumber: null,
    templateKey: "template",
    paletteKey: "palette",
    illustrationKey: "illustration",
    kicker: "A TINY WIN",
    collectionLabel: "SLEEP",
    ...copy,
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
  };
}

const bedtime: PresentationCategory = {
  id: "category-1",
  slug: "bedtime",
  name: "Bedtime",
  collectionLabel: "SLEEP",
  defaultKicker: "A TINY WIN FOR TONIGHT",
  templateKey: "warm_editorial_corner_v1",
  paletteKey: "bedtime_blush_v1",
  illustrationKey: "bedtime_window_house_v1",
  designStatus: "ready",
  nextEditionNumber: 9,
  sortOrder: 1,
  createdBy: "creator@tinysoho.com",
  updatedBy: "creator@tinysoho.com",
  createdAt: "2026-08-22T12:00:00.000Z",
  updatedAt: "2026-08-22T12:00:00.000Z",
};

const recipes: PresentationCategory = {
  ...bedtime,
  id: "category-2",
  slug: "recipes",
  name: "Recipes",
  collectionLabel: "RECIPES",
  defaultKicker: "A LITTLE WIN AT THE TABLE",
  sortOrder: 2,
};

function editor(overrides: Partial<GuideCoverEditorModel> = {}): GuideCoverEditorModel {
  return {
    resourceId: "resource-1",
    categoryId: "category-1",
    copy,
    suggestionId: null,
    coverId: "cover-1",
    revision: 1,
    status: "draft",
    savedCategoryId: "category-1",
    savedCopy: copy,
    ...overrides,
  };
}

describe("guide cover draft persistence decisions", () => {
  it("uses PATCH only for the same saved draft category", () => {
    expect(buildDraftSaveIntent(editor(), "create-id")).toEqual({
      kind: "patch",
      coverId: "cover-1",
      expectedRevision: 1,
      intendedCopy: copy,
      previousCopy: copy,
    });
  });

  it("snapshots a category change as an exact new-draft intent", () => {
    const local = editor({
      categoryId: "category-2",
      copy: { ...copy, headline: "Keep this copy" },
      suggestionId: "suggestion-2",
    });

    const intent = buildDraftSaveIntent(local, "create-id");
    local.copy.headline = "A later edit";

    expect(intent).toEqual({
      kind: "create",
      operationId: "create-id",
      body: {
        id: "create-id",
        categoryId: "category-2",
        suggestionId: "suggestion-2",
        copy: { ...copy, headline: "Keep this copy" },
      },
    });
  });

  it("preserves edits made after an uncertain create when replay succeeds", () => {
    const intent = buildDraftSaveIntent(
      editor({ coverId: null, revision: null, status: "not_configured" }),
      "create-id",
    );
    if (intent.kind !== "create") throw new Error("expected create intent");
    const current = editor({
      coverId: null,
      revision: null,
      status: "not_configured",
      copy: { ...copy, headline: "A later edit" },
      savedCategoryId: null,
      savedCopy: null,
    });

    const merged = mergeCreateSuccess(current, cover(), intent);

    expect(merged.copy.headline).toBe("A later edit");
    expect(merged.coverId).toBe("cover-1");
    expect(merged.savedCopy).toEqual(copyFromCover(cover()));
  });

  it("classifies exact, unchanged, and divergent PATCH reconciliation", () => {
    const attempt = {
      kind: "patch" as const,
      coverId: "cover-1",
      expectedRevision: 1,
      intendedCopy: { ...copy, headline: "My edit" },
      previousCopy: copy,
    };

    expect(
      classifyPatchReconciliation(cover({ revision: 2, headline: "My edit" }), attempt),
    ).toBe("saved");
    expect(classifyPatchReconciliation(cover(), attempt)).toBe("unchanged");
    expect(
      classifyPatchReconciliation(cover({ revision: 2, headline: "Their edit" }), attempt),
    ).toBe("conflict");
  });
});

describe("the initial editor for a guide", () => {
  const unconfigured: ResourcePresentationResponse = {
    presentation: null,
    coverVersions: [],
  };

  it("chooses no category and no copy when nothing is configured", () => {
    const initial = createInitialGuideCoverEditor(
      "resource-1",
      [bedtime, recipes],
      unconfigured,
    );

    // The first ready collection in the list is not a choice the creator made. Seeding it
    // would show a category nobody picked and make Save valid before any decision.
    expect(initial.categoryId).toBeNull();
    expect(initial.copy).toEqual({
      headline: "",
      supportingLine: "",
      closingLine: "",
      alternativeDescription: "",
    });
    expect(initial.status).toBe("not_configured");
    expect(initial.savedCategoryId).toBeNull();
    expect(initial.savedCopy).toBeNull();
  });

  it("refuses to build a save intent while no category is chosen", () => {
    const initial = createInitialGuideCoverEditor("resource-1", [bedtime], unconfigured);

    expect(() => buildDraftSaveIntent(initial, "create-id")).toThrow(
      "A presentation category is required",
    );
  });

  it("uses the category the resource is already configured with", () => {
    const initial = createInitialGuideCoverEditor("resource-1", [bedtime, recipes], {
      presentation: {
        resourceId: "resource-1",
        categoryId: recipes.id,
        editionNumber: null,
        createdAt: "2026-08-22T12:00:00.000Z",
        updatedAt: "2026-08-22T12:00:00.000Z",
      },
      coverVersions: [cover({ categoryId: recipes.id })],
    });

    expect(initial.categoryId).toBe(recipes.id);
    expect(initial.copy).toEqual(copy);
    expect(initial.status).toBe("draft");
  });
});
