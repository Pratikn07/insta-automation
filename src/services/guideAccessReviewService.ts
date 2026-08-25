import { prisma } from "../lib/prisma.js";
import {
  sendGuideRecoveryAction,
  type GuideActionCapabilities,
} from "../meta/sendGuideAction.js";
import type { MetaSendResult } from "../types/meta.js";
import {
  guideAccessRepository,
  type GuideAccessRepository,
} from "./guideAccessRepository.js";
import { guideRichGateEnabled } from "./guideFollowGateV2Rollout.js";

const GUIDE_NAME_LIMIT = 200;

export interface GuideAccessReview {
  attemptId: string;
  conversationId: string;
  igUserId: string;
  resourceName: string;
  state: "needs_review";
  lastFollowResult: "follower" | "non_follower" | "unknown";
  followCheckCount: number;
  followResponseCount: number;
  messagingWindowExpiresAt: Date;
  messagingWindowOpen: boolean;
  canRelease: boolean;
  canResendAction: boolean;
}

export type ResendGuideAccessActionResult =
  | "sent"
  | "not_found"
  | "messaging_window_closed"
  | "delivering"
  | "needs_review";

type GuideAccessReviewDependencies = {
  findReviews(igUserIds: string[]): Promise<
    Array<{
      id: string;
      conversationId: string;
      lastFollowResult: "follower" | "non_follower" | "unknown";
      followCheckCount: number;
      followResponseCount: number;
      messagingWindowExpiresAt: Date;
      conversation: { igUserId: string };
      resource: { name: string };
    }>
  >;
  resetReviewActionForConversation: GuideAccessRepository["resetReviewActionForConversation"];
  markNeedsReview: GuideAccessRepository["markNeedsReview"];
  loadRecipient(conversationId: string): Promise<string | null>;
  sendRecoveryAction(input: {
    recipientId: string;
    action: "request_guide";
    actionToken: string;
    capabilities: GuideActionCapabilities;
  }): Promise<MetaSendResult>;
  capabilities(): GuideActionCapabilities;
};

export function createGuideAccessReviewService(
  dependencies: GuideAccessReviewDependencies,
) {
  return {
    async listForIgUsers(igUserIds: string[], now = new Date()): Promise<GuideAccessReview[]> {
      if (igUserIds.length === 0) return [];
      const rows = await dependencies.findReviews([...new Set(igUserIds)]);
      return rows.map((row) => {
        const messagingWindowOpen = row.messagingWindowExpiresAt > now;
        const deliveryStarted = row.lastFollowResult === "follower";
        return {
          attemptId: row.id,
          conversationId: row.conversationId,
          igUserId: row.conversation.igUserId,
          resourceName: row.resource.name.slice(0, GUIDE_NAME_LIMIT),
          state: "needs_review",
          lastFollowResult: row.lastFollowResult,
          followCheckCount: row.followCheckCount,
          followResponseCount: row.followResponseCount,
          messagingWindowExpiresAt: row.messagingWindowExpiresAt,
          messagingWindowOpen,
          canRelease: !deliveryStarted,
          canResendAction: messagingWindowOpen && !deliveryStarted,
        };
      });
    },

    async resendAction(input: {
      conversationId: string;
      actor: string;
      now: Date;
    }): Promise<ResendGuideAccessActionResult> {
      const reset = await dependencies.resetReviewActionForConversation({
        conversationId: input.conversationId,
        actor: input.actor,
        now: input.now,
      });
      if (reset.kind !== "ready") {
        if (reset.kind === "not_found") return "not_found";
        if (reset.kind === "messaging_window_closed") return "messaging_window_closed";
        return "delivering";
      }

      const recipientId = await dependencies.loadRecipient(input.conversationId);
      if (!recipientId) return "needs_review";

      try {
        const receipt = await dependencies.sendRecoveryAction({
          recipientId,
          action: "request_guide",
          actionToken: reset.token.id,
          capabilities: dependencies.capabilities(),
        });
        if (receipt.messageId) return "sent";
      } catch {
        // The send may have reached Meta. Never repeat it automatically.
      }
      try {
        await dependencies.markNeedsReview({
          attemptId: reset.attempt.id,
          expectedState: "awaiting_request",
        });
      } catch {
        // The owner still receives an uncertainty response; production health also detects
        // this awaiting row if the checkpoint itself failed.
      }
      return "needs_review";
    },
  };
}

export const guideAccessReviewService = createGuideAccessReviewService({
  findReviews: (igUserIds) =>
    prisma.guideAccessAttempt.findMany({
      where: {
        state: "needs_review",
        conversation: { igUserId: { in: igUserIds } },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: 100,
      select: {
        id: true,
        conversationId: true,
        lastFollowResult: true,
        followCheckCount: true,
        followResponseCount: true,
        messagingWindowExpiresAt: true,
        conversation: { select: { igUserId: true } },
        resource: { select: { name: true } },
      },
    }),
  resetReviewActionForConversation: (input) =>
    guideAccessRepository.resetReviewActionForConversation(input),
  markNeedsReview: (input) => guideAccessRepository.markNeedsReview(input),
  loadRecipient: async (conversationId) => {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { igUserId: true },
    });
    return conversation?.igUserId ?? null;
  },
  sendRecoveryAction: sendGuideRecoveryAction,
  capabilities: () =>
    guideRichGateEnabled()
      ? {
          privateQuickReply: true,
          dmGenericGate: true,
          dmQuickReply: true,
          privateGeneric: true,
        }
      : {
          privateQuickReply: false,
          dmGenericGate: false,
          dmQuickReply: false,
          privateGeneric: false,
        },
});
