import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { lockJourneyIdentity } from "./journeyIdentityLock.js";

/**
 * How long one person-keyword request stays a single journey.
 *
 * Measured from the most recent trigger, not from when the window opened, so a
 * person who asks again keeps one journey alive rather than starting a second.
 * The boundary is strict: at exactly 48 hours a new journey may open, because
 * beyond that the intent is plausibly new rather than a repeat.
 */
export const JOURNEY_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Lock/deadlock conflicts are expected here, not exceptional: a viral reel can
 * deliver several comments from the same person within seconds.
 *
 * Higher than the 3 used for recovery claims, because those contend over distinct
 * rows while these all contend over the SAME person-keyword window — every member
 * of a burst conflicts with every other, so the loser of one round may lose the
 * next. Exhausting this throws, which is correct: the caller must not send a gate
 * DM without knowing whether one was already sent.
 *
 * Raised from 6 to 10 after the contract suite's 5-way burst exhausted the budget under
 * load — a real database, ten other suites competing for connections, and every member of
 * the burst serialising against the same row. Six was enough in isolation and not enough
 * when the database was busy, which is exactly the condition production hits during a
 * viral reel. A retry costs milliseconds; exhausting the budget costs the caller its
 * ability to tell whether a gate DM went out.
 */
const SERIALIZATION_RETRY_ATTEMPTS = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Did this failure mean "another transaction got there first, try again"?
 *
 * Prisma normalises a serialization failure to `P2034` for its own query builder,
 * but a `$queryRaw` surfaces Postgres' native `40001` unchanged — and the
 * `SELECT ... FOR UPDATE` below is raw. Matching only `P2034` let a genuine race
 * escape as a hard failure, which under a burst of concurrent comments meant the
 * caller could not tell whether a gate had been sent.
 *
 * `40P01` (deadlock_detected) is included for the same reason: it is retryable and
 * arrives by the same path.
 */
function isRetryableConflict(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "P2034" || code === "40001" || code === "40P01") return true;
  // A raw-query failure carries the SQLSTATE in its message rather than `code`.
  const message = (err as { message?: string })?.message ?? "";
  return message.includes("40001") || message.includes("could not serialize access");
}

/**
 * What resolution decided, and therefore what the caller may send.
 *
 * Only `new_journey` authorises an outbound gate DM. That single rule is what
 * collapses the 342 duplicate sends measured in production history.
 */
export type JourneyDisposition =
  | "new_journey"
  | "reused_active"
  | "already_completed_recently"
  | "replayed_comment";

export type JourneyResolution = {
  disposition: JourneyDisposition;
  intentId: string;
  /** The conversation that owns automation for this intent, when one exists. */
  conversationId: string | null;
  /** True only for `new_journey`; the caller must not send otherwise. */
  maySendGate: boolean;
};

export type JourneyTriggerInput = {
  igUserId: string;
  keywordId: string;
  /** Meta comment id. The (comment, keyword) unique index absorbs webhook replays. */
  commentId: string;
  mediaId?: string | null;
  receivedAt: Date;
  /** "comment" | "dm" — recorded for audit, not used in the decision. */
  triggerKind: string;
};

/**
 * Attach a trigger to its canonical journey, creating one only when needed.
 *
 * A transaction-scoped person-keyword advisory lock makes two simultaneous
 * first comments line up before either reads the live window. The second reads
 * the winner's row and attaches to it. Exactly one caller receives `new_journey`.
 *
 * `createConversation` is invoked INSIDE the transaction so a new journey and its
 * conversation commit together — a conversation without an intent would be
 * invisible to reconciliation, and an intent without a conversation would own
 * nothing.
 *
 * Non-throwing by design is NOT appropriate here: the caller must not send a gate
 * DM if it cannot establish whether one was already sent. A failure propagates.
 */
