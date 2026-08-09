import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gateQueue = {
  updateMany: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
};
const conversation = { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() };
const sendTrackedPrivateReply = vi.fn();
const sendTrackedText = vi.fn();
const logEvent = vi.fn();
const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const flags = { experiment: false };

const scheduleAcceptedGateRecovery = vi.fn();
const scheduleSettingsBlockedRecovery = vi.fn();
const scheduleTrackingUnavailableRecovery = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: { gateQueue, conversation } }));
vi.mock("./dmDeliveryService.js", () => ({ sendTrackedPrivateReply, sendTrackedText }));
vi.mock("../services/eventLogger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/eventLogger.js")>();
  return { ...actual, logEvent };
});
vi.mock("../lib/logger.js", () => ({ logger }));
vi.mock("../config/env.js", () => ({
  env: new Proxy(
    {
      GATE_MAX_ATTEMPTS: 3,
      GATE_RETRY_BATCH: 5,
      DM_RECOVERY_LEASE_MS: 900000,
      DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES: "10:12345",
    },
    {
      get(target, property) {
        if (property === "GATE_DM_EXPERIMENT") return flags.experiment;
        return target[property as keyof typeof target];
      },
    },
  ),
}));
vi.mock("./dmRecoveryService.js", () => ({
  scheduleAcceptedGateRecovery,
  scheduleSettingsBlockedRecovery,
  scheduleTrackingUnavailableRecovery,
}));

const { runGateQueueTick } = await import("./gateQueueWorker.js");

const SENTINELS = [
  "PRIVATE-DM-SENTINEL",
  "ACCESS-TOKEN-SENTINEL",
  "https://graph.instagram.com/messages?access_token=ACCESS-TOKEN-SENTINEL",
  "PROVIDER-MESSAGE-SENTINEL",
  "REQUEST-BODY-SENTINEL",
  "ARBITRARY-AXIOS-CODE-SENTINEL",
];

function graphFailure(code = 100, subcode = 2534025): AxiosError {
  const error = new AxiosError(
    "PROVIDER-MESSAGE-SENTINEL PRIVATE-DM-SENTINEL",
    "ARBITRARY-AXIOS-CODE-SENTINEL",
  );
  error.config = {
    headers: {} as never,
    url: SENTINELS[2],
    data: "REQUEST-BODY-SENTINEL PRIVATE-DM-SENTINEL",
  };
  error.response = {
    status: 500,
    statusText: "Server Error",
    headers: {},
    config: error.config,
    data: {
      error: {
        code,
        error_subcode: subcode,
        message: "PROVIDER-MESSAGE-SENTINEL",
        fbtrace_id: "trace_GATE-1",
      },
    },
  };
  return error;
}

const row = {
  id: "gate-1",
  conversationId: "conversation-1",
  igUserId: "ig-user-1",
  commentId: "comment-1",
  mediaId: "media-1",
  gateMessage: "PRIVATE-DM-SENTINEL",
  attempts: 0,
  commentAt: new Date(),
  updatedAt: new Date(),
};

const convoObj = {
  id: "conversation-1",
  state: "awaiting_gate",
  keywordId: "keyword-1",
  keyword: { id: "keyword-1", keyword: "SLEEP" },
};

beforeEach(() => {
  flags.experiment = false;
  for (const fn of [
    ...Object.values(gateQueue),
    ...Object.values(conversation),
    sendTrackedPrivateReply,
    sendTrackedText,
    logEvent,
    scheduleAcceptedGateRecovery,
    scheduleSettingsBlockedRecovery,
    scheduleTrackingUnavailableRecovery,
    ...Object.values(logger),
  ]) {
    fn.mockReset();
  }
  gateQueue.findMany.mockImplementation(async (args?: { where?: { status?: string } }) => {
    if (args?.where?.status === "sending") return [];
    if (args?.where?.status === "pending") return [row];
    return [];
  });
  gateQueue.updateMany.mockResolvedValue({ count: 1 });
  gateQueue.update.mockResolvedValue(row);
  conversation.findMany.mockResolvedValue([convoObj]);
  conversation.findUnique.mockResolvedValue(convoObj);
  logEvent.mockResolvedValue(undefined);
  scheduleAcceptedGateRecovery.mockResolvedValue({ id: "rec-1", status: "waiting" });
  scheduleSettingsBlockedRecovery.mockResolvedValue({ id: "rec-2", status: "waiting" });
  scheduleTrackingUnavailableRecovery.mockResolvedValue({ id: "rec-3", status: "tracking_unavailable" });
});

