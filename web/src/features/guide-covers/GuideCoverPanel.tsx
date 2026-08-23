import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiErrorCode, apiMutation, apiRead } from "@/lib/api";
import { useOperationId } from "@/lib/useOperationId";
import {
  GUIDE_COVER_TEXT_RULES,
  validateGuideCoverDraft,
} from "@shared/guideCoverPolicy";

import { copyFromCategory } from "./guideCoverEditorState";
import {
  copyMatches,
  createInitialGuideCoverEditor,
  type GuideCoverEditorModel,
} from "./guideCoverDraftPersistence";
import { lifecyclePendingLabel } from "./guideCoverLifecycle";
import { GuideCoverPreview } from "./GuideCoverPreview.tsx";
import { PresentationCategoryPicker } from "./PresentationCategoryPicker";
import { useGuideCoverDraftPersistence } from "./useGuideCoverDraftPersistence";
import { useGuideCoverLifecycle } from "./useGuideCoverLifecycle";
import type {
  GuideCoverCopy,
  GuideCoverPreviewStatus,
  GuideCoverSuggestionResponse,
  PresentationCategory,
  PresentationCategoriesResponse,
  ResourcePresentationResponse,
} from "./types";

export interface GuideCoverPanelProps {
  resourceId: string;
  resourceName: string;
}

function statusLabel(status: GuideCoverEditorModel["status"]): string {
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

function isAuthoringDisabled(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    apiErrorCode(error) === "guide_cover_authoring_disabled"
  );
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
    isAuthoringDisabled(categoriesQuery.error) ||
    isAuthoringDisabled(presentationQuery.error);
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
  const [editor, setEditor] = useState<GuideCoverEditorModel>(() =>
    createInitialGuideCoverEditor(resourceId, categories, presentation),
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<GuideCoverPreviewStatus>("loading");
  const { operationId: suggestionOperationId, renew: renewSuggestionOperationId } =
    useOperationId();

  const selectedCategory =
    categories.find((category) => category.id === editor.categoryId) ?? null;
  const copyIsValid = validateGuideCoverDraft(editor.copy).ok;
  const isDirty =
    !editor.savedCopy ||
    editor.categoryId !== editor.savedCategoryId ||
    !copyMatches(editor.copy, editor.savedCopy);
  const savePrerequisitesMet = Boolean(
    selectedCategory?.designStatus === "ready" &&
      copyIsValid &&
      isDirty,
  );
  const {
    isReconciling,
    isSaving,
    pendingCreate,
    pendingPatch,
    reconcilePatch,
    saveDraft,
  } = useGuideCoverDraftPersistence({
    resourceId,
    editor,
    savePrerequisitesMet,
    setEditor,
    setError,
    setNotice,
    setHasConflict,
    refetchPresentation,
  });
  const hasSavedDraft = Boolean(
    editor.coverId &&
      editor.revision &&
      (editor.status === "draft" || editor.status === "approved"),
  );
  const lifecyclePrerequisitesMet = Boolean(
    hasSavedDraft &&
      !isDirty &&
      selectedCategory?.designStatus === "ready" &&
      previewStatus === "ready" &&
      !hasConflict &&
      !pendingPatch &&
      !isSuggesting &&
      !isSaving &&
      !isReconciling &&
      !pendingCreate,
  );
  const {
    approveAndPublish,
    checkLifecycleStatus,
    isCheckingLifecycle,
    lifecycleStage,
    pendingLifecycle,
    publicationFailed,
  } = useGuideCoverLifecycle({
    resourceId,
    editor,
    canStartLifecycle: lifecyclePrerequisitesMet,
    setEditor,
    setError,
    setNotice,
    refetchPresentation,
  });
  const isLifecycleBusy = lifecycleStage !== null || isCheckingLifecycle;
  const editorBusy = isSuggesting || isSaving || isReconciling || isLifecycleBusy;
  const canSuggest = !editorBusy && !pendingPatch && !pendingLifecycle;
  const canSave = Boolean(
    (pendingCreate || savePrerequisitesMet) &&
      !isSuggesting &&
      !isSaving &&
      !pendingPatch &&
      !isReconciling &&
      !isLifecycleBusy &&
      !pendingLifecycle,
  );
  const canPublish =
    lifecyclePrerequisitesMet && !isLifecycleBusy && !pendingLifecycle;

  const activeEditor = editor;

  function updateCopy(field: keyof GuideCoverCopy, value: string) {
    setEditor((current) =>
      current ? { ...current, copy: { ...current.copy, [field]: value } } : current,
    );
    setError(null);
    setNotice(null);
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
            : pendingLifecycle
              ? lifecyclePendingLabel(pendingLifecycle)
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
            : pendingCreate
              ? "Retry draft creation"
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
        {pendingLifecycle && (
          <Button
            type="button"
            variant="outline"
            disabled={isCheckingLifecycle || isLifecycleBusy}
            onClick={() => void checkLifecycleStatus()}
          >
            {isCheckingLifecycle
              ? `Checking ${pendingLifecycle.stage} status…`
              : pendingLifecycle.stage === "approval"
                ? "Check approval status"
                : "Check publication status"}
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
    required: true,
    disabled,
    "aria-describedby": countId,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const nextValue = event.target.value;
      if ([...nextValue].length <= maximum) onChange(nextValue);
    },
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
