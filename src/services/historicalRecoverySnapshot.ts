import { createHash } from "node:crypto";
import type { CampaignPhase } from "./historicalRecoveryEligibility.js";

export type SelectionSnapshotConfiguration = {
  phase: CampaignPhase;
  selectionVersion: string;
  sourceDataCutoff: string;
  commentFrom: string | null;
  commentTo: string | null;
  westernOnly: boolean;
  holdoutPercent: number;
  copyVersion: string;
  eligibilityPolicyVersion: string;
  inboundWindowHours: number;
  completionWindowHours: number;
};

export type SelectionSnapshotSource = {
  position: number;
  commentId: string;
  mediaId: string | null;
  receivedAt: string;
  choiceReason: string;
};

export type SelectionSnapshotInclusion = {
  position: number;
  intentId: string;
  igUserId: string;
  conversationId: string | null;
  keywordId: string;
  commentId: string;
  mediaId: string | null;
  commentAt: string;
  keywordSnapshot: string;
  publicReplyText: string;
  evidence: string;
  audienceOrigin: string | null;
  audienceOriginConfidence: string | null;
  arm: "treatment" | "holdout";
  sourceChoiceReason: string;
  sources: SelectionSnapshotSource[];
};

export type SelectionSnapshotExclusion = {
  intentId: string;
  igUserId: string;
  keywordId: string;
  reason: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

/** Hash only normalized inputs that define selection identity. */
export function buildSelectionFingerprint(config: SelectionSnapshotConfiguration): string {
  return digest(config);
}

/** Hash every owner-reviewed selection decision, including ordering and source choice. */
export function buildSelectionDecisionHash(
  config: SelectionSnapshotConfiguration,
  inclusions: SelectionSnapshotInclusion[],
  exclusions: SelectionSnapshotExclusion[],
): string {
  return digest({
    config,
    inclusions,
    exclusions: [...exclusions].sort((left, right) =>
      left.intentId.localeCompare(right.intentId)
      || left.igUserId.localeCompare(right.igUserId)
      || left.keywordId.localeCompare(right.keywordId)
      || left.reason.localeCompare(right.reason)),
  });
}