describe("runGateQueueTick Graph failure privacy", () => {
  it("stores only a stable category for a secret-bearing retry failure", async () => {
    sendTrackedPrivateReply.mockRejectedValue(graphFailure());

    await runGateQueueTick();

    // An HTTP 500 leaves the send outcome unknown, so the row is parked for
    // review rather than retried — a retry could deliver the gate DM twice.
    // It previously scheduled a retry only because subcode 2534025 was matched
    // bare as a rate limit.
    expect(gateQueue.update).toHaveBeenCalledWith({
      where: { id: "gate-1" },
      data: {
        status: "send_uncertain",
        attempts: 1,
        lastError: "graph_response",
      },
    });
    const captured = JSON.stringify({
      persistence: gateQueue.update.mock.calls,
      logs: logger.error.mock.calls,
      events: logEvent.mock.calls,
    });
    for (const sentinel of SENTINELS) expect(captured).not.toContain(sentinel);
  });

  it("writes only the safe descriptor for the experiment EventLog caller", async () => {
    flags.experiment = true;
    gateQueue.findMany.mockImplementation(async (args?: { where?: { status?: string } }) => {
      if (args?.where?.status === "sending") return [];
      if (args?.where?.status === "pending") return [];
      if (args?.where?.status === "exhausted") return [row];
      return [];
    });
    sendTrackedText.mockRejectedValue(graphFailure(2, 460));
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      if (typeof callback === "function") callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    try {
      await runGateQueueTick();
    } finally {
      timeout.mockRestore();
    }

    expect(logEvent).toHaveBeenCalledWith("gate_dm_experiment_failed", {
      conversationId: "conversation-1",
      igUserId: "ig-user-1",
      category: "graph_response",
      httpStatus: 500,
      graphCode: 2,
      graphSubcode: 460,
      traceId: "trace_GATE-1",
      transportCode: null,
    });
    const captured = JSON.stringify(logEvent.mock.calls);
    for (const sentinel of SENTINELS) expect(captured).not.toContain(sentinel);
  });
});

describe("runGateQueueTick batch pacing", () => {
  // Subcode 2534025 is "comment invalid for a private reply" — permanent for
  // that one comment. Treating it as a rate limit aborted the whole remaining
  // batch, so a single deleted or expired comment starved every other queued
  // gate DM in the tick.
  it("keeps draining the batch after one comment is permanently invalid", async () => {
    const second = { ...row, id: "gate-2", commentId: "comment-2" };
    gateQueue.findMany.mockImplementation(async (args?: { where?: { status?: string } }) => {
      if (args?.where?.status === "sending") return [];
      if (args?.where?.status === "pending") return [row, second];
      return [];
    });
    conversation.findMany.mockResolvedValue([
      { ...convoObj, id: "conversation-1" },
    ]);
    sendTrackedPrivateReply
      .mockRejectedValueOnce(graphFailure(100, 2534025))
      .mockResolvedValueOnce({
        instagramMessageId: "mid-2",
        dmMessageId: "dm-2",
        acceptedAt: new Date(),
      });

    await runGateQueueTick();

    expect(sendTrackedPrivateReply).toHaveBeenCalledTimes(2);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Gate retry hit rate limit — backing off for this tick",
    );
  });
});

