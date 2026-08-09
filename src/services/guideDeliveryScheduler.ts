import { logger } from "../lib/logger.js";

export type GuideDeliverySchedulerOptions = {
  intervalMs: number;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval: (handle: ReturnType<typeof globalThis.setInterval>) => void;
  runTick: () => Promise<unknown>;
};

export function startGuideDeliveryScheduler(
  options: GuideDeliverySchedulerOptions,
): () => void {
  let running = false;
  let stopped = false;

  const run = () => {
    if (running || stopped) return;
    running = true;
    void (async () => {
      try {
        await options.runTick();
      } catch {
        logger.error(
          { errorCode: "guide_delivery_tick_failed" },
          "Guide delivery tick failed",
        );
      } finally {
        running = false;
      }
    })();
  };

  run();
  const handle = options.setInterval(run, options.intervalMs);
  return () => {
    if (stopped) return;
    stopped = true;
    options.clearInterval(handle);
  };
}
