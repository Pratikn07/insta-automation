import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isInstagramGuideTextTooLong } from "../../shared/guideMessagePolicy.js";
import {
  classifyCreateReplay,
  idempotencyKeyMismatch,
  isPrimaryKeyViolation,
} from "./createReplay.js";

export const resourcesRouter = Router();

/**
 * `id` is required, and supplied by the browser. A create whose response was
 * lost can then be repeated safely: the same UUID either creates the row or
 * proves the row is already there.
 */
const createSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
});
const updateSchema = createSchema.omit({ id: true }).partial();

/** The fields this request owns, and therefore the fields a replay must match. */
const RESOURCE_REPLAY_KEYS = ["name", "description"] as const;

resourcesRouter.get("/", async (_req, res) => {
  const rows = await prisma.resource.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { messages: true, keywords: true } },
      messages: { select: { body: true } },
    },
  });
  res.json(
    rows.map(({ messages, ...resource }) => ({
      ...resource,
      invalidMessageCount: messages.filter(
        (message) => message.body !== null && isInstagramGuideTextTooLong(message.body),
      ).length,
    })),
  );
});

resourcesRouter.get("/:id", async (req, res) => {
  const row = await prisma.resource.findUnique({
    where: { id: req.params.id },
    include: {
      messages: { orderBy: { order: "asc" } },
      keywords: { select: { id: true, keyword: true } },
    },
  });
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json({
    ...row,
    invalidMessageCount: row.messages.filter(
      (message) => message.body !== null && isInstagramGuideTextTooLong(message.body),
    ).length,
  });
});

resourcesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = { ...parsed.data, description: parsed.data.description ?? null };

  if (idempotencyKeyMismatch(req.headers["idempotency-key"], data.id)) {
    return res.status(400).json({ error: "idempotency_key_mismatch" });
  }

  try {
    res.status(201).json(await prisma.resource.create({ data }));
  } catch (error) {
    if (!isPrimaryKeyViolation(error)) throw error;
    const existing = await prisma.resource.findUnique({ where: { id: data.id } });
    // The row must exist: the primary key just told us so.
    if (!existing) throw error;
    if (classifyCreateReplay({ existing, intended: data, keys: RESOURCE_REPLAY_KEYS }) === "conflict") {
      return res.status(409).json({ error: "idempotency_conflict" });
    }
    res.status(200).json(existing);
  }
});

resourcesRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = await prisma.resource.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  res.json(updated);
});

resourcesRouter.delete("/:id", async (req, res) => {
  const id = req.params.id;
  const deliveryHistoryCount = await prisma.guideDelivery.count({
    where: { resourceId: id },
  });
  if (deliveryHistoryCount > 0) {
    return res.status(409).json({ error: "resource_has_delivery_history" });
  }
  const keywordIds = (
    await prisma.keyword.findMany({ where: { resourceId: id }, select: { id: true } })
  ).map((k) => k.id);
  await prisma.$transaction([
    prisma.conversation.deleteMany({ where: { keywordId: { in: keywordIds } } }),
    prisma.keyword.deleteMany({ where: { resourceId: id } }),
    prisma.resource.delete({ where: { id } }),
  ]);
  res.status(204).end();
});
