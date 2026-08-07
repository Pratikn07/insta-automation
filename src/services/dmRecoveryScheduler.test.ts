import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

const { startDmRecoveryScheduler } = await import("./dmRecoveryScheduler.js");

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

  it("catches a rejected tick without unhandled rejection", async () => {
    const runTick = vi.fn().mockRejectedValue(new Error("boom"));
    startDmRecoveryScheduler({
      enabled: true,
      intervalMs: 60_000,
      setInterval: vi.fn() as any,
      clearInterval: vi.fn(),
      runTick,
    });
    await new Promise((r) => setTimeout(r, 10));
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
});
