import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MessagingEntry } from "../types/meta.js";

// --- mocks -------------------------------------------------------------------
const recordInboundMessage = vi.fn();
const updateDmThreadProfile = vi.fn();
const markThreadResolved = vi.fn();
const queueReplyDraft = vi.fn();
const findKeywordInMessage = vi.fn();
const findActiveAwaitingDone = vi.fn();
const hasCompletedKeyword = vi.fn();
const openConversation = vi.fn();
const markCompleted = vi.fn();
const markGated = vi.fn();
const sendSequence = vi.fn();
const sendTrackedText = vi.fn();
const resolveUsername = vi.fn();
const logEvent = vi.fn();
const describeGraphError = vi.fn((e: unknown) => ({ message: String(e) }));
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
}));
vi.mock("../services/replyDraftService.js", () => ({ queueReplyDraft }));
vi.mock("../services/keywordService.js", () => ({ findKeywordInMessage }));
vi.mock("../services/conversationService.js", () => ({
  findActiveAwaitingDone,
  hasCompletedKeyword,
  openConversation,
  markCompleted,
  markGated,
}));
vi.mock("../services/sequenceSender.js", () => ({ sendSequence }));
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
      get: (target, prop) =>
        prop === "AI_DRAFTS_ENABLED" ? aiFlags.AI_DRAFTS_ENABLED : target[prop as string],
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
  resource: { messages: [{ id: "m1", order: 0, type: "text", body: "guide" }] },
};

beforeEach(() => {
  for (const fn of [
    recordInboundMessage,
    updateDmThreadProfile,
    markThreadResolved,
    queueReplyDraft,
    findKeywordInMessage,
    findActiveAwaitingDone,
    hasCompletedKeyword,
    openConversation,
    markCompleted,
    markGated,
    sendSequence,
    sendTrackedText,
    resolveUsername,
    logEvent,
    describeGraphError,
  ]) {
    fn.mockReset();
  }
  for (const fn of Object.values(logger)) fn.mockReset();
  describeGraphError.mockImplementation((e: unknown) => ({ message: String(e) }));
  recordInboundMessage.mockResolvedValue({
    duplicate: false,
    becameLatest: true,
    threadId: "thread-1",
    messageId: "message-1",
  });
  resolveUsername.mockResolvedValue({ isFollower: true, username: "geri", name: "Geri" });
  findKeywordInMessage.mockResolvedValue(null);
  findActiveAwaitingDone.mockResolvedValue(null);
  hasCompletedKeyword.mockResolvedValue(false);
  openConversation.mockResolvedValue({ id: "convo-1" });
  logEvent.mockResolvedValue(undefined);
  sendTrackedText.mockResolvedValue({ messageId: "mid-out" });
  sendSequence.mockResolvedValue(undefined);
  queueReplyDraft.mockResolvedValue({ id: "draft-1" });
  aiFlags.AI_DRAFTS_ENABLED = true;
});

describe("handleMessage — inbound capture", () => {
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
    expect(openConversation).not.toHaveBeenCalled();
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

  it("continues handling when the profile lookup fails", async () => {
    resolveUsername.mockRejectedValue(new Error("consent required"));
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));

    expect(openConversation).toHaveBeenCalledOnce();
  });
});

describe("handleMessage — branch order is unchanged", () => {
  it("keeps a keyword trigger on the existing automation path", async () => {
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));

    expect(openConversation).toHaveBeenCalledOnce();
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

    expect(openConversation).toHaveBeenCalledWith("ig-user-1", "keyword-1");
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
      httpStatus: 400,
      code: 10,
      subcode: 2018278,
      fbtrace_id: "trace-1",
      message: privateBody,
      requestBody: { message: { text: privateBody } },
    });
    sendSequence.mockRejectedValue(graphError);

    await handleMessage(inbound("Done"));

    const emitted = JSON.stringify({ logs: logger.error.mock.calls, events: logEvent.mock.calls });
    expect(emitted).not.toContain(privateBody);
    expect(logEvent).toHaveBeenCalledWith("sequence_failed", {
      conversationId: "convo-1",
      errorCode: "graph_request_failed",
      httpStatus: 400,
      code: 10,
      subcode: 2018278,
      fbtrace_id: "trace-1",
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
