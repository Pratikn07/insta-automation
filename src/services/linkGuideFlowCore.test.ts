// src/services/linkGuideFlowCore.test.ts
import { describe, expect, it, vi } from "vitest";
import { createLinkGuideFlow, type LinkGuideFlowDeps } from "./linkGuideFlowCore.js";
import type { LinkGuideResource } from "./linkGuidePolicy.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const RECEIPT = { instagramMessageId: "mid-1", dmMessageId: "dm-1", acceptedAt: NOW };
const TRACKED = "https://api.example.com/r/tok_ABCDEFG";
const RESOURCE: LinkGuideResource = {
  id: "res-1",
  name: "Halloween collection",
  description: "8 toddler-friendly recipes",
  deliveryMode: "link",
  linkUrl: "https://mycuratedhaven.com/halloween",
  linkButtonLabel: "Open the recipes",
  linkCardTitle: "Your Halloween recipes 👻",
  linkCardSubtitle: null,
};
const COMMENT_INPUT = {
  conversationId: "convo-1",
  keywordId: "kw-1",
  keywordSnapshot: "GHOST",
  commentId: "comment-1",
  mediaId: "reel-9",
  igUserId: "ig-parent",
  resource: RESOURCE,
};
const DM_INPUT = {
  conversationId: "convo-1",
  keywordId: "kw-1",
  mediaId: "reel-9",
  igUserId: "ig-parent",
  resource: RESOURCE,
  threadId: "thread-1",
  inboundMessageId: "message-1",
};

function makeDeps(overrides: Partial<LinkGuideFlowDeps> = {}) {
  const deps = {
    repository: {
      createSend: vi.fn(async () => ({ id: "send-1" })),
      markSendSent: vi.fn(async () => undefined),
      markSendFailed: vi.fn(async () => undefined),
    },
    isEnabled: () => true,
    isCardEnabled: () => true,
    isTwoHourRecoveryEnabled: () => false,
    redirectBaseUrl: "https://api.example.com",
    allowedHosts: new Set(["mycuratedhaven.com"]),
    profileUrl: "https://www.instagram.com/tinysoho/",
    loadCover: vi.fn(async () => ({ coverUrl: "https://cdn.example.com/cover.png" })),
    sendMeta: vi.fn(async () => ({ messageId: "mid-dm" })),
    sendTrackedPrivateCard: vi.fn(async (input: { send: () => Promise<unknown> }) => {
      await input.send();
      return RECEIPT;
    }),
    sendTrackedPrivateReply: vi.fn(async () => RECEIPT),
    sendTrackedText: vi.fn(async () => ({ messageId: "mid-text" })),
    markLinkSent: vi.fn(async () => undefined),
    scheduleAcceptedGateRecovery: vi.fn(async () => ({ id: "rec-1" })),
    markThreadResolved: vi.fn(async () => undefined),
    logEvent: vi.fn(async () => undefined),
    describeError: () => ({ category: "unknown_error" }),
    newToken: () => "tok_ABCDEFG",
    now: () => NOW,
    ...overrides,
  };
  return deps as typeof deps & LinkGuideFlowDeps;
}

describe("readiness", () => {
  it("is ready only when switched on, configured, and the guide's link is valid", () => {
    expect(createLinkGuideFlow(makeDeps()).readiness(RESOURCE)).toBe("ready");
    expect(createLinkGuideFlow(makeDeps({ isEnabled: () => false })).readiness(RESOURCE)).toBe("disabled");
    expect(createLinkGuideFlow(makeDeps({ redirectBaseUrl: undefined })).readiness(RESOURCE)).toBe("misconfigured");
    expect(
      createLinkGuideFlow(makeDeps()).readiness({ ...RESOURCE, linkUrl: "https://evil.example/x" }),
    ).toBe("misconfigured");
    expect(createLinkGuideFlow(makeDeps()).readiness({ ...RESOURCE, deliveryMode: "gated" })).toBe("misconfigured");
  });
});

