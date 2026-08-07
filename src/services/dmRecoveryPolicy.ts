import { createHash } from "node:crypto";
import type { DmRecoveryCohort, DmRecoveryTriggerKind } from "@prisma/client";
import type { Origin } from "./originInference.js";

export const RECOVERY_TEMPLATE_VERSION = "v1";

export type RecoverySuppressionReason =
  | "seen"
  | "inbound_reply"
  | "quick_reply"
  | "attachment"
  | "reaction"
  | "postback"
  | "completed"
  | "completed_elsewhere"
  | "person_cooldown"
  | "newer_candidate"
  | "source_unavailable"
  | "tracking_unavailable"
  // The row already reached a terminal state, so there is nothing left to
  // decide. Distinct from the evidence reasons on purpose: a finalized row
  // carries no claim about whether the person ever read the DM, and callers
  // must not overwrite the reason already stored on the row.
  | "already_finalized"
  // The recovery reminder is a PUBLIC comment. This account sells to a Western
  // audience, so a high-confidence South-Asian origin is withheld rather than
  // posted. Named for the decision, not for the person: it records why WE did
  // not post, and it is never shown to anyone outside the dashboard.
  | "audience_out_of_market"
  | "owner_cancelled";

export type RecoveryDecision =
  | { kind: "wait" }
  | { kind: "holdout" }
  | { kind: "suppress"; reason: RecoverySuppressionReason }
  | { kind: "send_settings_fallback" }
  | { kind: "send_no_confirmed_read_reminder" };

export function renderRecoveryCopy(
  trigger: "no_confirmed_read" | "settings_blocked",
  keywordSnapshot: string,
): string {
  const trimmed = keywordSnapshot.trim();
  if (!trimmed) {
    throw new Error("invalid_keyword_snapshot: Snapshot must be a non-empty string");
  }

  return trigger === "settings_blocked"
    ? `I couldn’t send your DM 💛 Your message-request settings blocked it. DM @tinysoho “${trimmed}”.`
    : `I sent your guide 💛 Check your DMs/Requests. If you don’t see it, DM @tinysoho “${trimmed}”.`;
}

export function assignRecoveryCohort(
  igUserId: string,
  experimentVersion: string,
  holdoutPercent: number,
): DmRecoveryCohort {
  if (holdoutPercent <= 0) return "treatment";
  if (holdoutPercent >= 100) return "control";

  const hash = createHash("sha256")
    .update(`${experimentVersion}:${igUserId}`)
    .digest();
  const uint32 = hash.readUInt32BE(0);
  const bucket = (uint32 / 0xffffffff) * 100;

  return bucket < holdoutPercent ? "control" : "treatment";
}

export type RecoveryPolicyInput = {
  now: Date;
  triggerKind: DmRecoveryTriggerKind;
  status: string;
  cohort: DmRecoveryCohort;
  eligibleAt: Date;
  acceptedAt: Date | null;
  instagramGateMessageId: string | null;
  commentId: string;
  seenAt: Date | null;
  engagedAt: Date | null;
  firstEngagementKind: string | null;
  conversationCompletedAt: Date | null;
  conversationCompletedElsewhere: boolean;
  cancelledAt: Date | null;
  hasRecentSentReminderForPerson: boolean;
  hasNewerEligibleCandidate: boolean;
  isSourceCommentAvailable: boolean;
  /**
   * Name-based origin proxy from `inferOrigin`. NOT measured geography — Meta
   * exposes no per-user country.
   */
  audienceOrigin: Origin;
  /** Confidence of `audienceOrigin`. Only `high` may withhold a send. */
  audienceOriginConfidence: "high" | "low";
  /** `DM_RECOVERY_WESTERN_ONLY`. When false the origin is ignored entirely. */
  westernOnly: boolean;
};

// Terminal statuses that must never be sent again.
const TERMINAL_STATUSES = new Set([
  "sending",
  "sent",
  "send_failed",
  "send_uncertain",
  "suppressed",
  "tracking_unavailable",
  "cancelled",
  "control",
]);

