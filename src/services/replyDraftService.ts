import type { ReplyDraft } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { DmDraftRequest } from "./codexRuntimeClient.js";
import { ACTIVE_DRAFT_STATUSES } from "./replyDraftMachine.js";
import { CURRENT_DM_PROMPT_VERSION } from "./replyDraftPolicy.js";

/** How much conversation the drafter sees: recent, and bounded. */
const CONTEXT_MESSAGE_LIMIT = 20;
const CONTEXT_CHAR_BUDGET = 8_000;

/**
 * Creating and advancing reply drafts.
 *
 * Task 7 extends this file with generation completion; Task 8 with the approval
 * claim. `queueReplyDraft` lands here now so Task 5 can call it without leaving a
 * broken intermediate commit.
 */

/** Prisma's unique-constraint code — the partial index rejecting a second active draft. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Queue a draft for a thread's latest inbound message.
 *
 * Revisions are allocated as `max(revision) + 1` rather than a count, so a
 * regenerate after a dismissal still gets a fresh number and the audit trail
 * stays ordered.
 *
 * Two webhooks for the same thread can race here. Rather than lock, we let the
 * database's partial unique index arbitrate: the loser catches the violation and
 * returns the winning active draft, because both callers only want "the active
 * draft for this thread".
 */
export interface QueueReplyDraftInput {
  threadId: string;
  inboundMessageId: string;
  kind?: "reply" | "engagement_follow_up";
  sourceConversationId?: string | null;
  eligibleAt?: Date;
  expiresAt?: Date | null;
}

export async function queueReplyDraft(input: QueueReplyDraftInput): Promise<ReplyDraft> {
  const eligibleAt = input.eligibleAt ?? new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      const highest = await tx.replyDraft.aggregate({
        where: { threadId: input.threadId },
        _max: { revision: true },
      });
      const revision = (highest._max.revision ?? 0) + 1;

      // Supersede first so the partial unique index has room for the new row.
      await tx.replyDraft.updateMany({
        where: { threadId: input.threadId, status: { in: [...ACTIVE_DRAFT_STATUSES] } },
        data: { status: "superseded" },
      });

      return await tx.replyDraft.create({
        data: {
          threadId: input.threadId,
          inboundMessageId: input.inboundMessageId,
          revision,
          status: "queued",
          kind: input.kind ?? "reply",
          sourceConversationId: input.sourceConversationId ?? null,
          eligibleAt,
          nextAttemptAt: eligibleAt,
          expiresAt: input.expiresAt ?? null,
          promptVersion: CURRENT_DM_PROMPT_VERSION,
        },
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // Prisma marks a transaction that hit P2002 as aborted. The transaction has
    // fully rolled back before this root-client lookup runs, so it can see the
    // concurrent winner without issuing another query on the failed transaction.
    const winner = await prisma.replyDraft.findFirst({
      where: { threadId: input.threadId, status: { in: [...ACTIVE_DRAFT_STATUSES] } },
      orderBy: { revision: "desc" },
    });
    if (!winner) throw error;
    return winner;
  }
}

/**
 * Claim the oldest due queued draft by flipping it to `generating`.
 *
 * The claim is a conditional `updateMany` on `status: queued`: only the worker
 * whose update actually changes the row owns it, so two overlapping ticks can
 * never generate the same draft twice. Returns null when nothing is due or the
 * race was lost.
 */
export async function claimOneQueuedDraft(): Promise<ReplyDraft | null> {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.replyDraft.findFirst({
      where: { status: "queued", nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!candidate) return null;

    const claim = await tx.replyDraft.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: { status: "generating" },
    });
    if (claim.count !== 1) return null; // another worker won it

    return tx.replyDraft.findUnique({ where: { id: candidate.id } });
  });
}

export interface DraftContext {
  participant: DmDraftRequest["participant"];
  messages: DmDraftRequest["messages"];
  guideContext: DmDraftRequest["guideContext"];
}

/**
 * Load the bounded transcript a draft needs. Newest 20 messages, then trimmed to
 * an 8,000-char budget from the oldest end, and returned oldest-first so the
 * drafter reads the conversation in order. Returns null if the thread vanished.
 */
export async function loadDraftContext(draft: {
  threadId: string;
}): Promise<DraftContext | null> {
  const thread = await prisma.dmThread.findUnique({
    where: { id: draft.threadId },
    select: { username: true, name: true, igUserId: true },
  });
  if (!thread) return null;

  const recent = await prisma.dmMessage.findMany({
    where: { threadId: draft.threadId },
    orderBy: { instagramTimestamp: "desc" },
    take: CONTEXT_MESSAGE_LIMIT,
    select: { direction: true, text: true, type: true, source: true, instagramTimestamp: true },
  });

  // recent is newest-first; walk it keeping a running char budget, then reverse
  // to oldest-first for the model.
  const kept: typeof recent = [];
  let budget = CONTEXT_CHAR_BUDGET;
  for (const m of recent) {
    const cost = m.text?.length ?? 0;
    if (kept.length > 0 && cost > budget) break;
    kept.push(m);
    budget -= cost;
  }
  kept.reverse();

  return {
    participant: { igUserId: thread.igUserId, username: thread.username, name: thread.name },
    messages: kept.map((m) => ({
      direction: m.direction,
      text: m.text,
      messageType: m.type,
      source: m.source,
      at: m.instagramTimestamp.toISOString(),
    })),
    // Widening to the full catalog is a deliberate follow-on; for now the drafter
    // gets no guide unless a later task supplies one.
    guideContext: null,
  };
}

export interface CompleteGenerationInput {
  suggestedText: string;
  workingText: string;
  rationale: string;
  confidence: string;
  warnings: string[];
  modelId: string | null;
}

