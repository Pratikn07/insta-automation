import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MessagingEntry } from "../types/meta.js";

// --- mocks -------------------------------------------------------------------
const recordInboundMessage = vi.fn();
const updateDmThreadProfile = vi.fn();
const markThreadResolved = vi.fn();
const markInboundDeleted = vi.fn();
const recordRecoveryInbound = vi.fn();
const recordInboundCampaignHealthSignals = vi.fn();
const markInboundCampaignHealthCaptured = vi.fn();
const queueReplyDraft = vi.fn();
const findKeywordInMessage = vi.fn();
const findActiveAwaitingDone = vi.fn();
const findLatestIncompleteConversation = vi.fn();
const hasCompletedKeyword = vi.fn();
const openConversationIn = vi.fn();
const resolveJourneyIntent = vi.fn();
const markGated = vi.fn();
const deliverGuideForTrigger = vi.fn();
const sendTrackedText = vi.fn();
const resolveUsername = vi.fn();
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
vi.mock("../services/keywordService.js", () => ({ findKeywordInMessage }));
// The resolver is contract-tested against real Postgres; here the DM path's own
// contract is that it records the trigger and still delivers.
vi.mock("../services/journeyIntentService.js", () => ({ resolveJourneyIntent }));
vi.mock("../services/conversationService.js", () => ({
  findActiveAwaitingDone,
  findLatestIncompleteConversation,
  hasCompletedKeyword,
  openConversationIn,
  markGated,
}));
vi.mock("../services/guideDeliveryService.js", () => ({ deliverGuideForTrigger }));
vi.mock("../services/dmDeliveryService.js", () => ({ sendTrackedText }));
vi.mock("../services/igUserService.js", () => ({ resolveUsername }));
vi.mock("../services/eventLogger.js", () => ({
  logEvent,
  describeGraphError,
}));
vi.mock("../lib/logger.js", () => ({ logger }));

