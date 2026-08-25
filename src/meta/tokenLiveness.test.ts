import { AxiosError, AxiosHeaders } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  graphGet: vi.fn(),
  logEvent: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock("./graphClient.js", () => ({ graph: { get: mocks.graphGet } }));
// eventLogger's graphErrorIsAuthFailure is the real classifier — the point of this
// module is that a 190 is recognised, so let it run rather than stubbing it out.
vi.mock("../services/eventLogger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/eventLogger.js")>();
  return { ...actual, logEvent: mocks.logEvent };
});
vi.mock("../lib/logger.js", () => ({
  logger: { error: mocks.loggerError, debug: mocks.loggerDebug },
}));

const { probeTokenLiveness } = await import("./tokenLiveness.js");

function graphError(code: number, message = "graph failure"): AxiosError {
  const config = { params: { access_token: "meta-token-secret" }, headers: new AxiosHeaders() };
  return new AxiosError(message, "ERR_BAD_REQUEST", config as never, undefined, {
    status: 400,
    statusText: "Bad Request",
    headers: new AxiosHeaders(),
    config: config as never,
    data: { error: { code, message } },
  });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});

describe("probeTokenLiveness", () => {
  it("reports live and raises no alarm when Meta answers /me", async () => {
    mocks.graphGet.mockResolvedValue({ data: { id: "17841400000000000" } });

    await expect(probeTokenLiveness()).resolves.toBe("live");
    expect(mocks.graphGet).toHaveBeenCalledWith("/me", { params: { fields: "id" } });
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("records ig_token_invalidated and errors on a Graph 190", async () => {
    mocks.graphGet.mockRejectedValue(
      graphError(190, "Error validating access token: the session has been invalidated"),
    );

    await expect(probeTokenLiveness()).resolves.toBe("invalidated");
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "ig_token_invalidated",
      expect.objectContaining({ source: "liveness_probe", graphCode: 190 }),
    );
    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it("does not leak the token or provider prose on a credential failure", async () => {
    mocks.graphGet.mockRejectedValue(
      graphError(190, "Error validating access token: the session has been invalidated"),
    );

    await probeTokenLiveness();

    const captured = JSON.stringify([...mocks.logEvent.mock.calls, ...mocks.loggerError.mock.calls]);
    expect(captured).not.toContain("meta-token-secret");
    expect(captured).not.toContain("the session has been invalidated");
  });

  it("treats a transient non-credential error as unknown, with no alarm", async () => {
    mocks.graphGet.mockRejectedValue(graphError(100, "temporary problem"));

    await expect(probeTokenLiveness()).resolves.toBe("unknown");
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(mocks.loggerError).not.toHaveBeenCalled();
    expect(mocks.loggerDebug).toHaveBeenCalled();
  });

  it("treats a transport error as unknown, not a credential failure", async () => {
    mocks.graphGet.mockRejectedValue(new AxiosError("socket hang up", "ECONNRESET"));

    await expect(probeTokenLiveness()).resolves.toBe("unknown");
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
