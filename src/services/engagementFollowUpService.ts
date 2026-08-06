import { prisma } from "../lib/prisma.js";
import { ACTIVE_DRAFT_STATUSES } from "./replyDraftMachine.js";
import {
  computeFollowUpSchedule,
  CURRENT_DM_PROMPT_VERSION,
} from "./replyDraftPolicy.js";

export interface ScheduleEngagementFollowUpInput {
  conversationId: string;
  threadId: string;
  inboundMessageId: string;
  inboundAt: Date;
  deliveredAt: Date;
}

export interface ScheduleEngagementFollowUpResult {
  scheduled: boolean;
  draftId: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/** Queue one owner-reviewable follow-up after a confirmed guide delivery. */
export async function scheduleEngagementFollowUp(
  input: ScheduleEngagementFollowUpInput,
): Promise<ScheduleEngagementFollowUpResult> {
  const schedule = computeFollowUpSchedule({
    deliveredAt: input.deliveredAt,
    inboundAt: input.inboundAt,
  });
  if (!schedule) return { scheduled: false, draftId: null };

  try {
    return await prisma.$transaction(async (tx) => {
      // This conditional update is the idempotency claim. Concurrent schedulers
      // serialize on the conversation row; only the first can change null -> now.
      const claim = await tx.conversation.updateMany({
        where: { id: input.conversationId, engagementFollowUpScheduledAt: null },
        data: { engagementFollowUpScheduledAt: new Date() },
      });
      if (claim.count !== 1) return { scheduled: false, draftId: null };

      // The guide answered this specific inbound. Do not supersede a draft for a
      // newer genuine inbound that raced with guide completion.
      await tx.replyDraft.updateMany({
        where: {
          threadId: input.threadId,
          inboundMessageId: input.inboundMessageId,
          status: { in: [...ACTIVE_DRAFT_STATUSES] },
        },
        data: { status: "superseded" },
      });

      const highest = await tx.replyDraft.aggregate({
        where: { threadId: input.threadId },
        _max: { revision: true },
      });
      const draft = await tx.replyDraft.create({
        data: {
          threadId: input.threadId,
          inboundMessageId: input.inboundMessageId,
          revision: (highest._max.revision ?? 0) + 1,
          status: "queued",
          kind: "engagement_follow_up",
          sourceConversationId: input.conversationId,
          eligibleAt: schedule.eligibleAt,
          nextAttemptAt: schedule.eligibleAt,
          expiresAt: schedule.expiresAt,
          promptVersion: CURRENT_DM_PROMPT_VERSION,
        },
      });

      return { scheduled: true, draftId: draft.id };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // The failed transaction (including its scheduling claim) has rolled back.
    // Only now is it safe to resolve the conversation-linked concurrent winner.
    const winner = await prisma.replyDraft.findFirst({
      where: {
        sourceConversationId: input.conversationId,
        kind: "engagement_follow_up",
        status: { in: [...ACTIVE_DRAFT_STATUSES] },
      },
      orderBy: { revision: "desc" },
    });
    if (!winner) throw error;
    return { scheduled: true, draftId: winner.id };
  }
}
