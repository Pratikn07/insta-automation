import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MessagingEntry } from "../types/meta.js";
import {
  GUIDE_ACTION_PAYLOAD,
  GUIDE_ACTION_TIMESTAMP,
  guideQuickReplyEvent,
} from "../test/fixtures/metaGuideGateEvents.js";

// --- mocks -------------------------------------------------------------------
const recordInboundMessage = vi.fn();
const updateDmThreadProfile = vi.fn();
const markThreadResolved = vi.fn();
const markInboundDeleted = vi.fn();
const recordRecoveryInbound = vi.fn();
const recordInboundCampaignHealthSignals = vi.fn();
const markInboundCampaignHealthCaptured = vi.fn();
const queueReplyDraft = vi.fn();
const scheduleEngagementFollowUp = vi.fn();
const findKeywordInMessage = vi.fn();
const findActiveAwaitingDone = vi.fn();
const findLatestIncompleteConversation = vi.fn();
const hasCompletedKeyword = vi.fn();
const openConversationIn = vi.fn();
const resolveJourneyIntent = vi.fn();
const markCompleted = vi.fn();
const markGated = vi.fn();
const sendSequence = vi.fn();
const guideDeliveryOwner = vi.fn();
const deliverGuideForTrigger = vi.fn();
const sendTrackedText = vi.fn();
const resolveUsername = vi.fn();
const routeGuideAction = vi.fn();
const gateOwner = vi.fn();
const startDirectDmGuideRequest = vi.fn();
const recordGuideAccessMetric = vi.fn();
const logEvent = vi.fn();
const SAFE_UNKNOWN = {
  category: "unknown_error",
  httpStatus: null,
  graphCode: null,
  graphSubcode: null,
  traceId: null,
};
const describeGraphError = vi.fn(() => SAFE_UNKNOWN);
const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

vi.mock("../services/dmThreadService.js", () => ({
  recordInboundMessage,
  updateDmThreadProfile,
  markThreadResolved,
  markInboundDeleted,
}));
vi.mock("../services/dmRecoveryService.js", () => ({ recordRecoveryInbound }));
vi.mock("../services/campaignHealthObservation.js", () => ({
  recordInboundCampaignHealthSignals,
  markInboundCampaignHealthCaptured,
}));
vi.mock("../services/replyDraftService.js", () => ({ queueReplyDraft }));
vi.mock("../services/engagementFollowUpService.js", () => ({ scheduleEngagementFollowUp }));
vi.mock("../services/keywordService.js", () => ({ findKeywordInMessage }));
// The resolver is contract-tested against real Postgres; here the DM path's own
// contract is that it records the trigger and still delivers.
vi.mock("../services/journeyIntentService.js", () => ({ resolveJourneyIntent }));
vi.mock("../services/conversationService.js", () => ({
  findActiveAwaitingDone,
  findLatestIncompleteConversation,
  hasCompletedKeyword,
  openConversationIn,
  markCompleted,
  markGated,
}));
vi.mock("../services/sequenceSender.js", () => ({ sendSequence }));
vi.mock("../services/guideDeliveryRollout.js", () => ({ guideDeliveryOwner }));
vi.mock("../services/guideDeliveryService.js", () => ({ deliverGuideForTrigger }));
vi.mock("../services/dmDeliveryService.js", () => ({ sendTrackedText }));
vi.mock("../services/igUserService.js", () => ({ resolveUsername }));
vi.mock("./guideActionRouter.js", () => ({ routeGuideAction }));
vi.mock("../services/guideFollowGateV2Rollout.js", () => ({
  guideFollowGateV2Selector: { owner: gateOwner },
}));
vi.mock("../services/guideAccessActionService.js", () => ({ startDirectDmGuideRequest }));
vi.mock("../services/guideAccessMetrics.js", () => ({
  guideAccessMetrics: { record: recordGuideAccessMetric },
}));
vi.mock("../services/eventLogger.js", () => ({
  logEvent,
  describeGraphError,
}));
vi.mock("../lib/logger.js", () => ({ logger }));

// The real env has AI_DRAFTS_ENABLED=false (all AI ships off), so drafting is
// mocked ON here and toggled per test. `aiDraftsEnabled` is mutable so one test
// can prove the flag genuinely gates the queue call.
const aiFlags = {
  AI_DRAFTS_ENABLED: true,
  AI_FOLLOW_UPS_ENABLED: true,
  GUIDE_DELIVERY_ENABLED: true,
  GUIDE_DELIVERY_ROLLOUT_PERCENT: 25,
  GUIDE_DELIVERY_COHORT_IG_USER_IDS: "controlled-1",
};
vi.mock("../config/env.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    env: Record<string, unknown>;
  };
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, prop) => {
        if (prop === "AI_DRAFTS_ENABLED") return aiFlags.AI_DRAFTS_ENABLED;
        if (prop === "AI_FOLLOW_UPS_ENABLED") return aiFlags.AI_FOLLOW_UPS_ENABLED;
        if (prop === "GUIDE_DELIVERY_ENABLED") return aiFlags.GUIDE_DELIVERY_ENABLED;
        if (prop === "GUIDE_DELIVERY_ROLLOUT_PERCENT") {
          return aiFlags.GUIDE_DELIVERY_ROLLOUT_PERCENT;
        }
        if (prop === "GUIDE_DELIVERY_COHORT_IG_USER_IDS") {
          return aiFlags.GUIDE_DELIVERY_COHORT_IG_USER_IDS;
        }
        return target[prop as string];
      },
    }),
  };
});

const { handleMessage } = await import("./messageHandler.js");
const { env } = await import("../config/env.js");

// --- fixtures ----------------------------------------------------------------
function inbound(text: string, overrides: Partial<MessagingEntry> = {}): MessagingEntry {
  return {
    sender: { id: "ig-user-1" },
    recipient: { id: env.IG_USER_ID },
    timestamp: 1785895200000,
    message: { mid: "mid-1", text },
    ...overrides,
  };
}

const keywordFixture = {
  id: "keyword-1",
  keyword: "SLEEP",
  gateMessage: "Follow and reply DONE",
  mediaId: null,
  inferredFromPost: null,
  resource: {
    id: "resource-1",
    messages: [{ id: "m1", order: 0, type: "text", body: "guide" }],
  },
};

