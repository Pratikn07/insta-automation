import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getDashboardStats } from "../services/statsService.js";

export const statsRouter = Router();

statsRouter.get("/", async (_req, res) => {
  const stats = await getDashboardStats();
  res.json(stats);
});

const eventsQuery = z.object({
  kind: z.string().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});

statsRouter.get("/events", async (req, res) => {
  const parsed = eventsQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { kind, limit, cursor } = parsed.data;

  const rows = await prisma.eventLog.findMany({
    where: kind ? { kind } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    items,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  });
});
