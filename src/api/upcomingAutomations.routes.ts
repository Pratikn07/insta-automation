import { Router, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logEvent } from "../services/eventLogger.js";
import { normalizeKeyword } from "../services/keywordService.js";

export const upcomingAutomationsRouter = Router();

const keywordToken = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9]+$/, "Keyword must be one letters-and-numbers token");

const editableFields = z.object({
  keyword: keywordToken.optional(),
  resourceId: z.string().uuid().optional(),
  publicReply: z.string().min(1).max(280).optional(),
  gateMessage: z.string().min(1).max(1000).optional(),
  active: z.boolean().optional(),
});

const createSchema = editableFields.required({
  keyword: true,
  resourceId: true,
  publicReply: true,
  gateMessage: true,
});

type OpenStatus = "waiting" | "needs_attention";

function isOpenStatus(status: string): status is OpenStatus {
  return status === "waiting" || status === "needs_attention";
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "P2002",
  );
}

async function validateResource(resourceId: string): Promise<"ok" | "missing" | "empty"> {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { id: true, _count: { select: { messages: true } } },
  });
  if (!resource) return "missing";
  return resource._count.messages > 0 ? "ok" : "empty";
}

function respondForResourceValidation(
  result: "ok" | "missing" | "empty",
  res: Response,
): boolean {
  if (result === "missing") {
    res.status(400).json({ error: "invalid_resource" });
    return true;
  }
  if (result === "empty") {
    res.status(400).json({ error: "empty_resource" });
    return true;
  }
  return false;
}

upcomingAutomationsRouter.get("/", async (_req, res) => {
  const automations = await prisma.upcomingAutomation.findMany({
    where: { status: { not: "bound" } },
    include: {
      resource: { select: { id: true, name: true, _count: { select: { messages: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json({ automations, discoveryEnabled: env.UPCOMING_AUTOMATIONS_ENABLED });
});

upcomingAutomationsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const resourceResult = await validateResource(parsed.data.resourceId);
  if (respondForResourceValidation(resourceResult, res)) return;

  const triggerWord = normalizeKeyword(parsed.data.keyword);
  try {
    const created = await prisma.upcomingAutomation.create({
      data: {
        triggerWord,
        resourceId: parsed.data.resourceId,
        publicReply: parsed.data.publicReply,
        gateMessage: parsed.data.gateMessage,
        active: parsed.data.active ?? true,
        status: "waiting",
        createdBy: req.adminEmail ?? "unknown",
      },
    });
    await logEvent("upcoming_automation_created", {
      upcomingAutomationId: created.id,
      triggerWord,
      createdBy: req.adminEmail ?? "unknown",
    });
    res.status(201).json(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: "upcoming_keyword_reserved" });
    }
    throw error;
  }
});

upcomingAutomationsRouter.patch("/:id", async (req, res) => {
  const parsed = editableFields.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const current = await prisma.upcomingAutomation.findUnique({ where: { id: req.params.id } });
  if (!current) return res.status(404).json({ error: "not_found" });
  if (!isOpenStatus(current.status)) {
    return res.status(409).json({ error: "upcoming_automation_resolved" });
  }

  if (parsed.data.resourceId) {
    const resourceResult = await validateResource(parsed.data.resourceId);
    if (respondForResourceValidation(resourceResult, res)) return;
  }

  const data = {
    ...(parsed.data.keyword !== undefined && {
      triggerWord: normalizeKeyword(parsed.data.keyword),
    }),
    ...(parsed.data.resourceId !== undefined && { resourceId: parsed.data.resourceId }),
    ...(parsed.data.publicReply !== undefined && { publicReply: parsed.data.publicReply }),
    ...(parsed.data.gateMessage !== undefined && { gateMessage: parsed.data.gateMessage }),
    ...(parsed.data.active !== undefined && { active: parsed.data.active }),
  };

  try {
    const changed = await prisma.upcomingAutomation.updateMany({
      where: { id: req.params.id, status: { in: ["waiting", "needs_attention"] } },
      data,
    });
    if (changed.count === 0) {
      return res.status(409).json({ error: "upcoming_automation_resolved" });
    }
    const updated = await prisma.upcomingAutomation.findUnique({ where: { id: req.params.id } });
    if (!updated) return res.status(404).json({ error: "not_found" });
    await logEvent("upcoming_automation_updated", {
      upcomingAutomationId: current.id,
      triggerWord: updated.triggerWord,
      updatedBy: req.adminEmail ?? "unknown",
    });
    res.json(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: "upcoming_keyword_reserved" });
    }
    throw error;
  }
});

upcomingAutomationsRouter.post("/:id/cancel", async (req, res) => {
  const current = await prisma.upcomingAutomation.findUnique({ where: { id: req.params.id } });
  if (!current) return res.status(404).json({ error: "not_found" });
  if (!isOpenStatus(current.status)) {
    return res.status(409).json({ error: "upcoming_automation_resolved" });
  }

  const changed = await prisma.upcomingAutomation.updateMany({
    where: { id: current.id, status: { in: ["waiting", "needs_attention"] } },
    data: { status: "cancelled", cancelledAt: new Date(), errorCode: null },
  });
  if (changed.count === 0) {
    return res.status(409).json({ error: "upcoming_automation_resolved" });
  }
  const cancelled = await prisma.upcomingAutomation.findUnique({ where: { id: current.id } });
  if (!cancelled) return res.status(404).json({ error: "not_found" });
  await logEvent("upcoming_automation_cancelled", {
    upcomingAutomationId: current.id,
    triggerWord: current.triggerWord,
    cancelledBy: req.adminEmail ?? "unknown",
  });
  res.json(cancelled);
});

upcomingAutomationsRouter.post("/:id/retry", async (req, res) => {
  const current = await prisma.upcomingAutomation.findUnique({ where: { id: req.params.id } });
  if (!current) return res.status(404).json({ error: "not_found" });
  if (current.status !== "needs_attention") {
    const error = isOpenStatus(current.status)
      ? "upcoming_automation_not_retryable"
      : "upcoming_automation_resolved";
    return res.status(409).json({ error });
  }

  const changed = await prisma.upcomingAutomation.updateMany({
    where: { id: current.id, status: "needs_attention" },
    data: {
      status: "waiting",
      errorCode: null,
      lastAttemptAt: null,
      matchedMediaId: null,
      retriedAt: new Date(),
    },
  });
  if (changed.count === 0) {
    return res.status(409).json({ error: "upcoming_automation_resolved" });
  }
  const retried = await prisma.upcomingAutomation.findUnique({ where: { id: current.id } });
  if (!retried) return res.status(404).json({ error: "not_found" });
  await logEvent("upcoming_automation_retried", {
    upcomingAutomationId: current.id,
    triggerWord: current.triggerWord,
    retriedBy: req.adminEmail ?? "unknown",
  });
  res.json(retried);
});
