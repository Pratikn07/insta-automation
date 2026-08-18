import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getSession = vi.fn(() => new Promise(() => {}));
const refreshSession = vi.fn(() => new Promise(() => {}));

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      // The stall this timeout exists for: a token call that never settles.
      getSession: (...a: unknown[]) => getSession(...(a as [])),
      refreshSession: (...a: unknown[]) => refreshSession(...(a as [])),
    },
  },
}));

const { api, TimeoutError, ApiError, apiErrorCode, apiRead } = (await import(
  "./api"
)) as typeof import("./api") & {
  apiErrorCode: (error: unknown) => string | null;
};

const { RequestTimeoutError } = await import("./requestDeadline");

/** A session that resolves, so a test can reach the fetch call itself. */
function withSession() {
  getSession.mockImplementation(
    () => Promise.resolve({ data: { session: { access_token: "token" } } }) as never,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe("api timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects rather than hanging when a dependency never settles", async () => {
    const call = api("/resources");
    const assertion = expect(call).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it("names the path so the failure is diagnosable", async () => {
    const call = api("/funnels/guide-follow");
    const assertion = expect(call).rejects.toThrow(/funnels\/guide-follow/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it("is still pending before the timeout elapses", async () => {
    let settled = false;
    const call = api("/resources").catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await call;
    expect(settled).toBe(true);
  });
});

// The old timeout raced a promise against fetch. Losing that race rejected the
// caller but left the request running: the browser still held the connection, the
// server still did the work, and a slow response still arrived to nobody. A read
// that has given up has to actually stop.
describe("apiRead aborts the request it gave up on", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSession.mockReset();
    refreshSession.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts the underlying fetch when the deadline elapses", async () => {
    withSession();
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        capturedSignal = init.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }),
    );

    const call = apiRead("/stats");
    const assertion = expect(call).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
    expect(capturedSignal!.reason).toBeInstanceOf(RequestTimeoutError);
  });

  it("passes the caller's cancellation through to fetch and keeps its identity", async () => {
    withSession();
    const caller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );

    const call = apiRead("/stats", { signal: caller.signal });
    const reason = new DOMException("Component unmounted.", "AbortError");
    caller.abort(reason);

    // A cancelled read is not a failed read: it must stay distinguishable from a
    // timeout so retry policy can ignore it.
    await expect(call).rejects.toBe(reason);
    await expect(call).rejects.not.toBeInstanceOf(RequestTimeoutError);
  });

  it("clears its timer once the read succeeds", async () => {
    withSession();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ ok: true }))));

    await expect(apiRead("/stats")).resolves.toEqual({ ok: true });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("honours a caller-supplied deadline", async () => {
    withSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );

    const call = apiRead("/stats", { timeoutMs: 5_000 });
    const assertion = expect(call).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
});

describe("apiErrorCode", () => {
  it("returns a stable server error code without parsing its message", () => {
    const error = new ApiError(
      400,
      { error: "message_body_too_long", limit: 1_000, actual: 1_001 },
      "Message is 1,001 characters; Instagram's limit is 1,000.",
    );

    expect(apiErrorCode(error)).toBe("message_body_too_long");
  });

  it("returns null when an API error does not have a string error code", () => {
    expect(apiErrorCode(new ApiError(400, { error: { fieldErrors: {} } }, "Invalid request"))).toBe(null);
  });
});