// The real env has AI_DRAFTS_ENABLED=false (all AI ships off), so drafting is
// mocked ON here and toggled per test. `aiDraftsEnabled` is mutable so one test
// can prove the flag genuinely gates the queue call.
const aiFlags = { AI_DRAFTS_ENABLED: true };
vi.mock("../config/env.js", async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return {
    env: new Proxy(actual.env, {
      get: (target, prop) => {
        if (prop === "AI_DRAFTS_ENABLED") return aiFlags.AI_DRAFTS_ENABLED;
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
    findKeywordInMessage,
    findActiveAwaitingDone,
    findLatestIncompleteConversation,
    hasCompletedKeyword,
    openConversationIn,
    resolveJourneyIntent,
    markGated,
    deliverGuideForTrigger,
    sendTrackedText,
    resolveUsername,
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
  deliverGuideForTrigger.mockResolvedValue("completed");
  queueReplyDraft.mockResolvedValue({ id: "draft-1" });
  recordInboundCampaignHealthSignals.mockResolvedValue({ recorded: 0 });
  markInboundCampaignHealthCaptured.mockResolvedValue(true);
  aiFlags.AI_DRAFTS_ENABLED = true;
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
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
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
      keyword: {
        keyword: "POTTY",
        resource: { id: "resource-old", messages: [{ id: "potty-msg" }] },
      },
    });

    await handleMessage(inbound("SLEEP"));

    expect(resolveJourneyIntent).toHaveBeenCalledWith(
      expect.objectContaining({ igUserId: "ig-user-1", keywordId: "keyword-1" }),
      expect.any(Function),
    );
    expect(findActiveAwaitingDone).not.toHaveBeenCalled();
    // A follower gets the NEW keyword's guide instantly — never the stale gate's.
    expect(deliverGuideForTrigger).toHaveBeenCalledWith({
      conversationId: "convo-1",
      resourceId: "resource-1",
      igUserId: "ig-user-1",
      threadId: "thread-1",
      triggerKind: "inbound_reply",
      triggerId: "message-1",
      triggeredAt: new Date(1785895200000),
      sendWindowExpiresAt: new Date(1785981600000),
      followerAtTrigger: true,
    });
  });

  it("delivers the guide on an open-gate reply and queues no draft", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { id: "resource-1", messages: [] } },
    });

    await handleMessage(inbound("Done"));

    expect(deliverGuideForTrigger).toHaveBeenCalledWith({
      conversationId: "convo-1",
      resourceId: "resource-1",
      igUserId: "ig-user-1",
      threadId: "thread-1",
      triggerKind: "inbound_reply",
      triggerId: "message-1",
      triggeredAt: new Date(1785895200000),
      sendWindowExpiresAt: new Date(1785981600000),
      followerAtTrigger: true,
    });
    expect(queueReplyDraft).not.toHaveBeenCalled();
  });

  it("recovers an expired DONE and asks a confirmed non-follower to follow", async () => {
    resolveUsername.mockResolvedValue({ isFollower: false, username: "geri", name: "Geri" });
    findLatestIncompleteConversation.mockResolvedValue({
      id: "expired-convo",
      keywordId: "keyword-1",
      state: "expired",
      keyword: { keyword: "SLEEP", resource: { id: "resource-1", messages: [] } },
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
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
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
      keyword: { keyword: "SLEEP", resource: { id: "resource-1", messages: [] } },
    });

    await handleMessage(inbound("\tDoNe!!  "));

    expect(deliverGuideForTrigger).toHaveBeenCalledWith({
      conversationId: "expired-convo",
      resourceId: "resource-1",
      igUserId: "ig-user-1",
      threadId: "thread-1",
      triggerKind: "inbound_reply",
      triggerId: "message-1",
      triggeredAt: new Date(1785895200000),
      sendWindowExpiresAt: new Date(1785981600000),
      followerAtTrigger: true,
    });
    expect(queueReplyDraft).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "done_received",
      expect.objectContaining({ recoveredInactiveGate: true }),
    );
  });

  it.each(["Can you help?", "done please", "well done", "I followed"])(
    "does not recover an expired request for non-contract text: %s",
    async (text) => {
      await handleMessage(inbound(text));

      expect(findLatestIncompleteConversation).not.toHaveBeenCalled();
      expect(deliverGuideForTrigger).not.toHaveBeenCalled();
      expect(queueReplyDraft).toHaveBeenCalledOnce();
    },
  );
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
      keyword: { keyword: "GREEN", resource: { id: "resource-1", messages: [] } },
    });
  }

  it("never delivers the guide when someone tags us in their story", async () => {
    openGate();

    await handleMessage(storyMention());

    // The production incident: a story tag unlocked a gated guide the person
    // never asked to unlock.
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalledWith("done_received", expect.anything());
  });

  it("leaves the gate open so a real reply still unlocks it", async () => {
    openGate();

    await handleMessage(storyMention());

    expect(markGated).not.toHaveBeenCalled();
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
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

    expect(deliverGuideForTrigger).toHaveBeenCalledOnce();
  });
});

