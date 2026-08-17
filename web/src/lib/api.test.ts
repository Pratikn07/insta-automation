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

const { api, TimeoutError } = await import("./api");

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