beforeEach(() => {
  for (const fn of [
    recordInboundMessage,
    updateDmThreadProfile,
    markThreadResolved,
    markInboundDeleted,
    recordRecoveryInbound,
    recordInboundCampaignHealthSignals,
    markInboundCampaignHealthCaptured,
    queueReplyDraft,
    scheduleEngagementFollowUp,
    findKeywordInMessage,
    findActiveAwaitingDone,
    findLatestIncompleteConversation,
    hasCompletedKeyword,
    openConversationIn,
    resolveJourneyIntent,
    markCompleted,
    markGated,
    sendSequence,
    guideDeliveryOwner,
    deliverGuideForTrigger,
    sendTrackedText,
    resolveUsername,
    routeGuideAction,
    gateOwner,
    startDirectDmGuideRequest,
    recordGuideAccessMetric,
    logEvent,
    describeGraphError,
  ]) {
    fn.mockReset();
  }
  for (const fn of Object.values(logger)) fn.mockReset();
  describeGraphError.mockReturnValue(SAFE_UNKNOWN);
  recordInboundMessage.mockResolvedValue({
    duplicate: false,
    becameLatest: true,
    threadId: "thread-1",
    messageId: "message-1",
  });
  resolveUsername.mockResolvedValue({ isFollower: true, username: "geri", name: "Geri" });
  routeGuideAction.mockResolvedValue({
    kind: "handled",
    outcome: "guide_delivery_started",
  });
  findKeywordInMessage.mockResolvedValue(null);
  findActiveAwaitingDone.mockResolvedValue(null);
  findLatestIncompleteConversation.mockResolvedValue(null);
  hasCompletedKeyword.mockResolvedValue(false);
  openConversationIn.mockResolvedValue({ id: "convo-1" });
  resolveJourneyIntent.mockResolvedValue({
    disposition: "new_journey",
    intentId: "intent-1",
    conversationId: "convo-1",
    maySendGate: true,
  });
  logEvent.mockResolvedValue(undefined);
  sendTrackedText.mockResolvedValue({ messageId: "mid-out" });
  sendSequence.mockResolvedValue(undefined);
  // Default-off: every pre-existing expectation is the V1 path.
  gateOwner.mockReturnValue("v1");
  startDirectDmGuideRequest.mockResolvedValue("guide_delivery_started");
  recordGuideAccessMetric.mockResolvedValue("recorded");
  guideDeliveryOwner.mockReturnValue("legacy");
  deliverGuideForTrigger.mockResolvedValue("completed");
  queueReplyDraft.mockResolvedValue({ id: "draft-1" });
  scheduleEngagementFollowUp.mockResolvedValue({ scheduled: true, draftId: "follow-up-1" });
  recordInboundCampaignHealthSignals.mockResolvedValue({ recorded: 0 });
  markInboundCampaignHealthCaptured.mockResolvedValue(true);
  markCompleted.mockResolvedValue({
    id: "convo-1",
    completedAt: new Date("2026-08-05T10:01:00.000Z"),
  });
  aiFlags.AI_DRAFTS_ENABLED = true;
  aiFlags.AI_FOLLOW_UPS_ENABLED = true;
  aiFlags.GUIDE_DELIVERY_ENABLED = true;
  aiFlags.GUIDE_DELIVERY_ROLLOUT_PERCENT = 25;
  aiFlags.GUIDE_DELIVERY_COHORT_IG_USER_IDS = "controlled-1";
});

describe("handleMessage — inbound capture", () => {
  it("captures a stable inbound message for campaign health classification", async () => {
    await handleMessage(inbound("STOP"));

    expect(recordInboundCampaignHealthSignals).toHaveBeenCalledWith({
      igUserId: "ig-user-1",
      instagramMessageId: "mid-1",
      text: "STOP",
      observedAt: new Date(1785895200000),
    });
    expect(markInboundCampaignHealthCaptured).toHaveBeenCalledWith(
      "message-1",
      expect.any(Date),
    );
  });

  it("retries idempotent health capture for a duplicate webhook", async () => {
    recordInboundMessage.mockResolvedValue({
      duplicate: true,
      becameLatest: false,
      threadId: "thread-1",
      messageId: "message-1",
    });

    await handleMessage(inbound("STOP"));

    expect(recordInboundCampaignHealthSignals).toHaveBeenCalledWith({
      igUserId: "ig-user-1",
      instagramMessageId: "mid-1",
      text: "STOP",
      observedAt: new Date(1785895200000),
    });
  });

  it("leaves durable capture state pending without breaking acknowledged inbound handling", async () => {
    recordInboundCampaignHealthSignals.mockRejectedValue(new Error("private database detail"));

    await expect(handleMessage(inbound("STOP"))).resolves.toBeUndefined();

    expect(markInboundCampaignHealthCaptured).not.toHaveBeenCalled();
    expect(recordRecoveryInbound).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "campaign_health_inbound_capture_failed" }),
      expect.any(String),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private database detail");
  });

  it("drops a duplicate webhook before automation or drafting", async () => {
    recordInboundMessage.mockResolvedValue({
      duplicate: true,
      becameLatest: false,
      threadId: "thread-1",
      messageId: "message-1",
    });

    await handleMessage(inbound("SLEEP"));

    expect(findKeywordInMessage).not.toHaveBeenCalled();
    expect(queueReplyDraft).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("stores a delayed non-latest webhook but skips every downstream side effect", async () => {
    recordInboundMessage.mockResolvedValue({
      duplicate: false,
      becameLatest: false,
      threadId: "thread-1",
      messageId: "message-stale",
    });

    await handleMessage(inbound("SLEEP"));

    expect(resolveUsername).not.toHaveBeenCalled();
    expect(updateDmThreadProfile).not.toHaveBeenCalled();
    expect(findKeywordInMessage).not.toHaveBeenCalled();
    expect(findActiveAwaitingDone).not.toHaveBeenCalled();
    expect(resolveJourneyIntent).not.toHaveBeenCalled();
    expect(queueReplyDraft).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
  });

  it("ignores an echo of our own message", async () => {
    await handleMessage(
      inbound("SLEEP", { message: { mid: "mid-1", text: "SLEEP", is_echo: true } }),
    );
    expect(recordInboundMessage).not.toHaveBeenCalled();
  });

  it("records an image-only DM as an image, not an empty text message", async () => {
    await handleMessage(
      inbound("", {
        message: {
          mid: "mid-img",
          attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }],
        },
      }),
    );

    expect(recordInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "image", mediaUrl: "https://cdn/x.jpg" }),
    );
  });

  it("uses Meta's timestamp so a delayed webhook still orders correctly", async () => {
    await handleMessage(inbound("hello"));
    expect(recordInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ instagramTimestamp: new Date(1785895200000) }),
    );
  });

  it("captures a provider-shaped quick reply as text plus quick-reply recovery evidence", async () => {
    const entry = guideQuickReplyEvent();

    await handleMessage(entry);

    expect(recordInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        igUserId: "controlled-recipient",
        instagramMessageId: "controlled-quick-reply-mid",
        text: "Yes, send it",
        messageType: "text",
        instagramTimestamp: new Date(GUIDE_ACTION_TIMESTAMP),
      }),
    );
    expect(recordRecoveryInbound).toHaveBeenCalledWith({
      igUserId: "controlled-recipient",
      eventAt: new Date(GUIDE_ACTION_TIMESTAMP),
      receivedAt: expect.any(Date),
      kind: "quick_reply",
    });
    expect(routeGuideAction).toHaveBeenCalledWith({
      payload: GUIDE_ACTION_PAYLOAD,
      senderId: "controlled-recipient",
      inboundMessageId: "message-1",
      eventAt: new Date(GUIDE_ACTION_TIMESTAMP),
    });
    expect(resolveUsername).not.toHaveBeenCalled();
    expect(findKeywordInMessage).not.toHaveBeenCalled();
    expect(findActiveAwaitingDone).not.toHaveBeenCalled();
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain(GUIDE_ACTION_PAYLOAD);
  });

  it("routes an exact quick-reply provider replay only once", async () => {
    recordInboundMessage
      .mockResolvedValueOnce({
        duplicate: false,
        becameLatest: true,
        threadId: "thread-1",
        messageId: "message-1",
      })
      .mockResolvedValueOnce({
        duplicate: true,
        becameLatest: false,
        threadId: "thread-1",
        messageId: "message-1",
      });
    const entry = guideQuickReplyEvent();

    await handleMessage(entry);
    await handleMessage(entry);

    expect(routeGuideAction).toHaveBeenCalledOnce();
    expect(findKeywordInMessage).not.toHaveBeenCalled();
    expect(findActiveAwaitingDone).not.toHaveBeenCalled();
  });

  it("routes a valid delayed quick reply even when it is not the latest thread message", async () => {
    recordInboundMessage.mockResolvedValue({
      duplicate: false,
      becameLatest: false,
      threadId: "thread-1",
      messageId: "message-delayed-action",
    });

    await handleMessage(guideQuickReplyEvent());

    expect(routeGuideAction).toHaveBeenCalledOnce();
    expect(routeGuideAction).toHaveBeenCalledWith({
      payload: GUIDE_ACTION_PAYLOAD,
      senderId: "controlled-recipient",
      inboundMessageId: "message-delayed-action",
      eventAt: new Date(GUIDE_ACTION_TIMESTAMP),
    });
    expect(resolveUsername).not.toHaveBeenCalled();
    expect(findKeywordInMessage).not.toHaveBeenCalled();
    expect(findActiveAwaitingDone).not.toHaveBeenCalled();
  });

  it("still skips ordinary delayed text when it is not the latest thread message", async () => {
    recordInboundMessage.mockResolvedValue({
      duplicate: false,
      becameLatest: false,
      threadId: "thread-1",
      messageId: "message-delayed-text",
    });

    await handleMessage(inbound("SLEEP"));

    expect(routeGuideAction).not.toHaveBeenCalled();
    expect(resolveUsername).not.toHaveBeenCalled();
    expect(findKeywordInMessage).not.toHaveBeenCalled();
    expect(findActiveAwaitingDone).not.toHaveBeenCalled();
  });

  it.each([[undefined], [""]])(
    "records a quick-reply object with payload %j as quick-reply recovery evidence",
    async (payload) => {
      const entry = guideQuickReplyEvent();
      entry.message = {
        ...entry.message!,
        quick_reply: payload === undefined ? {} : { payload },
      };

      await handleMessage(entry);

      expect(recordRecoveryInbound).toHaveBeenCalledWith({
        igUserId: "controlled-recipient",
        eventAt: new Date(GUIDE_ACTION_TIMESTAMP),
        receivedAt: expect.any(Date),
        kind: "quick_reply",
      });
      expect(routeGuideAction).toHaveBeenCalledOnce();
      expect(findKeywordInMessage).not.toHaveBeenCalled();
    },
  );

  it("acknowledges an unknown quick-reply action without treating its title as a keyword", async () => {
    const entry = guideQuickReplyEvent();
    entry.message = {
      ...entry.message!,
      text: "SLEEP",
      quick_reply: { payload: "unregistered:action:value" },
    };

    await handleMessage(entry);

    expect(routeGuideAction).toHaveBeenCalledWith({
      payload: "unregistered:action:value",
      senderId: "controlled-recipient",
      inboundMessageId: "message-1",
      eventAt: new Date(GUIDE_ACTION_TIMESTAMP),
    });
    expect(findKeywordInMessage).not.toHaveBeenCalled();
    expect(findActiveAwaitingDone).not.toHaveBeenCalled();
  });

  it("continues handling when the profile lookup fails", async () => {
    resolveUsername.mockRejectedValue(new Error("consent required"));
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));

    expect(resolveJourneyIntent).toHaveBeenCalledOnce();
  });
});