export async function resolveJourneyIntent(
  input: JourneyTriggerInput,
  createConversation: (tx: Prisma.TransactionClient) => Promise<{ id: string }>,
): Promise<JourneyResolution> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await prisma.$transaction(
        async (tx) => resolveInTransaction(tx, input, createConversation),
        // The transaction-scoped advisory lock is the serialization boundary.
        // ReadCommitted takes its overlap snapshot AFTER a waiter acquires that
        // lock; Serializable would freeze the pre-wait snapshot and miss the
        // reconciliation transaction that just committed.
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;

      // Serialization failure: the other transaction won, so re-reading will now
      // find its intent and this caller will correctly attach rather than open a
      // second journey.
      if (isRetryableConflict(err) && attempt < SERIALIZATION_RETRY_ATTEMPTS) {
        // Full jitter. A fixed backoff makes a burst of N comments collide again
        // in lockstep on every retry.
        await sleep(Math.random() * (25 * attempt));
        continue;
      }

      // P2002 on (comment_id, keyword_id): the same keyword match was delivered
      // twice and the other delivery committed first. A single comment may
      // legitimately match a different keyword, so comment id alone is not replay
      // identity.
      if (code === "P2002" && attempt < SERIALIZATION_RETRY_ATTEMPTS) {
        const existing = await findExistingTrigger(input.commentId, input.keywordId);
        if (existing) return existing;
        await sleep(Math.random() * (25 * attempt));
        continue;
      }

      logger.error(
        {
          errorCode: "journey_intent_resolve_failed",
          igUserId: input.igUserId,
          keywordId: input.keywordId,
        },
        "Could not resolve the journey intent",
      );
      throw err;
    }
  }
}