describe("runGateQueueTick Recovery Scheduling (Task 7)", () => {
  it("schedules accepted-DM recovery after a queued send succeeds", async () => {
    const acceptedAt = new Date("2026-08-06T08:00:00Z");
    gateQueue.findMany.mockResolvedValue([row]);
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-1",
      dmMessageId: "dm-1",
      acceptedAt,
    });

    await runGateQueueTick();

    expect(scheduleAcceptedGateRecovery).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      igUserId: "ig-user-1",
      keywordId: "keyword-1",
      keywordSnapshot: "SLEEP",
      commentId: "comment-1",
      mediaId: "media-1",
      gateDmMessageId: "dm-1",
      instagramGateMessageId: "mid-1",
      acceptedAt,
    });
    expect(gateQueue.update).toHaveBeenCalledWith({
      where: { id: "gate-1" },
      data: { status: "sent", attempts: 1, lastError: null },
    });
  });

  it("creates an immediate settings recovery candidate for allowlisted settings rejection", async () => {
    gateQueue.findMany.mockResolvedValue([row]);
    sendTrackedPrivateReply.mockRejectedValue(graphFailure(10, 12345));

    await runGateQueueTick();

    expect(gateQueue.update).toHaveBeenCalledWith({
      where: { id: "gate-1" },
      data: { status: "abandoned", attempts: 1, lastError: "settings_blocked" },
    });
    expect(scheduleSettingsBlockedRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        commentId: "comment-1",
        mediaId: "media-1",
      }),
    );
  });
});

describe("runGateQueueTick claim safety (Task 7)", () => {
  // The plan pins nextAttemptAt into the compare-and-set. Ticks are not guarded
  // against overlapping (5 min interval, no running flag), so a row this tick
  // just pushed into backoff is still `pending` and would otherwise be
  // re-claimed and sent immediately by an overlapping tick, bypassing the
  // backoff entirely.
  it("will not claim a row whose backoff has been pushed into the future", async () => {
    gateQueue.findMany.mockImplementation(async (args?: { where?: { status?: string } }) => {
      if (args?.where?.status === "sending") return [];
      if (args?.where?.status === "pending") return [row];
      return [];
    });
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-1",
      dmMessageId: "dm-1",
      acceptedAt: new Date(),
    });

    await runGateQueueTick();

    const claim = gateQueue.updateMany.mock.calls.find(
      ([args]) => args?.data?.status === "sending",
    );
    expect(claim).toBeDefined();
    expect(claim![0].where).toMatchObject({
      id: "gate-1",
      status: "pending",
      nextAttemptAt: { lte: expect.any(Date) },
    });
  });

  it("skips an item another worker already claimed", async () => {
    gateQueue.findMany.mockImplementation(async (args?: { where?: { status?: string } }) => {
      if (args?.where?.status === "sending") return [];
      if (args?.where?.status === "pending") return [row];
      return [];
    });
    // The compare-and-set matched nothing: someone else won the claim.
    gateQueue.updateMany.mockResolvedValue({ count: 0 });

    await runGateQueueTick();

    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
  });

  // Retrying a revoked or expired token cannot succeed. It burns the attempt
  // budget on every queued row and delays the operator noticing the outage.
  it("retires an auth failure instead of retrying it", async () => {
    gateQueue.findMany.mockImplementation(async (args?: { where?: { status?: string } }) => {
      if (args?.where?.status === "sending") return [];
      if (args?.where?.status === "pending") return [row];
      return [];
    });
    sendTrackedPrivateReply.mockRejectedValue(graphFailure(190, 460));

    await runGateQueueTick();

    const finalise = gateQueue.update.mock.calls.at(-1)![0];
    expect(finalise.data.status).toBe("exhausted");
    expect(finalise.data).not.toHaveProperty("nextAttemptAt");
    expect(scheduleSettingsBlockedRecovery).not.toHaveBeenCalled();
  });
});

