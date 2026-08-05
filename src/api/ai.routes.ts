import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { CodexRuntimeError, createCodexRuntimeClient } from "../services/codexRuntimeClient.js";
import type { CodexRuntimeClient } from "../services/codexRuntimeClient.js";
import { sendTrackedText } from "../services/dmDeliveryService.js";
import { markThreadResolved } from "../services/dmThreadService.js";
import { logEvent } from "../services/eventLogger.js";
import { classifySendError } from "../services/replyDraftSendCore.js";
import {
  DraftActionError,
  claimApprovedDraft,
  markSendFailed,
  markSendUncertain,
  markSent,
  queueReplyDraft,
} from "../services/replyDraftService.js";

/**
 * Owner-facing AI routes. Mounted under the apiRouter, so `requireAdmin` has
 * already run — but nothing here trusts the runtime's output shape or forwards
 * its error text, because a runtime message can carry account detail.
 *
 * The client is injected so tests can drive failure modes without a live
 * runtime; production uses the env-configured singleton below.
 */
export interface AiRouterDependencies {
  client: CodexRuntimeClient;
  isConfigured: () => boolean;
}

/** Translate a runtime failure into a browser-safe status and code. */
function sendRuntimeError(res: Response, error: unknown): void {
  if (error instanceof CodexRuntimeError) {
    const status =
      error.code === "ai_not_configured"
        ? 503
        : error.code === "runtime_rate_limited"
          ? 429
          : error.code === "runtime_unauthorized"
            ? 502
            : error.code === "runtime_timeout" || error.code === "runtime_unavailable"
              ? 503
              : 502;
    res.status(status).json({
      error: error.code,
      retryAt: error.retryAt ? error.retryAt.toISOString() : null,
    });
    return;
  }
  // Unexpected failures are logged server-side only. The message can embed a
  // token or account detail, so the browser gets a generic code.
  logger.error({ err: error }, "AI route failed");
  res.status(502).json({ error: "ai_runtime_error" });
}

