import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  getAccessToken: vi.fn(() => "ACCESS-TOKEN-SENTINEL"),
  persistRefreshedToken: vi.fn(),
  readTokenTiming: vi.fn(),
  logEvent: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      get: mocks.axiosGet,
      isAxiosError: actual.isAxiosError,
    },
  };
});
vi.mock("./tokenStore.js", () => ({
  getAccessToken: mocks.getAccessToken,
  persistRefreshedToken: mocks.persistRefreshedToken,
  readTokenTiming: mocks.readTokenTiming,
}));
vi.mock("../services/eventLogger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/eventLogger.js")>();
  return { ...actual, logEvent: mocks.logEvent };
});
vi.mock("../lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
    warn: mocks.loggerWarn,
    info: mocks.loggerInfo,
  },
}));

const { classifyRefreshOutcome, expiryFromExpiresIn, runTokenRefreshTick } = await import(
  "./tokenRefresher.js"
);

// The DB/HTTP wiring of runTokenRefreshTick is covered by the live smoke test in
// TK4's verification (it needs a real ig_token row and a real Meta call). What is
// unit-testable — and what actually encodes the hard-won knowledge — is how a
// Meta response gets classified and how expiry is computed from it.

describe("expiryFromExpiresIn", () => {
  const NOW = Date.parse("2026-07-27T03:00:00.000Z");

  it("converts Meta's seconds into an absolute expiry", () => {
    // Meta's real sample value: 5183944s ≈ 59.99 days.
    const exp = expiryFromExpiresIn(5_183_944, NOW);
    const days = (exp.getTime() - NOW) / 86_400_000;
    expect(Math.round(days)).toBe(60);
  });

  it("falls back to 60 days when Meta omits expires_in", () => {
    // Defensive: a missing expires_in must not produce an Invalid Date that
    // silently poisons the health readout.
    const exp = expiryFromExpiresIn(undefined, NOW);
    expect(Math.round((exp.getTime() - NOW) / 86_400_000)).toBe(60);
  });

  it("ignores a nonsensical zero or negative expires_in", () => {
    // A 0 would mark the token instantly expired and trip the alarm for no
    // reason; treat it as unknown instead.
    expect(expiryFromExpiresIn(0, NOW).getTime()).toBeGreaterThan(NOW);
    expect(expiryFromExpiresIn(-5, NOW).getTime()).toBeGreaterThan(NOW);
  });
});

describe("classifyRefreshOutcome", () => {
  function graphError(message: string, code = 190) {
    return {
      isAxiosError: true,
      response: { data: { error: { message, code, type: "OAuthException" } } },
    };
  }

  it("treats Meta's under-24h complaint as benign, not an alarm", () => {
    // Every freshly minted token spends its first day in this state. Logging it
    // as an error would cry wolf once every 6h for a whole day after each
    // manual re-mint.
    const o = classifyRefreshOutcome(
      graphError("The token must be at least 24 hours old to be refreshed"),
    );
    expect(o.kind).toBe("too_young");
    expect(o.alarming).toBe(false);
  });

  it("flags an expired session as alarming — this is the state we must never reach", () => {
    const o = classifyRefreshOutcome(
      graphError("Error validating access token: Session has expired on Sunday, 26-Jul-26"),
    );
    expect(o.kind).toBe("expired");
    expect(o.alarming).toBe(true);
  });

  it("flags an invalidated session (password change) as alarming and distinct", () => {
    // Seen for real: after re-minting, the OLD token reported "session has been
    // invalidated" rather than "expired". Different cause, same required action.
    const o = classifyRefreshOutcome(
      graphError("The session has been invalidated because the user changed their password"),
    );
    expect(o.kind).toBe("invalidated");
    expect(o.alarming).toBe(true);
  });

  it("treats an unrecognised failure as alarming rather than assuming it is fine", () => {
    const o = classifyRefreshOutcome(graphError("Something entirely new", 4));
    expect(o.kind).toBe("unknown");
    expect(o.alarming).toBe(true);
  });

  it("handles a non-Graph failure (timeout, DNS) without throwing", () => {
    const o = classifyRefreshOutcome(new Error("ETIMEDOUT"));
    expect(o.kind).toBe("unknown");
    expect(o.alarming).toBe(true);
    expect(o).not.toHaveProperty("message");
  });
});

describe("runTokenRefreshTick privacy", () => {
  const NOW = new Date("2026-08-05T12:00:00.000Z");
  const sentinels = [
    "PRIVATE-DM-SENTINEL",
    "ACCESS-TOKEN-SENTINEL",
    "https://graph.instagram.com/refresh_access_token?access_token=ACCESS-TOKEN-SENTINEL",
    "PROVIDER-MESSAGE-SENTINEL",
    "REQUEST-BODY-SENTINEL",
    "ARBITRARY-AXIOS-CODE-SENTINEL",
  ];

  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.getAccessToken.mockReturnValue("ACCESS-TOKEN-SENTINEL");
    mocks.readTokenTiming.mockResolvedValue({
      refreshedAt: new Date("2026-07-01T00:00:00.000Z"),
      expiresAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    mocks.logEvent.mockResolvedValue(undefined);
  });

  it("persists and logs only the closed Graph descriptor on refresh failure", async () => {
    const error = new AxiosError(
      "Session has expired — PROVIDER-MESSAGE-SENTINEL PRIVATE-DM-SENTINEL",
      "ARBITRARY-AXIOS-CODE-SENTINEL",
    );
    error.config = {
      headers: {} as never,
      url: sentinels[2],
      data: "REQUEST-BODY-SENTINEL",
    };
    error.response = {
      status: 400,
      statusText: "Bad Request",
      headers: {},
      config: error.config,
      data: {
        error: {
          code: 190,
          error_subcode: 463,
          message: "Session has expired — PROVIDER-MESSAGE-SENTINEL",
          fbtrace_id: "trace_REFRESH-1",
        },
      },
    };
    mocks.axiosGet.mockRejectedValue(error);

    await runTokenRefreshTick(NOW);

    const safe = {
      kind: "expired",
      category: "graph_response",
      httpStatus: 400,
      graphCode: 190,
      graphSubcode: 463,
      traceId: "trace_REFRESH-1",
      transportCode: null,
    };
    expect(mocks.loggerError).toHaveBeenCalledWith(safe, "ig token refresh failed");
    expect(mocks.logEvent).toHaveBeenCalledWith("ig_token_refresh_failed", safe);
    const captured = JSON.stringify({
      logs: mocks.loggerError.mock.calls,
      events: mocks.logEvent.mock.calls,
    });
    for (const sentinel of sentinels) expect(captured).not.toContain(sentinel);
  });

  it("does not log a secret-bearing 200 response that omitted access_token", async () => {
    mocks.axiosGet.mockResolvedValue({
      data: {
        marker: "REQUEST-BODY-SENTINEL",
        providerMessage: "PROVIDER-MESSAGE-SENTINEL",
      },
    });

    await runTokenRefreshTick(NOW);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      { errorCode: "token_refresh_missing_access_token" },
      "token refresh returned no access_token",
    );
    expect(mocks.logEvent).toHaveBeenCalledWith("ig_token_refresh_failed", {
      reason: "no_access_token",
    });
    const captured = JSON.stringify(mocks.loggerError.mock.calls);
    for (const sentinel of sentinels) expect(captured).not.toContain(sentinel);
  });
});

describe("vitest sanity", () => {
  it("does not leak mocks between files", () => {
    expect(vi.isMockFunction(console.log)).toBe(false);
  });
});