describe("handleMessage — branch order is unchanged", () => {
  it("keeps a keyword trigger on the existing automation path", async () => {
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));

    expect(resolveJourneyIntent).toHaveBeenCalledOnce();
    expect(queueReplyDraft).not.toHaveBeenCalled();
  });

  it("prefers a new keyword over an open gate, as before", async () => {
    // Someone with an open POTTY gate who types SLEEP starts a SLEEP conversation
    // rather than completing the POTTY one. The open gate is never consulted.
    findKeywordInMessage.mockResolvedValue(keywordFixture);
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-old",
      keywordId: "keyword-old",
      keyword: { keyword: "POTTY", resource: { messages: [{ id: "potty-msg" }] } },
    });

    await handleMessage(inbound("SLEEP"));

    expect(resolveJourneyIntent).toHaveBeenCalledWith(
      expect.objectContaining({ igUserId: "ig-user-1", keywordId: "keyword-1" }),
      expect.any(Function),
    );
    expect(findActiveAwaitingDone).not.toHaveBeenCalled();
    // A follower gets the NEW keyword's guide instantly — never the stale gate's.
    expect(sendSequence).toHaveBeenCalledWith(
      expect.objectContaining({ messages: keywordFixture.resource.messages }),
    );
  });

  it("delivers the guide on an open-gate reply and queues no draft", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });

    await handleMessage(inbound("Done"));

    expect(sendSequence).toHaveBeenCalledOnce();
    expect(markCompleted).toHaveBeenCalledWith("convo-1");
    expect(queueReplyDraft).not.toHaveBeenCalled();
  });

  it("recovers an expired DONE and asks a confirmed non-follower to follow", async () => {
    resolveUsername.mockResolvedValue({ isFollower: false, username: "geri", name: "Geri" });
    findLatestIncompleteConversation.mockResolvedValue({
      id: "expired-convo",
      keywordId: "keyword-1",
      state: "expired",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });

    await handleMessage(inbound("Done"));

    expect(findLatestIncompleteConversation).toHaveBeenCalledWith("ig-user-1");
    expect(sendTrackedText).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientIgUserId: "ig-user-1",
        source: "keyword_automation",
      }),
    );
    expect(markGated).toHaveBeenCalledWith("expired-convo");
    expect(sendSequence).not.toHaveBeenCalled();
    expect(queueReplyDraft).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "follow_required",
      expect.objectContaining({ recoveredInactiveGate: true }),
    );
  });

  it("recovers an expired DONE and delivers to a follower", async () => {
    findLatestIncompleteConversation.mockResolvedValue({
      id: "expired-convo",
      keywordId: "keyword-1",
      state: "expired",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });

    await handleMessage(inbound("DONE!"));

    expect(sendSequence).toHaveBeenCalledOnce();
    expect(markCompleted).toHaveBeenCalledWith("expired-convo");
    expect(queueReplyDraft).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "done_received",
      expect.objectContaining({ recoveredInactiveGate: true }),
    );
  });

  it("does not recover an expired request for arbitrary text", async () => {
    await handleMessage(inbound("Can you help?"));

    expect(findLatestIncompleteConversation).not.toHaveBeenCalled();
    expect(queueReplyDraft).toHaveBeenCalledOnce();
  });
});

