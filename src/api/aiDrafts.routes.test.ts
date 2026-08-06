import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks -------------------------------------------------------------------
const replyDraft = { findUnique: vi.fn(), updateMany: vi.fn() };
const dmThread = { findUnique: vi.fn() };
const claimApprovedDraft = vi.fn();
const claimRetryDraft = vi.fn();
const queueReplyDraft = vi.fn();
const regenerateReplyDraft = vi.fn();
const markSent = vi.fn();
const markSendFailed = vi.fn();
const markSendUncertain = vi.fn();
const sendTrackedText = vi.fn();
const markThreadResolved = vi.fn();
const logEvent = vi.fn();
const loggerError = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: { replyDraft, dmThread } }));
vi.mock("../services/replyDraftService.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    claimApprovedDraft,
    claimRetryDraft,
    queueReplyDraft,
    regenerateReplyDraft,
    markSent,
    markSendFailed,
    markSendUncertain,
  };
});
vi.mock("../services/dmDeliveryService.js", () => ({ sendTrackedText }));
vi.mock("../services/dmThreadService.js", () => ({ markThreadResolved }));
vi.mock("../services/eventLogger.js", () => ({ logEvent, describeGraphError: () => ({}) }));
vi.mock("../lib/logger.js", () => ({
  logger: { error: loggerError, warn: vi.fn(), info: vi.fn() },
}));

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
  suggestedText: "Model text that the owner replaced",
};

function makeApp(authenticated = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authenticated) req.adminEmail = "owner@example.com";
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
    claimRetryDraft,
    queueReplyDraft,
    regenerateReplyDraft,
    markSent,
    markSendFailed,
    markSendUncertain,
    sendTrackedText,
    markThreadResolved,
    logEvent,
    loggerError,
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
  claimApprovedDraft.mockImplementation(async (input: { workingText: string }) => ({
    approvedText: input.workingText,
    inboundMessageId: "message-2",
  }));
  claimRetryDraft.mockResolvedValue({
    approvedText: "Previously approved text",
    inboundMessageId: "message-2",
  });
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
    await request(makeApp())
      .patch(base)
      .send({ workingText: "   " })
      .expect(400, { error: "invalid_working_text" });
  });

  it("rejects text over 1000 characters", async () => {
    await request(makeApp())
      .patch(base)
      .send({ workingText: "x".repeat(1001) })
      .expect(400, { error: "invalid_working_text" });
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

  it("returns a controlled safe error when persistence fails", async () => {
    replyDraft.updateMany.mockRejectedValue(new Error("database error containing private text"));
    const res = await request(makeApp())
      .patch(base)
      .send({ workingText: "Private editor text" })
      .expect(500, { error: "internal_error" });
    expect(JSON.stringify(res.body)).not.toContain("private text");
  });
});

