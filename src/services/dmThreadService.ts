import type { DmMessageSource, DmMessageType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ACTIVE_DRAFT_STATUSES } from "./replyDraftMachine.js";
import { compareInboundOrder } from "./dmOrdering.js";

/**
 * Recording of real DM history, alongside the existing automation journey.
 *
 * Two of these functions deliberately swallow their own errors. They run AFTER a
 * successful Instagram send, and a logging failure must never look like a send
 * failure — that is exactly how a delivered gate DM once became 30+ duplicates.
 */

export interface RecordInboundResult {
  duplicate: boolean;
  becameLatest: boolean;
  threadId: string;
  messageId: string;
}

const INBOUND_TRANSACTION_ATTEMPTS = 3;

export interface RecordInboundInput {
  igAccountId: string;
  igUserId: string;
  instagramMessageId: string;
  text: string | null;
  messageType: DmMessageType;
  mediaUrl: string | null;
  instagramTimestamp: Date;
}

export interface RecordOutboundInput {
  igAccountId: string;
  igUserId: string;
  instagramMessageId: string | null;
  text: string | null;
  messageType: DmMessageType;
  mediaUrl: string | null;
  source: DmMessageSource;
  instagramTimestamp: Date;
}

export interface ThreadProfileInput {
  threadId: string;
  username: string | null;
  name: string | null;
}

/**
 * Record an inbound DM exactly once.
 *
 * Idempotent on Meta's `mid`: Meta retries webhooks, and a replay must not create
 * a second message, a second draft, or re-open a thread the owner already
 * answered. Callers check `duplicate` and return immediately.
 */
export async function recordInboundMessage(
  input: RecordInboundInput,
): Promise<RecordInboundResult> {
  for (let attempt = 1; attempt <= INBOUND_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const existing = await tx.dmMessage.findUnique({
            where: { instagramMessageId: input.instagramMessageId },
            select: { id: true, threadId: true },
          });
          if (existing) {
            return {
              duplicate: true,
              becameLatest: false,
              threadId: existing.threadId,
              messageId: existing.id,
            };
          }

          const thread = await tx.dmThread.upsert({
            where: {
              igAccountId_igUserId: {
                igAccountId: input.igAccountId,
                igUserId: input.igUserId,
              },
            },
            create: {
              igAccountId: input.igAccountId,
              igUserId: input.igUserId,
              lastMessageAt: input.instagramTimestamp,
            },
            update: {},
            select: { id: true, latestInboundMessageId: true },
          });

          const currentLatest = thread.latestInboundMessageId
            ? await tx.dmMessage.findUnique({
                where: { id: thread.latestInboundMessageId },
                select: { instagramMessageId: true, instagramTimestamp: true },
              })
            : null;
          const becameLatest =
            !currentLatest ||
            !currentLatest.instagramMessageId ||
            compareInboundOrder(
              { at: input.instagramTimestamp, id: input.instagramMessageId },
              {
                at: currentLatest.instagramTimestamp,
                id: currentLatest.instagramMessageId,
              },
            ) > 0;

          if (becameLatest) {
            // Supersede BEFORE inserting, so the partial unique index can never
            // see two active drafts for this thread. A draft already `sending`
            // stays untouched because its Instagram outcome is still unknown.
            await tx.replyDraft.updateMany({
              where: { threadId: thread.id, status: { in: [...ACTIVE_DRAFT_STATUSES] } },
              data: { status: "superseded" },
            });
          }

          // Delayed older webhooks still belong in the transcript. They simply
          // cannot replace the true latest inbound or cancel its pending draft.
          const message = await tx.dmMessage.create({
            data: {
              threadId: thread.id,
              instagramMessageId: input.instagramMessageId,
              direction: "inbound",
              type: input.messageType,
              source: "instagram_user",
              text: input.text,
              mediaUrl: input.mediaUrl,
              instagramTimestamp: input.instagramTimestamp,
            },
            select: { id: true },
          });

          if (becameLatest) {
            await tx.dmThread.update({
              where: { id: thread.id },
              data: {
                latestInboundMessageId: message.id,
                needsReply: true,
                lastInboundAt: input.instagramTimestamp,
                lastMessageAt: input.instagramTimestamp,
              },
            });
          }

          return {
            duplicate: false,
            becameLatest,
            threadId: thread.id,
            messageId: message.id,
          };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (err) {
      const retryable =
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: unknown }).code === "P2034";
      if (!retryable || attempt === INBOUND_TRANSACTION_ATTEMPTS) throw err;
    }
  }

  throw new Error("unreachable");
}

export type RecordedOutboundMessage = {
  threadId: string;
  messageId: string;
};

/**
 * Record a message we sent. Never throws.
 *
 * Only outbound timestamps are touched — never `latestInboundMessageId` or
 * `needsReply`. Replying does not make the inbound answered; `markThreadResolved`
 * decides that, and only while the inbound is still the latest.
 */
export async function recordOutboundMessage(
  input: RecordOutboundInput,
): Promise<RecordedOutboundMessage | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const thread = await tx.dmThread.upsert({
        where: {
          igAccountId_igUserId: { igAccountId: input.igAccountId, igUserId: input.igUserId },
        },
        create: {
          igAccountId: input.igAccountId,
          igUserId: input.igUserId,
          lastMessageAt: input.instagramTimestamp,
        },
        update: {},
        select: { id: true },
      });

      const message = await tx.dmMessage.create({
        data: {
          threadId: thread.id,
          instagramMessageId: input.instagramMessageId,
          direction: "outbound",
          type: input.messageType,
          source: input.source,
          text: input.text,
          mediaUrl: input.mediaUrl,
          instagramTimestamp: input.instagramTimestamp,
        },
        select: { id: true },
      });

      await tx.dmThread.update({
        where: { id: thread.id },
        data: {
          lastOutboundAt: input.instagramTimestamp,
          lastMessageAt: input.instagramTimestamp,
        },
      });

      return { threadId: thread.id, messageId: message.id };
    });
  } catch (err) {
    // IDs, source and length only — never the message body.
    logger.error(
      {
        errorCode: "dm_history_write_failed",
        igUserId: input.igUserId,
        instagramMessageId: input.instagramMessageId,
        source: input.source,
        length: input.text?.length ?? 0,
      },
      "Failed to record outbound DM (message was already delivered)",
    );
    return null;
  }
}

/**
 * Mark an inbound as answered — but only if it is still the latest.
 *
 * The `latestInboundMessageId` equality is the whole point: a slow automation
 * finishing after the user sent a second message must not clear `needsReply` and
 * hide that newer message from the owner.
 */
export async function markThreadResolved(input: {
  threadId: string;
  inboundMessageId: string;
}): Promise<void> {
  try {
    await prisma.dmThread.updateMany({
      where: { id: input.threadId, latestInboundMessageId: input.inboundMessageId },
      data: { needsReply: false },
    });
  } catch (err) {
    logger.error(
      { errorCode: "dm_thread_resolve_failed", threadId: input.threadId },
      "Failed to mark DM thread resolved",
    );
  }
}

/** Store the resolved username/name. Never throws — profile lookups are best-effort. */
export async function updateDmThreadProfile(input: ThreadProfileInput): Promise<void> {
  try {
    await prisma.dmThread.updateMany({
      where: { id: input.threadId },
      data: { username: input.username, name: input.name },
    });
  } catch (err) {
    logger.error(
      { errorCode: "dm_profile_update_failed", threadId: input.threadId },
      "Failed to update DM thread profile",
    );
  }
}
