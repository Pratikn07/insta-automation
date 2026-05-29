import { prisma } from "../lib/prisma.js";

export interface DashboardStats {
  activeKeywords: number;
  totalKeywords: number;
  dmsSentToday: number;
  conversationsAwaiting: number;
  completedToday: number;
  lastError: { kind: string; createdAt: Date; payload: unknown } | null;
}

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const today = startOfTodayUtc();

  const [activeKeywords, totalKeywords, dmsSentToday, awaiting, completedToday, lastError] =
    await Promise.all([
      prisma.keyword.count({ where: { active: true } }),
      prisma.keyword.count(),
      prisma.eventLog.count({
        where: { kind: "dm_sent", createdAt: { gte: today } },
      }),
      prisma.conversation.count({ where: { state: "awaiting_done" } }),
      prisma.conversation.count({
        where: { state: "completed", completedAt: { gte: today } },
      }),
      prisma.eventLog.findFirst({
        where: { kind: "error" },
        orderBy: { createdAt: "desc" },
        select: { kind: true, createdAt: true, payload: true },
      }),
    ]);

  return {
    activeKeywords,
    totalKeywords,
    dmsSentToday,
    conversationsAwaiting: awaiting,
    completedToday,
    lastError,
  };
}