/**
 * Pure decision function.  Evaluation order matches the required safety priority:
 *
 *  1. Terminal status
 *  2. Positive evidence (seen / engaged / completed)
 *  3. Missing source comment
 *  3b. Out-of-market audience (DM_RECOVERY_WESTERN_ONLY)
 *  4. Tracking unavailable (no_confirmed_read without gate mid)
 *  5. Person cooldown (24h)
 *  6. Newer candidate
 *  7. Settings fallback
 *  8. Ten-hour eligibility wait
 *  9. Holdout (control cohort)
 * 10. Send no-confirmed-read reminder
 */
export function decideRecovery(input: RecoveryPolicyInput): RecoveryDecision {
  // 1. Terminal status — never re-evaluate
  if (TERMINAL_STATUSES.has(input.status)) {
    if (input.status === "cancelled" || input.cancelledAt) {
      return { kind: "suppress", reason: "owner_cancelled" };
    }
    if (input.status === "tracking_unavailable") {
      return { kind: "suppress", reason: "tracking_unavailable" };
    }
    if (input.status === "control") {
      return { kind: "holdout" };
    }
    // sent, send_failed, send_uncertain, sending, suppressed. Never report a
    // read/engagement reason here — the row may have been finalized for reasons
    // that have nothing to do with the person opening the DM.
    return { kind: "suppress", reason: "already_finalized" };
  }

  // Owner cancellation (even without a terminal status row)
  if (input.cancelledAt) {
    return { kind: "suppress", reason: "owner_cancelled" };
  }

  // 2. Positive evidence
  if (input.seenAt) {
    return { kind: "suppress", reason: "seen" };
  }

  if (input.engagedAt) {
    const kind = input.firstEngagementKind ?? "inbound_reply";
    const reason: RecoverySuppressionReason =
      kind === "reaction"
        ? "reaction"
        : kind === "postback"
        ? "postback"
        : kind === "quick_reply"
        ? "quick_reply"
        : kind === "attachment"
        ? "attachment"
        : "inbound_reply";
    return { kind: "suppress", reason };
  }

  if (input.conversationCompletedAt) {
    return {
      kind: "suppress",
      reason: input.conversationCompletedElsewhere ? "completed_elsewhere" : "completed",
    };
  }

  // 3. Missing source comment
  if (!input.isSourceCommentAvailable) {
    return { kind: "suppress", reason: "source_unavailable" };
  }

  // 3b. Out-of-market audience. Applies to BOTH trigger kinds: the settings
  // fallback is the same public comment and carries the same cost.
  //
  // Only a HIGH-confidence south_asian call withholds. `inferOrigin` returns
  // low confidence for its Western calls and leaves ~70% of this audience
  // `unknown`, so suppressing anything short of a script hit or a distinctive
  // token would silently cancel most of the feature while looking like a
  // targeting rule. A high-confidence call is a non-Latin script or an
  // unambiguous name token — a false positive there costs one withheld
  // reminder, which is the cheap direction to be wrong in.
  if (
    input.westernOnly &&
    input.audienceOrigin === "south_asian" &&
    input.audienceOriginConfidence === "high"
  ) {
    return { kind: "suppress", reason: "audience_out_of_market" };
  }

  // 4. Tracking unavailable (no_confirmed_read without gate message ID)
  if (input.triggerKind === "no_confirmed_read" && !input.instagramGateMessageId) {
    return { kind: "suppress", reason: "tracking_unavailable" };
  }

  // 5. Person cooldown (24h) — applies to ALL trigger kinds
  if (input.hasRecentSentReminderForPerson) {
    return { kind: "suppress", reason: "person_cooldown" };
  }

  // 6. Newer candidate — applies to ALL trigger kinds
  if (input.hasNewerEligibleCandidate) {
    return { kind: "suppress", reason: "newer_candidate" };
  }

  // 7. Settings fallback (after cooldown and candidate checks)
  if (input.triggerKind === "settings_blocked") {
    if (input.cohort === "control") {
      return { kind: "holdout" };
    }
    return { kind: "send_settings_fallback" };
  }

  // 8. Ten-hour eligibility wait
  if (input.now.getTime() < input.eligibleAt.getTime()) {
    return { kind: "wait" };
  }

  // 9. Holdout
  if (input.cohort === "control") {
    return { kind: "holdout" };
  }

  // 10. Send
  return { kind: "send_no_confirmed_read_reminder" };
}
