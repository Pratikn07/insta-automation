import { describe, expect, it } from "vitest";
import type { DmThreadDetail, ReplyDraft, ReplyDraftStatus } from "@/lib/types";
import {
  MAX_REPLY_LENGTH,
  approvalGate,
  draftStatusLabel,
  isLiveDraft,
  isStale,
  rowState,
} from "./replyDraftView";

function draft(overrides: Partial<ReplyDraft> = {}): ReplyDraft {
  return {
    id: "draft-1",
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

describe("isLiveDraft", () => {
  it("treats dismissed and superseded as history", () => {
    expect(isLiveDraft(draft({ status: "dismissed" }))).toBe(false);
    expect(isLiveDraft(draft({ status: "superseded" }))).toBe(false);
    expect(isLiveDraft(draft({ status: "sent" }))).toBe(false);
  });

  it("treats anything actionable as live", () => {
    expect(isLiveDraft(draft({ status: "pending_approval" }))).toBe(true);
    expect(isLiveDraft(draft({ status: "send_uncertain" }))).toBe(true);
  });
});
