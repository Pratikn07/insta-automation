import type { GuideAccessAttempt } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createGuideActionOutcomeService } from "./guideActionOutcomeService.js";

const NOW = new Date("2026-08-24T20:00:00.000Z");
const EVENT_AT = new Date("2026-08-24T19:59:00.000Z");
const TOKEN_ID = "3f05a514-1f04-4b14-9df4-7730c7c39af4";
const SENDER_ID = "17890000000000002";

function attempt(state: GuideAccessAttempt["state"]): GuideAccessAttempt {
  return {
    id: "d85f8707-a270-4b86-a85f-c91e366a52bd",
    conversationId: "071b9f8d-acde-4c9a-85c4-b16fbdc5329f",
    resourceId: "2cb88833-e8df-492c-9727-f7e0cc995fed",
    coverVersionId: null,
    state,
    lastFollowResult: state === "delivered" ? "follower" : "unknown",
    lastFollowCheckedAt: null,
    followCheckCount: 1,
    followResponseCount: 0,
    coverExposure: "not_shown",
    coverProviderMessageId: null,
    messagingWindowExpiresAt: new Date(EVENT_AT.getTime() + 24 * 60 * 60_000),
    createdAt: new Date("2026-08-24T19:00:00.000Z"),
    updatedAt: NOW,
  };
}

function harness(state: GuideAccessAttempt["state"] = "awaiting_follow") {
  const current = attempt(state);
  const sendRecoveryAction = vi.fn().mockResolvedValue({ messageId: "mid-action" });
  const sendText = vi.fn().mockResolvedValue({ messageId: "mid-text" });
  const issueToken = vi.fn().mockResolvedValue({
    kind: "issued",
    token: {
      id: "e903c34b-33b5-4c42-963a-1c5743fa6cad",
      attemptId: current.id,
      action: "check_follow",
      status: "active",
      expiresAt: current.messagingWindowExpiresAt,
      consumedAt: null,
      createdAt: NOW,
    },
  });
  const dependencies = {
    loadContext: vi.fn().mockResolvedValue({ attempt: current, senderId: SENDER_ID }),
    createOrLoadAttempt: vi.fn().mockResolvedValue({
      kind: "created",
      attempt: { ...current, state: "awaiting_request" },
      cover: null,
    }),
    issueToken,
    markNeedsReview: vi.fn().mockResolvedValue({
      kind: "transitioned",
      attempt: { ...current, state: "needs_review" },
    }),
    sendRecoveryAction,
    sendText,
    capabilities: vi.fn().mockReturnValue({
      privateQuickReply: false,
      dmGenericGate: false,
      dmQuickReply: true,
      privateGeneric: false,
    }),
    now: () => NOW,
    logger: { error: vi.fn() },
  };
  return {
    dependencies,
    present: createGuideActionOutcomeService(dependencies),
    issueToken,
    sendRecoveryAction,
    sendText,
  };
}

const baseInput = {
  eventId: "d67255b5-a199-4979-85ac-5cc40f41c3bf",
  tokenId: TOKEN_ID,
  senderId: SENDER_ID,
  action: "request_guide" as const,
  eventAt: EVENT_AT,
};

describe("guide action outcome presentation", () => {
  it("sends nothing for an exact duplicate webhook", async () => {
    const test = harness();
    await expect(test.present({ ...baseInput, outcome: "duplicate_event" })).resolves.toBe(
      "none_duplicate_webhook",
    );
    expect(test.dependencies.loadContext).not.toHaveBeenCalled();
    expect(test.sendRecoveryAction).not.toHaveBeenCalled();
    expect(test.sendText).not.toHaveBeenCalled();
  });

  it("sends nothing and discloses nothing for an invalid token or sender", async () => {
    const test = harness();
    await expect(test.present({ ...baseInput, outcome: "action_invalid" })).resolves.toBe(
      "none_invalid_action",
    );
    expect(test.sendText).not.toHaveBeenCalled();
  });

  it.each(["guide_audience_blocked", "guide_audience_deferred"] as const)(
    "sends nothing when the guide audience policy returns %s",
    async (outcome) => {
      const test = harness();

      await expect(test.present({ ...baseInput, outcome })).resolves.toBe(
        "none_audience_policy",
      );

      expect(test.dependencies.loadContext).not.toHaveBeenCalled();
      expect(test.sendRecoveryAction).not.toHaveBeenCalled();
      expect(test.sendText).not.toHaveBeenCalled();
    },
  );

  it("refreshes a follow action when an older opening is tapped after the gate", async () => {
    const test = harness("awaiting_follow");
    await expect(test.present({ ...baseInput, outcome: "action_replayed" })).resolves.toBe(
      "fresh_follow_action_sent",
    );
    expect(test.issueToken).toHaveBeenCalledWith(expect.objectContaining({ action: "check_follow" }));
    expect(test.sendRecoveryAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "check_follow", recipientId: SENDER_ID }),
    );
  });

  it("reopens an expired attempt and sends a fresh opening action", async () => {
    const test = harness("expired");
    await expect(test.present({ ...baseInput, outcome: "action_expired" })).resolves.toBe(
      "fresh_opening_sent",
    );
    expect(test.dependencies.createOrLoadAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(String),
        resourceId: expect.any(String),
        messagingWindowExpiresAt: new Date(EVENT_AT.getTime() + 24 * 60 * 60_000),
      }),
    );
    expect(test.sendRecoveryAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "request_guide" }),
    );
  });

  it("confirms that a completed guide was already sent instead of starting another", async () => {
    const test = harness("delivered");
    await expect(
      test.present({ ...baseInput, outcome: "guide_delivery_already_started" }),
    ).resolves.toBe("already_delivered_notice_sent");
    expect(test.sendText).toHaveBeenCalledOnce();
    expect(test.issueToken).not.toHaveBeenCalled();
  });

  it("shows one review notice for a distinct event that needs owner help", async () => {
    const test = harness("needs_review");
    await expect(
      test.present({ ...baseInput, outcome: "access_attempt_needs_review" }),
    ).resolves.toBe("review_notice_sent");
    expect(test.sendText).toHaveBeenCalledOnce();
  });

  it("marks the attempt for review when a refreshed control send is uncertain", async () => {
    const test = harness("awaiting_follow");
    test.sendRecoveryAction.mockResolvedValue({ messageId: null });
    await expect(test.present({ ...baseInput, outcome: "action_replayed" })).resolves.toBe(
      "needs_review",
    );
    expect(test.dependencies.markNeedsReview).toHaveBeenCalledOnce();
  });
});
