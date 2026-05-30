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
  // Reel scope: mediaId = the IG media id this keyword is attached to (null =
  // global). mediaCaption/mediaPermalink are denormalized snapshots so the
  // Keywords list can show which reel without re-hitting the Graph API.
  mediaId: z.string().nullable().optional(),
  mediaCaption: z.string().nullable().optional(),
  mediaPermalink: z.string().nullable().optional(),
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
  const keyword = normalizeKeyword(data.keyword);
  const mediaId = data.mediaId ?? null;

  // The @@unique([keyword, mediaId]) constraint catches duplicate reel-scoped
  // keywords (P2002 below), but Postgres treats NULLs as distinct, so it does
  // NOT stop two globals with the same word. Guard that case explicitly.
  if (mediaId === null) {
    const existingGlobal = await prisma.keyword.findFirst({ where: { keyword, mediaId: null } });
    if (existingGlobal) return res.status(409).json({ error: "keyword_exists" });
  }

  try {
    const created = await prisma.keyword.create({
      data: {
        keyword,
        mediaId,
        mediaCaption: data.mediaCaption ?? null,
        mediaPermalink: data.mediaPermalink ?? null,
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
      ...(data.mediaId !== undefined && { mediaId: data.mediaId }),
      ...(data.mediaCaption !== undefined && { mediaCaption: data.mediaCaption }),
      ...(data.mediaPermalink !== undefined && { mediaPermalink: data.mediaPermalink }),
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
