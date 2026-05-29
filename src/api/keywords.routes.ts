import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { normalizeKeyword } from "../services/keywordService.js";

export const keywordsRouter = Router();

const createSchema = z.object({
  keyword: z.string().min(1).max(60),
  resourceId: z.string().uuid(),
  publicReply: z.string().min(1).max(280),
  gateMessage: z.string().min(1).max(1000),
  active: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

keywordsRouter.get("/", async (_req, res) => {
  const rows = await prisma.keyword.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      resource: { select: { id: true, name: true, _count: { select: { messages: true } } } },
      _count: { select: { conversations: true } },
    },
  });
  res.json(rows);
});

keywordsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;
  try {
    const created = await prisma.keyword.create({
      data: {
        keyword: normalizeKeyword(data.keyword),
        resourceId: data.resourceId,
        publicReply: data.publicReply,
        gateMessage: data.gateMessage,
        active: data.active ?? true,
      },
    });
    res.status(201).json(created);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
      return res.status(409).json({ error: "keyword_exists" });
    }
    throw err;
  }
});

keywordsRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;
  const updated = await prisma.keyword.update({
    where: { id: req.params.id },
    data: {
      ...(data.keyword !== undefined && { keyword: normalizeKeyword(data.keyword) }),
      ...(data.resourceId !== undefined && { resourceId: data.resourceId }),
      ...(data.publicReply !== undefined && { publicReply: data.publicReply }),
      ...(data.gateMessage !== undefined && { gateMessage: data.gateMessage }),
      ...(data.active !== undefined && { active: data.active }),
    },
  });
  res.json(updated);
});

keywordsRouter.delete("/:id", async (req, res) => {
  await prisma.$transaction([
    prisma.conversation.deleteMany({ where: { keywordId: req.params.id } }),
    prisma.keyword.delete({ where: { id: req.params.id } }),
  ]);
  res.status(204).end();
});
