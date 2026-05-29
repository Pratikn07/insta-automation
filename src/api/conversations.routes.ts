import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

export const conversationsRouter = Router();

const listQuerySchema = z.object({
  state: z.enum(["awaiting_done", "completed", "expired"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});

conversationsRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { state, limit, cursor } = parsed.data;

  const rows = await prisma.conversation.findMany({
    where: state ? { state } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    include: {
      keyword: { select: { id: true, keyword: true } },
    },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    items,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  });
});

conversationsRouter.get("/:id/events", async (req, res) => {
  const id = req.params.id;
  const convo = await prisma.conversation.findUnique({
    where: { id },
    include: {
      keyword: { select: { id: true, keyword: true, resource: { select: { id: true, name: true } } } },
    },
  });
  if (!convo) return res.status(404).json({ error: "not_found" });

  const events = await prisma.eventLog.findMany({
    where: { payload: { path: ["conversationId"], equals: id } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  res.json({ conversation: convo, events });
});
