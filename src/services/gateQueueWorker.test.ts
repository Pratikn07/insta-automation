import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gateQueue = {
  updateMany: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
};
const conversation = { findMany: vi.fn(), update: vi.fn() };
const sendTrackedPrivateReply = vi.fn();
const sendTrackedText = vi.fn();
const logEvent = vi.fn();
const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const flags = { experiment: false };

vi.mock("../lib/prisma.js", () => ({ prisma: { gateQueue, conversation } }));
vi.mock("./dmDeliveryService.js", () => ({ sendTrackedPrivateReply, sendTrackedText }));
vi.mock("../services/eventLogger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/eventLogger.js")>();
  return { ...actual, logEvent };
});
vi.mock("../lib/logger.js", () => ({ logger }));
vi.mock("../config/env.js", () => ({
  env: new Proxy(
    { GATE_MAX_ATTEMPTS: 3, GATE_RETRY_BATCH: 5 },
    {
      get(target, property) {
        if (property === "GATE_DM_EXPERIMENT") return flags.experiment;
        return target[property as keyof typeof target];
      },
    },
  ),
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

function graphFailure(): AxiosError {
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
        code: 2,
        error_subcode: 460,
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
  gateMessage: "PRIVATE-DM-SENTINEL",
  attempts: 0,
  commentAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  flags.experiment = false;
  for (const fn of [
    ...Object.values(gateQueue),
    ...Object.values(conversation),
    sendTrackedPrivateReply,
    sendTrackedText,
    logEvent,
    ...Object.values(logger),
  ]) {
    fn.mockReset();
  }
  gateQueue.updateMany.mockResolvedValue({ count: 0 });
  gateQueue.update.mockResolvedValue(row);
  conversation.findMany.mockResolvedValue([]);
  logEvent.mockResolvedValue(undefined);
});

describe("runGateQueueTick Graph failure privacy", () => {
  it("stores only a stable category for a secret-bearing retry failure", async () => {
    gateQueue.findMany.mockResolvedValue([row]);
    sendTrackedPrivateReply.mockRejectedValue(graphFailure());

    await runGateQueueTick();

    expect(gateQueue.update).toHaveBeenCalledWith({
      where: { id: "gate-1" },
      data: {
        attempts: 1,
        lastError: "graph_response",
        nextAttemptAt: expect.any(Date),
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
    gateQueue.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    sendTrackedText.mockRejectedValue(graphFailure());
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
    });
    const captured = JSON.stringify(logEvent.mock.calls);
    for (const sentinel of SENTINELS) expect(captured).not.toContain(sentinel);
  });
});
