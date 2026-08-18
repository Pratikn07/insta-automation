import type { ReplyDraft } from "@prisma/client";
import { randomUUID } from "node:crypto";
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
const DRAFT_CREATION_TRANSACTION_ATTEMPTS = 3;

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
 * Two webhooks for the same thread can race here. The thread row is the shared
 * serialization point for inbound capture and every draft-producing path; the
 * partial unique index remains a final database backstop for one active draft.
 */
export interface QueueReplyDraftInput {
  threadId: string;
  /**
   * A webhook handler supplies the inbound it processed. The collection route
   * omits it and drafts for the authoritative latest inbound read under lock.
   */
  inboundMessageId?: string;
}

export async function queueReplyDraft(input: QueueReplyDraftInput): Promise<ReplyDraft> {
  for (let attempt = 1; attempt <= DRAFT_CREATION_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // This is the global creation lock order: thread first, drafts second.
          // It serializes ordinary creation with inbound capture, regeneration,
          // and follow-up scheduling before any active draft is mutated.
          const threads = await tx.$queryRaw<
            Array<{
              id: string;
              latestInboundMessageId: string | null;
              needsReply: boolean;
            }>
          >`
            SELECT
              thread."id",
              thread."latest_inbound_message_id" AS "latestInboundMessageId",
              thread."needs_reply" AS "needsReply"
            FROM "dm_thread" AS thread
            WHERE thread."id" = ${input.threadId}::uuid
            FOR UPDATE
          `;
          const thread = threads[0];
          if (!thread) throw new DraftActionError("draft_not_found");
          if (!thread.latestInboundMessageId) {
            throw new DraftActionError("no_inbound_message");
          }
          if (!thread.needsReply) {
            throw new DraftActionError("thread_not_needing_reply");
          }
          if (
            input.inboundMessageId !== undefined &&
            input.inboundMessageId !== thread.latestInboundMessageId
          ) {
            throw new DraftActionError("stale_draft");
          }

          const inboundMessageId = thread.latestInboundMessageId;

          // The business key for an initial draft is (thread, latest inbound).
          // Asking twice for a first draft of the same message is one intent — a
          // double click, or a retry after a lost response — so it coalesces onto
          // the draft that already exists rather than superseding a good draft and
          // spending another model call to replace it with an identical one.
          //
          // An active draft answering an *older* inbound is a different matter:
          // the question has moved on, so it is genuinely superseded below.
          // Replacing a draft the owner may be reading is an explicit transition,
          // and that is what regenerateReplyDraft is for — keyed by the prior
          // draft ID so it cannot happen by accident.
          const active = await tx.replyDraft.findFirst({
            where: {
              threadId: input.threadId,
              status: { in: [...ACTIVE_DRAFT_STATUSES] },
            },
            orderBy: { revision: "desc" },
          });
          if (active && active.inboundMessageId === inboundMessageId) return active;

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

          const eligibleAt = new Date();
          return await tx.replyDraft.create({
            data: {
              threadId: input.threadId,
              inboundMessageId,
              revision,
              status: "queued",
              kind: "reply",
              sourceConversationId: null,
              eligibleAt,
              nextAttemptAt: eligibleAt,
              expiresAt: null,
              promptVersion: CURRENT_DM_PROMPT_VERSION,
            },
          });
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (hasPrismaCode(error, "P2034") && attempt < DRAFT_CREATION_TRANSACTION_ATTEMPTS) {
        continue;
      }
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

  throw new Error("unreachable");
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
  | "no_inbound_message"
  | "thread_not_needing_reply"
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

type RegenerationThreadRow = {
  id: string;
  latestInboundMessageId: string | null;
  igUserId: string;
};

type RegenerationDraftRow = {
  threadId: string;
  inboundMessageId: string;
  status: string;
  kind: "reply" | "engagement_follow_up";
  sourceConversationId: string | null;
  eligibleAt: Date;
  expiresAt: Date | null;
  promptVersion: number | null;
  sourceIgUserId: string | null;
  sourceCompletedAt: Date | null;
  isEligible: boolean;
  isUnexpired: boolean;
};

type RegenerationBoundaryIdentity = Pick<
  RegenerationDraftRow,
  | "threadId"
  | "inboundMessageId"
  | "status"
  | "kind"
  | "sourceConversationId"
  | "eligibleAt"
  | "expiresAt"
  | "promptVersion"
>;

class RegenerationBoundaryLostError extends Error {
  readonly draft: RegenerationBoundaryIdentity;

  constructor(draft: RegenerationBoundaryIdentity) {
    super("regeneration_boundary_lost");
    this.name = "RegenerationBoundaryLostError";
    this.draft = draft;
  }
}

const REGENERATION_TRANSACTION_ATTEMPTS = 3;

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

/**
 * Replace one reviewable draft without changing what it replies to or, for a
 * follow-up, which completed guide delivery and send window authorised it.
 *
 * The draft and thread are locked and every safety decision uses the database
 * clock. This prevents a route-level read followed by a broad queue operation
 * from superseding a newer reactive reply that arrived in between.
 */
export async function regenerateReplyDraft(input: {
  threadId: string;
  draftId: string;
}): Promise<ReplyDraft> {
  for (let attempt = 1; attempt <= REGENERATION_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          // Match inbound processing's global lock order. Each statement must
          // finish before the next begins; a joined FOR UPDATE does not promise
          // which relation PostgreSQL locks first.
          const threads = await tx.$queryRaw<RegenerationThreadRow[]>`
            SELECT
              thread."id",
              thread."latest_inbound_message_id" AS "latestInboundMessageId",
              thread."ig_user_id" AS "igUserId"
            FROM "dm_thread" AS thread
            WHERE thread."id" = ${input.threadId}::uuid
            FOR UPDATE
          `;
          const thread = threads[0];
          if (!thread) throw new DraftActionError("draft_not_found");

          const drafts = await tx.$queryRaw<RegenerationDraftRow[]>`
            SELECT
              draft."thread_id" AS "threadId",
              draft."inbound_message_id" AS "inboundMessageId",
              draft."status"::text AS "status",
              draft."kind"::text AS "kind",
              draft."source_conversation_id" AS "sourceConversationId",
              draft."eligible_at" AS "eligibleAt",
              draft."expires_at" AS "expiresAt",
              draft."prompt_version" AS "promptVersion",
              source."ig_user_id" AS "sourceIgUserId",
              source."completed_at" AS "sourceCompletedAt",
              draft."eligible_at" <= clock_timestamp() AS "isEligible",
              (draft."expires_at" IS NULL OR draft."expires_at" > clock_timestamp()) AS "isUnexpired"
            FROM "reply_draft" AS draft
            LEFT JOIN "conversations" AS source ON source."id" = draft."source_conversation_id"
            WHERE draft."id" = ${input.draftId}::uuid
              AND draft."thread_id" = ${input.threadId}::uuid
            FOR UPDATE OF draft
          `;
          const draft = drafts[0];
          if (!draft) throw new DraftActionError("draft_not_found");

          // Every mutable decision happens only after both ordered lock
          // statements have completed.
          if (draft.status !== "pending_approval" && draft.status !== "generation_failed") {
            throw new DraftActionError("draft_not_pending");
          }
          if (draft.promptVersion !== CURRENT_DM_PROMPT_VERSION) {
            throw new DraftActionError("prompt_policy_outdated");
          }
          if (
            draft.threadId !== thread.id ||
            thread.latestInboundMessageId !== draft.inboundMessageId
          ) {
            throw new DraftActionError("stale_draft");
          }

          if (draft.kind === "engagement_follow_up") {
            if (
              !draft.sourceConversationId ||
              draft.sourceIgUserId !== thread.igUserId ||
              draft.sourceCompletedAt === null
            ) {
              throw new DraftActionError("stale_draft");
            }
            if (!draft.isEligible) throw new DraftActionError("follow_up_not_ready");
            if (!draft.expiresAt || !draft.isUnexpired) {
              const expired = await tx.$executeRaw`
                UPDATE "reply_draft"
                SET
                  "status" = 'expired',
                  "error_code" = 'follow_up_window_closed',
                  "updated_at" = clock_timestamp()
                WHERE "id" = ${input.draftId}::uuid
                  AND "thread_id" = ${input.threadId}::uuid
                  AND "inbound_message_id" = ${draft.inboundMessageId}::uuid
                  AND "status" = ${draft.status}::"reply_draft_status"
                  AND "kind" = 'engagement_follow_up'
                  AND "source_conversation_id" = ${draft.sourceConversationId}::uuid
                  AND "prompt_version" = ${CURRENT_DM_PROMPT_VERSION}
                  AND "eligible_at" = ${draft.eligibleAt}
                  AND "expires_at" = ${draft.expiresAt}
                  AND "expires_at" <= clock_timestamp()
              `;
              if (expired === 1) return { rejected: "follow_up_window_closed" as const };
              throw new DraftActionError("follow_up_window_closed");
            }
          } else if (draft.sourceConversationId !== null || draft.expiresAt !== null) {
            throw new DraftActionError("stale_draft");
          }

          // A failed historical draft is outside the one-active-draft index. It
          // must never displace a newer reactive reply.
          const newerActive = await tx.replyDraft.findFirst({
            where: {
              threadId: input.threadId,
              id: { not: input.draftId },
              status: { in: [...ACTIVE_DRAFT_STATUSES] },
            },
            select: { id: true },
          });
          if (newerActive) throw new DraftActionError("stale_draft");

          const replacementId = randomUUID();
          // The source UPDATE and replacement INSERT share one statement. Every
          // mutable predicate is repeated here, including database-clock checks
          // both before supersession and immediately before insertion. If the
          // final SELECT returns no row, throwing rolls this entire transaction
          // back before the source is expired in a separate guarded commit.
          const created = await tx.$queryRaw<Array<{ id: string }>>`
            WITH superseded AS (
              UPDATE "reply_draft" AS draft
              SET
                "status" = 'superseded',
                "updated_at" = clock_timestamp()
              WHERE draft."id" = ${input.draftId}::uuid
                AND draft."thread_id" = ${input.threadId}::uuid
                AND draft."inbound_message_id" = ${draft.inboundMessageId}::uuid
                AND draft."status" = ${draft.status}::"reply_draft_status"
                AND draft."kind" = ${draft.kind}::"reply_draft_kind"
                AND draft."prompt_version" = ${CURRENT_DM_PROMPT_VERSION}
                AND NOT EXISTS (
                  SELECT 1
                  FROM "reply_draft" AS active
                  WHERE active."thread_id" = draft."thread_id"
                    AND active."id" <> draft."id"
                    AND active."status" IN ('queued', 'generating', 'pending_approval')
                )
                AND EXISTS (
                  SELECT 1
                  FROM "dm_thread" AS thread
                  WHERE thread."id" = draft."thread_id"
                    AND thread."latest_inbound_message_id" = draft."inbound_message_id"
                    AND (
                      (
                        draft."kind" = 'reply'
                        AND draft."source_conversation_id" IS NULL
                        AND draft."expires_at" IS NULL
                      )
                      OR (
                        draft."kind" = 'engagement_follow_up'
                        AND draft."source_conversation_id" = ${draft.sourceConversationId}::uuid
                        AND draft."eligible_at" = ${draft.eligibleAt}
                        AND draft."expires_at" = ${draft.expiresAt}
                        AND draft."eligible_at" <= clock_timestamp()
                        AND draft."expires_at" > clock_timestamp()
                        AND EXISTS (
                          SELECT 1
                          FROM "conversations" AS source
                          WHERE source."id" = draft."source_conversation_id"
                            AND source."completed_at" IS NOT NULL
                            AND source."ig_user_id" = thread."ig_user_id"
                        )
                      )
                    )
                )
              RETURNING
                draft."thread_id",
                draft."inbound_message_id",
                draft."kind",
                draft."source_conversation_id",
                draft."eligible_at",
                draft."expires_at"
            ), created AS (
              INSERT INTO "reply_draft" (
                "id",
                "thread_id",
                "inbound_message_id",
                "revision",
                "status",
                "kind",
                "source_conversation_id",
                "eligible_at",
                "next_attempt_at",
                "expires_at",
                "prompt_version",
                "created_at",
                "updated_at"
              )
              SELECT
                ${replacementId}::uuid,
                superseded."thread_id",
                superseded."inbound_message_id",
                (
                  SELECT COALESCE(MAX(existing."revision"), 0) + 1
                  FROM "reply_draft" AS existing
                  WHERE existing."thread_id" = superseded."thread_id"
                ),
                'queued',
                superseded."kind",
                superseded."source_conversation_id",
                superseded."eligible_at",
                superseded."eligible_at",
                superseded."expires_at",
                ${CURRENT_DM_PROMPT_VERSION},
                clock_timestamp(),
                clock_timestamp()
              FROM superseded
              WHERE EXISTS (
                SELECT 1
                FROM "dm_thread" AS thread
                WHERE thread."id" = superseded."thread_id"
                  AND thread."latest_inbound_message_id" = superseded."inbound_message_id"
                  AND (
                    superseded."kind" = 'reply'
                    OR (
                      superseded."kind" = 'engagement_follow_up'
                      AND superseded."eligible_at" <= clock_timestamp()
                      AND superseded."expires_at" > clock_timestamp()
                      AND EXISTS (
                        SELECT 1
                        FROM "conversations" AS source
                        WHERE source."id" = superseded."source_conversation_id"
                          AND source."completed_at" IS NOT NULL
                          AND source."ig_user_id" = thread."ig_user_id"
                      )
                    )
                  )
              )
              RETURNING "id"
            )
            SELECT "id" FROM created
          `;
          const createdId = created[0]?.id;
          if (!createdId) throw new RegenerationBoundaryLostError(draft);

          const replacement = await tx.replyDraft.findUnique({ where: { id: createdId } });
          if (!replacement) throw new Error("regenerated_draft_missing");
          return replacement;
        },
        { isolationLevel: "Serializable" },
      );

      if ("rejected" in result) throw new DraftActionError(result.rejected);
      return result;
    } catch (error) {
      if (error instanceof RegenerationBoundaryLostError) {
        const draft = error.draft;
        if (draft.kind === "engagement_follow_up" && draft.expiresAt) {
          // The failed transaction has rolled back any supersession/insert. This
          // independent guarded statement can now converge the unchanged source
          // to expired without overwriting a concurrent winner.
          const expired = await prisma.$executeRaw`
            UPDATE "reply_draft"
            SET
              "status" = 'expired',
              "error_code" = 'follow_up_window_closed',
              "updated_at" = clock_timestamp()
            WHERE "id" = ${input.draftId}::uuid
              AND "thread_id" = ${input.threadId}::uuid
              AND "inbound_message_id" = ${draft.inboundMessageId}::uuid
              AND "status" = ${draft.status}::"reply_draft_status"
              AND "kind" = 'engagement_follow_up'
              AND "source_conversation_id" = ${draft.sourceConversationId}::uuid
              AND "prompt_version" = ${CURRENT_DM_PROMPT_VERSION}
              AND "eligible_at" = ${draft.eligibleAt}
              AND "expires_at" = ${draft.expiresAt}
              AND "expires_at" <= clock_timestamp()
          `;
          if (expired === 1) throw new DraftActionError("follow_up_window_closed");
        }
        throw new DraftActionError("stale_draft");
      }
      if (hasPrismaCode(error, "P2034") && attempt < REGENERATION_TRANSACTION_ATTEMPTS) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("unreachable");
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
  const result = await prisma.$transaction(async (tx) => {
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
      // A real follow-up always has expiresAt (enforced by the database check
      // constraint). Do not reject an elapsed deadline here: the row must first
      // be locked and atomically persisted as expired inside this transaction.
      if (draft.expiresAt === null) throw new DraftActionError("follow_up_window_closed");
    }

    const thread = await tx.dmThread.findUnique({
      where: { id: input.threadId },
      select: { latestInboundMessageId: true },
    });
    if (thread?.latestInboundMessageId !== draft.inboundMessageId) {
      throw new DraftActionError("stale_draft");
    }

    const approvedText = input.workingText.trim();
    let claim: { count: number };
    if (draft.kind === "engagement_follow_up") {
      // This statement must complete before the guarded UPDATE starts. A
      // materialized CTE is not sufficient: PostgreSQL may evaluate outer
      // predicates before demanding the CTE and waiting on its row lock.
      await tx.$queryRaw`
        SELECT "id"
        FROM "reply_draft"
        WHERE "id" = ${input.draftId}::uuid
        FOR UPDATE
      `;
      claim = {
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
      };
    } else {
      claim = await tx.replyDraft.updateMany({
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
    }
    // Lost the race to a concurrent approval — the winner is already sending.
    if (claim.count !== 1) {
      const current = await tx.replyDraft.findUnique({
        where: { id: input.draftId },
        select: {
          inboundMessageId: true,
          status: true,
          kind: true,
          promptVersion: true,
          eligibleAt: true,
          expiresAt: true,
        },
      });
      if (current?.status !== "pending_approval") {
        throw new DraftActionError("draft_not_pending");
      }
      if (current.kind !== draft.kind || current.inboundMessageId !== draft.inboundMessageId) {
        throw new DraftActionError("stale_draft");
      }
      if (current.promptVersion !== CURRENT_DM_PROMPT_VERSION) {
        throw new DraftActionError("prompt_policy_outdated");
      }
      const currentThread = await tx.dmThread.findUnique({
        where: { id: input.threadId },
        select: { latestInboundMessageId: true },
      });
      if (currentThread?.latestInboundMessageId !== draft.inboundMessageId) {
        throw new DraftActionError("stale_draft");
      }
      // The remaining follow-up-only predicate is the database clock. If it
      // crossed expiresAt after the application pre-check, fail closed and
      // commit the terminal state before surfacing the rejection. Throwing from
      // inside this transaction would roll the expiration back.
      if (draft.kind === "engagement_follow_up") {
        const expired = await tx.$executeRaw`
          UPDATE "reply_draft"
          SET
            "status" = 'expired',
            "error_code" = 'follow_up_window_closed',
            "updated_at" = clock_timestamp()
          WHERE "id" = ${input.draftId}::uuid
            AND "thread_id" = ${input.threadId}::uuid
            AND "inbound_message_id" = ${draft.inboundMessageId}::uuid
            AND "status" = 'pending_approval'
            AND "kind" = 'engagement_follow_up'
            AND "prompt_version" = ${CURRENT_DM_PROMPT_VERSION}
            AND "expires_at" <= clock_timestamp()
        `;
        if (expired === 1) {
          return { rejected: "follow_up_window_closed" as const };
        }
        if (now < current.eligibleAt) throw new DraftActionError("follow_up_not_ready");
        throw new DraftActionError("follow_up_window_closed");
      }
      throw new DraftActionError("draft_not_pending");
    }

    return { approvedText, inboundMessageId: draft.inboundMessageId };
  });

  if ("rejected" in result && result.rejected === "follow_up_window_closed") {
    throw new DraftActionError(result.rejected);
  }
  return result;
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
  const result = await prisma.$transaction(async (tx) => {
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
      if (draft.expiresAt === null) throw new DraftActionError("follow_up_window_closed");
    }

    const thread = await tx.dmThread.findUnique({
      where: { id: input.threadId },
      select: { latestInboundMessageId: true },
    });
    if (thread?.latestInboundMessageId !== draft.inboundMessageId) {
      throw new DraftActionError("stale_draft");
    }

    const retryableStatuses = ["send_failed", "send_uncertain"] as const;
    let claim: { count: number };
    if (draft.kind === "engagement_follow_up") {
      await tx.$queryRaw`
        SELECT "id"
        FROM "reply_draft"
        WHERE "id" = ${input.draftId}::uuid
        FOR UPDATE
      `;
      claim = {
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
            AND draft."approved_text" = ${draft.approvedText}
            AND draft."eligible_at" <= clock_timestamp()
            AND draft."expires_at" > clock_timestamp()
            AND EXISTS (
              SELECT 1
              FROM "dm_thread" AS thread
              WHERE thread."id" = draft."thread_id"
                AND thread."latest_inbound_message_id" = draft."inbound_message_id"
            )
        `,
      };
    } else {
      claim = await tx.replyDraft.updateMany({
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
    }
    if (claim.count !== 1) {
      const current = await tx.replyDraft.findUnique({
        where: { id: input.draftId },
        select: {
          inboundMessageId: true,
          status: true,
          kind: true,
          promptVersion: true,
          eligibleAt: true,
          expiresAt: true,
          approvedText: true,
        },
      });
      if (current?.status !== "send_failed" && current?.status !== "send_uncertain") {
        throw new DraftActionError("draft_not_retryable");
      }
      if (
        current.kind !== draft.kind ||
        current.inboundMessageId !== draft.inboundMessageId ||
        current.approvedText !== draft.approvedText
      ) {
        throw new DraftActionError("draft_not_retryable");
      }
      if (current.promptVersion !== CURRENT_DM_PROMPT_VERSION) {
        throw new DraftActionError("prompt_policy_outdated");
      }
      const currentThread = await tx.dmThread.findUnique({
        where: { id: input.threadId },
        select: { latestInboundMessageId: true },
      });
      if (currentThread?.latestInboundMessageId !== draft.inboundMessageId) {
        throw new DraftActionError("stale_draft");
      }
      if (draft.kind === "engagement_follow_up") {
        const expired = await tx.$executeRaw`
          UPDATE "reply_draft"
          SET
            "status" = 'expired',
            "error_code" = 'follow_up_window_closed',
            "updated_at" = clock_timestamp()
          WHERE "id" = ${input.draftId}::uuid
            AND "thread_id" = ${input.threadId}::uuid
            AND "inbound_message_id" = ${draft.inboundMessageId}::uuid
            AND "status" IN ('send_failed', 'send_uncertain')
            AND "kind" = 'engagement_follow_up'
            AND "prompt_version" = ${CURRENT_DM_PROMPT_VERSION}
            AND "expires_at" <= clock_timestamp()
        `;
        if (expired === 1) {
          return { rejected: "follow_up_window_closed" as const };
        }
        if (now < current.eligibleAt) throw new DraftActionError("follow_up_not_ready");
        throw new DraftActionError("follow_up_window_closed");
      }
      throw new DraftActionError("draft_not_retryable");
    }

    return { approvedText: draft.approvedText, inboundMessageId: draft.inboundMessageId };
  });

  if ("rejected" in result && result.rejected === "follow_up_window_closed") {
    throw new DraftActionError(result.rejected);
  }
  return result;
}

export interface FinalizeApprovedDraftSendInput {
  draftId: string;
  threadId: string;
  inboundMessageId: string;
  instagramMessageId: string;
  approvedText: string;
  approvedBy: string | null;
  sentAt: Date;
}

type LockedFinalizationDraft = {
  id: string;
  threadId: string;
  inboundMessageId: string;
  status: string;
  approvedText: string | null;
};

/**
 * Strictly finalize an AI-approved send after Graph returns a confirmed message id.
 *
 * There is deliberately no network call in this transaction. Thread and draft
 * locks make the outbound history row, guarded sending -> sent transition,
 * conditional needs-reply resolution, and body-free audit one all-or-nothing
 * database fact.
 */
export async function finalizeApprovedDraftSend(
  input: FinalizeApprovedDraftSendInput,
): Promise<void> {
  if (!input.instagramMessageId) throw new Error("send_state_not_recorded");

  await prisma.$transaction(async (tx) => {
    // Match the global lock order used by inbound capture and draft creation.
    const threads = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT thread."id"
      FROM "dm_thread" AS thread
      WHERE thread."id" = ${input.threadId}::uuid
      FOR UPDATE
    `;
    if (!threads[0]) throw new Error("send_state_not_recorded");

    const drafts = await tx.$queryRaw<LockedFinalizationDraft[]>`
      SELECT
        draft."id",
        draft."thread_id" AS "threadId",
        draft."inbound_message_id" AS "inboundMessageId",
        draft."status"::text AS "status",
        draft."approved_text" AS "approvedText"
      FROM "reply_draft" AS draft
      WHERE draft."id" = ${input.draftId}::uuid
      FOR UPDATE
    `;
    const draft = drafts[0];
    if (
      !draft ||
      draft.threadId !== input.threadId ||
      draft.inboundMessageId !== input.inboundMessageId ||
      draft.status !== "sending" ||
      draft.approvedText !== input.approvedText
    ) {
      throw new Error("send_state_not_recorded");
    }

    await tx.dmMessage.create({
      data: {
        threadId: input.threadId,
        instagramMessageId: input.instagramMessageId,
        direction: "outbound",
        type: "text",
        source: "ai_approved",
        text: input.approvedText,
        mediaUrl: null,
        instagramTimestamp: input.sentAt,
      },
    });

    const sent = await tx.replyDraft.updateMany({
      where: {
        id: input.draftId,
        threadId: input.threadId,
        inboundMessageId: input.inboundMessageId,
        status: "sending",
        approvedText: input.approvedText,
      },
      data: {
        status: "sent",
        sentAt: input.sentAt,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (sent.count !== 1) throw new Error("send_state_not_recorded");

    await tx.dmThread.update({
      where: { id: input.threadId },
      data: {
        lastOutboundAt: input.sentAt,
        lastMessageAt: input.sentAt,
      },
    });
    await tx.dmThread.updateMany({
      where: { id: input.threadId, latestInboundMessageId: input.inboundMessageId },
      data: { needsReply: false },
    });
    await tx.eventLog.create({
      data: {
        kind: "ai_reply_sent",
        payload: {
          threadId: input.threadId,
          draftId: input.draftId,
          by: input.approvedBy,
          length: input.approvedText.length,
          instagramMessageId: input.instagramMessageId,
        },
      },
    });
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
