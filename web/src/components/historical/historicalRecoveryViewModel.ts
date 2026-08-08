/**
 * What a historical recovery row and campaign MEAN to the operator.
 *
 * Pure, like dmRecoveryViewModel: the same input always produces the same view. No
 * fetching, no formatting of locales — this decides only what something means and
 * what the owner may do about it.
 *
 * The vocabulary deliberately matches the prospective lens where the concepts are
 * the same, so "Withheld by the audience filter" reads identically in both places.
 */

export type CampaignState =
  | "draft"
  | "awaiting_approval"
  | "running"
  | "paused"
  | "completed"
  | "cancelled";

export type CandidateOutcome =
  | "pending"
  | "sent"
  | "send_failed"
  | "send_uncertain"
  | "suppressed"
  | "cancelled"
  | "holdout_withheld";

export type Tone = "neutral" | "positive" | "pending" | "warning" | "danger";

export type CampaignRow = {
  id: string;
  phase: string;
  state: CampaignState;
  selectionVersion: string;
  copyVersion: string;
  sourceDataCutoff: string;
  candidateCount: number;
  holdoutPercent: number;
  batchSize: number;
  hourlyCap: number;
  dailyCap: number;
  approvedBy: string | null;
  approvedAt: string | null;
  pauseReason: string | null;
  createdAt: string;
  progress: Record<string, number>;
};

export type CandidateRow = {
  id: string;
  campaignPhase: string;
  username: string | null;
  igUserId: string;
  keywordSnapshot: string;
  commentAt: string;
  arm: string;
  outcome: CandidateOutcome;
  evidence: string;
  suppressionReason: string | null;
  publicReplyId: string | null;
  reviewedAt: string | null;
  laterCompletedAt: string | null;
  audienceOrigin: string | null;
  createdAt: string;
};

export type CampaignPhaseView = { title: string; description: string };

export function campaignPhaseView(phase: string): CampaignPhaseView {
  if (phase === "confirmed_failure") {
    return {
      title: "Confirmed delivery failures",
      description: "Instagram confirmed that the original guide could not be delivered.",
    };
  }
  if (phase === "unknown_read_pilot") {
    return {
      title: "No read confirmation pilot",
      description:
        "Instagram accepted the original DM, but no read confirmation was recorded. The guide may still be in Requests or Hidden Requests.",
    };
  }
  return {
    title: "Historical recovery",
    description: "A frozen campaign selected from earlier automation evidence.",
  };
}

/**
 * Suppression reasons, in the operator's language.
 *
 * Shares wording with the prospective lens for the shared concepts. Each names the
 * DECISION rather than the person, so a withheld row can be audited: "Withheld by
 * the audience filter" says who withheld it and why, where "Out of market" would
 * read as a fact about the person.
 */
export const SUPPRESSION_LABELS: Record<string, string> = {
  source_comment_deleted: "Original comment was deleted",
  // Distinct from deleted on purpose: a hidden comment still exists, so a reply
  // would succeed and be counted while nobody could see it.
  source_comment_hidden: "Original comment is hidden",
  replied_since_selection: "Replied—reminder not needed",
  completed_since_selection: "Completed—reminder not needed",
  contacted_since_selection: "Another reminder was recently sent",
  audience_out_of_market: "Withheld by the audience filter",
  stale_lease: "Interrupted mid-send—needs review",
  missing_reply_id: "Instagram gave no confirmation—needs review",
  auth_or_permission: "Instagram rejected our credentials",
  permanent: "Instagram permanently rejected this",
};

export function suppressionLabel(reason: string | null): string {
  if (!reason) return "Withheld";
  return SUPPRESSION_LABELS[reason] ?? reason.replace(/_/g, " ");
}

export type CandidateView = {
  label: string;
  description: string;
  tone: Tone;
  /** Did this row's person get the guide after we reached out? */
  recovered: boolean;
  /** Needs a human decision — never resolved automatically. */
  needsAttention: boolean;
};

/**
 * What one candidate means right now.
 *
 * `send_uncertain` is the case worth care: the comment MAY be live on Instagram and
 * we cannot prove it either way, so it is never presented as sent or as failed.
 * Calling it either would be a claim we cannot support.
 */