/**
 * Finish a generating draft.
 *
 * Transitions to `pending_approval` ONLY if the draft is still `generating` AND
 * the thread's latest inbound is still the one this draft answers. If a newer
 * inbound arrived mid-generation, the draft is stale and is superseded instead —
 * the owner must never be shown a reply to a message that is no longer the latest.
 */
export async function completeGeneration(
  draftId: string,
  input: CompleteGenerationInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const draft = await tx.replyDraft.findUnique({
      where: { id: draftId },
      select: { status: true, threadId: true, inboundMessageId: true },
    });
    if (!draft || draft.status !== "generating") return; // dismissed/superseded meanwhile

    const thread = await tx.dmThread.findUnique({
      where: { id: draft.threadId },
      select: { latestInboundMessageId: true },
    });
    const stillLatest = thread?.latestInboundMessageId === draft.inboundMessageId;

    if (!stillLatest) {
      await tx.replyDraft.updateMany({
        where: { id: draftId, status: "generating" },
        data: { status: "superseded" },
      });
      return;
    }

    await tx.replyDraft.updateMany({
      where: { id: draftId, status: "generating" },
      data: {
        status: "pending_approval",
        suggestedText: input.suggestedText,
        workingText: input.workingText,
        rationale: input.rationale,
        confidence: input.confidence,
        warnings: input.warnings,
        modelId: input.modelId,
        attempts: { increment: 1 },
        errorCode: null,
        errorMessage: null,
        retryAt: null,
      },
    });
  });
}

/** A rejected owner action. The code maps directly to an HTTP status in the route. */
export type DraftActionCode = "stale_draft" | "draft_not_pending" | "draft_not_found";

export class DraftActionError extends Error {
  readonly code: DraftActionCode;
  constructor(code: DraftActionCode) {
    super(code);
    this.name = "DraftActionError";
    this.code = code;
  }
}

export interface FailGenerationInput {
  errorCode: string;
  errorMessage: string;
  retryAt: Date | null;
}

/**
 * Record a generation failure. Moves `generating -> generation_failed` and stores
 * a SHORT safe category — never a raw app-server frame or prompt text. The owner
 * sees it and can regenerate; no worker retries it automatically.
 */
export async function failGeneration(
  draftId: string,
  input: FailGenerationInput,
): Promise<void> {
  await prisma.replyDraft.updateMany({
    where: { id: draftId, status: "generating" },
    data: {
      status: "generation_failed",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      retryAt: input.retryAt,
      failedAt: new Date(),
    },
  });
}

/**
 * Claim a pending draft for sending, on the owner's explicit approval.
 *
 * This is the single most safety-critical function in the feature — the only path
 * that turns an AI suggestion into an Instagram message. Three rules:
 *
 * 1. `approvedText` is the text the OWNER SAW, passed in from the editor. Never
 *    the model's original `suggestedText`, which stays immutable for audit.
 * 2. The draft must still answer the thread's LATEST inbound. A newer message
 *    means the reply is stale and must not be sent.
 * 3. The claim is a conditional `updateMany`, and the transaction ENDS before the
 *    caller touches Instagram. Two parallel approvals therefore yield one
 *    `count === 1` and one rejection, and no Postgres transaction is ever held
 *    open across a Graph request that could hang for a minute.
 */
export async function claimApprovedDraft(input: {
  threadId: string;
  draftId: string;
  approvedBy: string;
  workingText: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const draft = await tx.replyDraft.findUnique({
      where: { id: input.draftId },
      select: { threadId: true, inboundMessageId: true, status: true },
    });
    if (!draft || draft.threadId !== input.threadId) {
      throw new DraftActionError("draft_not_found");
    }
    if (draft.status !== "pending_approval") {
      throw new DraftActionError("draft_not_pending");
    }

    const thread = await tx.dmThread.findUnique({
      where: { id: input.threadId },
      select: { latestInboundMessageId: true },
    });
    if (thread?.latestInboundMessageId !== draft.inboundMessageId) {
      throw new DraftActionError("stale_draft");
    }

    const claim = await tx.replyDraft.updateMany({
      where: {
        id: input.draftId,
        threadId: input.threadId,
        inboundMessageId: draft.inboundMessageId,
        status: "pending_approval",
      },
      data: {
        workingText: input.workingText,
        approvedText: input.workingText,
        approvedBy: input.approvedBy,
        approvedAt: new Date(),
        status: "sending",
      },
    });
    // Lost the race to a concurrent approval — the winner is already sending.
    if (claim.count !== 1) throw new DraftActionError("draft_not_pending");
  });
}

/** Confirmed delivery. */
export async function markSent(draftId: string): Promise<void> {
  await prisma.replyDraft.updateMany({
    where: { id: draftId, status: "sending" },
    data: { status: "sent", sentAt: new Date(), errorCode: null, errorMessage: null },
  });
}

/** A definite Graph rejection: nothing was delivered, so a retry is safe to offer. */
export async function markSendFailed(draftId: string, errorCode: string): Promise<void> {
  await prisma.replyDraft.updateMany({
    where: { id: draftId, status: "sending" },
    data: { status: "send_failed", errorCode, failedAt: new Date() },
  });
}

/**
 * A timeout or socket reset: the message MAY have been delivered.
 *
 * Never retried automatically — that is the whole reason this state exists. The UI
 * makes the owner confirm they checked Instagram before offering a retry.
 */
export async function markSendUncertain(draftId: string, errorCode: string): Promise<void> {
  await prisma.replyDraft.updateMany({
    where: { id: draftId, status: "sending" },
    data: { status: "send_uncertain", errorCode, failedAt: new Date() },
  });
}
