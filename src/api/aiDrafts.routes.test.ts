import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks -------------------------------------------------------------------
const replyDraft = { findUnique: vi.fn(), updateMany: vi.fn() };
const dmThread = { findUnique: vi.fn() };
const claimApprovedDraft = vi.fn();
const queueReplyDraft = vi.fn();
const markSent = vi.fn();
const markSendFailed = vi.fn();
const markSendUncertain = vi.fn();
const sendTrackedText = vi.fn();
const markThreadResolved = vi.fn();
const logEvent = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: { replyDraft, dmThread } }));
vi.mock("../services/replyDraftService.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    claimApprovedDraft,
    queueReplyDraft,
    markSent,
    markSendFailed,
    markSendUncertain,
  };
});
vi.mock("../services/dmDeliveryService.js", () => ({ sendTrackedText }));
vi.mock("../services/dmThreadService.js", () => ({ markThreadResolved }));
vi.mock("../services/eventLogger.js", () => ({ logEvent, describeGraphError: () => ({}) }));

const sendFlags = { AI_SEND_ENABLED: true, AI_DRAFTS_ENABLED: true };
vi.mock("../config/env.js", async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return {
    env: new Proxy(actual.env, {
      get: (t, p) =>
        p === "AI_SEND_ENABLED"
          ? sendFlags.AI_SEND_ENABLED
          : p === "AI_DRAFTS_ENABLED"
            ? sendFlags.AI_DRAFTS_ENABLED
            : t[p as string],
    }),
  };
});

const { DraftActionError } = await import("../services/replyDraftService.js");
const { createAiRouter } = await import("./ai.routes.js");

const PENDING = {
  id: "draft-2",
  threadId: "thread-1",
  inboundMessageId: "message-2",
  status: "pending_approval",
  approvedText: null,
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.adminEmail = "owner@example.com";
    next();
  });
  app.use(
    "/api/ai",
    createAiRouter({
      client: {
        getConnectionStatus: vi.fn(),
        startDeviceLogin: vi.fn(),
        disconnect: vi.fn(),
        generateDmDraft: vi.fn(),
      },
      isConfigured: () => true,
    }),
  );
  return app;
}

const base = "/api/ai/dm-threads/thread-1/drafts/draft-2";

beforeEach(() => {
  for (const fn of [
    replyDraft.findUnique,
    replyDraft.updateMany,
    dmThread.findUnique,
    claimApprovedDraft,
    queueReplyDraft,
    markSent,
    markSendFailed,
    markSendUncertain,
    sendTrackedText,
    markThreadResolved,
    logEvent,
  ]) {
    fn.mockReset();
  }
  sendFlags.AI_SEND_ENABLED = true;
  sendFlags.AI_DRAFTS_ENABLED = true;
  replyDraft.findUnique.mockResolvedValue(PENDING);
  replyDraft.updateMany.mockResolvedValue({ count: 1 });
  dmThread.findUnique.mockResolvedValue({
    igUserId: "ig-user-1",
    latestInboundMessageId: "message-2",
    needsReply: true,
  });
  claimApprovedDraft.mockResolvedValue(undefined);
  sendTrackedText.mockResolvedValue({ messageId: "mid-out" });
  logEvent.mockResolvedValue(undefined);
});

describe("PATCH draft (edit)", () => {
  it("updates the working text without touching the suggestion", async () => {
    await request(makeApp()).patch(base).send({ workingText: "Edited reply 💛" }).expect(204);

    const [[call]] = replyDraft.updateMany.mock.calls as [[{ data: Record<string, unknown> }]];
    expect(call.data).toEqual({ workingText: "Edited reply 💛" });
    expect(call.data).not.toHaveProperty("suggestedText");
  });

  it("rejects blank text", async () => {
    await request(makeApp()).patch(base).send({ workingText: "   " }).expect(400);
  });

  it("rejects text over 1000 characters", async () => {
    await request(makeApp()).patch(base).send({ workingText: "x".repeat(1001) }).expect(400);
  });

  it("refuses to edit a draft that is no longer pending", async () => {
    replyDraft.findUnique.mockResolvedValue({ ...PENDING, status: "sent" });
    await request(makeApp()).patch(base).send({ workingText: "nope" }).expect(409, {
      error: "draft_not_pending",
    });
  });

  it("404s when the draft belongs to another thread", async () => {
    replyDraft.findUnique.mockResolvedValue({ ...PENDING, threadId: "other-thread" });
    await request(makeApp()).patch(base).send({ workingText: "nope" }).expect(404);
  });
});