describe("runCommentLinkGuide", () => {
  it("moves the conversation to link_sent, then sends the card as the private reply", async () => {
    const deps = makeDeps();
    const result = await createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT);

    expect(result).toEqual({ outcome: "sent", sendId: "send-1", shape: "card", receipt: RECEIPT });
    expect(deps.markLinkSent).toHaveBeenCalledWith("convo-1");
    expect(deps.markLinkSent.mock.invocationCallOrder[0]).toBeLessThan(
      deps.repository.createSend.mock.invocationCallOrder[0]!,
    );
    expect(deps.repository.createSend).toHaveBeenCalledWith({
      token: "tok_ABCDEFG",
      conversationId: "convo-1",
      resourceId: "res-1",
      keywordId: "kw-1",
      mediaId: "reel-9",
      igUserId: "ig-parent",
      channel: "private_reply",
      shape: "card",
    });
    const [payload, metadata] = deps.sendMeta.mock.calls[0] as unknown as [
      { recipient: unknown; message: { attachment: { payload: { elements: Array<{ title: string; subtitle: string; buttons: Array<{ url: string; title: string }> }> } } } },
      { mode: string },
    ];
    expect(payload.recipient).toEqual({ comment_id: "comment-1" });
    const element = payload.message.attachment.payload.elements[0]!;
    expect(element.title).toBe("Your Halloween recipes 👻");
    expect(element.subtitle).toBe("8 toddler-friendly recipes");
    expect(element.buttons[0]).toEqual({ type: "web_url", url: TRACKED, title: "Open the recipes" });
    expect(metadata.mode).toBe("private_link_card");
    expect(deps.repository.markSendSent).toHaveBeenCalledWith("send-1", "mid-1", NOW);
    expect(deps.logEvent).toHaveBeenCalledWith("dm_sent", {
      conversationId: "convo-1",
      kind: "link",
      shape: "card",
      channel: "private_reply",
    });
  });

  it("sends text with the link when the card switch is off, without loading a cover", async () => {
    const deps = makeDeps({ isCardEnabled: () => false });
    const result = await createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT);

    expect(result).toMatchObject({ outcome: "sent", shape: "text" });
    expect(deps.loadCover).not.toHaveBeenCalled();
    expect(deps.sendTrackedPrivateReply).toHaveBeenCalledWith({
      recipientIgUserId: "ig-parent",
      commentId: "comment-1",
      text: `Your Halloween recipes 👻\n${TRACKED}`,
      source: "keyword_automation",
    });
  });

  it("sends text when the guide has no published square cover", async () => {
    const deps = makeDeps({ loadCover: vi.fn(async () => null) });
    await expect(createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT)).resolves.toMatchObject({
      shape: "text",
    });
    expect(deps.sendTrackedPrivateCard).not.toHaveBeenCalled();
  });

  it("returns the text-with-link retry when the send fails, and marks the send failed", async () => {
    const error = new Error("socket hang up");
    const deps = makeDeps({ sendTrackedPrivateCard: vi.fn(async () => { throw error; }) });
    const result = await createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT);

    expect(result).toEqual({
      outcome: "failed",
      sendId: "send-1",
      shape: "card",
      error,
      retryText: `Your Halloween recipes 👻\n${TRACKED}`,
    });
    expect(deps.repository.markSendFailed).toHaveBeenCalledWith("send-1");
    expect(deps.repository.markSendSent).not.toHaveBeenCalled();
  });

  it("never reports a delivered DM as failed when only the bookkeeping write fails", async () => {
    const deps = makeDeps();
    deps.repository.markSendSent.mockRejectedValueOnce(new Error("db down"));
    await expect(createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT)).resolves.toMatchObject({
      outcome: "sent",
    });
    expect(deps.logEvent).toHaveBeenCalledWith("link_send_record_failed", { conversationId: "convo-1" });
  });

  it("schedules the 2-hour reminder with link wording only when that switch is on", async () => {
    const off = makeDeps();
    await createLinkGuideFlow(off).runCommentLinkGuide(COMMENT_INPUT);
    expect(off.scheduleAcceptedGateRecovery).not.toHaveBeenCalled();

    const on = makeDeps({ isTwoHourRecoveryEnabled: () => true });
    await createLinkGuideFlow(on).runCommentLinkGuide(COMMENT_INPUT);
    expect(on.scheduleAcceptedGateRecovery).toHaveBeenCalledWith({
      conversationId: "convo-1",
      igUserId: "ig-parent",
      keywordId: "kw-1",
      keywordSnapshot: "GHOST",
      commentId: "comment-1",
      mediaId: "reel-9",
      gateDmMessageId: "dm-1",
      instagramGateMessageId: "mid-1",
      acceptedAt: NOW,
      openingKind: "link",
    });
  });

  it("does nothing but log when link guides are switched off", async () => {
    const deps = makeDeps({ isEnabled: () => false });
    await expect(createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT)).resolves.toEqual({
      outcome: "not_ready",
      readiness: "disabled",
    });
    expect(deps.markLinkSent).not.toHaveBeenCalled();
    expect(deps.repository.createSend).not.toHaveBeenCalled();
    expect(deps.logEvent).toHaveBeenCalledWith("link_guide_disabled", {
      conversationId: "convo-1",
      resourceId: "res-1",
      source: "comment",
    });
  });
});

describe("runDmLinkGuide", () => {
  it("sends the card into the open thread and resolves the thread", async () => {
    const deps = makeDeps();
    await expect(createLinkGuideFlow(deps).runDmLinkGuide(DM_INPUT)).resolves.toMatchObject({
      outcome: "sent",
      shape: "card",
      receipt: null,
    });
    const [payload, metadata] = deps.sendMeta.mock.calls[0] as unknown as [
      { recipient: unknown; messaging_type: string },
      { mode: string },
    ];
    expect(payload.recipient).toEqual({ id: "ig-parent" });
    expect(payload.messaging_type).toBe("RESPONSE");
    expect(metadata.mode).toBe("dm_link_card");
    expect(deps.repository.markSendSent).toHaveBeenCalledWith("send-1", "mid-dm", NOW);
    expect(deps.markThreadResolved).toHaveBeenCalledWith({ threadId: "thread-1", inboundMessageId: "message-1" });
  });

  it("logs a DM failure and leaves the thread for the owner", async () => {
    const deps = makeDeps({ sendMeta: vi.fn(async () => { throw new Error("socket hang up"); }) });
    await expect(createLinkGuideFlow(deps).runDmLinkGuide(DM_INPUT)).resolves.toMatchObject({ outcome: "failed" });
    expect(deps.markThreadResolved).not.toHaveBeenCalled();
    expect(deps.logEvent).toHaveBeenCalledWith("dm_failed", {
      conversationId: "convo-1",
      stage: "link_inbound_dm",
      category: "unknown_error",
    });
  });
});
