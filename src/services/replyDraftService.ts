import type { ReplyDraft } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { DmDraftRequest } from "./codexRuntimeClient.js";
import { ACTIVE_DRAFT_STATUSES } from "./replyDraftMachine.js";
import { CURRENT_DM_PROMPT_VERSION } from "./replyDraftPolicy.js";

/** How much conversation the drafter sees: recent, and bounded. */
const CONTEXT_MESSAGE_LIMIT = 20;
const CONTEXT_CHAR_BUDGET = 8_000;
const CONTEXT_MESSAGE_CHAR_LIMIT = 2_000;

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
export async function claimOneQueuedDraft(now = new Date()): Promise<ReplyDraft | null> {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.replyDraft.findFirst({
      where: {
        status: "queued",
        eligibleAt: { lte: now },
        nextAttemptAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
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

/** Close every follow-up whose owner-review window has elapsed. */
export async function expireDueFollowUps(now = new Date()): Promise<number> {
  const result = await prisma.replyDraft.updateMany({
    where: {
      kind: "engagement_follow_up",
      status: {
        in: ["queued", "generating", "generation_failed", "pending_approval", "send_failed"],
      },
      expiresAt: { lte: now },
    },
    data: { status: "expired", errorCode: "follow_up_window_closed" },
  });
  return result.count;
}

type DraftContextBase = {
  participant: DmDraftRequest["participant"];
  messages: DmDraftRequest["messages"];
};

type DraftKindContext =
  | { kind: "reply"; guideDeliveredAt: null; guideContext: null }
  | Pick<
      Extract<DmDraftRequest, { kind: "engagement_follow_up" }>,
      "kind" | "guideDeliveredAt" | "guideContext"
    >;

export type DraftContext = DraftContextBase & DraftKindContext;

/**
 * Load the bounded transcript a draft needs. Newest 20 messages, then trimmed to
 * an 8,000-char budget from the oldest end, and returned oldest-first so the
 * drafter reads the conversation in order. Returns null if the draft is no
 * longer generating or its required thread/source conversation vanished.
 */
export async function loadDraftContext(draft: {
  id: string;
  threadId: string;
  kind: "reply" | "engagement_follow_up";
  sourceConversationId: string | null;
  expiresAt: Date | null;
}): Promise<DraftContext | null> {
  // A genuine newer inbound supersedes a generating draft in the inbound
  // transaction. Re-read the state before loading private content so superseded
  // work never reaches the runtime.
  const current = await prisma.replyDraft.findUnique({
    where: { id: draft.id },
    select: { status: true },
  });
  if (current?.status !== "generating") return null;

  const thread = await prisma.dmThread.findUnique({
    where: { id: draft.threadId },
    select: { username: true, name: true, igUserId: true },
  });
  if (!thread) return null;

  let kindContext: DraftKindContext;
  if (draft.kind === "engagement_follow_up") {
    if (!draft.sourceConversationId) return null;
    const source = await prisma.conversation.findUnique({
      where: { id: draft.sourceConversationId },
      select: {
        completedAt: true,
        keyword: {
          select: {
            keyword: true,
            resource: { select: { name: true, description: true } },
          },
        },
      },
    });
    if (!source?.completedAt) return null;
    kindContext = {
      kind: "engagement_follow_up",
      guideDeliveredAt: source.completedAt.toISOString(),
      guideContext: {
        keyword: source.keyword.keyword,
        resourceName: source.keyword.resource.name,
        description: source.keyword.resource.description,
      },
    };
  } else {
    kindContext = { kind: "reply", guideDeliveredAt: null, guideContext: null };
  }

  const recent = await prisma.dmMessage.findMany({
    where: { threadId: draft.threadId },
    orderBy: [
      { instagramTimestamp: "desc" },
      { instagramMessageId: "desc" },
    ],
    take: CONTEXT_MESSAGE_LIMIT,
    select: { direction: true, text: true, type: true, source: true, instagramTimestamp: true },
  });

  // recent is newest-first; walk it keeping a running char budget, then reverse
  // to oldest-first for the model.
  const boundedRecent = recent.map((message) => ({
    ...message,
    text: message.text?.slice(0, CONTEXT_MESSAGE_CHAR_LIMIT) ?? null,
  }));
  const kept: typeof boundedRecent = [];
  let budget = CONTEXT_CHAR_BUDGET;
  for (const m of boundedRecent) {
    const cost = m.text?.length ?? 0;
    if (kept.length > 0 && cost > budget) break;
    kept.push(m);
    budget -= cost;
  }
  kept.reverse();

  // Context reads are separate, short queries. A genuine inbound may supersede
  // the draft while they run, so make the final read immediately before handing
  // private context back to the worker.
  const stillGenerating = await prisma.replyDraft.findUnique({
    where: { id: draft.id },
    select: { status: true },
  });
  if (stillGenerating?.status !== "generating") return null;

  return {
    ...kindContext,
    participant: { igUserId: thread.igUserId, username: thread.username, name: thread.name },
    messages: kept.map((m) => ({
      direction: m.direction,
      text: m.text,
      messageType: m.type,
      source: m.source,
      at: m.instagramTimestamp.toISOString(),
    })),
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
      select: {
        status: true,
        threadId: true,
        inboundMessageId: true,
        kind: true,
        expiresAt: true,
      },
    });
    if (!draft || draft.status !== "generating") return; // dismissed/superseded meanwhile

    if (
      draft.kind === "engagement_follow_up" &&
      draft.expiresAt !== null &&
      draft.expiresAt <= new Date()
    ) {
      await tx.replyDraft.updateMany({
        where: { id: draftId, status: "generating" },
        data: { status: "expired", errorCode: "follow_up_window_closed" },
      });
      return;
    }

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

    const completionData = {
      status: "pending_approval" as const,
      suggestedText: input.suggestedText,
      workingText: input.workingText,
      rationale: input.rationale,
      confidence: input.confidence,
      warnings: input.warnings,
      modelId: input.modelId,
      promptVersion: CURRENT_DM_PROMPT_VERSION,
      attempts: { increment: 1 },
      errorCode: null,
      errorMessage: null,
      retryAt: null,
    };

    if (draft.kind === "engagement_follow_up") {
      // clock_timestamp() is evaluated by Postgres at the final write boundary.
      // A deadline crossing after the reads above therefore loses this update;
      // no transaction or row lock is held across the earlier runtime call.
      const completed = await tx.$executeRaw`
        UPDATE "reply_draft"
        SET
          "status" = 'pending_approval',
          "suggested_text" = ${input.suggestedText},
          "working_text" = ${input.workingText},
          "rationale" = ${input.rationale},
          "confidence" = ${input.confidence},
          "warnings" = ${JSON.stringify(input.warnings)}::jsonb,
          "model_id" = ${input.modelId},
          "prompt_version" = ${CURRENT_DM_PROMPT_VERSION},
          "attempts" = "attempts" + 1,
          "error_code" = NULL,
          "error_message" = NULL,
          "retry_at" = NULL,
          "updated_at" = clock_timestamp()
        WHERE "id" = ${draftId}::uuid
          AND "status" = 'generating'
          AND "kind" = 'engagement_follow_up'
          AND "expires_at" > clock_timestamp()
      `;
      if (completed !== 1) {
        // If the row is still generating, the guarded write can only have lost
        // because its deadline elapsed. Concurrent supersession/dismissal keeps
        // its own state because this fallback is conditional too.
        await tx.replyDraft.updateMany({
          where: { id: draftId, status: "generating", kind: "engagement_follow_up" },
          data: { status: "expired", errorCode: "follow_up_window_closed" },
        });
      }
      return;
    }

    await tx.replyDraft.updateMany({
      where: { id: draftId, status: "generating" },
      data: completionData,
    });
  });
}

/** A rejected owner action. The code maps directly to an HTTP status in the route. */
export type DraftActionCode =
  | "stale_draft"
  | "draft_not_pending"
  | "draft_not_found"
  | "prompt_policy_outdated"
  | "follow_up_not_ready"
  | "follow_up_window_closed"
  | "draft_not_retryable";

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
}, now = new Date()): Promise<{ approvedText: string; inboundMessageId: string }> {
  return prisma.$transaction(async (tx) => {
    const draft = await tx.replyDraft.findUnique({
      where: { id: input.draftId },
      select: {
        threadId: true,
        inboundMessageId: true,
        status: true,
        kind: true,
        promptVersion: true,
        eligibleAt: true,
        expiresAt: true,
      },
    });
    if (!draft || draft.threadId !== input.threadId) {
      throw new DraftActionError("draft_not_found");
    }
    if (draft.status !== "pending_approval") {
      throw new DraftActionError("draft_not_pending");
    }
    if (draft.promptVersion !== CURRENT_DM_PROMPT_VERSION) {
      throw new DraftActionError("prompt_policy_outdated");
    }
    if (draft.kind === "engagement_follow_up") {
      if (now < draft.eligibleAt) throw new DraftActionError("follow_up_not_ready");
      if (draft.expiresAt === null || now >= draft.expiresAt) {
        throw new DraftActionError("follow_up_window_closed");
      }
    }

    const thread = await tx.dmThread.findUnique({
      where: { id: input.threadId },
      select: { latestInboundMessageId: true },
    });
    if (thread?.latestInboundMessageId !== draft.inboundMessageId) {
      throw new DraftActionError("stale_draft");
    }

    const approvedText = input.workingText.trim();
    const claim =
      draft.kind === "engagement_follow_up"
        ? {
            count: await tx.$executeRaw`
              UPDATE "reply_draft" AS draft
              SET
                "working_text" = ${approvedText},
                "approved_text" = ${approvedText},
                "approved_by" = ${input.approvedBy},
                "approved_at" = ${now},
                "status" = 'sending',
                "updated_at" = clock_timestamp()
              WHERE draft."id" = ${input.draftId}::uuid
                AND draft."thread_id" = ${input.threadId}::uuid
                AND draft."inbound_message_id" = ${draft.inboundMessageId}::uuid
                AND draft."status" = 'pending_approval'
                AND draft."prompt_version" = ${CURRENT_DM_PROMPT_VERSION}
                AND draft."kind" = 'engagement_follow_up'
                AND draft."eligible_at" <= clock_timestamp()
                AND draft."expires_at" > clock_timestamp()
                AND EXISTS (
                  SELECT 1
                  FROM "dm_thread" AS thread
                  WHERE thread."id" = draft."thread_id"
                    AND thread."latest_inbound_message_id" = draft."inbound_message_id"
                )
            `,
          }
        : await tx.replyDraft.updateMany({
            where: {
              id: input.draftId,
              threadId: input.threadId,
              inboundMessageId: draft.inboundMessageId,
              status: "pending_approval",
              kind: "reply",
              promptVersion: CURRENT_DM_PROMPT_VERSION,
              thread: { latestInboundMessageId: draft.inboundMessageId },
            },
            data: {
              workingText: approvedText,
              approvedText,
              approvedBy: input.approvedBy,
              approvedAt: now,
              status: "sending",
            },
          });
    // Lost the race to a concurrent approval — the winner is already sending.
    if (claim.count !== 1) {
      const current = await tx.replyDraft.findUnique({
        where: { id: input.draftId },
        select: { status: true },
      });
      if (current?.status !== "pending_approval") {
        throw new DraftActionError("draft_not_pending");
      }
      const currentThread = await tx.dmThread.findUnique({
        where: { id: input.threadId },
        select: { latestInboundMessageId: true },
      });
      if (currentThread?.latestInboundMessageId !== draft.inboundMessageId) {
        throw new DraftActionError("stale_draft");
      }
      // The remaining follow-up-only predicate is the database clock. If it
      // crossed expiresAt after the application pre-check, fail closed.
      if (draft.kind === "engagement_follow_up") {
        throw new DraftActionError("follow_up_window_closed");
      }
      throw new DraftActionError("draft_not_pending");
    }

    return { approvedText, inboundMessageId: draft.inboundMessageId };
  });
}

