import type { ReplyDraftStatus } from "@prisma/client";

/**
 * The reply-draft lifecycle, as one table.
 *
 * Every status change in this feature goes through `canTransition`, so the legal
 * moves are stated once here rather than implied by scattered `updateMany`
 * filters. The two rules worth stating out loud:
 *
 *   - `sent` is terminal. A delivered Instagram message cannot be un-delivered.
 *   - `send_failed`/`send_uncertain` CAN return to `sending`, but only the
 *     owner-confirmed retry service may invoke it. No worker consumes either
 *     status, because a "failure" may in fact have been delivered.
 */
const TRANSITIONS: Readonly<Record<ReplyDraftStatus, readonly ReplyDraftStatus[]>> = {
  queued: ["generating", "dismissed", "superseded", "expired"],
  generating: ["pending_approval", "generation_failed", "superseded", "expired"],
  pending_approval: ["sending", "dismissed", "superseded", "expired"],
  // A generation failure is surfaced to the owner and never retried by a worker.
  // The ways out are regenerating (which creates a NEW revision and supersedes
  // this one), dismissing it, or expiring it at the messaging deadline.
  generation_failed: ["dismissed", "superseded", "expired"],
  sending: ["sent", "send_failed", "send_uncertain"],
  // Retrying is owner-confirmed only; deadline enforcement may instead expire it.
  send_failed: ["sending", "dismissed", "expired"],
  send_uncertain: ["sending", "dismissed"],
  sent: [],
  dismissed: [],
  superseded: [],
  expired: [],
};

/**
 * The statuses guarded by the partial unique index
 * `reply_draft_one_active_per_thread`. MUST stay identical to the migration's
 * WHERE clause: if they drift, the database allows two live drafts on one thread
 * while every caller assumes one.
 *
 * `sending` is excluded on purpose. A draft mid-flight to Instagram has an
 * unknown outcome, so a new inbound must not supersede it.
 */
export const ACTIVE_DRAFT_STATUSES = [
  "queued",
  "generating",
  "pending_approval",
] as const satisfies readonly ReplyDraftStatus[];

export function canTransition(from: ReplyDraftStatus, to: ReplyDraftStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Only a draft currently awaiting the owner may be approved and sent. */
export function isApprovable(status: ReplyDraftStatus): boolean {
  return status === "pending_approval";
}
