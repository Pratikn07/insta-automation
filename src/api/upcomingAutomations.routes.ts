import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { flags } from "../services/flagService.js";
import { prisma } from "../lib/prisma.js";
import { logEvent } from "../services/eventLogger.js";
import { normalizeKeyword } from "../services/keywordService.js";
import {
  classifyCreateReplay,
  idempotencyKeyMismatch,
  isPrimaryKeyViolation,
  isUniqueViolation,
} from "./createReplay.js";

export const upcomingAutomationsRouter = Router();

/**
 * How long a resolved setup keeps its place in the list.
 *
 * A `bound` row is a receipt, not an entry: the keyword it produced is an
 * ordinary keyword and already shows on its post in the Content grid, so leaving
 * it here forever prints the same fact twice and makes the list unscannable. A
 * `cancelled` row is the owner's own deliberate act. Both linger long enough to
 * be seen and then leave.
 *
 * Open rows — `waiting` and `needs_attention` — never expire. The asymmetry is
 * the point: a success she misses costs her nothing, a failure she misses costs
 * her every commenter on that post.
 */
const RESOLVED_ROW_VISIBLE_MS = 24 * 60 * 60 * 1000;

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

// `id` is client-owned. A create whose response is lost is indistinguishable from
// one that never ran, so the browser mints the UUID, sends it in both the body and
// `Idempotency-Key`, and repeats the same one — turning "did this happen?" into a
// primary-key lookup instead of a guess.
const createSchema = editableFields
  .required({
    keyword: true,
    resourceId: true,
    publicReply: true,
    gateMessage: true,
  })
  .extend({ id: z.string().uuid() });

/**
 * Compared against the stored row on a replay. `triggerWord` is compared after
 * normalization, because the request's casing was never part of the intent.
 *
 * Server-assigned and lifecycle fields are deliberately absent: `status`,
 * `createdBy`, `matchedMediaId` and the timestamps cannot disagree with a request
 * that never mentioned them.
 */
const UPCOMING_REPLAY_KEYS = [
  "id",
  "triggerWord",
  "resourceId",
  "publicReply",
  "gateMessage",
  "active",
] as const;

type OpenStatus = "waiting" | "needs_attention";

function isOpenStatus(status: string): status is OpenStatus {
  return status === "waiting" || status === "needs_attention";
}

/**
 * The guide must exist. It does NOT have to have steps yet.
 *
 * It used to have to, and that rule was wrong twice over. It blocked the useful
 * flow — you cannot write a guide before something exists to write it into, which
 * is why the reel flow creates the guide first and opens the editor second. And it
 * did not deliver the safety it implied: the binder never looked again, so a guide
 * emptied after the setup was created would still attach days later.
 *
 * The check now lives in upcomingAutomationBinding, where it can refuse to attach
 * rather than merely refuse to plan.
 */
async function validateResource(resourceId: string): Promise<"ok" | "missing"> {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { id: true },
  });
  return resource ? "ok" : "missing";
}

/**
 * The verified owner, or 401 and null.
 *
 * `requireAdmin` already guarantees an allowlisted address on every request, so
 * this cannot fire today. It exists because the four writes below persist this
 * value into `created_by`, `updated_by`, `cancelled_by` and `retried_by` — audit
 * columns, where a fabricated `"unknown"` would be indistinguishable afterwards
 * from a real name. If the identity is ever missing, refuse rather than invent it.
 *
 * Same shape as `owner()` in guideDeliveries.routes.ts, which is the house pattern
 * for a route that must know who is acting.
 */
function owner(req: Request, res: Response): string | null {
  if (req.adminEmail) return req.adminEmail;
  res.status(401).json({ error: "owner_auth_required" });
  return null;
}

function respondForResourceValidation(result: "ok" | "missing", res: Response): boolean {
  if (result === "missing") {
    res.status(400).json({ error: "invalid_resource" });
    return true;
  }
  return false;
}

upcomingAutomationsRouter.get("/", async (_req, res) => {
  const resolvedSince = new Date(Date.now() - RESOLVED_ROW_VISIBLE_MS);

  const automations = await prisma.upcomingAutomation.findMany({
    where: {
      OR: [
        { status: { in: ["waiting", "needs_attention"] } },
        { status: "bound", boundAt: { gte: resolvedSince } },
        { status: "cancelled", cancelledAt: { gte: resolvedSince } },
      ],
    },
    include: {
      resource: { select: { id: true, name: true, _count: { select: { messages: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json({ automations, discoveryEnabled: flags.bool("UPCOMING_AUTOMATIONS_ENABLED") });
});

upcomingAutomationsRouter.post("/", async (req, res) => {
  const createdBy = owner(req, res);
  if (!createdBy) return;

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (idempotencyKeyMismatch(req.headers["idempotency-key"], parsed.data.id)) {
    return res.status(400).json({ error: "idempotency_key_mismatch" });
  }

  const resourceResult = await validateResource(parsed.data.resourceId);
  if (respondForResourceValidation(resourceResult, res)) return;

  const intended = {
    id: parsed.data.id,
    triggerWord: normalizeKeyword(parsed.data.keyword),
    resourceId: parsed.data.resourceId,
    publicReply: parsed.data.publicReply,
    gateMessage: parsed.data.gateMessage,
    active: parsed.data.active ?? true,
  };

  try {
    const created = await prisma.upcomingAutomation.create({
      data: {
        ...intended,
        status: "waiting",
        createdBy,
      },
    });
    await logEvent("upcoming_automation_created", {
      upcomingAutomationId: created.id,
      triggerWord: intended.triggerWord,
      createdBy,
    });
    res.status(201).json(created);
  } catch (error) {
    // A clash on the primary key means this exact create already happened, so the
    // answer is the stored row. A clash on the partial unique index means a
    // DIFFERENT open setup already reserves this word, which is the domain
    // duplicate and keeps its own answer.
    if (isPrimaryKeyViolation(error)) {
      const existing = await prisma.upcomingAutomation.findUnique({
        where: { id: intended.id },
      });
      if (!existing) throw error;
      if (
        classifyCreateReplay({ existing, intended, keys: UPCOMING_REPLAY_KEYS }) === "conflict"
      ) {
        return res.status(409).json({ error: "idempotency_conflict" });
      }
      return res.status(200).json(existing);
    }
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: "upcoming_keyword_reserved" });
    }
    throw error;
  }
});

upcomingAutomationsRouter.patch("/:id", async (req, res) => {
  const updatedBy = owner(req, res);
  if (!updatedBy) return;

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
      updatedBy,
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
  const cancelledBy = owner(req, res);
  if (!cancelledBy) return;

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
    cancelledBy,
  });
  res.json(cancelled);
});

upcomingAutomationsRouter.post("/:id/retry", async (req, res) => {
  const retriedBy = owner(req, res);
  if (!retriedBy) return;

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
    retriedBy,
  });
  res.json(retried);
});
