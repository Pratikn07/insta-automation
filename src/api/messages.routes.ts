import { type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  INSTAGRAM_GUIDE_TEXT_LIMIT,
  MESSAGE_BODY_TOO_LONG_ERROR,
  countInstagramCodePoints,
} from "../../shared/guideMessagePolicy.js";
import {
  classifyCreateReplay,
  idempotencyKeyMismatch,
  isPrimaryKeyViolation,
} from "./createReplay.js";
import { asyncRouter } from "./asyncRouter.js";

export const messagesRouter = asyncRouter();

const messageTypeSchema = z.enum(["text", "image", "pdf"]);

/**
 * The route enforces the shared code-point policy. It rejects rather than
 * truncating because silently shortening a parent's guide would lose content.
 */
// Zod counts string `.max()` values in UTF-16 units. Transforming to code
// points first keeps its defense-in-depth limit aligned with the API boundary.
const messageBody = z
  .string()
  .transform((value) => [...value])
  .pipe(z.array(z.string()).max(INSTAGRAM_GUIDE_TEXT_LIMIT))
  .transform((codePoints) => codePoints.join(""));

const createSchema = z.object({
  id: z.string().uuid(),
  resourceId: z.string().uuid(),
  type: messageTypeSchema,
  body: messageBody.optional(),
  mediaUrl: z.string().url().optional(),
});

/**
 * What the request owns. `order` is deliberately absent: the server assigns it
 * from the current tail, so by the time a lost create is repeated the tail has
 * usually moved, and comparing it would call an honest replay a conflict.
 */
const MESSAGE_REPLAY_KEYS = ["resourceId", "type", "body", "mediaUrl"] as const;

const updateSchema = z.object({
  type: messageTypeSchema.optional(),
  body: messageBody.nullable().optional(),
  mediaUrl: z.string().url().nullable().optional(),
});

const reorderSchema = z.object({
  messageIds: z.array(z.string().uuid()).min(1),
});

function rejectLongBody(body: unknown, res: Response): boolean {
  if (typeof body !== "string") return false;
  const actual = countInstagramCodePoints(body);
  if (actual <= INSTAGRAM_GUIDE_TEXT_LIMIT) return false;
  res.status(400).json({
    error: MESSAGE_BODY_TOO_LONG_ERROR,
    limit: INSTAGRAM_GUIDE_TEXT_LIMIT,
    actual,
  });
  return true;
}

messagesRouter.get("/by-resource/:resourceId", async (req, res) => {
  const rows = await prisma.resourceMessage.findMany({
    where: { resourceId: req.params.resourceId },
    orderBy: { order: "asc" },
  });
  res.json(rows);
});

messagesRouter.post("/", async (req, res) => {
  if (rejectLongBody(req.body?.body, res)) return;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { resourceId, type, body, mediaUrl } = parsed.data;

  if (type === "text" && !body) {
    return res.status(400).json({ error: "text_step_requires_body" });
  }
  if ((type === "image" || type === "pdf") && !mediaUrl) {
    return res.status(400).json({ error: "media_step_requires_url" });
  }

  if (idempotencyKeyMismatch(req.headers["idempotency-key"], parsed.data.id)) {
    return res.status(400).json({ error: "idempotency_key_mismatch" });
  }

  const last = await prisma.resourceMessage.findFirst({
    where: { resourceId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const nextOrder = (last?.order ?? -1) + 1;

  const intended = {
    id: parsed.data.id,
    resourceId,
    type,
    body: body ?? null,
    mediaUrl: mediaUrl ?? null,
  };

  try {
    res.status(201).json(
      await prisma.resourceMessage.create({ data: { ...intended, order: nextOrder } }),
    );
  } catch (error) {
    if (!isPrimaryKeyViolation(error)) throw error;
    const existing = await prisma.resourceMessage.findUnique({ where: { id: intended.id } });
    if (!existing) throw error;
    if (
      classifyCreateReplay({ existing, intended, keys: MESSAGE_REPLAY_KEYS }) === "conflict"
    ) {
      return res.status(409).json({ error: "idempotency_conflict" });
    }
    res.status(200).json(existing);
  }
});

messagesRouter.patch("/:id", async (req, res) => {
  if (rejectLongBody(req.body?.body, res)) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = await prisma.resourceMessage.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  res.json(updated);
});

messagesRouter.post("/reorder/:resourceId", async (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { messageIds } = parsed.data;
  const { resourceId } = req.params;

  const existing = await prisma.resourceMessage.findMany({
    where: { resourceId },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((m) => m.id));
  if (messageIds.length !== existing.length || !messageIds.every((id) => existingIds.has(id))) {
    return res.status(400).json({ error: "id_set_mismatch" });
  }

  await prisma.$transaction(async (tx) => {
    // First park each row out of the unique-constraint range so we can reassign cleanly.
    for (let i = 0; i < messageIds.length; i++) {
      await tx.resourceMessage.update({
        where: { id: messageIds[i]! },
        data: { order: -1 - i },
      });
    }
    for (let i = 0; i < messageIds.length; i++) {
      await tx.resourceMessage.update({
        where: { id: messageIds[i]! },
        data: { order: i },
      });
    }
  });

  const rows = await prisma.resourceMessage.findMany({
    where: { resourceId },
    orderBy: { order: "asc" },
  });
  res.json(rows);
});

messagesRouter.delete("/:id", async (req, res) => {
  const target = await prisma.resourceMessage.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "not_found" });

  await prisma.$transaction(async (tx) => {
    await tx.resourceMessage.delete({ where: { id: target.id } });
    const remaining = await tx.resourceMessage.findMany({
      where: { resourceId: target.resourceId },
      orderBy: { order: "asc" },
    });
    // Park then renumber to keep contiguous orders without unique-constraint collisions.
    for (let i = 0; i < remaining.length; i++) {
      await tx.resourceMessage.update({
        where: { id: remaining[i]!.id },
        data: { order: -1 - i },
      });
    }
    for (let i = 0; i < remaining.length; i++) {
      await tx.resourceMessage.update({
        where: { id: remaining[i]!.id },
        data: { order: i },
      });
    }
  });
  res.status(204).end();
});