describe("handleMessage — mutually exclusive guide delivery ownership", () => {
  const triggeredAt = new Date(1785895200000);
  const sendWindowExpiresAt = new Date(1785895200000 + 24 * 60 * 60 * 1000);

  function expectedDurableCall(
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> {
    return {
      conversationId: "convo-1",
      resourceId: "resource-1",
      igUserId: "ig-user-1",
      threadId: "thread-1",
      triggerKind: "inbound_reply",
      triggerId: "message-1",
      triggeredAt,
      sendWindowExpiresAt,
      followerAtTrigger: true,
      ...overrides,
    };
  }

  function openGateConversation(id = "convo-1") {
    return {
      id,
      keywordId: "keyword-1",
      keyword: {
        keyword: "SLEEP",
        resource: { id: "resource-1", messages: keywordFixture.resource.messages },
      },
    };
  }

  it.each(["ledger", "legacy"] as const)(
    "routes an instant follower guide through only the %s sender",
    async (selectedOwner) => {
      findKeywordInMessage.mockResolvedValue(keywordFixture);
      guideDeliveryOwner.mockReturnValue(selectedOwner);

      await handleMessage(inbound("SLEEP"));

      expect(guideDeliveryOwner).toHaveBeenCalledOnce();
      expect(guideDeliveryOwner).toHaveBeenCalledWith({
        enabled: true,
        rolloutPercent: 25,
        cohortIgUserIds: new Set(["controlled-1"]),
        igUserId: "ig-user-1",
        triggerId: "message-1",
      });
      if (selectedOwner === "ledger") {
        expect(deliverGuideForTrigger).toHaveBeenCalledOnce();
        expect(deliverGuideForTrigger).toHaveBeenCalledWith(expectedDurableCall());
        expect(sendSequence).not.toHaveBeenCalled();
        expect(markCompleted).not.toHaveBeenCalled();
      } else {
        expect(sendSequence).toHaveBeenCalledOnce();
        expect(deliverGuideForTrigger).not.toHaveBeenCalled();
        expect(markCompleted).toHaveBeenCalledWith("convo-1");
      }
    },
  );

  it.each(["ledger", "legacy"] as const)(
    "routes an already-completed keyword through only the %s sender",
    async (selectedOwner) => {
      findKeywordInMessage.mockResolvedValue(keywordFixture);
      hasCompletedKeyword.mockResolvedValue(true);
      guideDeliveryOwner.mockReturnValue(selectedOwner);

      await handleMessage(inbound("SLEEP"));

      if (selectedOwner === "ledger") {
        expect(deliverGuideForTrigger).toHaveBeenCalledWith(
          expectedDurableCall({
            triggerKind: "explicit_redelivery",
            redeliveryIntro: "You've already got this one — here it is again 💛",
          }),
        );
        expect(sendSequence).not.toHaveBeenCalled();
        expect(sendTrackedText).not.toHaveBeenCalledWith(
          expect.objectContaining({
            text: "You've already got this one — here it is again 💛",
          }),
        );
      } else {
        expect(deliverGuideForTrigger).not.toHaveBeenCalled();
        expect(sendSequence).toHaveBeenCalledOnce();
        expect(sendTrackedText).toHaveBeenCalledWith(
          expect.objectContaining({
            text: "You've already got this one — here it is again 💛",
            source: "keyword_automation",
          }),
        );
      }
    },
  );

  it.each(["ledger", "legacy"] as const)(
    "routes an open-gate reply through only the %s sender",
    async (selectedOwner) => {
      findActiveAwaitingDone.mockResolvedValue(openGateConversation());
      guideDeliveryOwner.mockReturnValue(selectedOwner);

      await handleMessage(inbound("Done"));

      if (selectedOwner === "ledger") {
        expect(deliverGuideForTrigger).toHaveBeenCalledWith(expectedDurableCall());
        expect(sendSequence).not.toHaveBeenCalled();
        expect(markCompleted).not.toHaveBeenCalled();
      } else {
        expect(deliverGuideForTrigger).not.toHaveBeenCalled();
        expect(sendSequence).toHaveBeenCalledOnce();
        expect(markCompleted).toHaveBeenCalledWith("convo-1");
      }
    },
  );

  it("routes a recovered expired DONE through the same durable owner choke point", async () => {
    findLatestIncompleteConversation.mockResolvedValue(openGateConversation("expired-convo"));
    guideDeliveryOwner.mockReturnValue("ledger");

    await handleMessage(inbound("DONE!"));

    expect(deliverGuideForTrigger).toHaveBeenCalledWith(
      expectedDurableCall({ conversationId: "expired-convo" }),
    );
    expect(sendSequence).not.toHaveBeenCalled();
  });

  it.each([
    "preflight_failed",
    "needs_review",
    "retry_scheduled",
    "already_processing",
  ] as const)(
    "leaves the inbound thread needing attention when ledger returns %s",
    async (result) => {
      findActiveAwaitingDone.mockResolvedValue(openGateConversation());
      guideDeliveryOwner.mockReturnValue("ledger");
      deliverGuideForTrigger.mockResolvedValue(result);

      await handleMessage(inbound("Done"));

      expect(sendSequence).not.toHaveBeenCalled();
      expect(sendTrackedText).not.toHaveBeenCalled();
      expect(markCompleted).not.toHaveBeenCalled();
      expect(markThreadResolved).not.toHaveBeenCalled();
    },
  );

  it("preserves the follow-aware closing after ledger completes in this invocation", async () => {
    findKeywordInMessage.mockResolvedValue(keywordFixture);
    guideDeliveryOwner.mockReturnValue("ledger");
    deliverGuideForTrigger.mockResolvedValue("completed");

    await handleMessage(inbound("SLEEP"));

    expect(sendTrackedText).toHaveBeenCalledOnce();
    expect(sendTrackedText).toHaveBeenCalledWith({
      recipientIgUserId: "ig-user-1",
      text: "Thanks for following! 💛",
      source: "guide_automation",
    });
    expect(markCompleted).not.toHaveBeenCalled();
    expect(markThreadResolved).not.toHaveBeenCalled();
  });

  it("makes zero guide provider calls when ledger preflight rejects the plan", async () => {
    findKeywordInMessage.mockResolvedValue(keywordFixture);
    guideDeliveryOwner.mockReturnValue("ledger");
    deliverGuideForTrigger.mockResolvedValue("preflight_failed");

    await handleMessage(inbound("SLEEP"));

    expect(deliverGuideForTrigger).toHaveBeenCalledOnce();
    expect(sendSequence).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
    expect(markThreadResolved).not.toHaveBeenCalled();
  });

  it("does not fall back to legacy when ledger delivery throws", async () => {
    findActiveAwaitingDone.mockResolvedValue(openGateConversation());
    guideDeliveryOwner.mockReturnValue("ledger");
    deliverGuideForTrigger.mockRejectedValue(new Error("private ledger detail"));

    await expect(handleMessage(inbound("Done"))).resolves.toBeUndefined();

    expect(sendSequence).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it("drops a true duplicate webhook with the same provider mid before owner selection", async () => {
    recordInboundMessage
      .mockResolvedValueOnce({
        duplicate: false,
        becameLatest: true,
        threadId: "thread-1",
        messageId: "message-1",
      })
      .mockResolvedValueOnce({
        duplicate: true,
        becameLatest: false,
        threadId: "thread-1",
        messageId: "message-1",
      });
    findKeywordInMessage.mockResolvedValue(keywordFixture);
    guideDeliveryOwner.mockReturnValue("ledger");
    deliverGuideForTrigger.mockResolvedValue("already_processing");

    const webhook = inbound("SLEEP");
    await handleMessage(webhook);
    await handleMessage(webhook);

    expect(recordInboundMessage).toHaveBeenCalledTimes(2);
    expect(recordInboundMessage.mock.calls.map(([input]) => input.instagramMessageId)).toEqual([
      "mid-1",
      "mid-1",
    ]);
    expect(recordRecoveryInbound).toHaveBeenCalledOnce();
    expect(guideDeliveryOwner).toHaveBeenCalledOnce();
    expect(deliverGuideForTrigger).toHaveBeenCalledOnce();
    expect(sendSequence).not.toHaveBeenCalled();
  });

  it("reuses the persisted trigger ID when downstream processing is retried", async () => {
    findKeywordInMessage.mockResolvedValue(keywordFixture);
    guideDeliveryOwner.mockReturnValue("ledger");
    deliverGuideForTrigger.mockResolvedValue("already_processing");

    await handleMessage(inbound("SLEEP"));
    await handleMessage(
      inbound("SLEEP", { message: { mid: "mid-provider-replay", text: "SLEEP" } }),
    );

    expect(guideDeliveryOwner).toHaveBeenCalledTimes(2);
    expect(guideDeliveryOwner.mock.calls.map(([input]) => input.triggerId)).toEqual([
      "message-1",
      "message-1",
    ]);
    expect(deliverGuideForTrigger.mock.calls.map(([input]) => input.triggerId)).toEqual([
      "message-1",
      "message-1",
    ]);
  });

  it("does not select a guide owner for a confirmed non-follower", async () => {
    resolveUsername.mockResolvedValue({ isFollower: false, username: "geri", name: "Geri" });
    findActiveAwaitingDone.mockResolvedValue(openGateConversation());

    await handleMessage(inbound("Done"));

    expect(guideDeliveryOwner).not.toHaveBeenCalled();
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
    expect(sendTrackedText).toHaveBeenCalledWith(
      expect.objectContaining({ source: "keyword_automation" }),
    );
  });
});

describe("handleMessage — a story mention is engagement, not consent", () => {
  // Exactly what Meta delivered on 2026-08-08T04:58:56Z: no text, NO attachments
  // array, the story tucked under `message.story`. Confirmed by fetching the mid
  // from the Graph API, which returned {"message":"","story":{"mention":{...}}}.
  function storyMention(overrides: Record<string, unknown> = {}): MessagingEntry {
    return {
      sender: { id: "ig-user-1" },
      recipient: { id: env.IG_USER_ID },
      timestamp: 1785895200000,
      message: { mid: "mid-story", story: { mention: { link: "" } }, ...overrides },
    };
  }

  function openGate() {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "GREEN", resource: { messages: [] } },
    });
  }

  it("never delivers the guide when someone tags us in their story", async () => {
    openGate();

    await handleMessage(storyMention());

    // The production incident: a story tag unlocked a gated guide the person
    // never asked to unlock.
    expect(sendSequence).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalledWith("done_received", expect.anything());
  });

  it("leaves the gate open so a real reply still unlocks it", async () => {
    openGate();

    await handleMessage(storyMention());

    expect(markGated).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it("does not draft a reply to a story mention", async () => {
    // The live draft said "your message came through blank" — it wasn't blank,
    // it was a story tag.
    await handleMessage(storyMention());

    expect(queueReplyDraft).not.toHaveBeenCalled();
  });

  it("still captures the mention as inbound engagement", async () => {
    await handleMessage(storyMention());

    expect(recordInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "unknown", text: null }),
    );
    expect(recordRecoveryInbound).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith(
      "story_mention_received",
      expect.objectContaining({ senderId: "ig-user-1" }),
    );
  });

  it("still unlocks the gate for a reply to OUR story, which is a real reply", async () => {
    openGate();

    // A story REPLY carries the person's own words and arrives with
    // `story.reply_to`, not `story.mention`. That is genuine consent.
    await handleMessage(
      storyMention({ text: "Done", story: { reply_to: { link: "https://ig/story" } } }),
    );

    expect(sendSequence).toHaveBeenCalledOnce();
    expect(markCompleted).toHaveBeenCalledWith("convo-1");
  });
});

