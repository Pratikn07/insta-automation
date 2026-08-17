import { createHash } from "node:crypto";
import type {
  DmRecoveryCohort,
  DmRecoveryTimingArm,
  DmRecoveryTriggerKind,
} from "@prisma/client";
import type { Origin } from "./originInference.js";
import { normalizeRecoveryKeyword } from "./recoveryCopyCore.js";
import { DM_RECOVERY_TIMING_EXPERIMENT_VERSION } from "./dmRecoveryTimingExperiment.js";

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
  | "experiment_assignment_invalid"
  | "owner_cancelled"
  | "reconciled_alias";

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
  let keyword: string;
  try {
    keyword = normalizeRecoveryKeyword(keywordSnapshot);
  } catch {
    throw new Error("invalid_keyword_snapshot: Snapshot must be a non-empty string");
  }

  return trigger === "settings_blocked"
    ? `I couldn’t send your DM 💛 Your message-request settings blocked it. DM @tinysoho “${keyword}”.`
    : `I sent your guide 💛 Check your DMs/Requests. If you don’t see it, DM @tinysoho “${keyword}”.`;
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
  experimentVersionSnapshot: string | null;
  timingArm: DmRecoveryTimingArm | null;
  eligibleAt: Date;
  instagramGateMessageId: string | null;
  seenAt: Date | null;
  engagedAt: Date | null;
  firstEngagementKind: string | null;
  conversationCompletedAt: Date | null;
  cancelledAt: Date | null;
  hasRecentSentReminderForPerson: boolean;
  hasNewerEligibleCandidate: boolean;
  isSourceCommentAvailable: boolean;
  /**
   * Name-based origin proxy from `inferOrigin`. NOT measured geography — Meta
   * exposes no per-user country.
   */
  audienceOrigin: Origin;
  /**
   * Confidence of `audienceOrigin`. Recorded for reporting only — a `south_asian`
   * verdict withholds at EITHER confidence, so this no longer gates the decision.
   */
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

  // `completed_elsewhere` is not reachable from here. A sibling journey's
  // completion is resolved inside the completion transaction, which stamps those
  // rows terminal with that reason directly, so anything still live by the time
  // the policy runs completed on its own journey.
  if (input.conversationCompletedAt) {
    return { kind: "suppress", reason: "completed" };
  }

  // 3. Missing source comment
  if (!input.isSourceCommentAvailable) {
    return { kind: "suppress", reason: "source_unavailable" };
  }

  // 3b. Out-of-market audience. Applies to BOTH trigger kinds: the settings
  // fallback is the same public comment and carries the same cost.
  //
  // ANY south_asian verdict withholds, at either confidence. This is a Western
  // parenting product, so an out-of-market reminder is spend with no upside, and
  // the confidence distinction turned out not to be worth defending: measured on
  // 2,787 classified users, high confidence is 41.9% and adding low takes it to
  // 45.9% — a 4pp change. The low-confidence calls are also not noise, they are
  // ordinary given names the model declined to call unambiguous ("Priya",
  // "Manisha", surname "Khan").
  //
  // `unknown` and low-confidence non-south_asian still fall through and send:
  // roughly a fifth of this audience has no usable name, and withholding from
  // them would cancel much of the feature while looking like a targeting rule.
  if (input.westernOnly && input.audienceOrigin === "south_asian") {
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

  // V2 eligibility is frozen at insertion. Never recompute or repair an arm at
  // send time: an inconsistent row is evidence of corruption and must fail
  // closed before a public comment can be posted.
  if (input.experimentVersionSnapshot === DM_RECOVERY_TIMING_EXPERIMENT_VERSION) {
    const validV2Treatment =
      input.cohort === "treatment" &&
      (input.timingArm === "two_hour" || input.timingArm === "six_hour");
    if (!validV2Treatment) {
      return { kind: "suppress", reason: "experiment_assignment_invalid" };
    }
  }

  // 9. Holdout
  if (input.cohort === "control") {
    return { kind: "holdout" };
  }

  // 10. Send
  return { kind: "send_no_confirmed_read_reminder" };
}