/**
 * Reclaim a definitely-undelivered or owner-checked uncertain send.
 *
 * This is the only retry entrypoint. It repeats the same prompt, freshness and
 * follow-up deadline checks as first approval and returns only the immutable text
 * the owner previously approved. The transaction ends before Instagram is called.
 */
export async function claimRetryDraft(input: {
  threadId: string;
  draftId: string;
  confirmedNotDelivered: true;
}, now = new Date()): Promise<{ approvedText: string; inboundMessageId: string }> {
  return prisma.$transaction(async (tx) => {
    const draft = await tx.replyDraft.findUnique({
      where: { id: input.draftId },
      select: {
        threadId: true,
        inboundMessageId: true,
        status: true,
        kind: true,
        promptVersion: true,
        eligibleAt: true,
        expiresAt: true,
        approvedText: true,
      },
    });
    if (!draft || draft.threadId !== input.threadId) {
      throw new DraftActionError("draft_not_found");
    }
    if (
      input.confirmedNotDelivered !== true ||
      (draft.status !== "send_failed" && draft.status !== "send_uncertain") ||
      !draft.approvedText
    ) {
      throw new DraftActionError("draft_not_retryable");
    }
    if (draft.promptVersion !== CURRENT_DM_PROMPT_VERSION) {
      throw new DraftActionError("prompt_policy_outdated");
    }
    if (draft.kind === "engagement_follow_up") {
      if (now < draft.eligibleAt) throw new DraftActionError("follow_up_not_ready");
      if (draft.expiresAt === null || now >= draft.expiresAt) {
        throw new DraftActionError("follow_up_window_closed");
      }
    }

    const thread = await tx.dmThread.findUnique({
      where: { id: input.threadId },
      select: { latestInboundMessageId: true },
    });
    if (thread?.latestInboundMessageId !== draft.inboundMessageId) {
      throw new DraftActionError("stale_draft");
    }

    const retryableStatuses = ["send_failed", "send_uncertain"] as const;
    const claim =
      draft.kind === "engagement_follow_up"
        ? {
            count: await tx.$executeRaw`
              UPDATE "reply_draft" AS draft
              SET
                "status" = 'sending',
                "error_code" = NULL,
                "updated_at" = clock_timestamp()
              WHERE draft."id" = ${input.draftId}::uuid
                AND draft."thread_id" = ${input.threadId}::uuid
                AND draft."inbound_message_id" = ${draft.inboundMessageId}::uuid
                AND draft."status" IN ('send_failed', 'send_uncertain')
                AND draft."prompt_version" = ${CURRENT_DM_PROMPT_VERSION}
                AND draft."kind" = 'engagement_follow_up'
                AND draft."eligible_at" <= clock_timestamp()
                AND draft."expires_at" > clock_timestamp()
                AND EXISTS (
                  SELECT 1
                  FROM "dm_thread" AS thread
                  WHERE thread."id" = draft."thread_id"
                    AND thread."latest_inbound_message_id" = draft."inbound_message_id"
                )
            `,
          }
        : await tx.replyDraft.updateMany({
            where: {
              id: input.draftId,
              threadId: input.threadId,
              inboundMessageId: draft.inboundMessageId,
              status: { in: [...retryableStatuses] },
              kind: "reply",
              promptVersion: CURRENT_DM_PROMPT_VERSION,
              thread: { latestInboundMessageId: draft.inboundMessageId },
            },
            data: { status: "sending", errorCode: null },
          });
    if (claim.count !== 1) {
      const current = await tx.replyDraft.findUnique({
        where: { id: input.draftId },
        select: { status: true },
      });
      if (current?.status !== "send_failed" && current?.status !== "send_uncertain") {
        throw new DraftActionError("draft_not_retryable");
      }
      const currentThread = await tx.dmThread.findUnique({
        where: { id: input.threadId },
        select: { latestInboundMessageId: true },
      });
      if (currentThread?.latestInboundMessageId !== draft.inboundMessageId) {
        throw new DraftActionError("stale_draft");
      }
      if (draft.kind === "engagement_follow_up") {
        throw new DraftActionError("follow_up_window_closed");
      }
      throw new DraftActionError("draft_not_retryable");
    }

    return { approvedText: draft.approvedText, inboundMessageId: draft.inboundMessageId };
  });
}