describe("handleMessage — engagement follow-up scheduling", () => {
  const expectedScheduleInput = {
    conversationId: "convo-1",
    threadId: "thread-1",
    inboundMessageId: "message-1",
    inboundAt: new Date(1785895200000),
    deliveredAt: new Date("2026-08-05T10:01:00.000Z"),
  };

  it("schedules exactly once after instant keyword guide delivery is completed", async () => {
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));

    expect(scheduleEngagementFollowUp).toHaveBeenCalledOnce();
    expect(scheduleEngagementFollowUp).toHaveBeenCalledWith(expectedScheduleInput);
  });

  it("schedules exactly once after an already-delivered open gate is redelivered", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });
    hasCompletedKeyword.mockResolvedValue(true);

    await handleMessage(inbound("Done"));

    expect(scheduleEngagementFollowUp).toHaveBeenCalledOnce();
    expect(scheduleEngagementFollowUp).toHaveBeenCalledWith(expectedScheduleInput);
  });

  it("schedules exactly once after a normal open-gate guide delivery is completed", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });

    await handleMessage(inbound("Done"));

    expect(scheduleEngagementFollowUp).toHaveBeenCalledOnce();
    expect(scheduleEngagementFollowUp).toHaveBeenCalledWith(expectedScheduleInput);
  });

  it("does not schedule before a guide sequence succeeds", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });
    sendSequence.mockRejectedValue(new Error("graph 400"));

    await handleMessage(inbound("Done"));

    expect(markCompleted).not.toHaveBeenCalled();
    expect(scheduleEngagementFollowUp).not.toHaveBeenCalled();
  });

  it("does not schedule unless completion is confirmed", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });
    markCompleted.mockRejectedValue(new Error("database unavailable"));

    await handleMessage(inbound("Done"));

    expect(sendSequence).toHaveBeenCalledOnce();
    expect(scheduleEngagementFollowUp).not.toHaveBeenCalled();
  });

  it("keeps successful delivery successful when follow-up queueing fails", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });
    const privateBody = "private DM or model output";
    scheduleEngagementFollowUp.mockRejectedValue(new Error(privateBody));

    await expect(handleMessage(inbound("Done"))).resolves.toBeUndefined();

    expect(markThreadResolved).toHaveBeenCalledWith({
      threadId: "thread-1",
      inboundMessageId: "message-1",
    });
    expect(logEvent).not.toHaveBeenCalledWith("sequence_failed", expect.anything());
    expect(logger.error).toHaveBeenCalledWith(
      {
        errorCode: "follow_up_schedule_failed",
        conversationId: "convo-1",
        threadId: "thread-1",
        inboundMessageId: "message-1",
      },
      "Failed to schedule engagement follow-up after guide delivery",
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateBody);
  });

  it("does not queue without the completion timestamp and logs IDs only", async () => {
    findKeywordInMessage.mockResolvedValue(keywordFixture);
    markCompleted.mockResolvedValue({ id: "convo-1", completedAt: null });

    await handleMessage(inbound("SLEEP"));

    expect(scheduleEngagementFollowUp).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      {
        errorCode: "follow_up_completion_timestamp_missing",
        conversationId: "convo-1",
        threadId: "thread-1",
        inboundMessageId: "message-1",
      },
      "Failed to schedule engagement follow-up after guide delivery",
    );
  });

  it("does not schedule while AI_FOLLOW_UPS_ENABLED is false", async () => {
    aiFlags.AI_FOLLOW_UPS_ENABLED = false;
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));

    expect(sendSequence).toHaveBeenCalledOnce();
    expect(markCompleted).toHaveBeenCalledOnce();
    expect(scheduleEngagementFollowUp).not.toHaveBeenCalled();
  });

  it("does not schedule after a keyword gate-only send", async () => {
    resolveUsername.mockResolvedValue({ isFollower: false, username: "geri", name: "Geri" });
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));

    expect(sendTrackedText).toHaveBeenCalledWith(
      expect.objectContaining({ text: keywordFixture.gateMessage }),
    );
    expect(sendSequence).not.toHaveBeenCalled();
    expect(scheduleEngagementFollowUp).not.toHaveBeenCalled();
  });

  it("does not schedule after a follow-required nudge", async () => {
    resolveUsername.mockResolvedValue({ isFollower: false, username: "geri", name: "Geri" });
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });

    await handleMessage(inbound("Done"));

    expect(sendSequence).not.toHaveBeenCalled();
    expect(scheduleEngagementFollowUp).not.toHaveBeenCalled();
  });
});

