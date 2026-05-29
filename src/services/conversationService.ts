import { prisma } from "../lib/prisma.js";

const GATE_WINDOW_HOURS = 24;

export async function openConversation(igUserId: string, keywordId: string) {
  return prisma.conversation.create({
    data: { igUserId, keywordId, state: "awaiting_done" },
  });
}

export async function findActiveAwaitingDone(igUserId: string) {
  const cutoff = new Date(Date.now() - GATE_WINDOW_HOURS * 60 * 60 * 1000);
  return prisma.conversation.findFirst({
    where: {
      igUserId,
      state: "awaiting_done",
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
    include: { keyword: { include: { resource: { include: { messages: true } } } } },
  });
}

export async function markCompleted(conversationId: string) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { state: "completed", completedAt: new Date() },
  });
}

export async function expireOldConversations() {
  const cutoff = new Date(Date.now() - GATE_WINDOW_HOURS * 60 * 60 * 1000);
  return prisma.conversation.updateMany({
    where: { state: "awaiting_done", createdAt: { lt: cutoff } },
    data: { state: "expired" },
  });
}
