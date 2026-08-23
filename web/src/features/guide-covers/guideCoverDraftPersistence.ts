import { copyFromCategory, deriveGuideCoverEditorState } from "./guideCoverEditorState";
import type {
  GuideCoverCopy,
  PresentationCategory,
  ResourceCoverStatus,
  ResourceCoverVersion,
  ResourcePresentationResponse,
} from "./types";

export interface GuideCoverEditorModel {
  resourceId: string;
  categoryId: string | null;
  copy: GuideCoverCopy;
  suggestionId: string | null;
  coverId: string | null;
  revision: number | null;
  status: ResourceCoverStatus | "not_configured";
  savedCategoryId: string | null;
  savedCopy: GuideCoverCopy | null;
}

export interface CreateDraftIntent {
  kind: "create";
  operationId: string;
  body: {
    id: string;
    categoryId: string;
    suggestionId: string | null;
    copy: GuideCoverCopy;
  };
}

export interface PatchDraftIntent {
  kind: "patch";
  coverId: string;
  expectedRevision: number;
  intendedCopy: GuideCoverCopy;
  previousCopy: GuideCoverCopy;
}

export type DraftSaveIntent = CreateDraftIntent | PatchDraftIntent;
export type PatchReconciliation = "saved" | "unchanged" | "conflict";

const EMPTY_COPY: GuideCoverCopy = {
  headline: "",
  supportingLine: "",
  closingLine: "",
  alternativeDescription: "",
};

export function copyFromCover(cover: ResourceCoverVersion): GuideCoverCopy {
  return {
    headline: cover.headline,
    supportingLine: cover.supportingLine,
    closingLine: cover.closingLine,
    alternativeDescription: cover.alternativeDescription,
  };
}

export function copyMatches(left: GuideCoverCopy, right: GuideCoverCopy): boolean {
  return (
    left.headline === right.headline &&
    left.supportingLine === right.supportingLine &&
    left.closingLine === right.closingLine &&
    left.alternativeDescription === right.alternativeDescription
  );
}

export function createInitialGuideCoverEditor(
  resourceId: string,
  categories: PresentationCategory[],
  presentation: ResourcePresentationResponse,
): GuideCoverEditorModel {
  const derived = deriveGuideCoverEditorState(presentation, categories);
  const selectedCategory =
    derived.selectedCategory ??
    categories.find((category) => category.designStatus === "ready") ??
    categories[0] ??
    null;
  const workingCover = derived.workingCover;

  return {
    resourceId,
    categoryId: selectedCategory?.id ?? null,
    copy: workingCover
      ? copyFromCover(workingCover)
      : selectedCategory
        ? copyFromCategory(selectedCategory)
        : EMPTY_COPY,
    suggestionId: workingCover?.suggestionId ?? null,
    coverId: workingCover?.id ?? null,
    revision: workingCover?.revision ?? null,
    status: workingCover?.status ?? "not_configured",
    savedCategoryId: workingCover?.categoryId ?? null,
    savedCopy: workingCover ? copyFromCover(workingCover) : null,
  };
}

export function buildDraftSaveIntent(
  editor: GuideCoverEditorModel,
  createOperationId: string,
): DraftSaveIntent {
  const canPatch =
    editor.status === "draft" &&
    editor.coverId !== null &&
    editor.revision !== null &&
    editor.categoryId === editor.savedCategoryId;

  if (canPatch) {
    return {
      kind: "patch",
      coverId: editor.coverId!,
      expectedRevision: editor.revision!,
      intendedCopy: { ...editor.copy },
      previousCopy: { ...(editor.savedCopy ?? editor.copy) },
    };
  }

  if (!editor.categoryId) throw new Error("A presentation category is required");
  return {
    kind: "create",
    operationId: createOperationId,
    body: {
      id: createOperationId,
      categoryId: editor.categoryId,
      suggestionId: editor.suggestionId,
      copy: { ...editor.copy },
    },
  };
}

export function mergeCreateSuccess(
  current: GuideCoverEditorModel,
  cover: ResourceCoverVersion,
  intent: CreateDraftIntent,
): GuideCoverEditorModel {
  const currentStillMatchesIntent =
    current.categoryId === intent.body.categoryId &&
    current.suggestionId === intent.body.suggestionId &&
    copyMatches(current.copy, intent.body.copy);

  return {
    ...current,
    ...(currentStillMatchesIntent
      ? {
          categoryId: cover.categoryId,
          copy: copyFromCover(cover),
          suggestionId: cover.suggestionId,
        }
      : {}),
    coverId: cover.id,
    revision: cover.revision,
    status: cover.status,
    savedCategoryId: cover.categoryId,
    savedCopy: copyFromCover(cover),
  };
}

export function classifyPatchReconciliation(
  canonical: ResourceCoverVersion | undefined,
  attempt: PatchDraftIntent,
): PatchReconciliation {
  if (!canonical) return "conflict";
  if (copyMatches(copyFromCover(canonical), attempt.intendedCopy)) return "saved";
  if (
    canonical.revision === attempt.expectedRevision &&
    copyMatches(copyFromCover(canonical), attempt.previousCopy)
  ) {
    return "unchanged";
  }
  return "conflict";
}
