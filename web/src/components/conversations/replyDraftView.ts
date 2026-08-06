import type {
  DmThreadDetail,
  ReplyDraft,
  ReplyDraftKind,
  ReplyDraftStatus,
} from "@/lib/types";

/**
 * The reply-draft card's rules, kept free of any data-fetching import so they can
 * be tested without app env (same convention as connectionView.ts — importing a
 * component that pulls in @/lib/api throws without VITE_SUPABASE_*).
 */

/** Statuses the owner can still act on. Anything else is history. */
const LIVE_STATUSES: ReplyDraftStatus[] = [
  "queued",
  "generating",
  "pending_approval",
  "generation_failed",
  "sending",
  "send_failed",
  "send_uncertain",
];

export function isVisibleDraft(draft: ReplyDraft | null): boolean {
  if (!draft) return false;
  if (LIVE_STATUSES.includes(draft.status)) return true;
  return (
    draft.kind === "engagement_follow_up" &&
    (draft.status === "expired" || draft.status === "superseded")
  );
}

/**
 * A draft is stale the moment a newer inbound message arrives — it answers a
 * question that is no longer the latest thing said. Approval must be blocked, not
 * merely discouraged.
 */
export function isStale(thread: DmThreadDetail, draft: ReplyDraft | null): boolean {
  if (!draft) return false;
  if (!thread.latestInboundMessageId) return false;
  return draft.inboundMessageId !== thread.latestInboundMessageId;
}

export interface ApprovalGate {
  canApprove: boolean;
  /** Why approval is unavailable, for the button's title and the banner. */
  reason:
    | null
    | "not_pending"
    | "stale"
    | "empty"
    | "too_long"
    | "in_flight"
    | "send_disabled"
    | "prompt_policy_outdated"
    | "uncertain_needs_check"
    | "follow_up_not_ready"
    | "follow_up_window_closed";
}

export const MAX_REPLY_LENGTH = 1000;

/**
 * Can Approve & Send fire right now?
 *
 * `send_uncertain` deliberately does NOT fall through to ordinary approval: the
 * message may already have been delivered, so the owner must confirm they checked
 * Instagram first via the retry path.
 */
export function approvalGate(input: {
  thread: DmThreadDetail;
  draft: ReplyDraft | null;
  text: string;
  sendEnabled: boolean;
  mutationPending: boolean;
  now?: Date;
}): ApprovalGate {
  const { thread, draft, text, sendEnabled, mutationPending, now = new Date() } = input;

  if (!sendEnabled) return { canApprove: false, reason: "send_disabled" };
  if (!draft) return { canApprove: false, reason: "not_pending" };
  if (!draft.promptPolicyCurrent) {
    return { canApprove: false, reason: "prompt_policy_outdated" };
  }
  if (draft.kind === "engagement_follow_up") {
    if (draft.expiresAt && now >= new Date(draft.expiresAt)) {
      return { canApprove: false, reason: "follow_up_window_closed" };
    }
    if (now < new Date(draft.eligibleAt)) {
      return { canApprove: false, reason: "follow_up_not_ready" };
    }
  }
  if (draft.status === "send_uncertain") {
    return { canApprove: false, reason: "uncertain_needs_check" };
  }
  if (draft.status === "sending" || mutationPending) {
    return { canApprove: false, reason: "in_flight" };
  }
  if (draft.status !== "pending_approval") return { canApprove: false, reason: "not_pending" };
  if (isStale(thread, draft)) return { canApprove: false, reason: "stale" };

  const trimmed = text.trim();
  if (trimmed.length === 0) return { canApprove: false, reason: "empty" };
  if (trimmed.length > MAX_REPLY_LENGTH) return { canApprove: false, reason: "too_long" };

  return { canApprove: true, reason: null };
}

/** Map only stable server codes; raw backend/provider text never reaches the UI. */
export function draftActionErrorMessage(code: string | null): string {
  switch (code) {
    case "prompt_policy_outdated":
      return "This draft uses an older prompt policy and can no longer be used.";
    case "stale_draft":
      return "A newer Instagram message arrived before this action completed.";
    case "follow_up_not_ready":
      return "This follow-up is not ready yet.";
    case "follow_up_window_closed":
      return "The Instagram reply window closed before this could be sent.";
    default:
      return "This action could not be completed. Refresh and try again.";
  }
}

/** Row/badge label for a status. Plain English, no internal jargon. */
export function draftStatusLabel(status: ReplyDraftStatus, kind: ReplyDraftKind = "reply"): string {
  if (kind === "engagement_follow_up") {
    switch (status) {
      case "queued":
        return "Follow-up scheduled";
      case "generating":
        return "Writing follow-up";
      case "pending_approval":
        return "Follow-up ready";
      case "expired":
        return "Follow-up expired";
      case "superseded":
        return "Follow-up cancelled";
    }
  }
  switch (status) {
    case "queued":
    case "generating":
      return "Drafting";
    case "pending_approval":
      return "Draft ready";
    case "generation_failed":
      return "Draft failed";
    case "sending":
      return "Sending";
    case "sent":
      return "Replied";
    case "send_failed":
      return "Send failed";
    case "send_uncertain":
      return "Status uncertain";
    case "dismissed":
      return "Dismissed";
    case "superseded":
      return "Superseded";
    case "expired":
      return "Expired";
  }
}

/** What the thread list should show for a row. */
export function rowState(row: {
  needsReply: boolean;
  draft: ReplyDraft | null;
}): "drafting" | "draft_ready" | "needs_review" | "send_failed" | "automated" | "replied" {
  const status = row.draft?.status;
  if (status === "send_failed" || status === "send_uncertain") return "send_failed";
  if (status === "queued" || status === "generating") return "drafting";
  if (status === "pending_approval") return "draft_ready";
  if (row.needsReply) return "needs_review";
  if (status === "sent") return "replied";
  return "automated";
}