describe("handleMessage — durable guide delivery", () => {
  it("keeps a confirmed non-follower keyword request on the gate-only path", async () => {
    resolveUsername.mockResolvedValue({ isFollower: false, username: "geri", name: "Geri" });
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));

    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendTrackedText).toHaveBeenCalledWith({
      recipientIgUserId: "ig-user-1",
      text: keywordFixture.gateMessage,
      source: "keyword_automation",
    });
    expect(markGated).toHaveBeenCalledWith("convo-1");
  });

  it("uses explicit redelivery and compiles the intro into an already-completed keyword request", async () => {
    findKeywordInMessage.mockResolvedValue(keywordFixture);
    hasCompletedKeyword.mockResolvedValue(true);

    await handleMessage(inbound("SLEEP"));

    expect(deliverGuideForTrigger).toHaveBeenCalledWith({
      conversationId: "convo-1",
      resourceId: "resource-1",
      igUserId: "ig-user-1",
      threadId: "thread-1",
      triggerKind: "explicit_redelivery",
      triggerId: "message-1",
      triggeredAt: new Date(1785895200000),
      sendWindowExpiresAt: new Date(1785981600000),
      followerAtTrigger: true,
      redeliveryIntro: "You've already got this one — here it is again 💛",
    });
    expect(sendTrackedText).toHaveBeenCalledOnce();
    expect(sendTrackedText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Thanks for following! 💛" }),
    );
  });

  it("uses explicit redelivery for an already-completed open-gate request", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { id: "resource-1", messages: [] } },
    });
    hasCompletedKeyword.mockResolvedValue(true);

    await handleMessage(inbound("Done"));

    expect(deliverGuideForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "convo-1",
        resourceId: "resource-1",
        triggerKind: "explicit_redelivery",
        redeliveryIntro: "You've already got this one — here it is again 💛",
      }),
    );
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("derives the same durable trigger from repeated processing of one captured inbound", async () => {
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));
    await handleMessage(inbound("SLEEP"));

    expect(deliverGuideForTrigger).toHaveBeenCalledTimes(2);
    expect(deliverGuideForTrigger.mock.calls.map(([input]) => input.triggerId)).toEqual([
      "message-1",
      "message-1",
    ]);
  });

  it.each([
    "preflight_failed",
    "needs_review",
    "retry_scheduled",
    "already_processing",
  ])("does not send the closing nudge when durable delivery returns %s", async (result) => {
    findKeywordInMessage.mockResolvedValue(keywordFixture);
    deliverGuideForTrigger.mockResolvedValue(result);

    await handleMessage(inbound("SLEEP"));

    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(markThreadResolved).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalledWith("follow_nudge_sent", expect.anything());
  });

  it("does not send the closing nudge when an open-gate delivery needs review", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { id: "resource-1", messages: [] } },
    });
    deliverGuideForTrigger.mockResolvedValue("needs_review");

    await handleMessage(inbound("Done"));

    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalledWith("follow_nudge_sent", expect.anything());
  });

  it("sends the existing closing nudge when an open-gate delivery completes now", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { id: "resource-1", messages: [] } },
    });

    await handleMessage(inbound("Done"));

    expect(sendTrackedText).toHaveBeenCalledWith({
      recipientIgUserId: "ig-user-1",
      text: "Thanks for following! 💛",
      source: "guide_automation",
    });
  });

  it("leaves thread resolution and completion events to the durable finalizer", async () => {
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));

    expect(markThreadResolved).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalledWith("sequence_completed", expect.anything());
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
      keyword: { keyword: "SLEEP", resource: { id: "resource-1", messages: [] } },
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
      keyword: { keyword: "SLEEP", resource: { id: "resource-1", messages: [] } },
    });
    const privateBody = "private model or DM output";
    const graphError = new Error(privateBody);
    describeGraphError.mockReturnValue({
      category: "graph_response",
      httpStatus: 400,
      graphCode: 10,
      graphSubcode: 2018278,
      traceId: "trace-1",
    });
    deliverGuideForTrigger.mockRejectedValue(graphError);

    await handleMessage(inbound("Done"));

    const emitted = JSON.stringify({ logs: logger.error.mock.calls, events: logEvent.mock.calls });
    expect(emitted).not.toContain(privateBody);
    expect(logger.error).toHaveBeenCalledWith(
      {
        conversationId: "convo-1",
        errorCode: "graph_request_failed",
        category: "graph_response",
        httpStatus: 400,
        graphCode: 10,
        graphSubcode: 2018278,
        traceId: "trace-1",
      },
      "Guide delivery could not be started",
    );
    expect(logEvent).not.toHaveBeenCalledWith("sequence_failed", expect.anything());
  });

  it("never sends anything on the unhandled path", async () => {
    // Shadow drafting only. The owner approves before a word reaches the user.
    await handleMessage(inbound("Can you help with bedtime?"));
    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
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
  it("leaves guide-path thread resolution to the durable finalizer", async () => {
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { id: "resource-1", messages: [] } },
    });

    await handleMessage(inbound("Done"));

    expect(markThreadResolved).not.toHaveBeenCalled();
  });

  it("leaves needsReply set when durable delivery needs review", async () => {
    // The owner must see "Needs review" rather than a silently swallowed failure.
    findActiveAwaitingDone.mockResolvedValue({
      id: "convo-1",
      keywordId: "keyword-1",
      keyword: { keyword: "SLEEP", resource: { id: "resource-1", messages: [] } },
    });
    deliverGuideForTrigger.mockResolvedValue("needs_review");

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
      resource: { id: "resource-1", messages: [{ id: "m1", body: "guide" }] },
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
    expect(deliverGuideForTrigger).toHaveBeenCalledOnce();
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

    expect(deliverGuideForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ triggerKind: "explicit_redelivery" }),
    );
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
