import { describe, expect, it } from "vitest";
import type { DmThreadDetail, ReplyDraft, ReplyDraftStatus } from "@/lib/types";
import {
  MAX_REPLY_LENGTH,
  approvalGate,
  draftStatusLabel,
  isVisibleDraft,
  isStale,
  rowState,
} from "./replyDraftView";

function draft(overrides: Partial<ReplyDraft> = {}): ReplyDraft {
  return {
    id: "draft-1",
    kind: "reply",
    status: "pending_approval",
    revision: 1,
    suggestedText: "Most toddlers keep a nap until around 3 💛",
    workingText: "Most toddlers keep a nap until around 3 💛",
    approvedText: null,
    rationale: "Answers directly.",
    confidence: "high",
    warnings: [],
    errorCode: null,
    errorMessage: null,
    retryAt: null,
    sourceConversationId: null,
    eligibleAt: "2026-08-04T10:00:00.000Z",
    expiresAt: null,
    promptVersion: 2,
    inboundMessageId: "message-2",
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    createdAt: "2026-08-04T10:00:00.000Z",
    ...overrides,
  };
}

function thread(overrides: Partial<DmThreadDetail> = {}): DmThreadDetail {
  return {
    id: "thread-1",
    igUserId: "ig-user-1",
    username: "geri",
    name: "Geri",
    needsReply: true,
    latestInboundMessageId: "message-2",
    lastMessageAt: "2026-08-04T10:00:00.000Z",
    messages: [],
    draft: null,
    ...overrides,
  };
}

const OK = { sendEnabled: true, mutationPending: false };
const BEFORE_EXPIRY = new Date("2026-08-05T09:14:59.999Z");
const AT_EXPIRY = new Date("2026-08-05T09:15:00.000Z");

function followUp(overrides: Partial<ReplyDraft> = {}): ReplyDraft {
  return draft({
    kind: "engagement_follow_up",
    sourceConversationId: "conversation-1",
    eligibleAt: "2026-08-04T22:00:00.000Z",
    expiresAt: AT_EXPIRY.toISOString(),
    ...overrides,
  });
}

describe("isStale", () => {
  it("is false while the draft answers the latest inbound", () => {
    expect(isStale(thread(), draft())).toBe(false);
  });

  it("is true once a newer inbound arrives", () => {
    expect(isStale(thread({ latestInboundMessageId: "message-3" }), draft())).toBe(true);
  });

  it("is false when there is no draft", () => {
    expect(isStale(thread(), null)).toBe(false);
  });
});

describe("approvalGate", () => {
  it("allows approval for a current pending draft with valid text", () => {
    expect(
      approvalGate({ thread: thread(), draft: draft(), text: "Looks good 💛", ...OK }),
    ).toEqual({ canApprove: true, reason: null });
  });

  it("blocks approval when a newer inbound arrived", () => {
    expect(
      approvalGate({
        thread: thread({ latestInboundMessageId: "message-3" }),
        draft: draft(),
        text: "Looks good",
        ...OK,
      }),
    ).toEqual({ canApprove: false, reason: "stale" });
  });

  it("blocks blank and whitespace-only text", () => {
    for (const text of ["", "   ", "\n\t"]) {
      expect(approvalGate({ thread: thread(), draft: draft(), text, ...OK }).reason).toBe("empty");
    }
  });

  it("blocks text over the 1000-character limit", () => {
    expect(
      approvalGate({
        thread: thread(),
        draft: draft(),
        text: "x".repeat(MAX_REPLY_LENGTH + 1),
        ...OK,
      }).reason,
    ).toBe("too_long");
  });

  it("allows text at exactly the limit", () => {
    expect(
      approvalGate({
        thread: thread(),
        draft: draft(),
        text: "x".repeat(MAX_REPLY_LENGTH),
        ...OK,
      }).canApprove,
    ).toBe(true);
  });

  it("blocks while a send is already in flight", () => {
    expect(
      approvalGate({ thread: thread(), draft: draft({ status: "sending" }), text: "hi", ...OK })
        .reason,
    ).toBe("in_flight");
  });

  it("blocks while a mutation is pending, to prevent a double submit", () => {
    expect(
      approvalGate({
        thread: thread(),
        draft: draft(),
        text: "hi",
        sendEnabled: true,
        mutationPending: true,
      }).reason,
    ).toBe("in_flight");
  });

  it("blocks when sending is disabled by flag", () => {
    expect(
      approvalGate({
        thread: thread(),
        draft: draft(),
        text: "hi",
        sendEnabled: false,
        mutationPending: false,
      }).reason,
    ).toBe("send_disabled");
  });

  it("allows a ready follow-up until the exact expiry boundary", () => {
    expect(
      approvalGate({
        thread: thread(),
        draft: followUp(),
        text: "How did bedtime go?",
        now: BEFORE_EXPIRY,
        ...OK,
      }),
    ).toEqual({ canApprove: true, reason: null });
  });

  it("blocks a follow-up at and after its exact expiry boundary", () => {
    for (const now of [AT_EXPIRY, new Date(AT_EXPIRY.getTime() + 1)]) {
      expect(
        approvalGate({
          thread: thread(),
          draft: followUp(),
          text: "How did bedtime go?",
          now,
          ...OK,
        }),
      ).toEqual({ canApprove: false, reason: "follow_up_window_closed" });
    }
  });

  it("blocks a follow-up before it becomes eligible", () => {
    expect(
      approvalGate({
        thread: thread(),
        draft: followUp(),
        text: "How did bedtime go?",
        now: new Date("2026-08-04T21:59:59.999Z"),
        ...OK,
      }),
    ).toEqual({ canApprove: false, reason: "follow_up_not_ready" });
  });

  // The message MAY already be in someone's inbox: ordinary approval must not be
  // offered, only the explicit confirmed retry.
  it("blocks ordinary approval for send_uncertain and asks for a check", () => {
    expect(
      approvalGate({
        thread: thread(),
        draft: draft({ status: "send_uncertain" }),
        text: "hi",
        ...OK,
      }),
    ).toEqual({ canApprove: false, reason: "uncertain_needs_check" });
  });

  it.each(["queued", "generating", "generation_failed", "sent", "dismissed"] as ReplyDraftStatus[])(
    "blocks approval for a %s draft",
    (status) => {
      expect(
        approvalGate({ thread: thread(), draft: draft({ status }), text: "hi", ...OK }).canApprove,
      ).toBe(false);
    },
  );
});

