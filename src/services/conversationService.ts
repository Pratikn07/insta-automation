import { prisma } from "../lib/prisma.js";

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
  // Completing a conversation also cancels any still-pending gate retries for
  // it: the user has the guide, so another "reply DONE to unlock" would be pure
  // spam (Meta sometimes delivers a private reply while returning an error, so
  // a "failing" queue row may in fact be reaching the user's inbox).
  const [convo] = await prisma.$transaction([
    prisma.conversation.update({
      where: { id: conversationId },
      data: { state: "completed", completedAt: new Date() },
    }),
    prisma.gateQueue.updateMany({
      where: { conversationId, status: "pending" },
      data: { status: "abandoned", lastError: "conversation_completed" },
    }),
  ]);
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
