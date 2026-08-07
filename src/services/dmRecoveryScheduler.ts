import { logger } from "../lib/logger.js";

export type SchedulerOptions = {
  enabled: boolean;
  intervalMs: number;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval: (handle: ReturnType<typeof globalThis.setInterval>) => void;
  runTick: () => Promise<unknown>;
};

export function startDmRecoveryScheduler(options: SchedulerOptions): () => void {
  if (!options.enabled) return () => undefined;
  const run = () =>
    void options.runTick().catch((err) => {
      logger.error({ errorCode: "dm_recovery_tick_rejected", err }, "DM recovery tick rejected");
    });
  run();
  const handle = options.setInterval(run, options.intervalMs);
  return () => options.clearInterval(handle);
}
