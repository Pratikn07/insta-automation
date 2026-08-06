import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const eventLogCreate = vi.fn();
const loggerError = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { eventLog: { create: eventLogCreate } },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: loggerError },
}));

const { describeGraphError, logEvent } = await import("./eventLogger.js");

const SENTINELS = [
  "PRIVATE-DM-SENTINEL",
  "ACCESS-TOKEN-SENTINEL",
  "https://graph.instagram.com/messages?access_token=ACCESS-TOKEN-SENTINEL",
  "PROVIDER-MESSAGE-SENTINEL",
  "REQUEST-BODY-SENTINEL",
  "ARBITRARY-AXIOS-CODE-SENTINEL",
];

function secretGraphError(): AxiosError {
  const error = new AxiosError(
    `PROVIDER-MESSAGE-SENTINEL PRIVATE-DM-SENTINEL`,
    "ARBITRARY-AXIOS-CODE-SENTINEL",
  );
  error.config = {
    headers: {} as never,
    url: SENTINELS[2],
    data: JSON.stringify({
      message: { text: "PRIVATE-DM-SENTINEL" },
      marker: "REQUEST-BODY-SENTINEL",
    }),
  };
  error.response = {
    status: 400,
    statusText: "Bad Request",
    headers: {},
    config: error.config,
    data: {
      error: {
        code: 100,
        error_subcode: 2534025,
        message: "PROVIDER-MESSAGE-SENTINEL",
        fbtrace_id: "trace_SAFE-123",
      },
    },
  };
  return error;
}

beforeEach(() => {
  eventLogCreate.mockReset().mockResolvedValue({ id: "event-1" });
  loggerError.mockReset();
});

describe("describeGraphError", () => {
  it("returns an exact closed allowlist and drops every private provider/request field", () => {
    const described = describeGraphError(secretGraphError());

    expect(described).toEqual({
      category: "graph_response",
      httpStatus: 400,
      graphCode: 100,
      graphSubcode: 2534025,
      traceId: "trace_SAFE-123",
    });
    const captured = JSON.stringify(described);
    for (const sentinel of SENTINELS) expect(captured).not.toContain(sentinel);
  });

  it("uses only stable null metadata for unknown raw errors", () => {
    const described = describeGraphError(
      new Error("PROVIDER-MESSAGE-SENTINEL PRIVATE-DM-SENTINEL"),
    );
    expect(described).toEqual({
      category: "unknown_error",
      httpStatus: null,
      graphCode: null,
      graphSubcode: null,
      traceId: null,
    });
    expect(JSON.stringify(described)).not.toContain("SENTINEL");
  });

  it("rejects a trace value outside the bounded safe identifier grammar", () => {
    const error = secretGraphError();
    (error.response!.data as { error: { fbtrace_id: string } }).error.fbtrace_id =
      "PROVIDER-MESSAGE-SENTINEL with spaces";
    expect(describeGraphError(error)).toMatchObject({ traceId: null });
  });
});

describe("logEvent fallback", () => {
  it("never logs the raw database error or event payload", async () => {
    eventLogCreate.mockRejectedValue(
      new Error("PRIVATE-DM-SENTINEL ACCESS-TOKEN-SENTINEL"),
    );

    await expect(
      logEvent("dm_failed", { body: "REQUEST-BODY-SENTINEL" }),
    ).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      { errorCode: "event_log_write_failed", kind: "dm_failed" },
      "Failed to write eventLog",
    );
    const captured = JSON.stringify(loggerError.mock.calls);
    for (const sentinel of SENTINELS) expect(captured).not.toContain(sentinel);
  });
});
