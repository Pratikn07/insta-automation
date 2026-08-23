import { env } from "../config/env.js";
import { startDmRecoveryScheduler } from "./dmRecoveryScheduler.js";
import { runGuideCoverOrphanCleanupTick } from "./guideCoverOrphanCleanup.js";

export function startGuideCoverOrphanCleanupScheduler(options: {
  intervalMs?: number;
  startScheduler?: typeof startDmRecoveryScheduler;
  runTick?: () => Promise<unknown>;
} = {}): () => void {
  const startScheduler = options.startScheduler ?? startDmRecoveryScheduler;
  const runTick = options.runTick ?? (() =>
    runGuideCoverOrphanCleanupTick({ batchSize: env.GUIDE_COVER_ORPHAN_BATCH }));
  return startScheduler({
    enabled: true,
    intervalMs: options.intervalMs ?? env.GUIDE_COVER_ORPHAN_INTERVAL_MS,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    runTick,
  });
}
