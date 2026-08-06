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
  claimRetryDraft,
  markSendFailed,
  markSendUncertain,
  markSent,
  queueReplyDraft,
} from "../services/replyDraftService.js";
import type { DraftActionCode } from "../services/replyDraftService.js";

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
  logger.error({ errorCode: "ai_runtime_error" }, "AI route failed");
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

  // ---- advisor --------------------------------------------------------------
  // Read-only: the advisor can answer questions about the business and link to a
  // page, and there is no route here that sends, writes or changes a setting.

  const advisorGate = (_req: Request, res: Response, next: () => void) => {
    if (!env.AI_ADVISOR_ENABLED) {
      res.status(403).json({ error: "ai_advisor_disabled" });
      return;
    }
    next();
  };

  router.get("/advisor/history", advisorGate, async (_req, res) => {
    try {
      res.json({ items: await deps.client.getAdvisorHistory() });
    } catch (error) {
      sendRuntimeError(res, error);
    }
  });

  // `.strict()`: an unexpected key means the caller is trying to widen what the
  // runtime receives, so it fails rather than being silently dropped.
  const advisorAskSchema = z
    .object({
      message: z.string().trim().min(1).max(2000),
      clientMessageId: z.string().min(1).max(128),
    })
    .strict();

  router.post("/advisor/messages", advisorGate, async (req, res) => {
    const parsed = advisorAskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      res.json(await deps.client.askAdvisor(parsed.data));
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
      const statusByCode: Record<DraftActionCode, number> = {
        draft_not_found: 404,
        stale_draft: 409,
        draft_not_pending: 409,
        draft_not_retryable: 409,
        prompt_policy_outdated: 409,
        follow_up_not_ready: 409,
        follow_up_window_closed: 409,
      };
      res.status(statusByCode[error.code]).json({ error: error.code });
      return;
    }
    logger.error({ errorCode: "draft_action_failed" }, "Draft action failed");
    res.status(500).json({ error: "internal_error" });
  }

  async function writeDraftAudit(kind: string, payload: object): Promise<void> {
    try {
      await logEvent(kind, payload);
    } catch {
      // logEvent is intentionally non-throwing, but keep the HTTP boundary safe
      // if that implementation contract ever regresses. Never log the payload.
      logger.error({ errorCode: "draft_audit_failed", kind }, "Draft audit write failed");
    }
  }

  // Edit the owner's working copy. `suggestedText` is never touched.
  router.patch("/dm-threads/:threadId/drafts/:draftId", async (req, res) => {
    const parsed = textSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_working_text" });

    try {
      const draft = await loadDraft(req.params.threadId, req.params.draftId);
      if (!draft) return res.status(404).json({ error: "draft_not_found" });
      if (draft.status !== "pending_approval") {
        return res.status(409).json({ error: "draft_not_pending" });
      }

      await prisma.replyDraft.updateMany({
        where: { id: draft.id, status: "pending_approval" },
        data: { workingText: parsed.data.workingText },
      });
      await writeDraftAudit("ai_draft_edited", {
        threadId: draft.threadId,
        draftId: draft.id,
        by: req.adminEmail ?? null,
      });
      res.status(204).end();
    } catch (error) {
      sendActionError(res, error);
    }
  });

  /**
   * Queueing is gated on the WORKER's flag, not just on the UI.
   *
   * `queueReplyDraft` only writes a `queued` row; the worker drains it, and the
   * worker returns immediately when AI_DRAFTS_ENABLED is false. Without this check
   * a click creates work nothing will ever process and the drawer shows
   * "Writing a suggestion…" permanently. A clear refusal beats a spinner that can
   * never resolve.
   *
   * Checked inline rather than as middleware: a second handler makes Express widen
   * req.params to `string | string[]`, which breaks the typed Prisma lookups. This
   * matches how AI_SEND_ENABLED is already checked on approve and retry-send.
   */
  function draftsDisabled(res: Response): boolean {
    if (env.AI_DRAFTS_ENABLED) return false;
    res.status(403).json({ error: "ai_drafts_disabled" });
    return true;
  }

  // Generate a first draft for a thread that needs a reply and has no live draft.
  router.post("/dm-threads/:threadId/drafts", async (req, res) => {
    if (draftsDisabled(res)) return;

    try {
      const thread = await prisma.dmThread.findUnique({
        where: { id: req.params.threadId },
        select: { id: true, needsReply: true, latestInboundMessageId: true },
      });
      if (!thread) return res.status(404).json({ error: "not_found" });
      if (!thread.latestInboundMessageId) {
        return res.status(409).json({ error: "no_inbound_message" });
      }

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
    if (draftsDisabled(res)) return;

    try {
      const draft = await loadDraft(req.params.threadId, req.params.draftId);
      if (!draft) return res.status(404).json({ error: "draft_not_found" });

      const thread = await prisma.dmThread.findUnique({
        where: { id: draft.threadId },
        select: { latestInboundMessageId: true },
      });
      if (!thread?.latestInboundMessageId) {
        return res.status(409).json({ error: "no_inbound_message" });
      }

      // queueReplyDraft supersedes any active draft and allocates the next revision.
      const next = await queueReplyDraft({
        threadId: draft.threadId,
        inboundMessageId: thread.latestInboundMessageId,
      });
      await writeDraftAudit("ai_draft_regenerated", {
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
    try {
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
      await writeDraftAudit("ai_draft_dismissed", {
        threadId: draft.threadId,
        draftId: draft.id,
        by: req.adminEmail ?? null,
      });
      res.status(204).end();
    } catch (error) {
      sendActionError(res, error);
    }
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
    if (!req.adminEmail) return res.status(401).json({ error: "owner_auth_required" });

    const parsed = textSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_working_text" });

    let claimed: { approvedText: string; inboundMessageId: string };
    try {
      claimed = await claimApprovedDraft({
        threadId: req.params.threadId,
        draftId: req.params.draftId,
        approvedBy: req.adminEmail,
        workingText: parsed.data.workingText,
      });
    } catch (error) {
      return sendActionError(res, error);
    }

    await deliverApprovedDraft({
      draftId: req.params.draftId,
      threadId: req.params.threadId,
      inboundMessageId: claimed.inboundMessageId,
      approvedText: claimed.approvedText,
      by: req.adminEmail,
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
    if (!req.adminEmail) return res.status(401).json({ error: "owner_auth_required" });

    const schema = z.object({ confirmedNotDelivered: z.literal(true) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "confirmation_required" });

    let claimed: { approvedText: string; inboundMessageId: string };
    try {
      claimed = await claimRetryDraft({
        threadId: req.params.threadId,
        draftId: req.params.draftId,
        confirmedNotDelivered: parsed.data.confirmedNotDelivered,
      });
    } catch (error) {
      return sendActionError(res, error);
    }

    await writeDraftAudit("ai_reply_retry_confirmed", {
      threadId: req.params.threadId,
      draftId: req.params.draftId,
      by: req.adminEmail,
    });

    await deliverApprovedDraft({
      draftId: req.params.draftId,
      threadId: req.params.threadId,
      inboundMessageId: claimed.inboundMessageId,
      approvedText: claimed.approvedText,
      by: req.adminEmail,
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
  let thread: { igUserId: string } | null;
  try {
    thread = await prisma.dmThread.findUnique({
      where: { id: input.threadId },
      select: { igUserId: true },
    });
  } catch {
    logger.error(
      { errorCode: "ai_reply_recipient_lookup_failed", draftId: input.draftId },
      "AI reply recipient lookup failed",
    );
    try {
      // Instagram was never called, so this outcome is definitely retryable.
      await markSendFailed(input.draftId, "thread_lookup_failed");
    } catch {
      logger.error(
        { errorCode: "ai_reply_send_state_write_failed", draftId: input.draftId },
        "AI reply send state write failed",
      );
    }
    input.res.status(500).json({ error: "internal_error" });
    return;
  }
  if (!thread) {
    try {
      await markSendFailed(input.draftId, "thread_missing");
    } catch {
      logger.error(
        { errorCode: "ai_reply_send_state_write_failed", draftId: input.draftId },
        "AI reply send state write failed",
      );
    }
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
      try {
        await markSendUncertain(input.draftId, errorCode);
        await logEvent("ai_reply_send_uncertain", {
          threadId: input.threadId,
          draftId: input.draftId,
          errorCode,
        });
      } catch {
        logger.error(
          { errorCode: "ai_reply_send_state_write_failed", draftId: input.draftId },
          "AI reply send state write failed",
        );
      }
      // 202: we accepted the request but cannot confirm delivery.
      input.res.status(202).json({ status: "send_uncertain", errorCode });
      return;
    }
    try {
      await markSendFailed(input.draftId, errorCode);
      await logEvent("ai_reply_send_failed", {
        threadId: input.threadId,
        draftId: input.draftId,
        errorCode,
      });
    } catch {
      logger.error(
        { errorCode: "ai_reply_send_state_write_failed", draftId: input.draftId },
        "AI reply send state write failed",
      );
      input.res.status(202).json({
        status: "send_uncertain",
        errorCode: "send_recording_unconfirmed",
      });
      return;
    }
    input.res.status(502).json({ status: "send_failed", errorCode });
    return;
  }

  try {
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
  } catch {
    logger.error(
      { errorCode: "ai_reply_send_recording_unconfirmed", draftId: input.draftId },
      "AI reply delivery recording could not be confirmed",
    );
    input.res.status(202).json({
      status: "send_uncertain",
      errorCode: "send_recording_unconfirmed",
    });
    return;
  }
  input.res.status(200).json({ status: "sent" });
}

export const aiRouter = createAiRouter({
  client: createCodexRuntimeClient({
    baseUrl: env.CODEX_RUNTIME_URL,
    token: env.CODEX_RUNTIME_TOKEN,
  }),
  isConfigured: () => Boolean(env.CODEX_RUNTIME_URL && env.CODEX_RUNTIME_TOKEN),
});