export function candidateView(row: CandidateRow): CandidateView {
  if (row.arm === "holdout") {
    // A holdout who came back WITHOUT being contacted is the baseline (QA-12).
    //
    // This previously reported `recovered: false` for every holdout, which made the
    // control arm look like it never recovered and any treatment number look like pure
    // lift. The comparison is the entire reason the arm exists, so the two cases have to
    // be distinguishable.
    if (row.laterCompletedAt) {
      return {
        label: "Recovered on their own",
        description:
          "Never contacted, and completed the request anyway. This is the baseline the reminder's effect is measured against.",
        tone: "neutral",
        recovered: true,
        needsAttention: false,
      };
    }

    return {
      label: "Held back as control",
      description:
        "Deliberately not contacted, so the campaign can measure whether the reminder actually causes recovery.",
      tone: "neutral",
      recovered: false,
      needsAttention: false,
    };
  }

  switch (row.outcome) {
    case "pending":
      return {
        label: "Waiting to send",
        description:
          "Approved and queued. Every safety check runs again immediately before the comment is posted.",
        tone: "pending",
        recovered: false,
        needsAttention: false,
      };

    case "sent":
      return row.laterCompletedAt
        ? {
            label: "Recovered—guide delivered",
            description:
              "The reminder was posted and this person went on to complete the request. This is the outcome the campaign exists for.",
            tone: "positive",
            recovered: true,
            needsAttention: false,
          }
        : {
            label: "Reminder sent",
            description: "The public reminder was posted on the original comment.",
            tone: "neutral",
            recovered: false,
            needsAttention: false,
          };

    // Never shown as sent OR failed: the comment may exist and we cannot establish
    // which. Presenting it either way would be a claim we cannot support.
    case "send_uncertain":
      return {
        label: "Unconfirmed—check Instagram",
        description:
          "The send was interrupted, so the comment may or may not have posted. It is never retried automatically, because a retry could post a second public comment. Check the post, then mark it reviewed.",
        tone: "warning",
        recovered: false,
        needsAttention: true,
      };

    case "send_failed":
      return {
        label: "Send failed",
        description: `Instagram rejected the reply. ${suppressionLabel(row.suppressionReason)}.`,
        tone: "danger",
        recovered: false,
        needsAttention: true,
      };

    case "suppressed":
      return {
        label: suppressionLabel(row.suppressionReason),
        description:
          "A final check just before sending found this was no longer appropriate, so nothing was posted.",
        tone: "neutral",
        recovered: false,
        needsAttention: false,
      };

    case "cancelled":
      return {
        label: "Cancelled with the campaign",
        description: "The campaign was stopped before this reminder was sent.",
        tone: "neutral",
        recovered: false,
        needsAttention: false,
      };

    default:
      return {
        label: "Held back as control",
        description: "Not contacted.",
        tone: "neutral",
        recovered: false,
        needsAttention: false,
      };
  }
}

export type CampaignActions = {
  canApprove: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canAdvanceStage: boolean;
};

/**
 * Which owner actions apply, mirroring the server's state conditions.
 *
 * Offering an action the server will refuse teaches the operator not to trust the
 * controls, so this is kept in step with recoveryCampaignControl deliberately rather
 * than showing everything and letting the request fail.
 */
export function campaignActions(state: CampaignState): CampaignActions {
  return {
    canApprove: state === "draft" || state === "awaiting_approval",
    canPause: state === "running",
    canResume: state === "paused",
    canCancel: state !== "completed" && state !== "cancelled",
    canAdvanceStage: state === "running" || state === "paused",
  };
}

export type CampaignStatusView = { label: string; description: string; tone: Tone };

export function campaignStatusView(
  row: CampaignRow,
  sendingEnabled: boolean,
): CampaignStatusView {
  switch (row.state) {
    case "draft":
    case "awaiting_approval":
      return {
        label: "Awaiting your approval",
        description: `${row.candidateCount} people selected. Nothing is sent until you approve, and approval is recorded against your name.`,
        tone: "pending",
      };

    case "running":
      // An approved campaign that cannot send is the most confusing state possible,
      // so it is called out rather than shown as healthy.
      return sendingEnabled
        ? {
            label: "Sending",
            description: `Posting up to ${row.hourlyCap} reminders an hour, ${row.batchSize} at a time.`,
            tone: "positive",
          }
        : {
            label: "Approved—but sending is switched off",
            description:
              "This campaign is approved, but historical sending is disabled, so nothing will be posted until it is turned on.",
            tone: "warning",
          };

    case "paused":
      return {
        label: "Paused",
        description: row.pauseReason
          ? `Stopped: ${row.pauseReason}. Remaining people are untouched and will resume when you restart it.`
          : "Stopped. Remaining people are untouched and will resume when you restart it.",
        tone: "warning",
      };

    case "completed":
      return {
        label: "Finished",
        description: "Every selected person has been contacted, withheld, or held back as control.",
        tone: "neutral",
      };

    case "cancelled":
      return {
        label: "Cancelled",
        description:
          "Stopped for good. Reminders already posted stay posted—those comments are live on Instagram.",
        tone: "neutral",
      };

    default:
      return { label: row.state, description: "", tone: "neutral" };
  }
}

/** Recovery rate among people actually contacted. Null when nothing was sent yet. */
export function recoveryRate(progress: Record<string, number>): number | null {
  const sent = progress.sent ?? 0;
  if (sent === 0) return null;
  const recovered = progress.recovered ?? 0;
  return recovered / sent;
}
