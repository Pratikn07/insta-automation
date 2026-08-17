import type { RecoveryReminderRow } from "../../lib/types";

/**
 * The one explanation of what "no confirmed read" means.
 *
 * Meta exposes no unread signal, so the absence of a receipt is the absence of
 * evidence — not evidence of absence. Every listed possibility here is a real
 * reason the receipt could be missing, and none of them is "the message is
 * unread". Business Suite's gray warning is a UI affordance, not a webhook, so
 * nothing in this product can observe it.
 */
export const NO_CONFIRMED_READ_TOOLTIP =
  "Meta accepted the DM, but we received no read confirmation. It may be unread, in Requests or Hidden Requests, blocked after acceptance, or read without an available receipt.";

/**
 * How long after eligibility a send still counts as on time.
 *
 * Matches the default worker tick: the worker cannot post at the exact instant a
 * row becomes eligible, so anything inside one interval is punctual. Without
 * this every single send would be labelled late.
 */
const ON_TIME_ALLOWANCE_MS = 60_000;

export type RecoveryTone = "neutral" | "positive" | "pending" | "warning" | "danger";

export type RecoveryStatusView = {
  label: string;
  description: string;
  tone: RecoveryTone;
  /** Needs a person to look at it. */
  attention: boolean;
  /** Secondary text: what the system will do next, as distinct from the evidence. */
  actionState: string | null;
  canCancel: boolean;
  canMarkReviewed: boolean;
};

const CANCELLABLE: ReadonlySet<string> = new Set([
  "waiting",
  "control",
  "tracking_unavailable",
  "send_failed",
]);

const NEEDS_REVIEW: ReadonlySet<string> = new Set([
  "send_failed",
  "send_uncertain",
  "tracking_unavailable",
]);

const SUPPRESSION_LABELS: Record<string, string> = {
  seen: "Seen—reminder not needed",
  inbound_reply: "Replied—reminder not needed",
  quick_reply: "Replied—reminder not needed",
  attachment: "Replied—reminder not needed",
  reaction: "Reacted—reminder not needed",
  postback: "Reacted—reminder not needed",
  completed: "Completed—reminder not needed",
  completed_elsewhere: "Completed—reminder not needed",
  person_cooldown: "Another reminder was recently sent",
  // Named for the decision, not the person. A withheld row that reads like an
  // ordinary suppression cannot be audited or reversed, so this one says who
  // withheld it and on what basis.
  audience_out_of_market: "Withheld by the audience filter",
  newer_candidate: "Superseded by a newer reminder",
  source_unavailable: "Original comment unavailable",
  tracking_unavailable: "Tracking unavailable",
  already_finalized: "Already resolved",
  owner_cancelled: "Cancelled by owner",
};

function sentView(row: RecoveryReminderRow): { label: string; description: string } {
  const eligible = Date.parse(row.eligibleAt);
  const sent = row.sentAt ? Date.parse(row.sentAt) : null;
  const late = sent !== null && sent - eligible > ON_TIME_ALLOWANCE_MS;

  return late
    ? {
        label: "Reminder sent late after worker delay",
        description:
          "The public reminder was posted, but well after it became due. Check worker health — a late reminder is a different experience from a timely one.",
      }
    : {
        label: "Reminder sent",
        description: "The public reminder was posted on the original comment.",
      };
}

/**
 * Pure: the same row and time always produce the same view. No formatting of
 * percentages, no locale work, no data fetching — this decides only what a row
 * means and what the owner may do to it.
 */
export function recoveryStatusView(row: RecoveryReminderRow, now: Date): RecoveryStatusView {
  const attention = NEEDS_REVIEW.has(row.status);
  const immutableExperimentControl =
    row.experimentVersion === "read-recovery-timing-v2" && row.timingArm === "no_reminder";
  const canCancel =
    CANCELLABLE.has(row.status) && row.sentAt === null && !immutableExperimentControl;
  const canMarkReviewed = attention && row.reviewedAt === null;

  const base = { attention, canCancel, canMarkReviewed, actionState: null as string | null };

  switch (row.status) {
    case "sent": {
      const { label, description } = sentView(row);
      return { ...base, label, description, tone: "positive" };
    }
    case "sending":
      return {
        ...base,
        label: "Posting reminder",
        description: "A worker holds this record and is posting the public reminder now.",
        tone: "pending",
      };
    case "control":
      if (immutableExperimentControl) {
        return {
          ...base,
          label: "No-reminder experiment arm",
          description:
            "This guide request is intentionally held back for measurement. No public reminder will be sent, and the assignment cannot be changed.",
          tone: "neutral",
        };
      }
      return {
        ...base,
        label: "Control group—reminder intentionally withheld",
        description:
          "This person was assigned to the holdout, so no public reminder is posted. Withheld records are the comparison the experiment depends on.",
        tone: "neutral",
      };
    case "suppressed": {
      const withheldByFilter = row.suppressionReason === "audience_out_of_market";
      return {
        ...base,
        label: SUPPRESSION_LABELS[row.suppressionReason ?? ""] ?? "Reminder not needed",
        description: withheldByFilter
          ? "Withheld because the audience filter judged this person out of market. That is a name-based inference, not measured location — check the stored origin evidence before relying on it."
          : "Positive evidence arrived, so no public reminder was posted.",
        // Withheld deliberately, like a control row: a decision to review, not
        // an error to alarm about.
        tone: withheldByFilter ? "neutral" : "positive",
      };
    }
    case "tracking_unavailable":
      return {
        ...base,
        label: "Tracking unavailable",
        description:
          "The DM's outcome could not be correlated, so read state is unknown and no reminder will be posted automatically.",
        tone: "warning",
      };
    case "cancelled":
      return {
        ...base,
        label: "Cancelled by owner",
        description: "Cancelled before any public reminder was posted.",
        tone: "neutral",
      };
    case "send_failed":
      return {
        ...base,
        label: "Couldn’t post public reminder",
        description: "Instagram rejected the public reply. Nothing was posted.",
        tone: "danger",
      };
    case "send_uncertain":
      return {
        ...base,
        label: "Send outcome uncertain—check Instagram",
        description:
          "The reply may or may not have posted, so it is never retried automatically. Check the comment on Instagram before acting.",
        tone: "danger",
      };
    case "waiting":
    default: {
      // A settings rejection is a different fact about a different failure, so
      // it outranks whatever the read evidence says.
      if (row.triggerKind === "settings_blocked") {
        return {
          ...base,
          label: "Settings blocked",
          description:
            "Instagram rejected the DM because of the recipient's message-request settings. A public reminder is eligible immediately.",
          tone: "warning",
          actionState: "Reminder ready",
        };
      }

      const due = Date.parse(row.eligibleAt) <= now.getTime();
      return due
        ? {
            ...base,
            label: "No confirmed read",
            description: NO_CONFIRMED_READ_TOOLTIP,
            tone: "warning",
            // The evidence and what happens next are separate statements.
            actionState: "Reminder ready",
          }
        : {
            ...base,
            label: "Waiting for read confirmation",
            description:
              "Still inside the window. A public reminder is only considered once the window closes with no confirmed read.",
            tone: "pending",
            actionState: "Scheduled",
          };
    }
  }
}