async function resolveInTransaction(
  tx: Prisma.TransactionClient,
  input: JourneyTriggerInput,
  createConversation: (tx: Prisma.TransactionClient) => Promise<{ id: string }>,
): Promise<JourneyResolution> {
  await lockJourneyIdentity(tx, input.igUserId, input.keywordId);

  // Model the globally unique Instagram comment once. A second configured
  // keyword may legitimately associate the same source with another intent, but
  // it must not rewrite the source's media identity.
  let sourceEvent = await tx.journeySourceEvent.upsert({
    where: { commentId: input.commentId },
    create: {
      commentId: input.commentId,
      mediaId: input.mediaId ?? null,
      firstReceivedAt: input.receivedAt,
    },
    update: {},
    select: { id: true, mediaId: true },
  });
  if (sourceEvent.mediaId && input.mediaId && sourceEvent.mediaId !== input.mediaId) {
    throw new Error("journey_source_event_media_conflict");
  }
  if (!sourceEvent.mediaId && input.mediaId) {
    sourceEvent = await tx.journeySourceEvent.update({
      where: { id: sourceEvent.id },
      data: { mediaId: input.mediaId },
      select: { id: true, mediaId: true },
    });
  }

  // Replay check first. A redelivered comment must not refresh the window or
  // touch state — it already did its work on the first delivery.
  const replayed = await tx.journeyTrigger.findUnique({
    where: {
      sourceEventId_keywordId: { sourceEventId: sourceEvent.id, keywordId: input.keywordId },
    },
    select: { intentId: true, conversationId: true },
  });
  if (replayed) {
    return {
      disposition: "replayed_comment",
      intentId: replayed.intentId,
      conversationId: replayed.conversationId,
      maySendGate: false,
    };
  }

  // Database time, not process time. Two app instances can disagree by seconds,
  // and this comparison decides whether a journey is one or two.
  const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT NOW() AS now`;

  // The newest window for this person and this KEYWORD ROW. Identity is the
  // keyword id, never the word (design §19), and media id is deliberately not
  // part of it.
  //
  // That distinction matters in this data: DINNER exists as three separate
  // keyword rows — one global and one per reel — each pointing at a DIFFERENT
  // guide. Two comments on two reels are therefore two different keyword ids, two
  // intents, and two guides, which is correct because two different things were
  // asked for. Only a repeat against the SAME keyword row collapses.
  const [live] = await tx.$queryRaw<
    Array<{
      id: string;
      canonical_conversation_id: string | null;
      completed_at: Date | null;
      window_expires_at: Date;
      /** Needed to keep the journey's stamps monotonic — see the update below. */
      last_trigger_at: Date;
    }>
  >`
    SELECT "id", "canonical_conversation_id", "completed_at", "window_expires_at", "last_trigger_at"
    FROM "journey_intent"
    WHERE "ig_user_id" = ${input.igUserId}
      AND "keyword_id" = ${input.keywordId}::uuid
      AND "window_expires_at" > ${now}
    ORDER BY "last_trigger_at" DESC
    LIMIT 1
    FOR UPDATE
  `;

  if (live) {
    // Completed inside the window: record the ask, send nothing. Re-delivering
    // the guide is a separate, deliberate decision the caller owns.
    const disposition: JourneyDisposition = live.completed_at
      ? "already_completed_recently"
      : "reused_active";

    // Only a live request extends the window. Refreshing it after completion
    // would keep a finished intent alive and suppress a genuinely new request.
    if (!live.completed_at) {
      // The journey's stamps only ever move FORWARD.
      //
      // `receivedAt` is taken when the handler picks the comment up — the comment webhook
      // carries no timestamp of its own (commentHandler.ts) — so a trigger can legitimately
      // arrive carrying a time EARLIER than the window it is attaching to: two handlers
      // take their stamps in one order and commit in the other, and the one that committed
      // first defines `window_started_at`.
      //
      // Writing that earlier value directly violated chk_intent_trigger_after_start. A
      // check violation is not a serialization conflict, so `isRetryableConflict` did not
      // catch it and the error escaped `resolveJourneyIntent` — which throws by design,
      // because a caller that cannot establish whether a gate DM went out must not send
      // one. The person who commented then silently never received their guide.
      //
      // Clamped against `last_trigger_at` rather than `window_started_at`: the weaker
      // clamp satisfies the constraint but still lets an out-of-order trigger rewind a
      // journey a later ask had already extended, pulling the expiry back with it and
      // cutting the window short. The expiry takes the same treatment, so a late-arriving
      // straggler can never shorten a live journey.
      //
      // The ask itself is not lost: the journeyTrigger row below keeps its true
      // `receivedAt`, so the history stays honest about when each comment actually landed.
      const stampedAt = new Date(
        Math.max(input.receivedAt.getTime(), live.last_trigger_at.getTime()),
      );
      await tx.journeyIntent.update({
        where: { id: live.id },
        data: {
          lastTriggerAt: stampedAt,
          windowExpiresAt: new Date(
            Math.max(stampedAt.getTime() + JOURNEY_WINDOW_MS, live.window_expires_at.getTime()),
          ),
        },
      });
    }

    await tx.journeyTrigger.create({
      data: {
        intentId: live.id,
        sourceEventId: sourceEvent.id,
        keywordId: input.keywordId,
        conversationId: live.canonical_conversation_id,
        receivedAt: input.receivedAt,
        triggerKind: input.triggerKind,
        disposition,
      },
    });

    return {
      disposition,
      intentId: live.id,
      conversationId: live.canonical_conversation_id,
      maySendGate: false,
    };
  }

  // No live window: this is a genuinely new request. The conversation and the
  // intent are created together so neither can exist without the other.
  const conversation = await createConversation(tx);
  const intent = await tx.journeyIntent.create({
    data: {
      igUserId: input.igUserId,
      keywordId: input.keywordId,
      canonicalConversationId: conversation.id,
      windowStartedAt: input.receivedAt,
      lastTriggerAt: input.receivedAt,
      windowExpiresAt: new Date(input.receivedAt.getTime() + JOURNEY_WINDOW_MS),
    },
  });

  await tx.journeyTrigger.create({
    data: {
      intentId: intent.id,
      sourceEventId: sourceEvent.id,
      keywordId: input.keywordId,
      conversationId: conversation.id,
      receivedAt: input.receivedAt,
      triggerKind: input.triggerKind,
      disposition: "new_journey",
    },
  });

  await tx.conversation.update({
    where: { id: conversation.id },
    data: { canonicalIntentId: intent.id },
  });

  return {
    disposition: "new_journey",
    intentId: intent.id,
    conversationId: conversation.id,
    maySendGate: true,
  };
}

/** The winning delivery's trigger, when a replay lost the insert race. */
async function findExistingTrigger(
  commentId: string,
  keywordId: string,
): Promise<JourneyResolution | null> {
  const sourceEvent = await prisma.journeySourceEvent.findUnique({
    where: { commentId },
    select: { id: true },
  });
  if (!sourceEvent) return null;
  const existing = await prisma.journeyTrigger.findUnique({
    where: {
      sourceEventId_keywordId: {
        sourceEventId: sourceEvent.id,
        keywordId,
      },
    },
    select: { intentId: true, conversationId: true },
  });
  if (!existing) return null;
  return {
    disposition: "replayed_comment",
    intentId: existing.intentId,
    conversationId: existing.conversationId,
    maySendGate: false,
  };
}

export type JourneyPublicAcknowledgement = {
  commentId: string;
  keywordId: string;
  state: "confirmed" | "failed" | "uncertain";
  replyId?: string | null;
  errorCategory?: string | null;
};

/**
 * Freeze the public acknowledgement result on the exact source-intent
 * association. Exact replay is idempotent; conflicting replay fails closed so a
 * later observation cannot silently rewrite the original audit evidence.
 */
export async function recordJourneyPublicAcknowledgement(
  input: JourneyPublicAcknowledgement,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const association = await tx.journeyTrigger.findFirst({
      where: {
        keywordId: input.keywordId,
        sourceEvent: { commentId: input.commentId },
      },
      select: {
        id: true,
        publicAcknowledgementState: true,
        acknowledgementReplyId: true,
        acknowledgementErrorCategory: true,
      },
    });
    if (!association) throw new Error("journey_acknowledgement_association_missing");

    const replyId = input.replyId ?? null;
    const errorCategory = input.errorCategory ?? null;
    if (association.publicAcknowledgementState !== "pending") {
      if (
        association.publicAcknowledgementState === input.state &&
        association.acknowledgementReplyId === replyId &&
        association.acknowledgementErrorCategory === errorCategory
      ) {
        return;
      }
      throw new Error("journey_acknowledgement_evidence_conflict");
    }

    await tx.journeyTrigger.update({
      where: { id: association.id },
      data: {
        publicAcknowledgementState: input.state,
        acknowledgementReplyId: replyId,
        acknowledgementErrorCategory: errorCategory,
      },
    });
  });
}

/**
 * Stamp the intent that owns a conversation as completed.
 *
 * Called from the completion path so a later trigger inside the same window
 * reads `already_completed_recently` instead of re-sending the gate.
 */
export async function markIntentCompleted(
  tx: Prisma.TransactionClient,
  conversationId: string,
  completedAt: Date,
): Promise<void> {
  // Completion through an ALIAS must close the intent too (QA-05).
  //
  // This previously matched only `canonicalConversationId`, so a person who replied
  // DONE on a superseded journey completed that conversation while their canonical
  // intent stayed open. Found live in production: @gore2_7793 has their DINNER guide,
  // yet intent d8fbe920 still reads incomplete, which makes them eligible for a public
  // recovery reminder about a guide they already received.
  //
  // Two ways a conversation can close its intent:
  //   - it IS the canonical conversation, or
  //   - it points at the intent via canonicalIntentId (set by reconciliation, and by
  //     the live resolver for every trigger it attaches).
  const alias = await tx.conversation.findUnique({
    where: { id: conversationId },
    select: { canonicalIntentId: true },
  });

  await tx.journeyIntent.updateMany({
    where: {
      completedAt: null,
      OR: [
        { canonicalConversationId: conversationId },
        ...(alias?.canonicalIntentId ? [{ id: alias.canonicalIntentId }] : []),
      ],
    },
    data: { completedAt },
  });
}