describe("handleMessage — unhandled DMs", () => {
  it("still records message_unhandled for existing observability", async () => {
    await handleMessage(inbound("Can you help with bedtime?"));

    expect(logEvent).toHaveBeenCalledWith(
      "message_unhandled",
      expect.objectContaining({ senderId: "ig-user-1" }),
    );
  });

  it("records the inbound before queueing a draft", async () => {
    const order: string[] = [];
    recordInboundMessage.mockImplementation(async () => {
      order.push("record");
      return {
        duplicate: false,
        becameLatest: true,
        threadId: "thread-1",
        messageId: "message-1",
      };
    });
    queueReplyDraft.mockImplementation(async () => {
      order.push("queue");
      return { id: "draft-1" };
    });

    await handleMessage(inbound("Can you help with bedtime?"));

    expect(order).toEqual(["record", "queue"]);
    expect(queueReplyDraft).toHaveBeenCalledWith({
      threadId: "thread-1",
      inboundMessageId: "message-1",
    });
  });

  it("records only message metadata in EventLog for an unhandled DM", async () => {
    const privateBody = "private bedtime details";

    await handleMessage(inbound(privateBody));

    expect(logEvent).toHaveBeenCalledWith("message_received", {
      senderId: "ig-user-1",
      mid: "mid-1",
      messageType: "text",
      textLength: privateBody.length,
    });
    expect(logEvent).toHaveBeenCalledWith("message_unhandled", {
      senderId: "ig-user-1",
      mid: "mid-1",
      textLength: privateBody.length,
      hadOpenConversation: false,
    });
    expect(
      JSON.stringify({ logs: logger.debug.mock.calls, events: logEvent.mock.calls }),
    ).not.toContain(privateBody);
  });

  it("records only message metadata when an open-gate reply is handled", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });
    const privateBody = "Done, my child finally slept";

    await handleMessage(inbound(privateBody));

    expect(logEvent).toHaveBeenCalledWith("done_received", {
      conversationId: "convo-1",
      senderId: "ig-user-1",
      mid: "mid-1",
      messageType: "text",
      textLength: privateBody.length,
      matched: "any_reply",
      looksLikeDone: false,
      recoveredInactiveGate: false,
    });
    expect(
      JSON.stringify({ logs: logger.info.mock.calls, events: logEvent.mock.calls }),
    ).not.toContain(privateBody);
  });

  it("keeps Graph request bodies and backend messages out of error logs and EventLog", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });
    const privateBody = "private model or DM output";
    const graphError = new Error("graph request failed");
    describeGraphError.mockReturnValue({
      category: "graph_response",
      httpStatus: 400,
      graphCode: 10,
      graphSubcode: 2018278,
      traceId: "trace-1",
    });
    sendSequence.mockRejectedValue(graphError);

    await handleMessage(inbound("Done"));

    const emitted = JSON.stringify({ logs: logger.error.mock.calls, events: logEvent.mock.calls });
    expect(emitted).not.toContain(privateBody);
    expect(logEvent).toHaveBeenCalledWith("sequence_failed", {
      conversationId: "convo-1",
      errorCode: "graph_request_failed",
      category: "graph_response",
      httpStatus: 400,
      graphCode: 10,
      graphSubcode: 2018278,
      traceId: "trace-1",
    });
  });

  it("never sends anything on the unhandled path", async () => {
    // Shadow drafting only. The owner approves before a word reaches the user.
    await handleMessage(inbound("Can you help with bedtime?"));
    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
  });

  it("survives a draft-queue failure without breaking the webhook", async () => {
    // Meta retries a failed webhook, which would re-run everything above. A draft
    // is an assist, never a requirement.
    queueReplyDraft.mockRejectedValue(new Error("database unavailable"));
    await expect(handleMessage(inbound("Can you help?"))).resolves.toBeUndefined();
  });

  it("queues nothing while AI_DRAFTS_ENABLED is false", async () => {
    // The shipped default. Capture still happens; only drafting is gated.
    aiFlags.AI_DRAFTS_ENABLED = false;

    await handleMessage(inbound("Can you help with bedtime?"));

    expect(recordInboundMessage).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith("message_unhandled", expect.anything());
    expect(queueReplyDraft).not.toHaveBeenCalled();
  });
});

describe("handleMessage — thread resolution", () => {
  it("resolves the thread after a successful open-gate delivery", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });

    await handleMessage(inbound("Done"));

    expect(markThreadResolved).toHaveBeenCalledWith({
      threadId: "thread-1",
      inboundMessageId: "message-1",
    });
  });

  it("leaves needsReply set when the automatic send fails", async () => {
    // The owner must see "Needs review" rather than a silently swallowed failure.
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { messages: [] } },
    });
    sendSequence.mockRejectedValue(new Error("graph 400"));

    await handleMessage(inbound("Done"));

    expect(markThreadResolved).not.toHaveBeenCalled();
  });
});

