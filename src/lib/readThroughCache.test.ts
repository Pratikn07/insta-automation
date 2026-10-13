import { describe, expect, it, vi } from "vitest";
import { createReadThroughCache } from "./readThroughCache.js";

/**
 * A fake clock, because a TTL asserted with real timers is a test that either
 * sleeps or flakes.
 */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createReadThroughCache", () => {
  it("computes on a miss and returns the loaded value", async () => {
    const cache = createReadThroughCache<number>({ ttlMs: 1000 });
    const load = vi.fn().mockResolvedValue(7);

    await expect(cache.get("k", load)).resolves.toBe(7);
    expect(load).toHaveBeenCalledOnce();
  });

  it("serves a second read inside the TTL without touching the loader", async () => {
    const clock = fakeClock();
    const cache = createReadThroughCache<number>({ ttlMs: 1000, now: clock.now });
    const load = vi.fn().mockResolvedValue(7);

    await cache.get("k", load);
    clock.advance(999);
    await expect(cache.get("k", load)).resolves.toBe(7);

    expect(load).toHaveBeenCalledOnce();
  });

  it("recomputes once the TTL has elapsed", async () => {
    const clock = fakeClock();
    const cache = createReadThroughCache<number>({ ttlMs: 1000, now: clock.now });
    const load = vi.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(8);

    await expect(cache.get("k", load)).resolves.toBe(7);
    clock.advance(1000);
    await expect(cache.get("k", load)).resolves.toBe(8);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys entries independently, so one window cannot serve another's numbers", async () => {
    const cache = createReadThroughCache<string>({ ttlMs: 1000 });

    await expect(cache.get("july", async () => "july-numbers")).resolves.toBe("july-numbers");
    await expect(cache.get("august", async () => "august-numbers")).resolves.toBe(
      "august-numbers",
    );
  });

  /**
   * The reason this cache stores the promise rather than the resolved value. Four
   * dashboard panels mounting at once must not become four copies of the same
   * 1.7s aggregate competing for the same small connection pool.
   */
  it("collapses concurrent misses onto one in-flight load", async () => {
    const cache = createReadThroughCache<number>({ ttlMs: 1000 });
    let release!: (v: number) => void;
    const load = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));

    const all = Promise.all([cache.get("k", load), cache.get("k", load), cache.get("k", load)]);
    release(7);

    await expect(all).resolves.toEqual([7, 7, 7]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("does not cache a failure — the next read retries instead of serving the error", async () => {
    const cache = createReadThroughCache<number>({ ttlMs: 1000 });
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("db unavailable"))
      .mockResolvedValueOnce(7);

    await expect(cache.get("k", load)).rejects.toThrow("db unavailable");
    await expect(cache.get("k", load)).resolves.toBe(7);
    expect(load).toHaveBeenCalledTimes(2);
  });

  /**
   * The funnel window is caller-supplied, so the key space is unbounded. Without a
   * cap, a client walking date ranges would grow this map until the process died.
   */
  it("evicts the oldest entry once maxEntries is exceeded", async () => {
    const cache = createReadThroughCache<string>({ ttlMs: 60_000, maxEntries: 2 });

    await cache.get("a", async () => "a");
    await cache.get("b", async () => "b");
    await cache.get("c", async () => "c");

    expect(cache.size).toBe(2);

    // "a" was evicted, so it must recompute; "c" is still warm.
    const reloadA = vi.fn().mockResolvedValue("a2");
    await expect(cache.get("a", reloadA)).resolves.toBe("a2");
    expect(reloadA).toHaveBeenCalledOnce();

    const reloadC = vi.fn().mockResolvedValue("c2");
    await expect(cache.get("c", reloadC)).resolves.toBe("c");
    expect(reloadC).not.toHaveBeenCalled();
  });

  describe("with staleMs (stale-while-revalidate)", () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
      return { promise, resolve, reject };
    }

    /**
     * The point of the option. A report that takes seconds must not make the page
     * wait just because a minute has passed since someone last looked.
     */
    it("serves the stale value after the TTL while one refresh runs in the background", async () => {
      const clock = fakeClock();
      const cache = createReadThroughCache<number>({ ttlMs: 1000, staleMs: 10_000, now: clock.now });
      const refresh = deferred<number>();
      const load = vi.fn().mockResolvedValueOnce(7).mockReturnValueOnce(refresh.promise);

      await cache.get("k", load);
      clock.advance(1500);

      await expect(cache.get("k", load)).resolves.toBe(7);
      expect(load).toHaveBeenCalledTimes(2);

      refresh.resolve(8);
      await refresh.promise;
      await expect(cache.get("k", load)).resolves.toBe(8);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("collapses stale reads onto a single background refresh", async () => {
      const clock = fakeClock();
      const cache = createReadThroughCache<number>({ ttlMs: 1000, staleMs: 10_000, now: clock.now });
      const refresh = deferred<number>();
      const load = vi.fn().mockResolvedValueOnce(7).mockReturnValueOnce(refresh.promise);

      await cache.get("k", load);
      clock.advance(1500);

      await expect(
        Promise.all([cache.get("k", load), cache.get("k", load), cache.get("k", load)]),
      ).resolves.toEqual([7, 7, 7]);
      expect(load).toHaveBeenCalledTimes(2);
      refresh.resolve(8);
    });

    it("keeps serving the stale value when a refresh fails, and retries on the next read", async () => {
      const clock = fakeClock();
      const cache = createReadThroughCache<number>({ ttlMs: 1000, staleMs: 10_000, now: clock.now });
      const failed = deferred<number>();
      const load = vi
        .fn()
        .mockResolvedValueOnce(7)
        .mockReturnValueOnce(failed.promise)
        .mockResolvedValueOnce(9);

      await cache.get("k", load);
      clock.advance(1500);
      await expect(cache.get("k", load)).resolves.toBe(7);

      failed.reject(new Error("db unavailable"));
      await failed.promise.catch(() => undefined);

      await expect(cache.get("k", load)).resolves.toBe(7);
      expect(load).toHaveBeenCalledTimes(3);
    });

    it("waits for a fresh load once the value is older than ttlMs + staleMs", async () => {
      const clock = fakeClock();
      const cache = createReadThroughCache<number>({ ttlMs: 1000, staleMs: 10_000, now: clock.now });
      const load = vi.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(8);

      await cache.get("k", load);
      clock.advance(11_000);

      await expect(cache.get("k", load)).resolves.toBe(8);
    });
  });

  it("invalidate() clears a single key", async () => {
    const cache = createReadThroughCache<number>({ ttlMs: 60_000 });
    const load = vi.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(8);

    await cache.get("k", load);
    cache.invalidate("k");
    await expect(cache.get("k", load)).resolves.toBe(8);
  });

  it("invalidate() with no key clears everything, which is what tests need", async () => {
    const cache = createReadThroughCache<string>({ ttlMs: 60_000 });

    await cache.get("a", async () => "a");
    await cache.get("b", async () => "b");
    cache.invalidate();

    expect(cache.size).toBe(0);
  });
});
