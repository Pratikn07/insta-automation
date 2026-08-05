import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { CodexRuntimeError, runtimeClient } from "./codexRuntimeClient.js";
import {
  claimOneQueuedDraft,
  completeGeneration,
  failGeneration,
  loadDraftContext,
} from "./replyDraftService.js";

/**
 * Shadow-drafting worker: turns queued drafts into pending suggestions.
 *
 * Non-throwing at the outer boundary, like every other worker in server.ts — a
 * runtime hiccup can never crash the process. It NEVER sends a message and NEVER
 * retries a generation failure: a failed draft is surfaced to the owner, who can
 * regenerate. Two drafts per tick, sequentially, to stay gentle on the single
 * ChatGPT subscription behind the runtime.
 */
const MAX_DRAFTS_PER_TICK = 2;

/** requestId per generation. crypto.randomUUID avoids a uuid dependency. */
function newRequestId(): string {
  return crypto.randomUUID();
}

export async function runReplyDraftTick(): Promise<void> {
  if (!env.AI_DRAFTS_ENABLED) return;

  try {
    // One status check per tick, not per draft: if ChatGPT is disconnected there
    // is nothing to do, and hammering the runtime would be pointless.
    const status = await runtimeClient.getConnectionStatus().catch(() => null);
    if (!status?.connected) return;

    for (let i = 0; i < MAX_DRAFTS_PER_TICK; i++) {
      const draft = await claimOneQueuedDraft();
      if (!draft) return; // queue drained before the cap

      await generateOne(draft);
    }
  } catch (err) {
    // Mirrors runGateQueueTick / runGeminiQueueTick: swallow at the boundary.
    logger.error({ err }, "runReplyDraftTick failed");
  }
}

async function generateOne(draft: { id: string; threadId: string }): Promise<void> {
  const context = await loadDraftContext(draft);
  if (!context) {
    // The thread was deleted between queueing and now. Fail the draft rather than
    // generate against nothing.
    await failGeneration(draft.id, {
      errorCode: "context_unavailable",
      errorMessage: "The conversation for this draft is no longer available.",
      retryAt: null,
    });
    return;
  }

  try {
    const suggestion = await runtimeClient.generateDmDraft({
      requestId: newRequestId(),
      participant: context.participant,
      messages: context.messages,
      brandVoice: env.AI_BRAND_VOICE,
      guideContext: context.guideContext,
    });

    await completeGeneration(draft.id, {
      suggestedText: suggestion.reply,
      workingText: suggestion.reply,
      rationale: suggestion.rationale,
      confidence: suggestion.confidence,
      warnings: suggestion.warnings,
      modelId: suggestion.modelId,
    });
  } catch (err) {
    // Only a safe category is stored. A CodexRuntimeError already IS the category;
    // anything else collapses to a generic code so a raw app-server message (which
    // can embed account or token detail) never reaches the database or the owner.
    const isKnown = err instanceof CodexRuntimeError;
    await failGeneration(draft.id, {
      errorCode: isKnown ? err.code : "draft_unavailable",
      errorMessage: describeDraftError(err),
      retryAt: isKnown ? err.retryAt : null,
    });
  }
}

/** A short, safe, owner-facing sentence. Never the raw error text. */
function describeDraftError(err: unknown): string {
  if (err instanceof CodexRuntimeError) {
    switch (err.code) {
      case "runtime_rate_limited":
        return "ChatGPT usage limit reached. Try again after it resets.";
      case "runtime_unauthorized":
        return "ChatGPT needs reconnecting before drafts can be generated.";
      case "runtime_timeout":
        return "The draft took too long to generate.";
      case "ai_not_configured":
        return "The AI runtime isn't configured.";
      default:
        return "The draft couldn't be generated. You can try again.";
    }
  }
  return "The draft couldn't be generated. You can try again.";
}
