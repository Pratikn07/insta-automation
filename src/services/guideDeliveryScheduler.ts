import { logger } from "../lib/logger.js";

export type GuideDeliverySchedulerOptions = {
  intervalMs: number;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval: (handle: ReturnType<typeof globalThis.setInterval>) => void;
  runTick: () => Promise<unknown>;
};

/** Starts one local, non-overlapping reconciliation loop. */
export function startGuideDeliveryScheduler(options: GuideDeliverySchedulerOptions): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await options.runTick();
      } catch {
        logger.error(
          { errorCode: "guide_delivery_tick_rejected" },
          "Guide delivery tick rejected",
        );
      } finally {
        running = false;
      }
    })();
  };
  run();
  const handle = options.setInterval(run, options.intervalMs);
  return () => options.clearInterval(handle);
}
