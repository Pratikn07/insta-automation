import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { IG_TEXT_BYTE_LIMIT, instagramTextBytes } from "../lib/instagramLimits.js";

export const messagesRouter = Router();

const messageTypeSchema = z.enum(["text", "image", "pdf"]);

/**
 * Instagram measures a message in BYTES, not characters: "Message text must be
 * UTF-8 and be a 1000 bytes or less" (Meta, Instagram Messaging API). An emoji
 * costs 4 bytes and a bullet or curly quote costs 3, so a `.max(n)` on string
 * length — which is what this schema used to carry, at 2000 — permitted roughly
 * double the deliverable size and let undeliverable steps reach the sender.
 *
 * Measured against production on 2026-08-16: 10 stored steps exceed 1,000 bytes
 * and six of those are under 1,000 characters, so the old check passed every one
 * of them. The failure surfaced only at send time, as a Graph error, after a
 * real person had already asked for the guide.
 *
 * Rejecting here rather than truncating: silently shortening a parent's guide is
 * worse than refusing to save it, and the editor shows the same budget live so
 * this should never be the first time anyone hears about it.
 */
const withinInstagramLimit = (value: string) =>
  instagramTextBytes(value) <= IG_TEXT_BYTE_LIMIT;

const limitMessage = (value: string) =>
  `Message is ${instagramTextBytes(value).toLocaleString()} bytes; Instagram's limit is ` +
  `${IG_TEXT_BYTE_LIMIT.toLocaleString()}. Emoji cost 4 bytes each, bullets and curly quotes 3.`;

const messageBody = z.string().refine(withinInstagramLimit, (value) => ({
  message: limitMessage(value),
}));

const createSchema = z.object({
  resourceId: z.string().uuid(),
  type: messageTypeSchema,
  body: messageBody.optional(),
  mediaUrl: z.string().url().optional(),
});

const updateSchema = z.object({
  type: messageTypeSchema.optional(),
  body: messageBody.nullable().optional(),
  mediaUrl: z.string().url().nullable().optional(),
});

const reorderSchema = z.object({
  messageIds: z.array(z.string().uuid()).min(1),
});

messagesRouter.get("/by-resource/:resourceId", async (req, res) => {
  const rows = await prisma.resourceMessage.findMany({
    where: { resourceId: req.params.resourceId },
    orderBy: { order: "asc" },
  });
  res.json(rows);
});

messagesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { resourceId, type, body, mediaUrl } = parsed.data;

  if (type === "text" && !body) {
    return res.status(400).json({ error: "text_step_requires_body" });
  }
  if ((type === "image" || type === "pdf") && !mediaUrl) {
    return res.status(400).json({ error: "media_step_requires_url" });
  }

  const last = await prisma.resourceMessage.findFirst({
    where: { resourceId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const nextOrder = (last?.order ?? -1) + 1;

  const created = await prisma.resourceMessage.create({
    data: { resourceId, order: nextOrder, type, body: body ?? null, mediaUrl: mediaUrl ?? null },
  });
  res.status(201).json(created);
});

messagesRouter.patch("/:id", async (req, res) => {
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