export function createAiRouter(deps: AiRouterDependencies): Router {
  const router = Router();

  // One guard for every route: an unconfigured runtime is answered identically
  // and without touching the client, so a partial deploy cannot half-work.
  router.use((_req: Request, res: Response, next) => {
    if (!deps.isConfigured()) {
      res.status(503).json({ error: "ai_not_configured" });
      return;
    }
    next();
  });

  router.get("/connection", async (req, res) => {
    try {
      res.json(await deps.client.getConnectionStatus(req.query.refresh === "true"));
    } catch (error) {
      sendRuntimeError(res, error);
    }
  });

  router.post("/connection", async (_req, res) => {
    try {
      res.json(await deps.client.startDeviceLogin());
    } catch (error) {
      sendRuntimeError(res, error);
    }
  });

  router.post("/disconnect", async (_req, res) => {
    try {
      await deps.client.disconnect();
      res.status(204).end();
    } catch (error) {
      sendRuntimeError(res, error);
    }
  });

  // ---- draft mutations ------------------------------------------------------
  // Every route below acts on ONE draft of ONE thread. Approve and retry-send are
  // additionally gated on AI_SEND_ENABLED, because they are the only paths in the
  // product that put an AI-derived message in front of a real person.

  const textSchema = z.object({ workingText: z.string().trim().min(1).max(1000) });

  /** Load a draft and confirm it belongs to the thread in the URL. */
  async function loadDraft(threadId: string, draftId: string) {
    const draft = await prisma.replyDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.threadId !== threadId) return null;
    return draft;
  }

  function sendActionError(res: Response, error: unknown): void {
    if (error instanceof DraftActionError) {
      const status = error.code === "draft_not_found" ? 404 : 409;
      res.status(status).json({ error: error.code });
      return;
    }
    logger.error({ err: error }, "Draft action failed");
    res.status(500).json({ error: "internal_error" });
  }

  // Edit the owner's working copy. `suggestedText` is never touched.
  router.patch("/dm-threads/:threadId/drafts/:draftId", async (req, res) => {
    const parsed = textSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const draft = await loadDraft(req.params.threadId, req.params.draftId);
    if (!draft) return res.status(404).json({ error: "draft_not_found" });
    if (draft.status !== "pending_approval") {
      return res.status(409).json({ error: "draft_not_pending" });
    }

    await prisma.replyDraft.updateMany({
      where: { id: draft.id, status: "pending_approval" },
      data: { workingText: parsed.data.workingText },
    });
    await logEvent("ai_draft_edited", {
      threadId: draft.threadId,
      draftId: draft.id,
      by: req.adminEmail ?? null,
    });
    res.status(204).end();
  });

  // Generate a first draft for a thread that needs a reply and has no live draft.
  router.post("/dm-threads/:threadId/drafts", async (req, res) => {
    const thread = await prisma.dmThread.findUnique({
      where: { id: req.params.threadId },
      select: { id: true, needsReply: true, latestInboundMessageId: true },
    });
    if (!thread) return res.status(404).json({ error: "not_found" });
    if (!thread.latestInboundMessageId) {
      return res.status(409).json({ error: "no_inbound_message" });
    }

    try {
      const draft = await queueReplyDraft({
        threadId: thread.id,
        inboundMessageId: thread.latestInboundMessageId,
      });
      res.status(202).json({ draftId: draft.id, status: draft.status });
    } catch (error) {
      sendActionError(res, error);
    }
  });

  // Supersede the current draft and queue a fresh revision for the same inbound.
  router.post("/dm-threads/:threadId/drafts/:draftId/regenerate", async (req, res) => {
    const draft = await loadDraft(req.params.threadId, req.params.draftId);
    if (!draft) return res.status(404).json({ error: "draft_not_found" });

    const thread = await prisma.dmThread.findUnique({
      where: { id: draft.threadId },
      select: { latestInboundMessageId: true },
    });
    if (!thread?.latestInboundMessageId) {
      return res.status(409).json({ error: "no_inbound_message" });
    }

    try {
      // queueReplyDraft supersedes any active draft and allocates the next revision.
      const next = await queueReplyDraft({
        threadId: draft.threadId,
        inboundMessageId: thread.latestInboundMessageId,
      });
      await logEvent("ai_draft_regenerated", {
        threadId: draft.threadId,
        previousDraftId: draft.id,
        draftId: next.id,
        by: req.adminEmail ?? null,
      });
      res.status(202).json({ draftId: next.id, status: next.status });
    } catch (error) {
      sendActionError(res, error);
    }
  });

  router.post("/dm-threads/:threadId/drafts/:draftId/dismiss", async (req, res) => {
    const draft = await loadDraft(req.params.threadId, req.params.draftId);
    if (!draft) return res.status(404).json({ error: "draft_not_found" });
    if (draft.status !== "pending_approval" && draft.status !== "generation_failed") {
      return res.status(409).json({ error: "draft_not_pending" });
    }

    await prisma.replyDraft.updateMany({
      where: { id: draft.id, status: draft.status },
      data: { status: "dismissed" },
    });
    // Dismissing means "I've handled this myself", so the thread stops asking —
    // but only if this is still the latest inbound.
    await markThreadResolved({
      threadId: draft.threadId,
      inboundMessageId: draft.inboundMessageId,
    });
    await logEvent("ai_draft_dismissed", {
      threadId: draft.threadId,
      draftId: draft.id,
      by: req.adminEmail ?? null,
    });
    res.status(204).end();
  });

  /**
   * Approve and send.
   *
   * The claim transaction ENDS before Instagram is touched — a Graph request can
   * hang for a minute and must never hold a Postgres transaction open. After the
   * claim, exactly one caller owns the draft, so `sendTrackedText` runs once.
   */
  router.post("/dm-threads/:threadId/drafts/:draftId/approve", async (req, res) => {
    if (!env.AI_SEND_ENABLED) return res.status(403).json({ error: "ai_send_disabled" });

    const parsed = textSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const draft = await loadDraft(req.params.threadId, req.params.draftId);
    if (!draft) return res.status(404).json({ error: "draft_not_found" });

    try {
      await claimApprovedDraft({
        threadId: draft.threadId,
        draftId: draft.id,
        approvedBy: req.adminEmail ?? "unknown",
        workingText: parsed.data.workingText,
      });
    } catch (error) {
      return sendActionError(res, error);
    }

    await deliverApprovedDraft({
      draftId: draft.id,
      threadId: draft.threadId,
      inboundMessageId: draft.inboundMessageId,
      approvedText: parsed.data.workingText,
      by: req.adminEmail ?? null,
      res,
    });
  });

  /**
   * Retry a send the owner has decided is safe to repeat.
   *
   * `confirmedNotDelivered` is required for BOTH failure states. For send_failed it
   * is a formality; for send_uncertain it is the whole point — the message may
   * already be in someone's inbox, and only the owner can check.
   */
  router.post("/dm-threads/:threadId/drafts/:draftId/retry-send", async (req, res) => {
    if (!env.AI_SEND_ENABLED) return res.status(403).json({ error: "ai_send_disabled" });

    const schema = z.object({ confirmedNotDelivered: z.literal(true) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "confirmation_required" });

    const draft = await loadDraft(req.params.threadId, req.params.draftId);
    if (!draft) return res.status(404).json({ error: "draft_not_found" });
    if (draft.status !== "send_failed" && draft.status !== "send_uncertain") {
      return res.status(409).json({ error: "draft_not_retryable" });
    }
    const text = draft.approvedText;
    if (!text) return res.status(409).json({ error: "no_approved_text" });

    // Re-claim into `sending` so a double retry cannot double-send.
    const claim = await prisma.replyDraft.updateMany({
      where: { id: draft.id, status: draft.status },
      data: { status: "sending", errorCode: null },
    });
    if (claim.count !== 1) return res.status(409).json({ error: "draft_not_retryable" });

    await logEvent("ai_reply_retry_confirmed", {
      threadId: draft.threadId,
      draftId: draft.id,
      previousStatus: draft.status,
      by: req.adminEmail ?? null,
    });

    await deliverApprovedDraft({
      draftId: draft.id,
      threadId: draft.threadId,
      inboundMessageId: draft.inboundMessageId,
      approvedText: text,
      by: req.adminEmail ?? null,
      res,
    });
  });

  return router;
}

