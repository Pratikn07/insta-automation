/** The design direction that can be selected from the category API. */
export type PresentationCategoryDesignStatus = "ready" | "needs_review" | "inactive";

export interface PresentationCategory {
  id: string;
  slug: string;
  name: string;
  collectionLabel: string;
  defaultKicker: string;
  templateKey: string;
  paletteKey: string;
  illustrationKey: string;
  designStatus: PresentationCategoryDesignStatus;
  nextEditionNumber: number;
  sortOrder: number | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ResourceCoverStatus = "draft" | "approved" | "published" | "retired";
export type ResourceCoverRenderStatus = "not_rendered" | "rendering" | "ready" | "failed";

export interface ResourcePresentation {
  resourceId: string;
  categoryId: string;
  editionNumber: number | null;
  createdAt: string;
  updatedAt: string;
  /** Included by the presentation read endpoint; kept optional for compact API fixtures. */
  category?: PresentationCategory | null;
}

export interface ResourceCoverVersion {
  id: string;
  resourceId: string;
  revision: number;
  status: ResourceCoverStatus;
  renderStatus: ResourceCoverRenderStatus;
  categoryId: string;
  editionNumber: number | null;
  templateKey: string;
  paletteKey: string;
  illustrationKey: string;
  kicker: string;
  collectionLabel: string;
  headline: string;
  supportingLine: string;
  closingLine: string;
  alternativeDescription: string;
  suggestionId: string | null;
  contentHash: string | null;
  dmStoragePath: string | null;
  genericStoragePath: string | null;
  renderErrorCode: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResourcePresentationResponse {
  presentation: ResourcePresentation | null;
  coverVersions: ResourceCoverVersion[];
}

export interface PresentationCategoriesResponse {
  categories: PresentationCategory[];
}

/** Copy fields editable by a creator; category-owned kicker/label are excluded. */
export interface GuideCoverCopy {
  headline: string;
  supportingLine: string;
  closingLine: string;
  alternativeDescription: string;
}

export interface GuideCoverSuggestionResponse {
  replayed: boolean;
  suggestion: { id: string };
  draft: GuideCoverCopy & {
    categoryId: string;
    templateKey: string;
    paletteKey: string;
    illustrationKey: string;
  };
}

export interface GuideCoverDraftResponse {
  cover: ResourceCoverVersion;
  replayed?: boolean;
}

export type GuideCoverPreviewStatus = "loading" | "ready" | "invalid" | "unavailable";

export type GuideCoverEditorPhase = "not_configured" | "draft" | "approved" | "published";

export interface DerivedGuideCoverEditorState {
  selectedCategory: PresentationCategory | null;
  workingCover: ResourceCoverVersion | null;
  phase: GuideCoverEditorPhase;
  previewEditionNumber: number;
}
