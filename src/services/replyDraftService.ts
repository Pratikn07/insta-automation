import type { ReplyDraft } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ACTIVE_DRAFT_STATUSES } from "./replyDraftMachine.js";

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
export async function queueReplyDraft(input: {
  threadId: string;
  inboundMessageId: string;
}): Promise<ReplyDraft> {
  return prisma.$transaction(async (tx) => {
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

    try {
      return await tx.replyDraft.create({
        data: {
          threadId: input.threadId,
          inboundMessageId: input.inboundMessageId,
          revision,
          status: "queued",
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent caller won. Return its draft instead of failing the webhook.
      const winner = await tx.replyDraft.findFirst({
        where: { threadId: input.threadId, status: { in: [...ACTIVE_DRAFT_STATUSES] } },
        orderBy: { revision: "desc" },
      });
      if (!winner) throw error;
      return winner;
    }
  });
}
