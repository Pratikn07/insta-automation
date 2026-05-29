import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

export const resourcesRouter = Router();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
});
const updateSchema = createSchema.partial();

resourcesRouter.get("/", async (_req, res) => {
  const rows = await prisma.resource.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { messages: true, keywords: true } },
    },
  });
  res.json(rows);
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
  res.json(row);
});

resourcesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const created = await prisma.resource.create({ data: parsed.data });
  res.status(201).json(created);
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
