import type { GuideLinkChannel, GuideLinkShape, Prisma, PrismaClient } from "@prisma/client";
import { MAX_RECORDED_CLICKS_PER_SEND } from "./linkGuidePolicy.js";

type LinkGuideDatabase = PrismaClient | Prisma.TransactionClient;

export type RedirectSend = {
  id: string;
  conversationId: string;
  mediaId: string | null;
  conversationState: string;
  resource: { name: string; linkUrl: string | null };
};

/**
 * Reads and writes for link-guide sends and clicks. Takes the client as an argument so
 * the contract test can point it at the disposable database. The production instance
 * will live in linkGuideFlow.ts (Task 8), the only file that imports the app's prisma singleton.
 */
export function createLinkGuideRepository(db: LinkGuideDatabase) {
  return {
    async createSend(input: {
      token: string;
      conversationId: string;
      resourceId: string;
      keywordId: string;
      mediaId: string | null;
      igUserId: string;
      channel: GuideLinkChannel;
      shape: GuideLinkShape;
    }): Promise<{ id: string }> {
      return db.guideLinkSend.create({ data: input, select: { id: true } });
    },

    async markSendSent(id: string, providerMessageId: string | null, sentAt: Date): Promise<void> {
      await db.guideLinkSend.update({ where: { id }, data: { status: "sent", providerMessageId, sentAt } });
    },

    async markSendFailed(id: string): Promise<void> {
      await db.guideLinkSend.update({ where: { id }, data: { status: "failed" } });
    },

    /**
     * A failed link DM is retried by the gate queue as text carrying the SAME token, so
     * the retry completes the send it retried rather than creating a second one. The write
     * is guarded on status "failed", so of two concurrent retries only one claims the row.
     */
    async markLatestFailedSendSent(
      conversationId: string,
      providerMessageId: string | null,
      sentAt: Date,
    ): Promise<boolean> {
      const latest = await db.guideLinkSend.findFirst({
        where: { conversationId, status: "failed" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (!latest) return false;
      const result = await db.guideLinkSend.updateMany({
        where: { id: latest.id, status: "failed" },
        data: { status: "sent", shape: "text", providerMessageId, sentAt },
      });
      return result.count === 1;
    },

    async findForRedirect(token: string): Promise<RedirectSend | null> {
      const row = await db.guideLinkSend.findUnique({
        where: { token },
        select: {
          id: true,
          conversationId: true,
          mediaId: true,
          conversation: { select: { state: true } },
          resource: { select: { name: true, linkUrl: true } },
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        conversationId: row.conversationId,
        mediaId: row.mediaId,
        conversationState: row.conversation.state,
        resource: row.resource,
      };
    },

    /**
     * Records one hit on /r/<token>. Bots are stored but never count as a tap.
     *
     * The 20-row cap is a soft bound against scrapers: the count and the insert are not
     * one atomic step, so a burst of simultaneous hits can overshoot it slightly.
     *
     * `firstHumanClick` can be true for more than one simultaneous human tap. Callers must
     * treat it as idempotent: the conversation completion it triggers is repeat-safe. The
     * funnel counts a parent's tap once regardless of how many rows they produced.
     */
    async recordClick(input: {
      sendId: string;
      destinationUrl: string;
      isBot: boolean;
      uaFamily: string;
      clickedAt: Date;
    }): Promise<{ recorded: boolean; firstHumanClick: boolean }> {
      const existing = await db.guideLinkClick.count({ where: { sendId: input.sendId } });
      if (existing >= MAX_RECORDED_CLICKS_PER_SEND) return { recorded: false, firstHumanClick: false };
      const priorHumanClicks = input.isBot
        ? 0
        : await db.guideLinkClick.count({ where: { sendId: input.sendId, isBot: false } });
      await db.guideLinkClick.create({ data: input });
      return { recorded: true, firstHumanClick: !input.isBot && priorHumanClicks === 0 };
    },
  };
}

export type LinkGuideRepository = ReturnType<typeof createLinkGuideRepository>;
