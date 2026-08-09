import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerError = vi.fn();
vi.mock("../lib/logger.js", () => ({
  logger: { error: loggerError, info: vi.fn(), warn: vi.fn() },
}));

const { startGuideDeliveryScheduler } = await import("./guideDeliveryScheduler.js");

describe("guide delivery scheduler", () => {
  beforeEach(() => loggerError.mockReset());

  it("runs immediately and registers the configured interval", () => {
    const setInterval = vi.fn();
    const runTick = vi.fn().mockResolvedValue({});

    startGuideDeliveryScheduler({
      intervalMs: 42_000,
      setInterval: setInterval as never,
      clearInterval: vi.fn(),
      runTick,
    });

    expect(runTick).toHaveBeenCalledOnce();
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 42_000);
  });

  it("does not overlap a slow tick", async () => {
    let intervalCallback!: () => void;
    let resolveFirst!: () => void;
    const firstTick = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const runTick = vi.fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => firstTick)
      .mockResolvedValue({});

    startGuideDeliveryScheduler({
      intervalMs: 60_000,
      setInterval: vi.fn((callback: () => void) => {
        intervalCallback = callback;
        return Symbol("timer") as never;
      }),
      clearInterval: vi.fn(),
      runTick,
    });

    intervalCallback();
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledOnce();

    resolveFirst();
    await firstTick;
    await Promise.resolve();
    intervalCallback();
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledTimes(2);
  });

  it.each(["sync", "async"])("catches a %s tick failure with stable safe metadata", async (kind) => {
    const sentinel = "PRIVATE DATABASE URL provider-body";
    const runTick = kind === "sync"
      ? vi.fn(() => {
          throw new Error(sentinel);
        })
      : vi.fn().mockRejectedValue(new Error(sentinel));

    expect(() => startGuideDeliveryScheduler({
      intervalMs: 60_000,
      setInterval: vi.fn() as never,
      clearInterval: vi.fn(),
      runTick: runTick as never,
    })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loggerError).toHaveBeenCalledWith(
      { errorCode: "guide_delivery_tick_failed" },
      "Guide delivery tick failed",
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinel);
  });

  it("stop clears the timer and prevents future callback runs", async () => {
    const handle = Symbol("timer");
    let intervalCallback!: () => void;
    const clearInterval = vi.fn();
    const runTick = vi.fn().mockResolvedValue({});
    const stop = startGuideDeliveryScheduler({
      intervalMs: 60_000,
      setInterval: vi.fn((callback: () => void) => {
        intervalCallback = callback;
        return handle as never;
      }),
      clearInterval: clearInterval as never,
      runTick,
    });
    await Promise.resolve();

    stop();
    intervalCallback();
    await Promise.resolve();

    expect(clearInterval).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledWith(handle);
    expect(runTick).toHaveBeenCalledOnce();
  });
});