describe("runGateQueueTick early batch stop", () => {
  // The batch is claimed up front. An early stop used to strand the untouched
  // rows in `sending` until their lease expired, at which point reconciliation
  // labelled them send_uncertain — rows that were never attempted at all.
  it("releases rows it claimed but never attempted", async () => {
    const second = { ...row, id: "gate-2", commentId: "comment-2" };
    gateQueue.findMany.mockImplementation(async (args?: { where?: { status?: string } }) => {
      if (args?.where?.status === "sending") return [];
      if (args?.where?.status === "pending") return [row, second];
      return [];
    });
    // A genuine rate limit stops the tick after the first row.
    sendTrackedPrivateReply.mockRejectedValue(graphFailure(4, 0));

    await runGateQueueTick();

    expect(gateQueue.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["gate-2"] }, status: "sending" },
      data: { status: "pending", claimedAt: null, claimExpiresAt: null },
    });
  });

  // The release used to sit inside the try, so a throw from the conversation
  // load skipped it and stranded the whole claimed batch in `sending`. The lease
  // then expired, reconciliation marked every row send_uncertain, and each got a
  // recovery row asserting the DM may have been delivered — to people who were
  // never messaged.
  it("releases the whole batch when loading conversations throws", async () => {
    const second = { ...row, id: "gate-2", commentId: "comment-2" };
    gateQueue.findMany.mockImplementation(async (args?: { where?: { status?: string } }) => {
      if (args?.where?.status === "sending") return [];
      if (args?.where?.status === "pending") return [row, second];
      return [];
    });
    conversation.findMany.mockRejectedValue(new Error("connection terminated"));

    await runGateQueueTick();

    expect(gateQueue.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["gate-1", "gate-2"] }, status: "sending" },
      data: { status: "pending", claimedAt: null, claimExpiresAt: null },
    });
    // Nothing was attempted, so no row may be recorded as maybe-delivered.
    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
    expect(scheduleTrackingUnavailableRecovery).not.toHaveBeenCalled();
  });

  it("still reports the tick failure after releasing", async () => {
    gateQueue.findMany.mockImplementation(async (args?: { where?: { status?: string } }) => {
      if (args?.where?.status === "sending") return [];
      if (args?.where?.status === "pending") return [row];
      return [];
    });
    conversation.findMany.mockRejectedValue(new Error("connection terminated"));

    await expect(runGateQueueTick()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});

// QA-05. After reconciliation a superseded ALIAS conversation can still read
// awaiting_done while the request it belongs to was satisfied through a sibling
// journey. Delivering here would gate somebody who already has the guide.
describe("canonical intent completion", () => {
  it("abandons a gate whose canonical intent completed elsewhere", async () => {
    gateQueue.findMany.mockResolvedValue([row]);
    gateQueue.updateMany.mockResolvedValue({ count: 1 });
    conversation.findMany.mockResolvedValue([
      {
        ...convoObj,
        // Its OWN state still looks sendable...
        state: "awaiting_done",
        // ...but the request was satisfied through a sibling journey.
        canonicalIntent: { completedAt: new Date() },
      },
    ]);

    await runGateQueueTick();

    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
    expect(gateQueue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "abandoned",
          // Named distinctly from conversation_completed so an operator can tell the
          // alias case from an ordinary completion.
          lastError: "intent_completed_elsewhere",
        }),
      }),
    );
  });

  it("abandons an alias gate even when the intent is open", async () => {
    gateQueue.findMany.mockResolvedValue([row]);
    gateQueue.updateMany.mockResolvedValue({ count: 1 });
    conversation.findMany.mockResolvedValue([
      {
        ...convoObj,
        state: "awaiting_done",
        canonicalIntentId: "intent-1",
        canonicalIntent: {
          completedAt: null,
          canonicalConversationId: "canonical-conversation",
        },
      },
    ]);

    await runGateQueueTick();

    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
    expect(gateQueue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "abandoned", lastError: "reconciled_alias" }),
      }),
    );
  });

  it("still delivers for the canonical owner while the intent is open", async () => {
    conversation.findMany.mockResolvedValue([
      {
        ...convoObj,
        canonicalIntentId: "intent-1",
        canonicalIntent: {
          completedAt: null,
          canonicalConversationId: convoObj.id,
        },
      },
    ]);
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-1",
      dmMessageId: "dm-1",
      acceptedAt: new Date(),
    });

    await runGateQueueTick();

    expect(sendTrackedPrivateReply).toHaveBeenCalled();
  });

  // A conversation with no intent at all (pre-reconciliation history) must still work.
  it("still delivers when there is no intent", async () => {
    gateQueue.findMany.mockResolvedValue([row]);
    gateQueue.updateMany.mockResolvedValue({ count: 1 });
    conversation.findMany.mockResolvedValue([
      { ...convoObj, state: "awaiting_done", canonicalIntent: null },
    ]);

    await runGateQueueTick();

    expect(sendTrackedPrivateReply).toHaveBeenCalled();
  });
});
