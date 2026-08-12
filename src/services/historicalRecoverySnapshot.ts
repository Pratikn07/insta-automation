import { createHash } from "node:crypto";
import type { CampaignPhase } from "./historicalRecoveryEligibility.js";
import type { AudienceSegment } from "./historicalAudienceSegment.js";

export const EXPANDED_AUDIENCE_ELIGIBILITY_POLICY_VERSION = "eligibility-v4-expanded-audience";

export type SelectionSnapshotConfiguration = {
  phase: CampaignPhase;
  selectionVersion: string;
  sourceDataCutoff: string;
  commentFrom: string | null;
  commentTo: string | null;
  selectionLimit: number | null;
  westernOnly: boolean;
  holdoutPercent: number;
  copyVersion: string;
  eligibilityPolicyVersion: string;
  inboundWindowHours: number;
  completionWindowHours: number;
  /** Present only on expanded-audience snapshots; omitted from legacy hash inputs. */
  audienceSegment?: AudienceSegment | null;
  rolloutGroupId?: string | null;
  rolloutGroupHourlyCap?: number | null;
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
  audienceOriginMethod: string | null;
  audienceOriginConfidence: string | null;
  /** Present only on expanded-audience snapshots; omitted from legacy hash inputs. */
  audienceSegment?: AudienceSegment | null;
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

export type StoredSelectionSnapshot = {
  configuration: SelectionSnapshotConfiguration | null;
  selectionFingerprint: string | null;
  decisionHash: string | null;
  candidateCount: number;
  excludedCount: number;
  inclusions: SelectionSnapshotInclusion[];
  exclusions: SelectionSnapshotExclusion[];
};

export type StoredSelectionSnapshotVerification =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "snapshot_incomplete"
        | "snapshot_fingerprint_mismatch"
        | "snapshot_hash_mismatch";
    };

/** Verify that stored rows still equal the exact configuration and manifest reviewed. */
export function verifyStoredSelectionSnapshot(
  snapshot: StoredSelectionSnapshot,
): StoredSelectionSnapshotVerification {
  if (
    snapshot.configuration === null
    || !snapshot.selectionFingerprint?.trim()
    || !snapshot.decisionHash?.trim()
    || snapshot.candidateCount <= 0
    || snapshot.inclusions.length !== snapshot.candidateCount
    || snapshot.exclusions.length !== snapshot.excludedCount
  ) {
    return { ok: false, reason: "snapshot_incomplete" };
  }

  const intentIds = new Set<string>();
  const isExpanded = snapshot.configuration.eligibilityPolicyVersion
    === EXPANDED_AUDIENCE_ELIGIBILITY_POLICY_VERSION;
  const expandedAudienceSegment = snapshot.configuration.audienceSegment;
  if (
    isExpanded
    && (
      !expandedAudienceSegment
      || !snapshot.configuration.rolloutGroupId?.trim()
      || !Number.isInteger(snapshot.configuration.rolloutGroupHourlyCap)
      || (snapshot.configuration.rolloutGroupHourlyCap ?? 0) < 1
      || (snapshot.configuration.rolloutGroupHourlyCap ?? 0) > 1000
    )
  ) {
    return { ok: false, reason: "snapshot_incomplete" };
  }
  for (const [position, inclusion] of snapshot.inclusions.entries()) {
    if (
      inclusion.position !== position
      || intentIds.has(inclusion.intentId)
      || !inclusion.audienceOriginMethod?.trim()
      || (isExpanded && inclusion.audienceSegment !== expandedAudienceSegment)
      || !inclusion.sourceChoiceReason.trim()
      || inclusion.sources.length === 0
      || inclusion.sources[0]!.commentId !== inclusion.commentId
      || inclusion.sources.some((source, sourcePosition) =>
        source.position !== sourcePosition
        || !source.commentId.trim()
        || !source.choiceReason.trim())
      || new Set(inclusion.sources.map((source) => source.commentId)).size
        !== inclusion.sources.length
    ) {
      return { ok: false, reason: "snapshot_incomplete" };
    }
    intentIds.add(inclusion.intentId);
  }
  if (new Set(snapshot.exclusions.map((row) => row.intentId)).size !== snapshot.exclusions.length) {
    return { ok: false, reason: "snapshot_incomplete" };
  }

  if (buildSelectionFingerprint(snapshot.configuration) !== snapshot.selectionFingerprint) {
    return { ok: false, reason: "snapshot_fingerprint_mismatch" };
  }
  if (
    buildSelectionDecisionHash(
      snapshot.configuration,
      snapshot.inclusions,
      snapshot.exclusions,
    ) !== snapshot.decisionHash
  ) {
    return { ok: false, reason: "snapshot_hash_mismatch" };
  }
  return { ok: true };
}
