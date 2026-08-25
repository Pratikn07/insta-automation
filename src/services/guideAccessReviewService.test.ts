import { describe, expect, it, vi } from "vitest";
import { createGuideAccessReviewService } from "./guideAccessReviewService.js";

const NOW = new Date("2026-08-24T20:00:00.000Z");
const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000002";
const TOKEN_ID = "30000000-0000-4000-8000-000000000003";

function harness() {
  const findReviews = vi.fn().mockResolvedValue([]);
  const resetReviewActionForConversation = vi.fn().mockResolvedValue({
    kind: "ready",
    attempt: { id: ATTEMPT_ID },
    token: { id: TOKEN_ID },
  });
  const sendRecoveryAction = vi.fn().mockResolvedValue({ messageId: "mid-owner-action" });
  const markNeedsReview = vi.fn().mockResolvedValue({ kind: "transitioned" });
  const loadRecipient = vi.fn().mockResolvedValue("17890000000000002");
  const service = createGuideAccessReviewService({
    findReviews,
    resetReviewActionForConversation,
    markNeedsReview,
    loadRecipient,
    sendRecoveryAction,
    capabilities: () => ({
      privateQuickReply: false,
      dmGenericGate: false,
      dmQuickReply: true,
    }),
  });
  return {
    service,
    findReviews,
    resetReviewActionForConversation,
    sendRecoveryAction,
    markNeedsReview,
  };
}

describe("guide access owner review", () => {
  it("returns bounded review identity and server-computed available actions", async () => {
    const test = harness();
    test.findReviews.mockResolvedValue([
      {
        id: ATTEMPT_ID,
        conversationId: CONVERSATION_ID,
        state: "needs_review",
        lastFollowResult: "unknown",
        followCheckCount: 5,
        followResponseCount: 3,
        messagingWindowExpiresAt: new Date(NOW.getTime() + 60_000),
        conversation: { igUserId: "parent-1" },
        resource: { name: "R".repeat(250) },
      },
    ]);

    await expect(test.service.listForIgUsers(["parent-1"], NOW)).resolves.toEqual([
      expect.objectContaining({
        resourceName: "R".repeat(200),
        messagingWindowOpen: true,
        canRelease: true,
        canResendAction: true,
      }),
    ]);
  });

  it("sends one fresh opening action through the reset fence", async () => {
    const test = harness();
    await expect(
      test.service.resendAction({
        conversationId: CONVERSATION_ID,
        actor: "owner@example.com",
        now: NOW,
      }),
    ).resolves.toBe("sent");

    expect(test.resetReviewActionForConversation).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      actor: "owner@example.com",
      now: NOW,
    });
    expect(test.sendRecoveryAction).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: "17890000000000002",
        action: "request_guide",
        actionToken: TOKEN_ID,
      }),
    );
  });

  it("never retries an uncertain owner send and returns the attempt to review", async () => {
    const test = harness();
    test.sendRecoveryAction.mockResolvedValue({ messageId: null });

    await expect(
      test.service.resendAction({
        conversationId: CONVERSATION_ID,
        actor: "owner@example.com",
        now: NOW,
      }),
    ).resolves.toBe("needs_review");
    expect(test.sendRecoveryAction).toHaveBeenCalledOnce();
    expect(test.markNeedsReview).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      expectedState: "awaiting_request",
    });
  });
});