describe("draftStatusLabel", () => {
  it("uses plain English, never internal jargon", () => {
    expect(draftStatusLabel("pending_approval")).toBe("Draft ready");
    expect(draftStatusLabel("generating")).toBe("Drafting");
    expect(draftStatusLabel("send_uncertain")).toBe("Status uncertain");
    expect(draftStatusLabel("sent")).toBe("Replied");
  });

  it("distinguishes every owner-visible follow-up phase", () => {
    expect(draftStatusLabel("queued", "engagement_follow_up")).toBe("Follow-up scheduled");
    expect(draftStatusLabel("generating", "engagement_follow_up")).toBe("Writing follow-up");
    expect(draftStatusLabel("pending_approval", "engagement_follow_up")).toBe("Follow-up ready");
    expect(draftStatusLabel("expired", "engagement_follow_up")).toBe("Follow-up expired");
    expect(draftStatusLabel("superseded", "engagement_follow_up")).toBe("Follow-up cancelled");
  });

  it("labels every status", () => {
    const all: ReplyDraftStatus[] = [
      "queued",
      "generating",
      "pending_approval",
      "generation_failed",
      "dismissed",
      "superseded",
      "sending",
      "sent",
      "send_failed",
      "send_uncertain",
      "expired",
    ];
    for (const s of all) expect(draftStatusLabel(s)).toBeTruthy();
  });
});

describe("rowState", () => {
  it("surfaces a failed send above everything else", () => {
    expect(rowState({ needsReply: true, draft: draft({ status: "send_uncertain" }) })).toBe(
      "send_failed",
    );
  });

  it("shows draft_ready for a pending draft", () => {
    expect(rowState({ needsReply: true, draft: draft() })).toBe("draft_ready");
  });

  it("shows needs_review when a thread needs a reply but has no draft", () => {
    expect(rowState({ needsReply: true, draft: null })).toBe("needs_review");
  });

  it("shows automated for an answered thread with no live draft", () => {
    expect(rowState({ needsReply: false, draft: null })).toBe("automated");
  });
});

describe("isVisibleDraft", () => {
  it("treats ordinary terminal drafts as history", () => {
    expect(isVisibleDraft(draft({ status: "dismissed" }))).toBe(false);
    expect(isVisibleDraft(draft({ status: "superseded" }))).toBe(false);
    expect(isVisibleDraft(draft({ status: "sent" }))).toBe(false);
  });

  it("treats anything actionable as live", () => {
    expect(isVisibleDraft(draft({ status: "pending_approval" }))).toBe(true);
    expect(isVisibleDraft(draft({ status: "send_uncertain" }))).toBe(true);
  });

  it("keeps expired and cancelled follow-ups visible", () => {
    expect(isVisibleDraft(followUp({ status: "expired" }))).toBe(true);
    expect(isVisibleDraft(followUp({ status: "superseded" }))).toBe(true);
    expect(isVisibleDraft(draft({ status: "expired" }))).toBe(false);
  });
});
