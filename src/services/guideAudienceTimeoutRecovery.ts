import { createHash } from "node:crypto";
import type { CommentGuideRequest, CommentGuideRequestResult } from "./guideAccessActionService.js";
import type {
  GuideAudienceAuthorization,
  AuthorizeNewGuideActionInput,
} from "./guideAudienceAuthorization.js";
import type { JourneyResolution, JourneyTriggerInput } from "./journeyIntentService.js";

/**
 * The bounded outage cohort. New deferrals are deliberately excluded: they need
 * a separate incident decision, never silent inclusion in this recovery run.
 */
export const GUIDE_AUDIENCE_TIMEOUT_INCIDENT_STARTED_AT = new Date("2026-09-23T23:54:00.000Z");
export const GUIDE_AUDIENCE_TIMEOUT_INCIDENT_ENDED_AT = new Date("2026-09-24T03:45:00.000Z");

const PRIVATE_REPLY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type AudienceTimeoutRecoveryCandidate = {
  /** The original defer decision; safe internal traceability without names or text in output. */
  decisionId: string;
  commentId: string;
  igUserId: string;
  mediaId: string;
  text: string;
  receivedAt: Date;
};

export type RecoveryKeywordMatch = {
  keywordId: string;
  resourceId: string;
  mediaId: string | null;
  mode: "post_strict" | "global_fallback";
};

export type ResolvedAudienceTimeoutRecoveryCandidate = AudienceTimeoutRecoveryCandidate & {
  keywordId: string;
  resourceId: string;
};

export type GuideAudienceTimeoutRecoveryPlan = {
  candidates: ResolvedAudienceTimeoutRecoveryCandidate[];
  excluded: Record<string, number>;
  /** Hash of the exact candidates eligible for reclassification. */
  cohortHash: string;
};

export type RecoveryAuthorization = GuideAudienceAuthorization;

export type AuthorizedAudienceTimeoutRecoveryCandidate =
  ResolvedAudienceTimeoutRecoveryCandidate & {
    classificationId: string;
    classificationOrigin: "unknown" | "other" | "us_western";
  };

export type AuthorizedGuideAudienceTimeoutRecoveryPlan = {
  candidates: AuthorizedAudienceTimeoutRecoveryCandidate[];
  excluded: Record<string, number>;
  /** Hash of the exact allowlisted send cohort, including classification identity. */
  cohortHash: string;
};

export type GuideAudienceTimeoutRecoveryPlanDependencies = {
  now?(): Date;
  resolveKeyword(candidate: AudienceTimeoutRecoveryCandidate): Promise<RecoveryKeywordMatch | null>;
  hasOpenJourney(input: { igUserId: string; keywordId: string }): Promise<boolean>;
};

export type GuideAudienceTimeoutRecoveryAuthorizationDependencies = {
  authorize(input: AuthorizeNewGuideActionInput): Promise<RecoveryAuthorization>;
};

export type GuideAudienceTimeoutRecoveryExecutionDependencies = {
  expectedCohortHash: string;
  openJourney(input: JourneyTriggerInput): Promise<JourneyResolution>;
  sendGatedDm(input: CommentGuideRequest): Promise<CommentGuideRequestResult>;
  recordOutcome(input: { decisionId: string; outcome: string }): Promise<void>;
};

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function isLivePrivateReplyWindow(receivedAt: Date, now: Date): boolean {
  return Number.isFinite(receivedAt.getTime()) && receivedAt.getTime() + PRIVATE_REPLY_WINDOW_MS > now.getTime();
}

function assertDistinctCandidates(candidates: readonly AudienceTimeoutRecoveryCandidate[]): void {
  const decisionIds = new Set<string>();
  const commentIds = new Set<string>();
  for (const candidate of candidates) {
    if (decisionIds.has(candidate.decisionId) || commentIds.has(candidate.commentId)) {
      throw new Error("duplicate guide audience timeout recovery candidate");
    }
    decisionIds.add(candidate.decisionId);
    commentIds.add(candidate.commentId);
  }
}

function sorted<T extends { decisionId: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => left.decisionId.localeCompare(right.decisionId));
}

