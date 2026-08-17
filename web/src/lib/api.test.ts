import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      // The stall this timeout exists for: a token call that never settles.
      getSession: vi.fn(() => new Promise(() => {})),
      refreshSession: vi.fn(() => new Promise(() => {})),
    },
  },
}));

const { api, TimeoutError, ApiError, apiErrorCode } = (await import("./api")) as typeof import("./api") & {
  apiErrorCode: (error: unknown) => string | null;
};

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
