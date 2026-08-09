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
  let running = false;
  // Awaiting inside the wrapper catches a synchronous throw as well as a
  // rejection. `runTick().catch(...)` only handles the latter, and a tick that
  // threw before returning its promise would surface as an uncaught exception
  // in a timer callback — able to take down a server whose job is answering
  // webhooks.
  const run = () => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await options.runTick();
      } catch (err) {
        // Stable code only. The raw error can carry database detail, provider
        // payloads, or credentials, and this line goes to the application log.
        logger.error(
          { errorCode: "dm_recovery_tick_rejected" },
          "DM recovery tick rejected",
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
