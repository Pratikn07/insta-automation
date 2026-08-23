import { expect, it, vi } from "vitest";

import { startGuideCoverOrphanCleanupScheduler } from "./guideCoverOrphanCleanupScheduler.js";

it("starts one non-overlapping cleanup schedule with the configured interval", () => {
  const startScheduler = vi.fn().mockReturnValue(() => undefined);
  const runTick = vi.fn();

  startGuideCoverOrphanCleanupScheduler({
    intervalMs: 900_000,
    startScheduler,
    runTick,
  });

  expect(startScheduler).toHaveBeenCalledWith({
    enabled: true,
    intervalMs: 900_000,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    runTick,
  });
});