function fingerprint(rows: readonly Record<string, unknown>[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function recoveryCandidateFingerprint(
  candidates: readonly ResolvedAudienceTimeoutRecoveryCandidate[],
): string {
  return fingerprint(
    sorted(candidates).map((candidate) => ({
      decisionId: candidate.decisionId,
      commentId: candidate.commentId,
      igUserId: candidate.igUserId,
      mediaId: candidate.mediaId,
      keywordId: candidate.keywordId,
      resourceId: candidate.resourceId,
      receivedAt: candidate.receivedAt.toISOString(),
    })),
  );
}

function authorizedCandidateFingerprint(
  candidates: readonly AuthorizedAudienceTimeoutRecoveryCandidate[],
): string {
  return fingerprint(
    sorted(candidates).map((candidate) => ({
      decisionId: candidate.decisionId,
      commentId: candidate.commentId,
      igUserId: candidate.igUserId,
      mediaId: candidate.mediaId,
      keywordId: candidate.keywordId,
      resourceId: candidate.resourceId,
      receivedAt: candidate.receivedAt.toISOString(),
      classificationId: candidate.classificationId,
      classificationOrigin: candidate.classificationOrigin,
    })),
  );
}

/**
 * Reconstruct an outbound-safe subset of the fixed outage cohort.
 *
 * This function is intentionally free of provider calls and all mutations. A
 * preview can therefore demonstrate the post/guide pairing and the cohort hash
 * without classifying anyone or making any customer-facing change.
 */
export async function buildGuideAudienceTimeoutRecoveryPlan(
  candidates: readonly AudienceTimeoutRecoveryCandidate[],
  dependencies: GuideAudienceTimeoutRecoveryPlanDependencies,
): Promise<GuideAudienceTimeoutRecoveryPlan> {
  assertDistinctCandidates(candidates);
  const now = dependencies.now?.() ?? new Date();
  const excluded: Record<string, number> = {};
  const selected: ResolvedAudienceTimeoutRecoveryCandidate[] = [];

  for (const candidate of sorted(candidates)) {
    if (!isLivePrivateReplyWindow(candidate.receivedAt, now)) {
      increment(excluded, "comment_window_closed");
      continue;
    }

    const match = await dependencies.resolveKeyword(candidate);
    // Global fallback can be valid for normal live automation, but it cannot
    // prove which guide belonged to this historical post. Recovery must be
    // stricter than live traffic rather than guessing across posts.
    if (
      !match ||
      match.mode !== "post_strict" ||
      !match.mediaId ||
      match.mediaId !== candidate.mediaId
    ) {
      increment(excluded, "not_exact_post_scoped_match");
      continue;
    }

    if (await dependencies.hasOpenJourney({ igUserId: candidate.igUserId, keywordId: match.keywordId })) {
      increment(excluded, "active_same_guide_journey");
      continue;
    }

    selected.push({
      ...candidate,
      keywordId: match.keywordId,
      resourceId: match.resourceId,
    });
  }

  const ordered = sorted(selected);
  return {
    candidates: ordered,
    excluded,
    cohortHash: recoveryCandidateFingerprint(ordered),
  };
}

/**
 * Runs the existing audience safety decision with enforcement forced on. The
 * disabled live flag must not accidentally turn a recovery candidate into an
 * allow; an unenforced response is treated as a hard error before any journey
 * can be opened.
 */
export async function authorizeGuideAudienceTimeoutRecovery(
  plan: GuideAudienceTimeoutRecoveryPlan,
  dependencies: GuideAudienceTimeoutRecoveryAuthorizationDependencies,
): Promise<AuthorizedGuideAudienceTimeoutRecoveryPlan> {
  const excluded = { ...plan.excluded };
  const selected: AuthorizedAudienceTimeoutRecoveryCandidate[] = [];

  for (const candidate of plan.candidates) {
    const authorization = await dependencies.authorize({
      igUserId: candidate.igUserId,
      source: "redelivery",
      commentId: candidate.commentId,
      resourceId: candidate.resourceId,
    });

    if (authorization.kind === "block") {
      increment(excluded, "audience_blocked");
      continue;
    }
    if (authorization.kind === "defer") {
      increment(excluded, `audience_deferred_${authorization.reason}`);
      continue;
    }
    if (!authorization.enforced) {
      throw new Error("recovery audience authorization was not enforced");
    }
    // Defense in depth: the service should create a block decision for this
    // origin, but recovery never trusts an unexpectedly malformed allow.
    if (authorization.classification.origin === "south_asian") {
      throw new Error("recovery audience authorization allowed south_asian");
    }

    selected.push({
      ...candidate,
      classificationId: authorization.classification.id,
      classificationOrigin: authorization.classification.origin,
    });
  }

  const ordered = sorted(selected);
  return {
    candidates: ordered,
    excluded,
    cohortHash: authorizedCandidateFingerprint(ordered),
  };
}

/**
 * Performs one private-gate send per approved, current candidate. It has no
 * public-comment dependency at all, and it stops on the first uncertain or
 * failed opening rather than widening an incident into a bulk send.
 */
export async function executeGuideAudienceTimeoutRecovery(
  plan: AuthorizedGuideAudienceTimeoutRecoveryPlan,
  dependencies: GuideAudienceTimeoutRecoveryExecutionDependencies,
): Promise<{ sent: number; skipped: number }> {
  if (dependencies.expectedCohortHash !== plan.cohortHash) {
    throw new Error("recovery cohort drift: rerun classification before sending");
  }

  let sent = 0;
  let skipped = 0;
  for (const candidate of plan.candidates) {
    const journey = await dependencies.openJourney({
      igUserId: candidate.igUserId,
      keywordId: candidate.keywordId,
      commentId: candidate.commentId,
      mediaId: candidate.mediaId,
      receivedAt: candidate.receivedAt,
      triggerKind: "guide_audience_timeout_recovery",
    });
    if (!journey.maySendGate) {
      skipped += 1;
      await dependencies.recordOutcome({ decisionId: candidate.decisionId, outcome: "journey_not_sendable" });
      continue;
    }
    if (!journey.conversationId) {
      throw new Error("recovery journey missing canonical conversation");
    }

    const result = await dependencies.sendGatedDm({
      conversationId: journey.conversationId,
      igUserId: candidate.igUserId,
      resourceId: candidate.resourceId,
      commentId: candidate.commentId,
      observedAt: candidate.receivedAt,
    });
    await dependencies.recordOutcome({ decisionId: candidate.decisionId, outcome: result.outcome });

    if (result.outcome === "guide_opening_sent") {
      sent += 1;
      continue;
    }
    if (result.outcome === "guide_opening_already_sent") {
      skipped += 1;
      continue;
    }
    throw new Error(`guide recovery stopped after ${result.outcome}`);
  }
  return { sent, skipped };
}
