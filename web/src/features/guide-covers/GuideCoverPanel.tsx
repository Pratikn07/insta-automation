import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorCode, apiMutation, apiRead } from "@/lib/api";
import { isUnknownOutcome } from "@/lib/unknownOutcome";
import { useOperationId } from "@/lib/useOperationId";
import {
  GUIDE_COVER_TEXT_RULES,
  validateGuideCoverDraft,
} from "@shared/guideCoverPolicy";

import { copyFromCategory, deriveGuideCoverEditorState } from "./guideCoverEditorState";
import { GuideCoverPreview } from "./GuideCoverPreview.tsx";
import { PresentationCategoryPicker } from "./PresentationCategoryPicker";
import type {
  GuideCoverCopy,
  GuideCoverDraftResponse,
  GuideCoverPreviewStatus,
  GuideCoverSuggestionResponse,
  PresentationCategory,
  PresentationCategoriesResponse,
  ResourceCoverStatus,
  ResourceCoverVersion,
  ResourcePresentationResponse,
} from "./types";

export interface GuideCoverPanelProps {
  resourceId: string;
  resourceName: string;
}

interface LocalEditor {
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

interface PendingPatch {
  coverId: string;
  expectedRevision: number;
  intendedCopy: GuideCoverCopy;
  previousCopy: GuideCoverCopy;
}

const EMPTY_COPY: GuideCoverCopy = {
  headline: "",
  supportingLine: "",
  closingLine: "",
  alternativeDescription: "",
};

function copyFromCover(cover: ResourceCoverVersion): GuideCoverCopy {
  return {
    headline: cover.headline,
    supportingLine: cover.supportingLine,
    closingLine: cover.closingLine,
    alternativeDescription: cover.alternativeDescription,
  };
}

function copyMatches(left: GuideCoverCopy, right: GuideCoverCopy): boolean {
  return (
    left.headline === right.headline &&
    left.supportingLine === right.supportingLine &&
    left.closingLine === right.closingLine &&
    left.alternativeDescription === right.alternativeDescription
  );
}

function statusLabel(status: LocalEditor["status"]): string {
  switch (status) {
    case "not_configured":
      return "Not configured";
    case "draft":
      return "Draft";
    case "approved":
      return "Approved";
    case "published":
      return "Published";
    case "retired":
      return "Not configured";
  }
}

function initialEditor(
  resourceId: string,
  categories: PresentationCategory[],
  presentation: ResourcePresentationResponse,
): LocalEditor {
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

export function GuideCoverPanel({ resourceId, resourceName }: GuideCoverPanelProps) {
  const categoriesQuery = useQuery<PresentationCategoriesResponse>({
    queryKey: ["presentation-categories"],
    queryFn: ({ signal }) =>
      apiRead<PresentationCategoriesResponse>("/presentation-categories", { signal }),
    retry: false,
  });
  const presentationQuery = useQuery<ResourcePresentationResponse>({
    queryKey: ["resource-presentation", resourceId],
    queryFn: ({ signal }) =>
      apiRead<ResourcePresentationResponse>(`/resources/${resourceId}/presentation`, { signal }),
    retry: false,
  });
  const disabled =
    apiErrorCode(categoriesQuery.error) === "guide_cover_authoring_disabled" ||
    apiErrorCode(presentationQuery.error) === "guide_cover_authoring_disabled";
  const readFailed =
    (categoriesQuery.isError && !categoriesQuery.data) ||
    (presentationQuery.isError && !presentationQuery.data);
  const isLoading = categoriesQuery.isLoading || presentationQuery.isLoading;

  if (disabled) return null;

  if (readFailed) {
    return (
      <section aria-label="Presentation and cover" className="rounded-xl border bg-card p-5">
        <p role="alert" className="text-sm text-destructive">
          Could not load the cover editor.
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-3"
          aria-label="Retry cover editor"
          onClick={() => {
            void categoriesQuery.refetch();
            void presentationQuery.refetch();
          }}
        >
          Retry
        </Button>
      </section>
    );
  }

  if (isLoading || !categoriesQuery.data || !presentationQuery.data) {
    return (
      <section
        aria-label="Presentation and cover"
        aria-busy="true"
        className="rounded-xl border bg-card p-5"
      >
        <p className="text-sm text-muted-foreground">Loading presentation and cover…</p>
      </section>
    );
  }

  return (
    <GuideCoverEditor
      key={resourceId}
      resourceId={resourceId}
      resourceName={resourceName}
      categories={categoriesQuery.data.categories}
      presentation={presentationQuery.data}
      refetchPresentation={() => presentationQuery.refetch()}
    />
  );
}

interface GuideCoverEditorProps extends GuideCoverPanelProps {
  categories: PresentationCategory[];
  presentation: ResourcePresentationResponse;
  refetchPresentation: () => Promise<{
    data?: ResourcePresentationResponse;
    isError: boolean;
  }>;
}

function GuideCoverEditor({
  resourceId,
  resourceName,
  categories,
  presentation,
  refetchPresentation,
}: GuideCoverEditorProps) {
  const [editor, setEditor] = useState<LocalEditor>(() =>
    initialEditor(resourceId, categories, presentation),
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<GuideCoverPreviewStatus>("loading");
  const [lifecycleStage, setLifecycleStage] = useState<"approving" | "publishing" | null>(
    null,
  );
  const [publicationFailed, setPublicationFailed] = useState(false);
  const { operationId: suggestionOperationId, renew: renewSuggestionOperationId } =
    useOperationId();
  const { operationId: createOperationId, renew: renewCreateOperationId } = useOperationId();

  const selectedCategory =
    categories.find((category) => category.id === editor.categoryId) ?? null;
  const copyIsValid = validateGuideCoverDraft(editor.copy).ok;
  const isDirty =
    !editor.savedCopy ||
    editor.categoryId !== editor.savedCategoryId ||
    !copyMatches(editor.copy, editor.savedCopy);
  const isLifecycleBusy = lifecycleStage !== null;
  const editorBusy = isSuggesting || isSaving || isReconciling || isLifecycleBusy;
  const canSuggest = !editorBusy && !pendingPatch;
  const canSave = Boolean(
    selectedCategory?.designStatus === "ready" &&
      copyIsValid &&
      isDirty &&
      !isSuggesting &&
      !isSaving &&
      !pendingPatch &&
      !isReconciling &&
      !isLifecycleBusy,
  );
  const hasSavedDraft = Boolean(
    editor.coverId &&
      editor.revision &&
      (editor.status === "draft" || editor.status === "approved"),
  );
  const canPublish = Boolean(
    hasSavedDraft &&
      !isDirty &&
      selectedCategory?.designStatus === "ready" &&
      previewStatus === "ready" &&
      !hasConflict &&
      !pendingPatch &&
      !isSuggesting &&
      !isSaving &&
      !isReconciling &&
      !isLifecycleBusy,
  );

  const activeEditor = editor;

  function updateCopy(field: keyof GuideCoverCopy, value: string) {
    setEditor((current) =>
      current ? { ...current, copy: { ...current.copy, [field]: value } } : current,
    );
    setError(null);
    setNotice(null);
  }

  function moveToConflict(message: string) {
    setEditor((current) =>
      current
        ? {
            ...current,
            coverId: null,
            revision: null,
            savedCategoryId: null,
            savedCopy: null,
            status: "not_configured",
          }
        : current,
    );
    setPendingPatch(null);
    setHasConflict(true);
    setNotice(null);
    setError(message);
  }

  async function reconcilePatch(attempt: PendingPatch) {
    setIsReconciling(true);
    try {
      const result = await refetchPresentation();
      if (result.isError || !result.data) {
        setPendingPatch(attempt);
        setError(
          "Still confirming whether the draft save went through. Check save status before retrying.",
        );
        return;
      }

      const canonical = result.data.coverVersions.find(
        (candidate) => candidate.id === attempt.coverId,
      );
      if (canonical && copyMatches(copyFromCover(canonical), attempt.intendedCopy)) {
        setEditor((current) =>
          current
            ? {
                ...current,
                coverId: canonical.id,
                revision: canonical.revision,
                status: canonical.status,
                savedCategoryId: canonical.categoryId,
                savedCopy: copyFromCover(canonical),
              }
            : current,
        );
        setPendingPatch(null);
        setHasConflict(false);
        setError(null);
        setNotice("Draft saved");
        return;
      }

      if (
        canonical &&
        canonical.revision === attempt.expectedRevision &&
        copyMatches(copyFromCover(canonical), attempt.previousCopy)
      ) {
        setPendingPatch(null);
        setError("The server draft is unchanged. It is safe to retry this save.");
        return;
      }

      moveToConflict(
        "A newer version exists. Your local copy is preserved; save it as a new draft.",
      );
    } finally {
      setIsReconciling(false);
    }
  }

  async function suggest() {
    if (!canSuggest) return;
    setError(null);
    setNotice(null);
    setIsSuggesting(true);
    try {
      const response = await apiMutation<GuideCoverSuggestionResponse>(
        `/resources/${resourceId}/cover-suggestions`,
        {
          method: "POST",
          operationId: suggestionOperationId,
          body: JSON.stringify({
            id: suggestionOperationId,
            selectedCategoryId: activeEditor.categoryId,
          }),
        },
      );
      const suggestedCategory = categories.find(
        (category) => category.id === response.draft.categoryId,
      );
      if (!suggestedCategory) {
        setError("The suggested presentation category is no longer available.");
        return;
      }
      setEditor((current) =>
        current
          ? {
              ...current,
              categoryId: suggestedCategory.id,
              suggestionId: response.suggestion.id,
              copy: {
                headline: response.draft.headline,
                supportingLine: response.draft.supportingLine,
                closingLine: response.draft.closingLine,
                alternativeDescription: response.draft.alternativeDescription,
              },
            }
          : current,
      );
      renewSuggestionOperationId();
    } catch {
      // Preserve both the UUID and the current local copy so this exact intent is replayable.
      setError("Could not get a suggestion. Retry to check the same suggestion request.");
    } finally {
      setIsSuggesting(false);
    }
  }

  async function saveDraft() {
    if (!canSave || !selectedCategory) return;
    setError(null);
    setNotice(null);
    setIsSaving(true);
    const existingCoverId =
      activeEditor.status === "draft" && activeEditor.coverId && activeEditor.revision
        ? activeEditor.coverId
        : null;
    const expectedRevision = existingCoverId ? activeEditor.revision : null;
    const isExistingDraft = existingCoverId !== null && expectedRevision !== null;
    const attempt: PendingPatch | null = isExistingDraft
      ? {
          coverId: existingCoverId,
          expectedRevision,
          intendedCopy: { ...activeEditor.copy },
          previousCopy: { ...(activeEditor.savedCopy ?? activeEditor.copy) },
        }
      : null;
    try {
      const response = isExistingDraft
        ? await apiMutation<GuideCoverDraftResponse>(
            `/resources/${resourceId}/cover-versions/${existingCoverId}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                expectedRevision,
                copy: activeEditor.copy,
              }),
            },
          )
        : await apiMutation<GuideCoverDraftResponse>(`/resources/${resourceId}/cover-versions`, {
            method: "POST",
            operationId: createOperationId,
            body: JSON.stringify({
              id: createOperationId,
              categoryId: selectedCategory.id,
              suggestionId: activeEditor.suggestionId,
              copy: activeEditor.copy,
            }),
          });
      setEditor((current) =>
        current
          ? {
              ...current,
              categoryId: response.cover.categoryId,
              copy: copyFromCover(response.cover),
              suggestionId: response.cover.suggestionId,
              coverId: response.cover.id,
              revision: response.cover.revision,
              status: "draft",
              savedCategoryId: response.cover.categoryId,
              savedCopy: copyFromCover(response.cover),
            }
          : current,
      );
      if (!isExistingDraft) renewCreateOperationId();
      setPendingPatch(null);
      setHasConflict(false);
      setNotice("Draft saved");
      void refetchPresentation();
    } catch (saveError) {
      if (apiErrorCode(saveError) === "cover_revision_conflict") {
        await refetchPresentation();
        moveToConflict(
          "A newer version exists. Your local copy is preserved; save it as a new draft.",
        );
      } else if (attempt && isUnknownOutcome(saveError)) {
        setPendingPatch(attempt);
        await reconcilePatch(attempt);
      } else {
        setError("Could not save the cover draft. Your local copy is still here.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function approveAndPublish() {
    if (!canPublish || !activeEditor.coverId || !activeEditor.revision) return;
    const coverId = activeEditor.coverId;
    const expectedRevision = activeEditor.revision;
    let approved = activeEditor.status === "approved";

    setError(null);
    setNotice(null);
    setPublicationFailed(false);
    if (!approved) {
      setLifecycleStage("approving");
      try {
        await apiMutation(`/resources/${resourceId}/cover-versions/${coverId}/approve`, {
          method: "POST",
          body: JSON.stringify({ expectedRevision }),
        });
        approved = true;
        setEditor((current) => (current ? { ...current, status: "approved" } : current));
      } catch (approvalError) {
        if (!isUnknownOutcome(approvalError)) {
          setError("Could not approve this cover. The previous published cover is unchanged.");
          setLifecycleStage(null);
          return;
        }

        const result = await refetchPresentation();
        const canonical = result.isError
          ? null
          : result.data?.coverVersions.find(
              (candidate) =>
                candidate.id === coverId && candidate.revision === expectedRevision,
            ) ?? null;
        if (canonical?.status === "published") {
          setEditor((current) => (current ? { ...current, status: "published" } : current));
          setNotice("Cover published");
          setLifecycleStage(null);
          return;
        }
        if (canonical?.status !== "approved") {
          setError(
            canonical?.status === "draft"
              ? "Approval did not complete. The saved draft is unchanged and can be retried."
              : "Still confirming whether approval went through. Nothing has been retried.",
          );
          setLifecycleStage(null);
          return;
        }

        approved = true;
        setEditor((current) => (current ? { ...current, status: "approved" } : current));
      }
    }

    if (!approved) return;
    setLifecycleStage("publishing");
    try {
      await apiMutation(`/resources/${resourceId}/cover-versions/${coverId}/publish`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision }),
      });
      setEditor((current) => (current ? { ...current, status: "published" } : current));
      setPublicationFailed(false);
      setNotice("Cover published");
      void refetchPresentation();
    } catch (publishError) {
      setEditor((current) => (current ? { ...current, status: "approved" } : current));
      setPublicationFailed(true);

      if (isUnknownOutcome(publishError)) {
        const result = await refetchPresentation();
        const canonical = result.isError
          ? null
          : result.data?.coverVersions.find(
              (candidate) =>
                candidate.id === coverId && candidate.revision === expectedRevision,
            ) ?? null;
        if (canonical?.status === "published") {
          setEditor((current) => (current ? { ...current, status: "published" } : current));
          setPublicationFailed(false);
          setError(null);
          setNotice("Cover published");
        } else if (canonical?.status === "approved") {
          setError(
            "Cover is Approved, and the canonical check shows publication did not complete. The previous published cover is unchanged; retry publication when ready.",
          );
        } else {
          setError(
            "Cover is Approved, but publication is still being confirmed. Retrying will reconcile this same cover revision.",
          );
        }
      } else {
        setPublicationFailed(true);
        setError(
          "Cover is Approved, but publication failed. The previous published cover is unchanged; retry publication when ready.",
        );
      }
    } finally {
      setLifecycleStage(null);
    }
  }

  return (
    <section
      aria-label="Presentation and cover"
      aria-busy={isSuggesting || isSaving || isReconciling || isLifecycleBusy}
      className="space-y-5 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Presentation &amp; cover</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Review the cover for {resourceName}. Nothing is saved until you choose save.
          </p>
        </div>
        <p role="status" className="rounded-full border px-2.5 py-1 text-xs font-medium">
          {hasConflict
            ? "Needs attention"
            : isLifecycleBusy
              ? "Publishing"
              : statusLabel(activeEditor.status)}
        </p>
      </div>

      <PresentationCategoryPicker
        categories={categories}
        disabled={editorBusy}
        onSelect={(categoryId) => {
          if (editorBusy) return;
          const category = categories.find((candidate) => candidate.id === categoryId);
          if (!category) return;
          setEditor((current) =>
            current
              ? {
                  ...current,
                  categoryId,
                  copy: copyFromCategory(category),
                  suggestionId: null,
                }
              : current,
          );
          setError(null);
          setNotice(null);
        }}
      />

      {selectedCategory && (
        <div className="rounded-lg bg-muted p-3 text-sm">
          <p><span className="font-medium">Kicker:</span> {selectedCategory.defaultKicker}</p>
          <p><span className="font-medium">Collection:</span> {selectedCategory.collectionLabel}</p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-4">
          <CoverField
            id="guide-cover-headline"
            label="Cover headline"
            value={activeEditor.copy.headline}
            maximum={GUIDE_COVER_TEXT_RULES.headline.maxCodePoints}
            disabled={editorBusy}
            onChange={(value) => updateCopy("headline", value)}
          />
          <CoverField
            id="guide-cover-supporting-line"
            label="Supporting line"
            value={activeEditor.copy.supportingLine}
            maximum={GUIDE_COVER_TEXT_RULES.supportingLine.maxCodePoints}
            disabled={editorBusy}
            onChange={(value) => updateCopy("supportingLine", value)}
          />
          <CoverField
            id="guide-cover-closing-line"
            label="Closing line"
            value={activeEditor.copy.closingLine}
            maximum={GUIDE_COVER_TEXT_RULES.closingLine.maxCodePoints}
            disabled={editorBusy}
            onChange={(value) => updateCopy("closingLine", value)}
          />
          <CoverField
            id="guide-cover-alternative-description"
            label="Alternative description"
            value={activeEditor.copy.alternativeDescription}
            maximum={GUIDE_COVER_TEXT_RULES.alternativeDescription.maxCodePoints}
            disabled={editorBusy}
            multiline
            onChange={(value) => updateCopy("alternativeDescription", value)}
          />

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={!canSuggest} onClick={() => void suggest()}>
              {isSuggesting ? "Suggesting…" : "Suggest from guide"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!selectedCategory || editorBusy}
              onClick={() => {
                if (!selectedCategory) return;
                setEditor((current) =>
                  current
                    ? { ...current, copy: copyFromCategory(selectedCategory), suggestionId: null }
                    : current,
                );
                setError(null);
                setNotice(null);
              }}
            >
              Reset to category defaults
            </Button>
          </div>
        </div>

        <div>
          {selectedCategory ? (
            <GuideCoverPreview
              category={selectedCategory}
              copy={activeEditor.copy}
              editionNumber={
                presentation.presentation?.editionNumber ?? selectedCategory.nextEditionNumber
              }
              onStatusChange={setPreviewStatus}
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Select a presentation category to preview the cover.
            </p>
          )}
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}

      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button type="button" disabled={!canSave} onClick={() => void saveDraft()}>
          {isSaving
            ? "Saving cover draft…"
            : hasConflict
              ? "Save as new draft"
              : "Save cover draft"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!canPublish}
          onClick={() => void approveAndPublish()}
        >
          {lifecycleStage === "approving"
            ? "Approving cover…"
            : lifecycleStage === "publishing"
              ? "Publishing cover…"
              : publicationFailed
                ? "Retry publish"
                : activeEditor.status === "approved"
                  ? "Publish approved cover"
                  : "Approve and publish"}
        </Button>
        {pendingPatch && (
          <Button
            type="button"
            variant="outline"
            disabled={isReconciling || isSaving}
            onClick={() => void reconcilePatch(pendingPatch)}
          >
            {isReconciling ? "Checking save status…" : "Check save status"}
          </Button>
        )}
      </div>
    </section>
  );
}

function CoverField({
  id,
  label,
  value,
  maximum,
  multiline = false,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  maximum: number;
  multiline?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const countId = `${id}-count`;
  const inputProps = {
    id,
    value,
    maxLength: maximum,
    required: true,
    disabled,
    "aria-describedby": countId,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value),
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <span id={countId} className="text-xs text-muted-foreground" aria-live="polite">
          {[...value].length} / {maximum}
        </span>
      </div>
      {multiline ? <Textarea {...inputProps} /> : <Input {...inputProps} />}
    </div>
  );
}
