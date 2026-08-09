import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { CURRENT_DM_PROMPT_VERSION } from "../services/replyDraftPolicy.js";

/**
 * Read models for the Conversations DM views.
 *
 * Mounted under apiRouter, so requireAdmin has already run. These are reads only —
 * every mutation lives on the AI router, where the send feature flag is enforced.
 */
export const dmThreadsRouter = Router();

const MESSAGE_LIMIT = 200;
export const DELIVERY_REVIEW_LIMIT = 10;

const ACTIONABLE_DELIVERY_REVIEW_WHERE = {
  OR: [
    { status: "needs_review" },
    { status: "failed", failureCode: "messaging_window_closed" },
  ],
} satisfies Prisma.GuideDeliveryWhereInput;

const DELIVERY_REVIEW_SELECT = {
  id: true,
  status: true,
  sendWindowExpiresAt: true,
  failureCode: true,
  units: {
    orderBy: { position: "asc" as const },
    select: { id: true, position: true, kind: true, status: true },
  },
} as const;

const listQuerySchema = z.object({
  scope: z.enum(["needs_reply", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  cursor: z.string().uuid().optional(),
});

/** The draft a row/detail should show: the active one, else the latest failed one. */
const DRAFT_SELECT = {
  id: true,
  kind: true,
  status: true,
  revision: true,
  suggestedText: true,
  workingText: true,
  approvedText: true,
  rationale: true,
  confidence: true,
  warnings: true,
  errorCode: true,
  errorMessage: true,
  retryAt: true,
  inboundMessageId: true,
  sourceConversationId: true,
  eligibleAt: true,
  expiresAt: true,
  promptVersion: true,
  sourceConversation: {
    select: {
      keyword: {
        select: {
          keyword: true,
          resource: { select: { name: true, description: true, kind: true } },
        },
      },
    },
  },
  approvedBy: true,
  approvedAt: true,
  sentAt: true,
  createdAt: true,
} as const;

type SelectedDraft = Prisma.ReplyDraftGetPayload<{ select: typeof DRAFT_SELECT }>;
type SelectedDeliveryReview = Prisma.GuideDeliveryGetPayload<{
  select: typeof DELIVERY_REVIEW_SELECT;
}>;

const GUIDE_NAME_LIMIT = 200;
const GUIDE_DESCRIPTION_LIMIT = 500;
const GUIDE_KIND_LIMIT = 64;
const GUIDE_KEYWORD_LIMIT = 100;

function serializeDraft(draft: SelectedDraft | undefined): object | null {
  if (!draft) return null;
  const { sourceConversation, ...safeDraft } = draft;
  const resource = sourceConversation?.keyword.resource;
  return {
    ...safeDraft,
    promptPolicyCurrent: draft.promptVersion === CURRENT_DM_PROMPT_VERSION,
    sourceGuide:
      draft.kind === "engagement_follow_up" && sourceConversation && resource
        ? {
            name: resource.name.slice(0, GUIDE_NAME_LIMIT),
            description: resource.description?.slice(0, GUIDE_DESCRIPTION_LIMIT) ?? null,
            kind: resource.kind?.slice(0, GUIDE_KIND_LIMIT) ?? null,
            keyword: sourceConversation.keyword.keyword.slice(0, GUIDE_KEYWORD_LIMIT),
          }
        : null,
  };
}

function serializeDeliveryReview(review: SelectedDeliveryReview, requestNow: Date) {
  return {
    id: review.id,
    status: review.status,
    confirmedUnits: review.units.filter((unit) => unit.status === "sent").length,
    totalUnits: review.units.length,
    sendWindowExpiresAt: review.sendWindowExpiresAt,
    sendWindowOpen: review.sendWindowExpiresAt > requestNow,
    failureCode: review.failureCode,
    units: review.units,
  };
}

dmThreadsRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { scope, limit, cursor } = parsed.data;

  const rows = await prisma.dmThread.findMany({
    where: scope === "needs_reply" ? { needsReply: true } : undefined,
    // Recency by conversation activity, id as the tiebreak so the cursor is stable.
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    select: {
      id: true,
      igUserId: true,
      username: true,
      name: true,
      needsReply: true,
      latestInboundMessageId: true,
      lastMessageAt: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      // Only the newest message is needed for a list row.
      messages: {
        orderBy: { instagramTimestamp: "desc" },
        take: 1,
        select: { direction: true, text: true, type: true, source: true, instagramTimestamp: true },
      },
      // Newest draft first; the client shows it only if it is active or failed.
      drafts: { orderBy: { revision: "desc" }, take: 1, select: DRAFT_SELECT },
      _count: {
        select: {
          guideDeliveries: { where: ACTIONABLE_DELIVERY_REVIEW_WHERE },
        },
      },
    },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  res.json({
    items: items.map(({ messages, drafts, _count, ...thread }) => ({
      ...thread,
      latestMessage: messages[0] ?? null,
      draft: serializeDraft(drafts[0]),
      deliveryReviewCount: _count.guideDeliveries,
    })),
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  });
});

dmThreadsRouter.get("/:threadId", async (req, res) => {
  const threadId = req.params.threadId;
  const requestNow = new Date();
  const thread = await prisma.dmThread.findUnique({
    where: { id: threadId },
    select: {
      id: true,
      igUserId: true,
      username: true,
      name: true,
      needsReply: true,
      latestInboundMessageId: true,
      lastMessageAt: true,
      messages: {
        orderBy: [{ instagramTimestamp: "desc" }, { id: "desc" }],
        take: MESSAGE_LIMIT,
        select: {
          id: true,
          direction: true,
          text: true,
          type: true,
          source: true,
          mediaUrl: true,
          instagramTimestamp: true,
        },
      },
      drafts: { orderBy: { revision: "desc" }, take: 1, select: DRAFT_SELECT },
      guideDeliveries: {
        where: ACTIONABLE_DELIVERY_REVIEW_WHERE,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: DELIVERY_REVIEW_LIMIT,
        select: DELIVERY_REVIEW_SELECT,
      },
    },
  });
  if (!thread) return res.status(404).json({ error: "not_found" });

  const { drafts, messages, guideDeliveries, ...rest } = thread;
  res.json({
    ...rest,
    messages: messages.reverse(),
    draft: serializeDraft(drafts[0]),
    deliveryReviews: (guideDeliveries ?? []).map((review) =>
      serializeDeliveryReview(review, requestNow)),
  });
});