describe("POST approve", () => {
  it("requires AI_SEND_ENABLED", async () => {
    sendFlags.AI_SEND_ENABLED = false;
    await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "Reply" })
      .expect(403, { error: "ai_send_disabled" });
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("sends the exact approved text once and marks it sent", async () => {
    await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "This is the exact reply 💛" })
      .expect(200, { status: "sent" });

    expect(sendTrackedText).toHaveBeenCalledTimes(1);
    expect(sendTrackedText).toHaveBeenCalledWith({
      recipientIgUserId: "ig-user-1",
      text: "This is the exact reply 💛",
      source: "ai_approved",
    });
    expect(markSent).toHaveBeenCalledWith("draft-2");
    expect(markThreadResolved).toHaveBeenCalledWith({
      threadId: "thread-1",
      inboundMessageId: "message-2",
    });
  });

  it("returns 409 stale_draft and never sends when a newer inbound arrived", async () => {
    claimApprovedDraft.mockRejectedValue(new DraftActionError("stale_draft"));

    await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "Reply" })
      .expect(409, { error: "stale_draft" });
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("returns 409 draft_not_pending for the loser of two parallel approvals", async () => {
    claimApprovedDraft.mockRejectedValue(new DraftActionError("draft_not_pending"));

    await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "Reply" })
      .expect(409, { error: "draft_not_pending" });
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("marks a definite Graph rejection send_failed with 502", async () => {
    const axiosish = Object.assign(new Error("Request failed"), {
      isAxiosError: true,
      response: { status: 400 },
    });
    sendTrackedText.mockRejectedValue(axiosish);

    const res = await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "Reply" })
      .expect(502);
    expect(res.body).toMatchObject({ status: "send_failed" });
    expect(markSendFailed).toHaveBeenCalledOnce();
    expect(markSendUncertain).not.toHaveBeenCalled();
  });

  it("marks a no-response timeout send_uncertain with 202 and never retries", async () => {
    const timeout = Object.assign(new Error("timeout of 10000ms exceeded"), {
      isAxiosError: true,
      code: "ECONNABORTED",
      response: undefined,
    });
    sendTrackedText.mockRejectedValue(timeout);

    const res = await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "Reply" })
      .expect(202);
    expect(res.body).toMatchObject({ status: "send_uncertain" });
    expect(markSendUncertain).toHaveBeenCalledOnce();
    // The costly mistake would be sending twice to a real person.
    expect(sendTrackedText).toHaveBeenCalledTimes(1);
    expect(markSent).not.toHaveBeenCalled();
  });

  it("rejects blank approved text", async () => {
    await request(makeApp()).post(`${base}/approve`).send({ workingText: "" }).expect(400);
    expect(claimApprovedDraft).not.toHaveBeenCalled();
  });
});