describe("handleMessage — Recovery & Deletion Integration (Task 8)", () => {
  it("calls markInboundDeleted when message is_deleted is true", async () => {
    const timestamp = 1786003200000;
    await handleMessage({
      sender: { id: "ig-1" },
      recipient: { id: "bot-1" },
      timestamp,
      message: { mid: "mid-del-1", is_deleted: true },
    });

    expect(markInboundDeleted).toHaveBeenCalledWith("mid-del-1", new Date(timestamp));
    expect(recordInboundMessage).not.toHaveBeenCalled();
    expect(recordRecoveryInbound).not.toHaveBeenCalled();
  });

  it("suppresses recovery for a captured delayed inbound even when not the latest message", async () => {
    recordInboundMessage.mockResolvedValue({
      duplicate: false,
      becameLatest: false,
      threadId: "thread-1",
      messageId: "dm-in-1",
    });

    await handleMessage({
      sender: { id: "ig-1" },
      recipient: { id: "bot-1" },
      timestamp: 1786003200000,
      message: { mid: "mid-in-1", text: "hello" },
    });

    expect(recordRecoveryInbound).toHaveBeenCalledWith({
      igUserId: "ig-1",
      eventAt: new Date(1786003200000),
      receivedAt: expect.any(Date),
      kind: "inbound_reply",
    });
  });
});

describe("untrusted inbound payloads", () => {
  it.each([["a missing mid", undefined], ["a blank mid", "   "]])(
    "acknowledges %s without touching persistence",
    async (_label, mid) => {
      await handleMessage({
        sender: { id: "ig-1" },
        recipient: { id: "bot" },
        timestamp: 1786003200000,
        message: { mid: mid as never, text: "hello" },
      });

      expect(recordInboundMessage).not.toHaveBeenCalled();
      expect(recordRecoveryInbound).not.toHaveBeenCalled();
    },
  );
});

// The DM path records journeys but must NOT suppress on them.
//
// Measured on production: 257 of the 342 same-person-same-keyword repeats inside
// 48 hours arrive by DM, and 188 of those had already completed. Those are people
// re-asking for a guide they own, and this path answers that deliberately with
// REDELIVERY_INTRO. Applying the comment path's guard here would break it.
describe("handleMessage journey resolution is bookkeeping, not a gate", () => {
  beforeEach(() => {
    findKeywordInMessage.mockResolvedValue({
      id: "keyword-1",
      keyword: "SLEEP",
      gateMessage: "gate copy",
      mediaId: null,
      inferredFromPost: null,
      resource: { messages: [{ id: "m1", body: "guide" }] },
    });
  });

  it("still delivers instantly to a follower on a reused journey", async () => {
    resolveJourneyIntent.mockResolvedValue({
      disposition: "reused_active",
      intentId: "intent-1",
      conversationId: "convo-1",
      maySendGate: false,
    });
    resolveUsername.mockResolvedValue({ isFollower: true, username: "parent", name: "Parent" });
    hasCompletedKeyword.mockResolvedValue(false);

    await handleMessage(inbound("SLEEP"));

    // maySendGate is false, and the guide goes out anyway.
    expect(sendSequence).toHaveBeenCalledOnce();
  });

  it("still redelivers to someone who already completed", async () => {
    resolveJourneyIntent.mockResolvedValue({
      disposition: "already_completed_recently",
      intentId: "intent-1",
      conversationId: "convo-1",
      maySendGate: false,
    });
    resolveUsername.mockResolvedValue({ isFollower: true, username: "parent", name: "Parent" });
    hasCompletedKeyword.mockResolvedValue(true);

    await handleMessage(inbound("SLEEP"));

    expect(sendSequence).toHaveBeenCalledOnce();
  });

  // A DM has no comment id, so the inbound message id stands in — that is what
  // buys the same replay protection the comment path gets.
  it("records the trigger against the inbound message id", async () => {
    await handleMessage(inbound("SLEEP"));

    expect(resolveJourneyIntent).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: "message-1", triggerKind: "dm" }),
      expect.any(Function),
    );
  });

  it("names the journey it joined on keyword_matched", async () => {
    resolveJourneyIntent.mockResolvedValue({
      disposition: "reused_active",
      intentId: "intent-1",
      conversationId: "convo-1",
      maySendGate: false,
    });

    await handleMessage(inbound("SLEEP"));

    const matched = logEvent.mock.calls.find(([kind]) => kind === "keyword_matched");
    expect(matched?.[1]).toMatchObject({ journeyDisposition: "reused_active", source: "dm" });
  });
});