/** Confirmed delivery. */
export async function markSent(draftId: string): Promise<void> {
  const result = await prisma.replyDraft.updateMany({
    where: { id: draftId, status: "sending" },
    data: { status: "sent", sentAt: new Date(), errorCode: null, errorMessage: null },
  });
  if (result.count !== 1) throw new Error("send_state_not_recorded");
}

/** A definite Graph rejection: nothing was delivered, so a retry is safe to offer. */
export async function markSendFailed(draftId: string, errorCode: string): Promise<void> {
  const result = await prisma.replyDraft.updateMany({
    where: { id: draftId, status: "sending" },
    data: { status: "send_failed", errorCode, failedAt: new Date() },
  });
  if (result.count !== 1) throw new Error("send_state_not_recorded");
}

/**
 * A timeout or socket reset: the message MAY have been delivered.
 *
 * Never retried automatically — that is the whole reason this state exists. The UI
 * makes the owner confirm they checked Instagram before offering a retry.
 */
export async function markSendUncertain(draftId: string, errorCode: string): Promise<void> {
  const result = await prisma.replyDraft.updateMany({
    where: { id: draftId, status: "sending" },
    data: { status: "send_uncertain", errorCode, failedAt: new Date() },
  });
  if (result.count !== 1) throw new Error("send_state_not_recorded");
}
