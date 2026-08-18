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

const { api, TimeoutError, ApiError, apiErrorCode, apiRead, apiMutation } = (await import(
  "./api"
)) as typeof import("./api") & {
  apiErrorCode: (error: unknown) => string | null;
};

const { RequestTimeoutError } = await import("./requestDeadline");
const { MutationNotDispatchedError, MutationOutcomeUnknownError } = await import(
  "./mutationOutcome"
);

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

// A read that fails can be repeated. A mutation that fails can only be repeated
// if you know it did not happen — and the moment fetch is called, you no longer
// know. So the one thing this client must get right is *when* the request left
// the browser, because that is the line between "safe to repeat" and "ask".
describe("apiMutation dispatch phase", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSession.mockReset();
    refreshSession.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports a pre-dispatch auth stall as definitely not dispatched", async () => {
    // Never settles: exactly the Supabase stall, and it happens before fetch.
    getSession.mockImplementation(() => new Promise(() => {}));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const call = apiMutation("/keywords", { method: "POST" });
    const assertion = expect(call).rejects.toBeInstanceOf(MutationNotDispatchedError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    // The claim has to be true: nothing was sent.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a timeout after dispatch as unknown, not as a timeout", async () => {
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

    const call = apiMutation("/keywords", { method: "POST", operationId: "op-1" });
    const assertion = expect(call).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    await expect(call).rejects.not.toBeInstanceOf(RequestTimeoutError);
  });

  it("reports a caller abort after dispatch as unknown", async () => {
    withSession();
    const caller = new AbortController();
    let fetchEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      fetchEntered = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        fetchEntered();
        // Real fetch rejects at once for an already-aborted signal, and only
        // later for one aborted mid-flight. Model both.
        if (init.signal?.aborted) return Promise.reject(init.signal.reason);
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }),
    );

    const call = apiMutation("/keywords", { method: "POST", signal: caller.signal });
    // Abort strictly after the request is in flight, which is the case that makes
    // the outcome genuinely unknowable.
    await entered;
    caller.abort(new DOMException("Unmounted.", "AbortError"));

    // Unmounting the component does not un-send the request.
    await expect(call).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
  });

  it("reports a network failure after dispatch as unknown", async () => {
    withSession();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));

    await expect(apiMutation("/keywords", { method: "POST" })).rejects.toBeInstanceOf(
      MutationOutcomeUnknownError,
    );
  });

  it("reports any post-dispatch 5xx as unknown", async () => {
    withSession();
    // A 502 from a proxy says nothing about whether the route ran behind it.
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ error: "bad_gateway" }, 502)));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(apiMutation("/keywords", { method: "POST" })).rejects.toBeInstanceOf(
      MutationOutcomeUnknownError,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps a definite 4xx a definite failure", async () => {
    withSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ error: "idempotency_conflict" }, 409))),
    );

    const call = apiMutation("/keywords", { method: "POST" });
    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(call).rejects.not.toBeInstanceOf(MutationOutcomeUnknownError);
    await expect(call).rejects.toMatchObject({ status: 409 });
  });

  it("never dispatches a second time on its own", async () => {
    withSession();
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(apiMutation("/keywords", { method: "POST" })).rejects.toBeInstanceOf(
      MutationOutcomeUnknownError,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends an Idempotency-Key only when the operation has an ID", async () => {
    withSession();
    const fetchSpy = vi.fn((url: string, init: RequestInit) => {
      void url;
      void init;
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchSpy);

    await apiMutation("/keywords", { method: "POST", operationId: "op-7" });
    await apiMutation("/keywords", { method: "POST" });

    const keyed = new Headers(fetchSpy.mock.calls[0][1].headers);
    const unkeyed = new Headers(fetchSpy.mock.calls[1][1].headers);
    expect(keyed.get("idempotency-key")).toBe("op-7");
    expect(unkeyed.has("idempotency-key")).toBe(false);
  });

  it("retries once after refreshing a rejected session, because 401 proves nothing ran", async () => {
    getSession.mockImplementation(
      () => Promise.resolve({ data: { session: { access_token: "stale" } } }) as never,
    );
    refreshSession.mockImplementation(
      () => Promise.resolve({ data: { session: { access_token: "fresh" } }, error: null }) as never,
    );
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(apiMutation("/keywords", { method: "POST" })).resolves.toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchSpy.mock.calls[1][1].headers).get("authorization")).toBe(
      "Bearer fresh",
    );
  });

  it("does not refresh-retry a 5xx", async () => {
    withSession();
    refreshSession.mockImplementation(
      () => Promise.resolve({ data: { session: { access_token: "fresh" } }, error: null }) as never,
    );
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ error: "boom" }, 500)));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(apiMutation("/keywords", { method: "POST" })).rejects.toBeInstanceOf(
      MutationOutcomeUnknownError,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("returns the parsed body on success and treats 204 as empty", async () => {
    withSession();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ id: "k-1" }, 201))));
    await expect(apiMutation("/keywords", { method: "POST" })).resolves.toEqual({ id: "k-1" });

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          status: 204,
          ok: true,
          headers: new Headers(),
        } as unknown as Response),
      ),
    );
    await expect(apiMutation("/keywords/1", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("refuses to be used for a read", async () => {
    withSession();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ ok: true }))));

    await expect(
      apiMutation("/stats", { method: "GET" } as unknown as { method: "POST" }),
    ).rejects.toThrow(/GET/);
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