describe("POST approve", () => {
  it("requires an authenticated owner identity", async () => {
    await request(makeApp(false))
      .post(`${base}/approve`)
      .send({ workingText: "Reply" })
      .expect(401, { error: "owner_auth_required" });
    expect(claimApprovedDraft).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("requires AI_SEND_ENABLED", async () => {
    sendFlags.AI_SEND_ENABLED = false;
    await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "Reply" })
      .expect(403, { error: "ai_send_disabled" });
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("sends the exact trimmed editor text once, never the model suggestion", async () => {
    await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "  This is the exact reply 💛\n" })
      .expect(200, { status: "sent" });

    expect(claimApprovedDraft).toHaveBeenCalledWith({
      threadId: "thread-1",
      draftId: "draft-2",
      approvedBy: "owner@example.com",
      workingText: "This is the exact reply 💛",
    });
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
    expect(logEvent).toHaveBeenCalledWith("ai_reply_sent", {
      threadId: "thread-1",
      draftId: "draft-2",
      by: "owner@example.com",
      length: 26,
    });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("This is the exact reply");
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("Model text that the owner replaced");
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

  it.each([
    "prompt_policy_outdated",
    "follow_up_not_ready",
    "follow_up_window_closed",
  ] as const)("returns 409 %s and never sends", async (code) => {
    claimApprovedDraft.mockRejectedValue(new DraftActionError(code));

    await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "Reply" })
      .expect(409, { error: code });
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

  it("never exposes a secret-bearing provider rejection in logs, audit, or HTTP", async () => {
    const providerSecret = "provider says private DM body and TOKEN-SECRET";
    const editorSecret = "Private editor text only Instagram may receive";
    const axiosish = Object.assign(new Error(providerSecret), {
      isAxiosError: true,
      code: "ERR_BAD_REQUEST",
      config: {
        url: "/messages?access_token=URL-TOKEN-SECRET",
        data: JSON.stringify({ text: editorSecret }),
      },
      response: {
        status: 400,
        data: { error: { code: 100, message: providerSecret } },
      },
    });
    sendTrackedText.mockRejectedValue(axiosish);

    const res = await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: editorSecret })
      .expect(502, { status: "send_failed", errorCode: "graph_rejected" });

    expect(markSendFailed).toHaveBeenCalledWith("draft-2", "graph_rejected");
    expect(logEvent).toHaveBeenCalledWith("ai_reply_send_failed", {
      threadId: "thread-1",
      draftId: "draft-2",
      errorCode: "graph_rejected",
    });
    const exposed = JSON.stringify({
      response: res.body,
      audit: logEvent.mock.calls,
      logs: loggerError.mock.calls,
    });
    for (const secret of [providerSecret, editorSecret, "TOKEN-SECRET", "URL-TOKEN-SECRET"]) {
      expect(exposed).not.toContain(secret);
    }
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

  it("maps an arbitrary secret-bearing transport code to safe metadata everywhere", async () => {
    const arbitraryCode = "SECRET_CODE_private-DM_owner-token";
    const providerMessage = "socket error included TOKEN-SECRET and private body";
    const timeout = Object.assign(new Error(providerMessage), {
      isAxiosError: true,
      code: arbitraryCode,
      config: { data: "private editor body", url: "/messages?access_token=URL-TOKEN" },
      response: undefined,
    });
    sendTrackedText.mockRejectedValue(timeout);

    const res = await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "private editor body" })
      .expect(202, { status: "send_uncertain", errorCode: "transport_error" });

    expect(markSendUncertain).toHaveBeenCalledWith("draft-2", "transport_error");
    expect(logEvent).toHaveBeenCalledWith("ai_reply_send_uncertain", {
      threadId: "thread-1",
      draftId: "draft-2",
      errorCode: "transport_error",
    });
    const exposed = JSON.stringify({
      response: res.body,
      audit: logEvent.mock.calls,
      logs: loggerError.mock.calls,
    });
    for (const secret of [arbitraryCode, providerMessage, "private editor body", "URL-TOKEN"]) {
      expect(exposed).not.toContain(secret);
    }
  });

  it("returns terminal send_uncertain when success recording cannot be confirmed", async () => {
    markSent.mockRejectedValue(new Error("database write failed with private detail"));

    const res = await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "Private editor text" })
      .expect(202);

    expect(res.body).toEqual({
      status: "send_uncertain",
      errorCode: "send_recording_unconfirmed",
    });
    expect(JSON.stringify(res.body)).not.toContain("private detail");
    expect(sendTrackedText).toHaveBeenCalledTimes(1);
    expect(markThreadResolved).not.toHaveBeenCalled();
  });

  it("returns a stable internal error when the atomic claim itself fails", async () => {
    claimApprovedDraft.mockRejectedValue(new Error("database DSN and private editor text"));

    const res = await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "Private editor text" })
      .expect(500, { error: "internal_error" });
    expect(JSON.stringify(res.body)).not.toContain("database DSN");
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("records a definite pre-send lookup failure without calling Instagram", async () => {
    dmThread.findUnique.mockRejectedValue(new Error("database lookup failed"));

    await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "Private editor text" })
      .expect(500, { error: "internal_error" });
    expect(markSendFailed).toHaveBeenCalledWith("draft-2", "thread_lookup_failed");
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("rejects blank approved text", async () => {
    await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "" })
      .expect(400, { error: "invalid_working_text" });
    expect(claimApprovedDraft).not.toHaveBeenCalled();
  });

  it("rejects approved text over 1000 characters", async () => {
    await request(makeApp())
      .post(`${base}/approve`)
      .send({ workingText: "x".repeat(1001) })
      .expect(400, { error: "invalid_working_text" });
    expect(claimApprovedDraft).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
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

  it("requires an authenticated owner identity", async () => {
    await request(makeApp(false))
      .post(`${base}/retry-send`)
      .send({ confirmedNotDelivered: true })
      .expect(401, { error: "owner_auth_required" });
    expect(claimRetryDraft).not.toHaveBeenCalled();
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
    expect(claimRetryDraft).toHaveBeenCalledWith({
      threadId: "thread-1",
      draftId: "draft-2",
      confirmedNotDelivered: true,
    });
    expect(replyDraft.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to retry a draft that is not in a failure state", async () => {
    claimRetryDraft.mockRejectedValue(new DraftActionError("draft_not_retryable"));
    await request(makeApp())
      .post(`${base}/retry-send`)
      .send({ confirmedNotDelivered: true })
      .expect(409, { error: "draft_not_retryable" });
  });

  it("refuses the loser of two parallel retries", async () => {
    claimRetryDraft.mockRejectedValue(new DraftActionError("draft_not_retryable"));
    await request(makeApp())
      .post(`${base}/retry-send`)
      .send({ confirmedNotDelivered: true })
      .expect(409, { error: "draft_not_retryable" });
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it.each(["prompt_policy_outdated", "follow_up_window_closed", "stale_draft"] as const)(
    "returns 409 %s and never retries",
    async (code) => {
      claimRetryDraft.mockRejectedValue(new DraftActionError(code));
      await request(makeApp())
        .post(`${base}/retry-send`)
        .send({ confirmedNotDelivered: true })
        .expect(409, { error: code });
      expect(sendTrackedText).not.toHaveBeenCalled();
    },
  );

  it("requires AI_SEND_ENABLED", async () => {
    sendFlags.AI_SEND_ENABLED = false;
    await request(makeApp())
      .post(`${base}/retry-send`)
      .send({ confirmedNotDelivered: true })
      .expect(403, { error: "ai_send_disabled" });
    expect(claimRetryDraft).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("does not let an audit write failure create an unhandled owner retry", async () => {
    logEvent.mockRejectedValueOnce(new Error("audit database unavailable"));

    await request(makeApp())
      .post(`${base}/retry-send`)
      .send({ confirmedNotDelivered: true })
      .expect(200, { status: "sent" });
    expect(sendTrackedText).toHaveBeenCalledTimes(1);
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

  it("returns a controlled safe error when dismissal persistence fails", async () => {
    replyDraft.updateMany.mockRejectedValue(new Error("database failure with private body"));
    const res = await request(makeApp()).post(`${base}/dismiss`).expect(500, {
      error: "internal_error",
    });
    expect(JSON.stringify(res.body)).not.toContain("private body");
  });

  it("delegates regeneration to the atomic service", async () => {
    regenerateReplyDraft.mockResolvedValue({ id: "draft-3", status: "queued" });
    await request(makeApp())
      .post(`${base}/regenerate`)
      .expect(202, { draftId: "draft-3", status: "queued" });

    expect(regenerateReplyDraft).toHaveBeenCalledWith({
      threadId: "thread-1",
      draftId: "draft-2",
    });
    expect(replyDraft.findUnique).not.toHaveBeenCalled();
    expect(dmThread.findUnique).not.toHaveBeenCalled();
  });

  it.each(["stale_draft", "prompt_policy_outdated", "follow_up_window_closed"] as const)(
    "returns the atomic service's stable %s rejection",
    async (code) => {
      regenerateReplyDraft.mockRejectedValue(new DraftActionError(code));

      await request(makeApp()).post(`${base}/regenerate`).expect(409, { error: code });
      expect(queueReplyDraft).not.toHaveBeenCalled();
    },
  );

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
    expect(regenerateReplyDraft).not.toHaveBeenCalled();
  });

  it("still queues when the worker is enabled", async () => {
    sendFlags.AI_DRAFTS_ENABLED = true;
    queueReplyDraft.mockResolvedValue({ id: "draft-9", status: "queued" });
    await request(makeApp()).post("/api/ai/dm-threads/thread-1/drafts").expect(202);
    expect(queueReplyDraft).toHaveBeenCalledOnce();
  });
});
