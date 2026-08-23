import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";

import { apiMutation } from "@/lib/api";
import { isUnknownOutcome } from "@/lib/unknownOutcome";

import type { GuideCoverEditorModel } from "./guideCoverDraftPersistence";
import {
  classifyLifecycleReconciliation,
  type LifecycleReconciliation,
  type PendingLifecycleAttempt,
} from "./guideCoverLifecycle";
import type { ResourcePresentationResponse } from "./types";

interface PresentationRefetchResult {
  data?: ResourcePresentationResponse;
  isError: boolean;
}

interface UseGuideCoverLifecycleOptions {
  resourceId: string;
  editor: GuideCoverEditorModel;
  canStartLifecycle: boolean;
  setEditor: Dispatch<SetStateAction<GuideCoverEditorModel>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  refetchPresentation: () => Promise<PresentationRefetchResult>;
}

export function useGuideCoverLifecycle({
  resourceId,
  editor,
  canStartLifecycle,
  setEditor,
  setError,
  setNotice,
  refetchPresentation,
}: UseGuideCoverLifecycleOptions) {
  const [lifecycleStage, setLifecycleStage] = useState<"approving" | "publishing" | null>(
    null,
  );
  const [pendingLifecycle, setPendingLifecycle] =
    useState<PendingLifecycleAttempt | null>(null);
  const [isCheckingLifecycle, setIsCheckingLifecycle] = useState(false);
  const [publicationFailed, setPublicationFailed] = useState(false);

  function uncertainMessage(attempt: PendingLifecycleAttempt): string {
    return attempt.stage === "approval"
      ? "Approval is still being confirmed. Check approval status before trying another action."
      : "Cover is Approved, but publication is still being confirmed. Check publication status before retrying.";
  }

  async function reconcileLifecycle(
    attempt: PendingLifecycleAttempt,
    continueAfterApproval: boolean,
  ): Promise<LifecycleReconciliation> {
    const result = await refetchPresentation();
    if (result.isError || !result.data) {
      setPendingLifecycle(attempt);
      setError(uncertainMessage(attempt));
      return "unresolved";
    }

    const outcome = classifyLifecycleReconciliation(result.data, attempt);
    if (outcome === "published") {
      setPendingLifecycle(null);
      setPublicationFailed(false);
      setEditor((current) => ({ ...current, status: "published" }));
      setError(null);
      setNotice("Cover published");
      return outcome;
    }

    if (outcome === "approved") {
      setPendingLifecycle(null);
      setEditor((current) => ({ ...current, status: "approved" }));
      if (!continueAfterApproval) {
        setPublicationFailed(attempt.stage === "publication");
        setError(
          attempt.stage === "publication"
            ? "Cover is Approved, and the canonical check shows publication did not complete. The previous published cover is unchanged; retry publication when ready."
            : null,
        );
        setNotice(attempt.stage === "approval" ? "Approval confirmed. Publish when ready." : null);
      }
      return outcome;
    }

    if (outcome === "draft") {
      setPendingLifecycle(null);
      setPublicationFailed(false);
      setEditor((current) => ({ ...current, status: "draft" }));
      setError(
        attempt.stage === "approval"
          ? "Approval did not complete. The saved draft is unchanged and can be retried."
          : "Canonical state changed before publication could be confirmed. Review the saved draft before retrying.",
      );
      return outcome;
    }

    setPendingLifecycle(attempt);
    setError(uncertainMessage(attempt));
    return outcome;
  }

  async function checkLifecycleStatus() {
    if (!pendingLifecycle || isCheckingLifecycle) return;
    setIsCheckingLifecycle(true);
    try {
      await reconcileLifecycle(pendingLifecycle, false);
    } finally {
      setIsCheckingLifecycle(false);
    }
  }

  async function approveAndPublish() {
    if (
      !canStartLifecycle ||
      pendingLifecycle ||
      !editor.coverId ||
      !editor.revision
    ) {
      return;
    }
    const coverId = editor.coverId;
    const expectedRevision = editor.revision;
    let approved = editor.status === "approved";

    setError(null);
    setNotice(null);
    setPublicationFailed(false);
    try {
      if (!approved) {
        setLifecycleStage("approving");
        try {
          await apiMutation(`/resources/${resourceId}/cover-versions/${coverId}/approve`, {
            method: "POST",
            body: JSON.stringify({ expectedRevision }),
          });
          approved = true;
          setEditor((current) => ({ ...current, status: "approved" }));
        } catch (approvalError) {
          if (!isUnknownOutcome(approvalError)) {
            setError("Could not approve this cover. The previous published cover is unchanged.");
            return;
          }

          const attempt: PendingLifecycleAttempt = {
            stage: "approval",
            coverId,
            expectedRevision,
          };
          setPendingLifecycle(attempt);
          const outcome = await reconcileLifecycle(attempt, true);
          if (outcome === "published") return;
          if (outcome !== "approved") return;
          approved = true;
        }
      }

      if (!approved) return;
      setLifecycleStage("publishing");
      try {
        await apiMutation(`/resources/${resourceId}/cover-versions/${coverId}/publish`, {
          method: "POST",
          body: JSON.stringify({ expectedRevision }),
        });
        setPendingLifecycle(null);
        setEditor((current) => ({ ...current, status: "published" }));
        setPublicationFailed(false);
        setNotice("Cover published");
        void refetchPresentation();
      } catch (publishError) {
        setEditor((current) => ({ ...current, status: "approved" }));
        setPublicationFailed(true);
        if (isUnknownOutcome(publishError)) {
          const attempt: PendingLifecycleAttempt = {
            stage: "publication",
            coverId,
            expectedRevision,
          };
          setPendingLifecycle(attempt);
          await reconcileLifecycle(attempt, false);
        } else {
          setError(
            "Cover is Approved, but publication failed. The previous published cover is unchanged; retry publication when ready.",
          );
        }
      }
    } finally {
      setLifecycleStage(null);
    }
  }

  return {
    approveAndPublish,
    checkLifecycleStatus,
    isCheckingLifecycle,
    lifecycleStage,
    pendingLifecycle,
    publicationFailed,
  };
}
