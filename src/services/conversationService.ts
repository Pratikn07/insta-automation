import { prisma } from "../lib/prisma.js";
import { suppressRecoveriesForCompletionSafely } from "./dmRecoveryService.js";

// Window during which we'll accept a DONE reply / keep a gate "open", measured
// from when the gate was DELIVERED (gatedAt), falling back to createdAt for legacy
// rows. 48h comfortably covers a prompt reply after a retry delivery; the inbound
// reply itself proves Instagram's own 24h messaging window is still open.
const GATE_WINDOW_HOURS = 48;

export async function openConversation(igUserId: string, keywordId: string) {
  return prisma.conversation.create({
    data: { igUserId, keywordId, state: "awaiting_done" },
  });
}

/**
 * Mark a conversation as gated NOW — call this whenever a gate DM is actually
 * delivered (live send or retry). Re-arms it to awaiting_done and starts the
 * DONE-window clock from delivery, which is the fix for retry-delivered gates
 * landing on already-expired conversations.
 */
export async function markGated(conversationId: string) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { state: "awaiting_done", gatedAt: new Date() },
  });
}

export async function findActiveAwaitingDone(igUserId: string) {
  const cutoff = new Date(Date.now() - GATE_WINDOW_HOURS * 60 * 60 * 1000);
  return prisma.conversation.findFirst({
    where: {
      igUserId,
      state: "awaiting_done",
      // Window measured from gatedAt when present, else createdAt (legacy/live).
      OR: [
        { gatedAt: { gte: cutoff } },
        { gatedAt: null, createdAt: { gte: cutoff } },
      ],
    },
    orderBy: { createdAt: "desc" },
    include: { keyword: { include: { resource: { include: { messages: true } } } } },
  });
}

/**
 * Recover the latest unfinished request after an explicit DONE. The inbound DM
 * opens Meta's current 24-hour send window even when our older gate window has
 * elapsed, so expired rows remain actionable only through this narrow lookup.
 */
export async function findLatestIncompleteConversation(igUserId: string) {
  return prisma.conversation.findFirst({
    where: {
      igUserId,
      state: { in: ["awaiting_done", "expired"] },
    },
    orderBy: { createdAt: "desc" },
    include: { keyword: { include: { resource: { include: { messages: true } } } } },
  });
}

export async function markCompleted(conversationId: string) {
  const completedAt = new Date();

  // Completing the conversation also abandons any still-pending gate retries:
  // the user has the guide, so another "reply DONE to unlock" would be pure
  // spam. Those two writes must land together, so they share a transaction.
  const convo = await prisma.$transaction(async (tx) => {
    const updated = await tx.conversation.update({
      where: { id: conversationId },
      data: { state: "completed", completedAt },
    });

    await tx.gateQueue.updateMany({
      where: { conversationId, status: "pending" },
      data: { status: "abandoned", lastError: "conversation_completed" },
    });

    return updated;
  });

  // Suppressing the recovery reminders is best-effort bookkeeping and runs
  // after the commit, never inside it. Inside, a failure here would roll back
  // the completion and the gate abandon, stranding the conversation in
  // awaiting_done with live gate rows — so the worker would re-send the gate to
  // someone who already has the guide, which is exactly the spam this abandon
  // exists to prevent.
  //
  // Losing the suppression is safe on its own: the recovery worker re-runs the
  // full policy in its final pre-send transaction, and `conversationCompletedAt`
  // suppresses the row there before any public comment is posted.
  await suppressRecoveriesForCompletionSafely({
    conversationId,
    igUserId: convo.igUserId,
    keywordId: convo.keywordId,
    completedAt,
  });

  return convo;
}

/**
 * Has this user already completed this keyword's guide? Guarantees one guide per
 * (user, keyword): a user who commented the same keyword on several reels, or who
 * has a stale open gate alongside a prior completion, must not receive the guide a
 * second time. This is the chokepoint guard against the duplicate-delivery class of
 * bug (both the live same-keyword repeat and any backfill re-run).
 */
export async function hasCompletedKeyword(igUserId: string, keywordId: string): Promise<boolean> {
  const prior = await prisma.conversation.findFirst({
    where: { igUserId, keywordId, state: "completed" },
    select: { id: true },
  });
  return prior !== null;
}

export async function expireOldConversations() {
  const cutoff = new Date(Date.now() - GATE_WINDOW_HOURS * 60 * 60 * 1000);
  // Expire only conversations whose effective gate time (gatedAt, else createdAt)
  // is past the window — so a freshly retry-gated conversation is NOT re-expired.
  return prisma.conversation.updateMany({
    where: {
      state: "awaiting_done",
      OR: [
        { gatedAt: { lt: cutoff } },
        { gatedAt: null, createdAt: { lt: cutoff } },
      ],
    },
    data: { state: "expired" },
  });
}
