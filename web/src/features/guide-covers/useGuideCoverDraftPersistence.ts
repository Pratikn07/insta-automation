import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";

import { apiErrorCode, apiMutation } from "@/lib/api";
import { isUnknownOutcome } from "@/lib/unknownOutcome";
import { useOperationId } from "@/lib/useOperationId";

import {
  buildDraftSaveIntent,
  classifyPatchReconciliation,
  copyFromCover,
  copyMatches,
  mergeCreateSuccess,
  type CreateDraftIntent,
  type GuideCoverEditorModel,
  type PatchDraftIntent,
} from "./guideCoverDraftPersistence";
import type {
  GuideCoverDraftResponse,
  ResourcePresentationResponse,
} from "./types";

interface PresentationRefetchResult {
  data?: ResourcePresentationResponse;
  isError: boolean;
}

interface UseGuideCoverDraftPersistenceOptions {
  resourceId: string;
  editor: GuideCoverEditorModel;
  savePrerequisitesMet: boolean;
  setEditor: Dispatch<SetStateAction<GuideCoverEditorModel>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setHasConflict: Dispatch<SetStateAction<boolean>>;
  refetchPresentation: () => Promise<PresentationRefetchResult>;
}

export function useGuideCoverDraftPersistence({
  resourceId,
  editor,
  savePrerequisitesMet,
  setEditor,
  setError,
  setNotice,
  setHasConflict,
  refetchPresentation,
}: UseGuideCoverDraftPersistenceOptions) {
  const [pendingCreate, setPendingCreate] = useState<CreateDraftIntent | null>(null);
  const [pendingPatch, setPendingPatch] = useState<PatchDraftIntent | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { operationId: createOperationId, renew: renewCreateOperationId } = useOperationId();

  function moveToConflict(message: string) {
    setEditor((current) => ({
      ...current,
      coverId: null,
      revision: null,
      savedCategoryId: null,
      savedCopy: null,
      status: "not_configured",
    }));
    setPendingCreate(null);
    setPendingPatch(null);
    setHasConflict(true);
    setNotice(null);
    setError(message);
  }

  async function reconcilePatch(attempt: PatchDraftIntent) {
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
      const outcome = classifyPatchReconciliation(canonical, attempt);
      if (outcome === "saved" && canonical) {
        setEditor((current) => ({
          ...current,
          coverId: canonical.id,
          revision: canonical.revision,
          status: canonical.status,
          savedCategoryId: canonical.categoryId,
          savedCopy: copyFromCover(canonical),
        }));
        setPendingPatch(null);
        setHasConflict(false);
        setError(null);
        setNotice("Draft saved");
        return;
      }

      if (outcome === "unchanged") {
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

  async function saveDraft() {
    if ((!savePrerequisitesMet && !pendingCreate) || pendingPatch) return;
    setError(null);
    setNotice(null);
    setIsSaving(true);

    const intent = pendingCreate ?? buildDraftSaveIntent(editor, createOperationId);
    try {
      const response =
        intent.kind === "patch"
          ? await apiMutation<GuideCoverDraftResponse>(
              `/resources/${resourceId}/cover-versions/${intent.coverId}`,
              {
                method: "PATCH",
                body: JSON.stringify({
                  expectedRevision: intent.expectedRevision,
                  copy: intent.intendedCopy,
                }),
              },
            )
          : await apiMutation<GuideCoverDraftResponse>(
              `/resources/${resourceId}/cover-versions`,
              {
                method: "POST",
                operationId: intent.operationId,
                body: JSON.stringify(intent.body),
              },
            );

      if (intent.kind === "create") {
        const localEditsRemain =
          editor.categoryId !== intent.body.categoryId ||
          editor.suggestionId !== intent.body.suggestionId ||
          !copyMatches(editor.copy, intent.body.copy);
        setEditor((current) => mergeCreateSuccess(current, response.cover, intent));
        setPendingCreate(null);
        renewCreateOperationId();
        setNotice(localEditsRemain ? "Draft saved; newer local edits remain unsaved." : "Draft saved");
      } else {
        setEditor((current) => ({
          ...current,
          categoryId: response.cover.categoryId,
          copy: copyFromCover(response.cover),
          suggestionId: response.cover.suggestionId,
          coverId: response.cover.id,
          revision: response.cover.revision,
          status: response.cover.status,
          savedCategoryId: response.cover.categoryId,
          savedCopy: copyFromCover(response.cover),
        }));
        setNotice("Draft saved");
      }
      setPendingPatch(null);
      setHasConflict(false);
      void refetchPresentation();
    } catch (saveError) {
      if (apiErrorCode(saveError) === "cover_revision_conflict") {
        await refetchPresentation();
        moveToConflict(
          "A newer version exists. Your local copy is preserved; save it as a new draft.",
        );
      } else if (intent.kind === "patch" && isUnknownOutcome(saveError)) {
        setPendingPatch(intent);
        await reconcilePatch(intent);
      } else if (intent.kind === "create" && isUnknownOutcome(saveError)) {
        setPendingCreate(intent);
        setError(
          "Could not confirm whether the cover draft was created. Retry this exact draft creation.",
        );
      } else {
        setError("Could not save the cover draft. Your local copy is still here.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  return {
    isReconciling,
    isSaving,
    pendingCreate,
    pendingPatch,
    reconcilePatch,
    saveDraft,
  };
}
