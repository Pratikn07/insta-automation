import { getGuideCoverCategory } from "@shared/guideCoverRegistry";

import type {
  DerivedGuideCoverEditorState,
  GuideCoverCopy,
  PresentationCategory,
  ResourcePresentationResponse,
} from "./types";

export function deriveGuideCoverEditorState(
  response: ResourcePresentationResponse,
  categories: PresentationCategory[],
): DerivedGuideCoverEditorState {
  const selectedCategory =
    categories.find((category) => category.id === response.presentation?.categoryId) ?? null;
  const workingCover =
    response.coverVersions.find((cover) => cover.status === "draft" || cover.status === "approved") ??
    response.coverVersions.find((cover) => cover.status === "published") ??
    null;

  return {
    selectedCategory,
    workingCover,
    phase: workingCover?.status === "draft" || workingCover?.status === "approved"
      ? workingCover.status
      : workingCover?.status === "published"
        ? "published"
        : "not_configured",
    previewEditionNumber:
      response.presentation?.editionNumber ?? selectedCategory?.nextEditionNumber ?? 1,
  };
}

export function copyFromCategory(category: PresentationCategory): GuideCoverCopy {
  const registered = getGuideCoverCategory(category.slug);
  if (registered) return { ...registered.exampleCopy };

  return {
    headline: category.name,
    supportingLine: "A simple guide for calmer family moments.",
    closingLine: "Made with care by TinySoho.",
    alternativeDescription: "A warm editorial TinySoho guide cover.",
  };
}
