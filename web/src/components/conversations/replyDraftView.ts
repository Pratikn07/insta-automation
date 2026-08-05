import type { DmThreadDetail, ReplyDraft, ReplyDraftStatus } from "@/lib/types";

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

export function isLiveDraft(draft: ReplyDraft | null): boolean {
  return draft !== null && LIVE_STATUSES.includes(draft.status);
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
    | "uncertain_needs_check";
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
}): ApprovalGate {
  const { thread, draft, text, sendEnabled, mutationPending } = input;

  if (!sendEnabled) return { canApprove: false, reason: "send_disabled" };
  if (!draft) return { canApprove: false, reason: "not_pending" };
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

/** Row/badge label for a status. Plain English, no internal jargon. */
export function draftStatusLabel(status: ReplyDraftStatus): string {
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
