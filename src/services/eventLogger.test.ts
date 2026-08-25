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

const { describeGraphError, graphErrorIsAuthFailure, logEvent } = await import("./eventLogger.js");

function graphErrorWithCode(code: number): AxiosError {
  const error = new AxiosError("graph failure", "ERR_BAD_REQUEST");
  error.config = { headers: {} as never };
  error.response = {
    status: 400,
    statusText: "Bad Request",
    headers: {},
    config: error.config,
    data: { error: { code } },
  };
  return error;
}

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
      // err.code is caller-controlled, so an unrecognised value is dropped
      // rather than echoed into the event log.
      transportCode: null,
    });
    const captured = JSON.stringify(described);
    for (const sentinel of SENTINELS) expect(captured).not.toContain(sentinel);
  });

  it("surfaces a known transport code but drops an arbitrary one", () => {
    const known = describeGraphError(
      new AxiosError("network", "ECONNREFUSED", { headers: {} as never }, {}),
    );
    expect(known).toMatchObject({
      category: "graph_transport",
      transportCode: "ECONNREFUSED",
    });

    const arbitrary = describeGraphError(
      new AxiosError("network", "ARBITRARY-AXIOS-CODE-SENTINEL", { headers: {} as never }, {}),
    );
    expect(arbitrary.transportCode).toBeNull();
    expect(JSON.stringify(arbitrary)).not.toContain("ARBITRARY-AXIOS-CODE-SENTINEL");
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
      transportCode: null,
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

describe("graphErrorIsAuthFailure", () => {
  it.each([190, 10, 200, 299])("treats Graph code %s as a credential failure", (code) => {
    expect(graphErrorIsAuthFailure(graphErrorWithCode(code))).toBe(true);
  });

  it.each([100, 4, 613, 199, 300])("treats Graph code %s as a non-credential failure", (code) => {
    expect(graphErrorIsAuthFailure(graphErrorWithCode(code))).toBe(false);
  });

  it("treats a transport error with no provider code as a non-credential failure", () => {
    expect(
      graphErrorIsAuthFailure(new AxiosError("socket hang up", "ECONNRESET")),
    ).toBe(false);
  });

  it("treats a non-Graph error as a non-credential failure", () => {
    expect(graphErrorIsAuthFailure(new Error("nope"))).toBe(false);
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