describe("POST retry-send", () => {
  beforeEach(() => {
    replyDraft.findUnique.mockResolvedValue({
      ...PENDING,
      status: "send_uncertain",
      approvedText: "Previously approved text",
    });
  });

  it("requires an explicit confirmation", async () => {
    await request(makeApp())
      .post(`${base}/retry-send`)
      .send({})
      .expect(400, { error: "confirmation_required" });
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("rejects confirmedNotDelivered: false", async () => {
    await request(makeApp())
      .post(`${base}/retry-send`)
      .send({ confirmedNotDelivered: false })
      .expect(400, { error: "confirmation_required" });
  });

  it("resends the previously approved text on confirmation", async () => {
    await request(makeApp())
      .post(`${base}/retry-send`)
      .send({ confirmedNotDelivered: true })
      .expect(200, { status: "sent" });

    expect(sendTrackedText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Previously approved text", source: "ai_approved" }),
    );
  });

  it("refuses to retry a draft that is not in a failure state", async () => {
    replyDraft.findUnique.mockResolvedValue({ ...PENDING, status: "sent" });
    await request(makeApp())
      .post(`${base}/retry-send`)
      .send({ confirmedNotDelivered: true })
      .expect(409, { error: "draft_not_retryable" });
  });

  it("refuses the loser of two parallel retries", async () => {
    replyDraft.updateMany.mockResolvedValue({ count: 0 });
    await request(makeApp())
      .post(`${base}/retry-send`)
      .send({ confirmedNotDelivered: true })
      .expect(409, { error: "draft_not_retryable" });
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("requires AI_SEND_ENABLED", async () => {
    sendFlags.AI_SEND_ENABLED = false;
    await request(makeApp())
      .post(`${base}/retry-send`)
      .send({ confirmedNotDelivered: true })
      .expect(403, { error: "ai_send_disabled" });
  });
});

describe("POST dismiss / regenerate", () => {
  it("dismisses a pending draft and resolves the thread", async () => {
    await request(makeApp()).post(`${base}/dismiss`).expect(204);
    expect(markThreadResolved).toHaveBeenCalledWith({
      threadId: "thread-1",
      inboundMessageId: "message-2",
    });
  });

  it("dismisses a failed generation too", async () => {
    replyDraft.findUnique.mockResolvedValue({ ...PENDING, status: "generation_failed" });
    await request(makeApp()).post(`${base}/dismiss`).expect(204);
  });

  it("refuses to dismiss a sent draft", async () => {
    replyDraft.findUnique.mockResolvedValue({ ...PENDING, status: "sent" });
    await request(makeApp()).post(`${base}/dismiss`).expect(409);
  });

  it("regenerate queues a new revision for the latest inbound", async () => {
    queueReplyDraft.mockResolvedValue({ id: "draft-3", status: "queued" });
    await request(makeApp())
      .post(`${base}/regenerate`)
      .expect(202, { draftId: "draft-3", status: "queued" });

    expect(queueReplyDraft).toHaveBeenCalledWith({
      threadId: "thread-1",
      inboundMessageId: "message-2",
    });
  });

  it("generate returns 202 for a thread with an inbound message", async () => {
    dmThread.findUnique.mockResolvedValue({
      id: "thread-1",
      needsReply: true,
      latestInboundMessageId: "message-2",
    });
    queueReplyDraft.mockResolvedValue({ id: "draft-9", status: "queued" });

    await request(makeApp())
      .post("/api/ai/dm-threads/thread-1/drafts")
      .expect(202, { draftId: "draft-9", status: "queued" });
  });

  it("generate 409s when the thread has no inbound message", async () => {
    dmThread.findUnique.mockResolvedValue({
      id: "thread-1",
      needsReply: false,
      latestInboundMessageId: null,
    });
    await request(makeApp())
      .post("/api/ai/dm-threads/thread-1/drafts")
      .expect(409, { error: "no_inbound_message" });
  });
});

/**
 * The queueing routes must refuse when the worker that drains the queue is off.
 *
 * Otherwise a click writes a `queued` row that nothing will ever process, and the
 * drawer shows "Writing a suggestion…" forever. A spinner that can never resolve is
 * worse than a clear refusal.
 */
describe("queueing a draft requires the worker to be running", () => {
  beforeEach(() => {
    sendFlags.AI_DRAFTS_ENABLED = false;
    dmThread.findUnique.mockResolvedValue({
      id: "thread-1",
      needsReply: true,
      latestInboundMessageId: "message-2",
    });
  });

  it("refuses a first draft with 403 and writes no row", async () => {
    await request(makeApp())
      .post("/api/ai/dm-threads/thread-1/drafts")
      .expect(403, { error: "ai_drafts_disabled" });
    expect(queueReplyDraft).not.toHaveBeenCalled();
  });

  it("refuses a regenerate with 403 and writes no row", async () => {
    replyDraft.findUnique.mockResolvedValue(PENDING);
    await request(makeApp())
      .post("/api/ai/dm-threads/thread-1/drafts/draft-2/regenerate")
      .expect(403, { error: "ai_drafts_disabled" });
    expect(queueReplyDraft).not.toHaveBeenCalled();
  });

  it("still queues when the worker is enabled", async () => {
    sendFlags.AI_DRAFTS_ENABLED = true;
    queueReplyDraft.mockResolvedValue({ id: "draft-9", status: "queued" });
    await request(makeApp()).post("/api/ai/dm-threads/thread-1/drafts").expect(202);
    expect(queueReplyDraft).toHaveBeenCalledOnce();
  });
});
