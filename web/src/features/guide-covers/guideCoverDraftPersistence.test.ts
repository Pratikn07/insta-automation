import { describe, expect, it } from "vitest";

import {
  buildDraftSaveIntent,
  classifyPatchReconciliation,
  copyFromCover,
  mergeCreateSuccess,
  type GuideCoverEditorModel,
} from "./guideCoverDraftPersistence";
import type { ResourceCoverVersion } from "./types";

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
