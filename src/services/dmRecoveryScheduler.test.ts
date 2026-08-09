import { beforeEach, describe, it, expect, vi } from "vitest";

const loggerError = vi.fn();
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), error: loggerError, warn: vi.fn() },
}));

const { startDmRecoveryScheduler } = await import("./dmRecoveryScheduler.js");

beforeEach(() => loggerError.mockReset());

describe("dmRecoveryScheduler", () => {
  it("does not register or run when recovery is disabled", () => {
    const timer = vi.fn();
    const runTick = vi.fn().mockResolvedValue({});
    startDmRecoveryScheduler({
      enabled: false,
      intervalMs: 60_000,
      setInterval: timer as any,
      clearInterval: vi.fn(),
      runTick,
    });
    expect(timer).not.toHaveBeenCalled();
    expect(runTick).not.toHaveBeenCalled();
  });

  it("runs once immediately and registers the configured interval", () => {
    const timer = vi.fn();
    const runTick = vi.fn().mockResolvedValue({});
    startDmRecoveryScheduler({
      enabled: true,
      intervalMs: 60_000,
      setInterval: timer as any,
      clearInterval: vi.fn(),
      runTick,
    });
    expect(runTick).toHaveBeenCalledOnce();
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  // This previously asserted nothing at all, so it passed whether or not the
  // rejection was handled — for the one property the scheduler exists to
  // guarantee.
  it("logs a rejected tick instead of leaving an unhandled rejection", async () => {
    const runTick = vi.fn().mockRejectedValue(new Error("boom"));

    startDmRecoveryScheduler({
      enabled: true,
      intervalMs: 60_000,
      setInterval: vi.fn() as any,
      clearInterval: vi.fn(),
      runTick,
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "dm_recovery_tick_rejected" }),
      expect.any(String),
    );
  });

  // A tick that throws before returning its promise never reaches .catch. In a
  // timer callback that is an uncaught exception, which can take down a server
  // whose whole job is answering webhooks.
  it("survives a tick that throws synchronously", async () => {
    const runTick = vi.fn(() => {
      throw new Error("sync boom");
    });

    expect(() =>
      startDmRecoveryScheduler({
        enabled: true,
        intervalMs: 60_000,
        setInterval: vi.fn() as any,
        clearInterval: vi.fn(),
        runTick: runTick as never,
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "dm_recovery_tick_rejected" }),
      expect.any(String),
    );
  });

  it("stop function clears the interval", () => {
    const clearFn = vi.fn();
    const handle = Symbol("timer");
    const stop = startDmRecoveryScheduler({
      enabled: true,
      intervalMs: 60_000,
      setInterval: vi.fn().mockReturnValue(handle) as any,
      clearInterval: clearFn as any,
      runTick: vi.fn().mockResolvedValue({}),
    });
    stop();
    expect(clearFn).toHaveBeenCalledWith(handle);
  });

  it("does not overlap ticks within one process", async () => {
    let intervalCallback: (() => void) | undefined;
    let resolveFirst!: () => void;
    const firstTick = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const runTick = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => firstTick)
      .mockResolvedValue({});

    startDmRecoveryScheduler({
      enabled: true,
      intervalMs: 60_000,
      setInterval: vi.fn((callback: () => void) => {
        intervalCallback = callback;
        return Symbol("timer") as never;
      }),
      clearInterval: vi.fn(),
      runTick,
    });

    expect(runTick).toHaveBeenCalledOnce();
    intervalCallback!();
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledOnce();

    resolveFirst();
    await firstTick;
    await Promise.resolve();
    intervalCallback!();
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledTimes(2);
  });
});
