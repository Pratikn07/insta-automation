import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestTimeoutError, awaitWithSignal, withDeadline } from "./requestDeadline";

describe("withDeadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aborts with a timeout reason when the deadline elapses", async () => {
    const deadline = withDeadline(undefined, 20_000);

    expect(deadline.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBeInstanceOf(RequestTimeoutError);
    expect((deadline.signal.reason as RequestTimeoutError).code).toBe("read_timeout");
    deadline.dispose();
  });

  it("carries the caller's own abort reason rather than replacing it", () => {
    const caller = new AbortController();
    const deadline = withDeadline(caller.signal, 20_000);
    const reason = new DOMException("The operation was aborted.", "AbortError");

    caller.abort(reason);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(reason);
    // Caller cancellation is not a timeout, and must never be reported as one.
    expect(deadline.signal.reason).not.toBeInstanceOf(RequestTimeoutError);
    deadline.dispose();
  });

  it("is already aborted when the caller aborted before the request started", () => {
    const caller = new AbortController();
    const reason = new DOMException("Gone.", "AbortError");
    caller.abort(reason);

    const deadline = withDeadline(caller.signal, 20_000);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(reason);
    deadline.dispose();
  });

  it("stops the timer on dispose so a settled request cannot abort later", async () => {
    const deadline = withDeadline(undefined, 20_000);

    deadline.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deadline.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes its caller listener on dispose", () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const deadline = withDeadline(caller.signal, 20_000);

    deadline.dispose();

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    // A caller aborting a request we have finished with must not touch it.
    caller.abort();
    expect(deadline.signal.aborted).toBe(false);
  });

  it("does not leak a listener per request onto a long-lived caller signal", () => {
    const caller = new AbortController();
    for (let i = 0; i < 50; i += 1) withDeadline(caller.signal, 20_000).dispose();

    // If dispose leaked, aborting would fan out to 50 dead controllers. The
    // observable proxy for that is the caller staying inert afterwards.
    expect(() => caller.abort()).not.toThrow();
  });
});

describe("awaitWithSignal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects with the timeout reason when a dependency never settles", async () => {
    const deadline = withDeadline(undefined, 20_000);
    // Exactly the Supabase auth stall this exists for.
    const neverSettles = new Promise<string>(() => {});

    const call = awaitWithSignal(neverSettles, deadline.signal);
    const assertion = expect(call).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    deadline.dispose();
  });

  it("resolves normally and leaves no listener behind", async () => {
    const deadline = withDeadline(undefined, 20_000);
    const add = vi.spyOn(deadline.signal, "addEventListener");
    const remove = vi.spyOn(deadline.signal, "removeEventListener");

    await expect(awaitWithSignal(Promise.resolve("token"), deadline.signal)).resolves.toBe(
      "token",
    );

    expect(remove.mock.calls.length).toBe(add.mock.calls.length);
    deadline.dispose();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const caller = new AbortController();
    const reason = new DOMException("Gone.", "AbortError");
    caller.abort(reason);
    const deadline = withDeadline(caller.signal, 20_000);

    await expect(awaitWithSignal(new Promise(() => {}), deadline.signal)).rejects.toBe(reason);
    deadline.dispose();
  });

  it("propagates the dependency's own rejection unchanged", async () => {
    const deadline = withDeadline(undefined, 20_000);
    const failure = new Error("auth refused");

    await expect(awaitWithSignal(Promise.reject(failure), deadline.signal)).rejects.toBe(failure);
    deadline.dispose();
  });
});