// Task 7: the strict gate replaces cached-follow authorization on the direct-DM
// keyword and redelivery paths. Cached `profile.isFollower` and a prior
// completion must both stop being able to authorize a send.
describe("strict follower gate v2 — direct DM and redelivery", () => {
  const V2_KEYWORD = {
    ...keywordFixture,
    resource: { ...keywordFixture.resource, name: "toddler sleep guide" },
  };

  beforeEach(() => {
    findKeywordInMessage.mockResolvedValue(V2_KEYWORD);
  });

  it("keeps V1 instant delivery for a cached follower when the switch is off", async () => {
    resolveUsername.mockResolvedValue({ isFollower: true, username: "p", name: "P" });

    await handleMessage(inbound("SLEEP"));

    expect(startDirectDmGuideRequest).not.toHaveBeenCalled();
    expect(recordGuideAccessMetric).not.toHaveBeenCalled();
    expect(sendSequence).toHaveBeenCalledTimes(1);
  });

  it("a cached follower cannot authorize a send once the strict gate owns the journey", async () => {
    gateOwner.mockReturnValue("v2");
    resolveUsername.mockResolvedValue({ isFollower: true, username: "p", name: "P" });

    await handleMessage(inbound("SLEEP"));

    expect(startDirectDmGuideRequest).toHaveBeenCalledTimes(1);
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
  });

  it("passes the internal message id and no cached follow evidence", async () => {
    gateOwner.mockReturnValue("v2");
    resolveUsername.mockResolvedValue({ isFollower: true, username: "p", name: "P" });

    await handleMessage(inbound("SLEEP"));

    const [conversation, inboundArg] = startDirectDmGuideRequest.mock.calls[0]!;
    expect(conversation).toMatchObject({
      id: "convo-1",
      igUserId: "ig-user-1",
      resourceId: "resource-1",
      guideName: "toddler sleep guide",
      deliveryTriggerKind: "inbound_reply",
    });
    expect(JSON.stringify(conversation)).not.toContain("isFollower");
    // The internal DmMessage UUID, never Meta's provider mid.
    expect(inboundArg).toMatchObject({ id: "message-1", threadId: "thread-1" });
    expect(inboundArg.id).not.toBe("mid-1");
  });

  it("a completed guide re-request goes through the strict gate, not straight to delivery", async () => {
    gateOwner.mockReturnValue("v2");
    hasCompletedKeyword.mockResolvedValue(true);
    resolveUsername.mockResolvedValue({ isFollower: null, username: "p", name: "P" });

    await handleMessage(inbound("SLEEP"));

    expect(startDirectDmGuideRequest).toHaveBeenCalledTimes(1);
    expect(startDirectDmGuideRequest.mock.calls[0]![0]).toMatchObject({
      deliveryTriggerKind: "explicit_redelivery",
    });
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
  });

  it("sends no V1 gate text to a cached non-follower on the strict path", async () => {
    gateOwner.mockReturnValue("v2");
    resolveUsername.mockResolvedValue({ isFollower: false, username: "p", name: "P" });

    await handleMessage(inbound("SLEEP"));

    expect(startDirectDmGuideRequest).toHaveBeenCalledTimes(1);
    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(markGated).not.toHaveBeenCalled();
  });

  it("decides ownership once, from the sender and the guide only", async () => {
    gateOwner.mockReturnValue("v2");

    await handleMessage(inbound("SLEEP"));

    expect(gateOwner).toHaveBeenCalledTimes(1);
    expect(gateOwner).toHaveBeenCalledWith({
      igUserId: "ig-user-1",
      resourceId: "resource-1",
    });
  });

  it.each([
    { outcome: "guide_delivery_started", stage: "delivery", want: "planned" },
    { outcome: "follow_confirmed", stage: "fresh_check", want: "follower" },
    { outcome: "follow_not_confirmed", stage: "fresh_check", want: "non_follower" },
    { outcome: "follow_check_unavailable", stage: "fresh_check", want: "unavailable" },
    { outcome: "access_attempt_needs_review", stage: "needs_review", want: "marked" },
    { outcome: "action_replayed", stage: "action", want: "replayed" },
    { outcome: "action_expired", stage: "action", want: "expired" },
  ])("records $outcome as $stage/$want", async ({ outcome, stage, want }) => {
    gateOwner.mockReturnValue("v2");
    startDirectDmGuideRequest.mockResolvedValue(outcome);

    await handleMessage(inbound("SLEEP"));

    expect(recordGuideAccessMetric).toHaveBeenCalledWith({ stage, outcome: want });
  });

  it("records no metric when the strict path did no new work", async () => {
    gateOwner.mockReturnValue("v2");
    startDirectDmGuideRequest.mockResolvedValue("guide_delivery_already_started");

    await handleMessage(inbound("SLEEP"));

    expect(recordGuideAccessMetric).not.toHaveBeenCalled();
  });

  it("falls back to V1 when ownership cannot be decided", async () => {
    gateOwner.mockImplementation(() => {
      throw new Error("flag read failed");
    });
    resolveUsername.mockResolvedValue({ isFollower: true, username: "p", name: "P" });

    await handleMessage(inbound("SLEEP"));

    expect(startDirectDmGuideRequest).not.toHaveBeenCalled();
    expect(sendSequence).toHaveBeenCalledTimes(1);
  });

  it("keeps a strict-path fault non-fatal and does not fall through to V1", async () => {
    gateOwner.mockReturnValue("v2");
    resolveUsername.mockResolvedValue({ isFollower: true, username: "p", name: "P" });
    startDirectDmGuideRequest.mockRejectedValue(new Error("strict path exploded"));

    await expect(handleMessage(inbound("SLEEP"))).resolves.toBeUndefined();

    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
  });
});

// Task 7, second entry point. With rich controls off — the only mode available
// until the capability rows are `supported` — the opening is TEXT: "Want me to
// send it here?". The parent answers "yes", which is not a keyword and not DONE,
// so it lands on the open-gate branch. `openConversationIn` already creates the
// conversation as awaiting_done with a null gatedAt, and findActiveAwaitingDone
// accepts that, so V1 would authorize the reply on cached follow state — and V1
// deliberately lets an unreadable null fall through to delivery. The strict gate
// forbids exactly that, so this branch needs the same ownership fence.
describe("strict follower gate v2 — reply to an open strict opening", () => {
  const OPEN_CONVO = {
    id: "convo-open-1",
    keywordId: "keyword-1",
    keyword: {
      keyword: "SLEEP",
      resource: {
        id: "resource-1",
        name: "toddler sleep guide",
        messages: [{ id: "m1", order: 0, type: "text", body: "guide" }],
      },
    },
  };

  beforeEach(() => {
    findKeywordInMessage.mockResolvedValue(null);
    findActiveAwaitingDone.mockResolvedValue(OPEN_CONVO);
  });

  it("routes a plain yes through the strict gate instead of V1", async () => {
    gateOwner.mockReturnValue("v2");
    resolveUsername.mockResolvedValue({ isFollower: true, username: "p", name: "P" });

    await handleMessage(inbound("yes"));

    expect(startDirectDmGuideRequest).toHaveBeenCalledTimes(1);
    expect(startDirectDmGuideRequest.mock.calls[0]![0]).toMatchObject({
      id: "convo-open-1",
      igUserId: "ig-user-1",
      resourceId: "resource-1",
      guideName: "toddler sleep guide",
    });
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
  });

  it("never lets an unreadable follow flag fall through to delivery", async () => {
    gateOwner.mockReturnValue("v2");
    // V1 treats null as "cannot gate what we cannot measure" and delivers.
    resolveUsername.mockResolvedValue({ isFollower: null, username: "p", name: "P" });

    await handleMessage(inbound("yes"));

    expect(startDirectDmGuideRequest).toHaveBeenCalledTimes(1);
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
  });

  it("sends no V1 follow-gate text to a cached non-follower", async () => {
    gateOwner.mockReturnValue("v2");
    resolveUsername.mockResolvedValue({ isFollower: false, username: "p", name: "P" });

    await handleMessage(inbound("yes"));

    expect(startDirectDmGuideRequest).toHaveBeenCalledTimes(1);
    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(markGated).not.toHaveBeenCalled();
  });

  it("routes an already-completed keyword through the strict gate, not V1 redelivery", async () => {
    gateOwner.mockReturnValue("v2");
    hasCompletedKeyword.mockResolvedValue(true);

    await handleMessage(inbound("yes"));

    expect(startDirectDmGuideRequest).toHaveBeenCalledTimes(1);
    expect(startDirectDmGuideRequest.mock.calls[0]![0]).toMatchObject({
      deliveryTriggerKind: "explicit_redelivery",
    });
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
  });

  it("decides ownership from the conversation's own guide", async () => {
    gateOwner.mockReturnValue("v2");

    await handleMessage(inbound("yes"));

    expect(gateOwner).toHaveBeenCalledWith({
      igUserId: "ig-user-1",
      resourceId: "resource-1",
    });
  });

  it("keeps the V1 open-gate path intact when the switch is off", async () => {
    resolveUsername.mockResolvedValue({ isFollower: true, username: "p", name: "P" });

    await handleMessage(inbound("yes"));

    expect(startDirectDmGuideRequest).not.toHaveBeenCalled();
    expect(sendSequence).toHaveBeenCalledTimes(1);
  });
});
