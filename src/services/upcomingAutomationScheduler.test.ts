import { expect, it, vi } from "vitest";
import { startUpcomingAutomationScheduler } from "./upcomingAutomationScheduler.js";

it("starts the non-overlapping one-minute discovery schedule only when enabled", () => {
  const startScheduler = vi.fn();
  const runTick = vi.fn();

  startUpcomingAutomationScheduler(true, { startScheduler, runTick });

  expect(startScheduler).toHaveBeenCalledWith({
    enabled: true,
    intervalMs: 60_000,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    runTick,
  });
});
