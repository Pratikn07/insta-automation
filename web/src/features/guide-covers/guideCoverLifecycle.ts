import type {
  ResourceCoverStatus,
  ResourcePresentationResponse,
} from "./types";

export type LifecycleStage = "approval" | "publication";

export interface PendingLifecycleAttempt {
  stage: LifecycleStage;
  coverId: string;
  expectedRevision: number;
}

export type LifecycleReconciliation =
  | "draft"
  | "approved"
  | "published"
  | "unresolved";

export function nextLifecycleMutation(
  status: ResourceCoverStatus | "not_configured",
): LifecycleStage | null {
  if (status === "draft") return "approval";
  if (status === "approved") return "publication";
  return null;
}

export function classifyLifecycleReconciliation(
  presentation: ResourcePresentationResponse,
  attempt: PendingLifecycleAttempt,
): LifecycleReconciliation {
  const canonical = presentation.coverVersions.find(
    (candidate) =>
      candidate.id === attempt.coverId && candidate.revision === attempt.expectedRevision,
  );
  if (!canonical) return "unresolved";
  if (canonical.status === "draft") return "draft";
  if (canonical.status === "approved") return "approved";
  if (canonical.status === "published") return "published";
  return "unresolved";
}

export function lifecyclePendingLabel(attempt: PendingLifecycleAttempt): string {
  return attempt.stage === "approval"
    ? "Confirming approval"
    : "Confirming publication";
}
