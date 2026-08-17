import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerError = vi.fn();
vi.mock("../lib/logger.js", () => ({ logger: { error: loggerError, info: vi.fn(), warn: vi.fn() } }));
const { bindGuideDeliverySchedulerShutdown, startGuideDeliveryScheduler } = await import("./guideDeliveryScheduler.js");

beforeEach(() => loggerError.mockReset());

describe("guide delivery scheduler", () => {
  it("runs immediately, prevents overlap, and stops its interval", async () => {
    let intervalCallback: (() => void) | undefined;
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const runTick = vi.fn<() => Promise<unknown>>().mockImplementationOnce(() => first).mockResolvedValue({});
    const clearInterval = vi.fn();
    const handle = Symbol("timer");
    const stop = startGuideDeliveryScheduler({
      intervalMs: 60_000,
      setInterval: vi.fn((callback: () => void) => { intervalCallback = callback; return handle as never; }),
      clearInterval: clearInterval as never,
      runTick,
    });
    expect(runTick).toHaveBeenCalledOnce();
    intervalCallback!();
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledOnce();
    resolveFirst();
    await first;
    await Promise.resolve();
    intervalCallback!();
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledTimes(2);
    stop();
    expect(clearInterval).toHaveBeenCalledWith(handle);
  });

  it.each(["reject", "throw"])("contains a tick that %s", async (kind) => {
    const runTick = kind === "throw"
      ? vi.fn(() => { throw new Error("private failure"); })
      : vi.fn().mockRejectedValue(new Error("private failure"));
    expect(() => startGuideDeliveryScheduler({
      intervalMs: 60_000,
      setInterval: vi.fn() as never,
      clearInterval: vi.fn() as never,
      runTick: runTick as never,
    })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loggerError).toHaveBeenCalledWith(
      { errorCode: "guide_delivery_tick_rejected" },
      "Guide delivery tick rejected",
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("private failure");
  });

  it("quiesces the retained scheduler interval on either graceful shutdown signal", () => {
    const listeners = new Map<string, () => void>();
    const processLike = {
      once: vi.fn((signal: string, callback: () => void) => listeners.set(signal, callback)),
    };
    const stop = vi.fn();

    bindGuideDeliverySchedulerShutdown(stop, processLike);
    expect(processLike.once).toHaveBeenCalledTimes(2);
    listeners.get("SIGTERM")!();
    listeners.get("SIGINT")!();
    expect(stop).toHaveBeenCalledOnce();
  });
});
