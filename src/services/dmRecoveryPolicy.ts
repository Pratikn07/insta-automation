import { createHash } from "node:crypto";
import type { DmRecoveryCohort, DmRecoveryTriggerKind } from "@prisma/client";

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
  cancelledAt: Date | null;
  hasRecentSentReminderForPerson: boolean;
  hasNewerEligibleCandidate: boolean;
  isSourceCommentAvailable: boolean;
};

export function decideRecovery(input: RecoveryPolicyInput): RecoveryDecision {
  if (input.cancelledAt) {
    return { kind: "suppress", reason: "owner_cancelled" };
  }

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
    return { kind: "suppress", reason: "completed" };
  }

  if (!input.isSourceCommentAvailable) {
    return { kind: "suppress", reason: "source_unavailable" };
  }

  if (input.triggerKind === "no_confirmed_read" && !input.instagramGateMessageId) {
    return { kind: "suppress", reason: "source_unavailable" };
  }

  if (input.triggerKind === "settings_blocked") {
    return { kind: "send_settings_fallback" };
  }

  if (input.now.getTime() < input.eligibleAt.getTime()) {
    return { kind: "wait" };
  }

  if (input.hasRecentSentReminderForPerson) {
    return { kind: "suppress", reason: "person_cooldown" };
  }

  if (input.hasNewerEligibleCandidate) {
    return { kind: "suppress", reason: "newer_candidate" };
  }

  if (input.cohort === "control") {
    return { kind: "holdout" };
  }

  return { kind: "send_no_confirmed_read_reminder" };
}