/**
 * Perform the one Instagram send for an already-claimed draft, and record the
 * outcome. Called with NO transaction open.
 *
 * A Graph response means Meta refused it — nothing was delivered, so `send_failed`
 * and a retry is safe. No response means we genuinely do not know, so
 * `send_uncertain`, which is NEVER retried automatically.
 */
async function deliverApprovedDraft(input: {
  draftId: string;
  threadId: string;
  inboundMessageId: string;
  approvedText: string;
  by: string | null;
  res: Response;
}): Promise<void> {
  const thread = await prisma.dmThread.findUnique({
    where: { id: input.threadId },
    select: { igUserId: true },
  });
  if (!thread) {
    await markSendFailed(input.draftId, "thread_missing");
    input.res.status(409).json({ error: "thread_missing" });
    return;
  }

  try {
    await sendTrackedText({
      recipientIgUserId: thread.igUserId,
      text: input.approvedText,
      source: "ai_approved",
    });
  } catch (error) {
    const { outcome, errorCode } = classifySendError(error);
    if (outcome === "uncertain") {
      await markSendUncertain(input.draftId, errorCode);
      await logEvent("ai_reply_send_uncertain", {
        threadId: input.threadId,
        draftId: input.draftId,
        errorCode,
      });
      // 202: we accepted the request but cannot confirm delivery.
      input.res.status(202).json({ status: "send_uncertain", errorCode });
      return;
    }
    await markSendFailed(input.draftId, errorCode);
    await logEvent("ai_reply_send_failed", {
      threadId: input.threadId,
      draftId: input.draftId,
      errorCode,
    });
    input.res.status(502).json({ status: "send_failed", errorCode });
    return;
  }

  await markSent(input.draftId);
  await markThreadResolved({
    threadId: input.threadId,
    inboundMessageId: input.inboundMessageId,
  });
  await logEvent("ai_reply_sent", {
    threadId: input.threadId,
    draftId: input.draftId,
    by: input.by,
    length: input.approvedText.length,
  });
  input.res.status(200).json({ status: "sent" });
}

export const aiRouter = createAiRouter({
  client: createCodexRuntimeClient({
    baseUrl: env.CODEX_RUNTIME_URL,
    token: env.CODEX_RUNTIME_TOKEN,
  }),
  isConfigured: () => Boolean(env.CODEX_RUNTIME_URL && env.CODEX_RUNTIME_TOKEN),
});
