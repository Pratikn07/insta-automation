import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

const CANDIDATE_DETAIL_SELECT = {
  id: true,
  campaignId: true,
  campaignPhase: true,
  intentId: true,
  igUserId: true,
  conversationId: true,
  keywordId: true,
  commentId: true,
  mediaId: true,
  commentAt: true,
  keywordSnapshot: true,
  publicReplyText: true,
  evidence: true,
  audienceOrigin: true,
  audienceOriginConfidence: true,
  arm: true,
  outcome: true,
  attempts: true,
  lastAttemptAt: true,
  sentAt: true,
  publicReplyId: true,
  suppressionReason: true,
  reviewedAt: true,
  laterInboundAt: true,
  laterCompletedAt: true,
  createdAt: true,
  updatedAt: true,
  campaign: {
    select: {
      id: true,
      phase: true,
      state: true,
      selectionVersion: true,
      copyVersion: true,
      sourceDataCutoff: true,
    },
  },
  keyword: { select: { id: true, keyword: true, mediaPermalink: true } },
  intent: {
    select: {
      id: true,
      igUserId: true,
      windowStartedAt: true,
      lastTriggerAt: true,
      windowExpiresAt: true,
      reconciledState: true,
      completedAt: true,
      keyword: { select: { id: true, keyword: true } },
      canonicalConversation: {
        select: {
          id: true,
          state: true,
          createdAt: true,
          reconciliationReason: true,
        },
      },
      aliasConversations: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          state: true,
          createdAt: true,
          reconciliationReason: true,
        },
      },
      triggers: {
        orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          conversationId: true,
          commentId: true,
          mediaId: true,
          receivedAt: true,
          triggerKind: true,
          disposition: true,
        },
      },
    },
  },
} satisfies Prisma.RecoveryCandidateSelect;

function optionalDate(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function payloadString(payload: Prisma.JsonValue, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Prisma.JsonObject)[key];
  return typeof value === "string" ? value : null;
}

export async function historicalCandidateDetail(candidateId: string) {
  const row = await prisma.recoveryCandidate.findUnique({
    where: { id: candidateId },
    select: CANDIDATE_DETAIL_SELECT,
  });
  if (!row) return null;

  const [reel, feed, auditRows] = await Promise.all([
    row.mediaId
      ? prisma.reelMeta.findUnique({
          where: { mediaId: row.mediaId },
          select: { permalink: true },
        })
      : null,
    row.mediaId
      ? prisma.feedPostMeta.findUnique({
          where: { mediaId: row.mediaId },
          select: { permalink: true },
        })
      : null,
    prisma.eventLog.findMany({
      where: { payload: { path: ["candidateId"], equals: candidateId } },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: { id: true, kind: true, payload: true, createdAt: true },
    }),
  ]);

  return {
    candidate: {
      id: row.id,
      campaignId: row.campaignId,
      campaignPhase: row.campaignPhase,
      intentId: row.intentId,
      igUserId: row.igUserId,
      conversationId: row.conversationId,
      keywordId: row.keywordId,
      commentId: row.commentId,
      mediaId: row.mediaId,
      commentAt: row.commentAt.toISOString(),
      keywordSnapshot: row.keywordSnapshot,
      publicReplyText: row.publicReplyText,
      evidence: row.evidence,
      audienceOrigin: row.audienceOrigin,
      audienceOriginConfidence: row.audienceOriginConfidence,
      arm: row.arm,
      outcome: row.outcome,
      attempts: row.attempts,
      lastAttemptAt: optionalDate(row.lastAttemptAt),
      sentAt: optionalDate(row.sentAt),
      publicReplyId: row.publicReplyId,
      suppressionReason: row.suppressionReason,
      reviewedAt: optionalDate(row.reviewedAt),
      laterInboundAt: optionalDate(row.laterInboundAt),
      laterCompletedAt: optionalDate(row.laterCompletedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    campaign: {
      ...row.campaign,
      sourceDataCutoff: row.campaign.sourceDataCutoff.toISOString(),
    },
    intent: {
      id: row.intent.id,
      igUserId: row.intent.igUserId,
      keyword: row.intent.keyword,
      windowStartedAt: row.intent.windowStartedAt.toISOString(),
      lastTriggerAt: row.intent.lastTriggerAt.toISOString(),
      windowExpiresAt: row.intent.windowExpiresAt.toISOString(),
      reconciledState: row.intent.reconciledState,
      completedAt: optionalDate(row.intent.completedAt),
      canonicalConversation: row.intent.canonicalConversation
        ? {
            ...row.intent.canonicalConversation,
            createdAt: row.intent.canonicalConversation.createdAt.toISOString(),
          }
        : null,
      aliasConversations: row.intent.aliasConversations.map((conversation) => ({
        ...conversation,
        createdAt: conversation.createdAt.toISOString(),
      })),
      triggers: row.intent.triggers.map((trigger) => ({
        ...trigger,
        receivedAt: trigger.receivedAt.toISOString(),
      })),
    },
    mediaPermalink: reel?.permalink ?? feed?.permalink ?? row.keyword.mediaPermalink ?? null,
    auditEvents: auditRows.map((event) => ({
      id: event.id,
      kind: event.kind,
      actor: payloadString(event.payload, "actor"),
      action: payloadString(event.payload, "action"),
      reason: payloadString(event.payload, "reason"),
      category: payloadString(event.payload, "category"),
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

export type HistoricalCandidateDetail = NonNullable<
  Awaited<ReturnType<typeof historicalCandidateDetail>>
>;
