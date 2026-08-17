import { logger } from "../lib/logger.js";

type CloseableServer = {
  close(callback: (error?: Error) => void): unknown;
};

export type GuideDeliverySchedulerOptions = {
  intervalMs: number;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval: (handle: ReturnType<typeof globalThis.setInterval>) => void;
  runTick: () => Promise<unknown>;
};

export type GuideDeliveryShutdownProcess = {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  kill(pid: number, signal: "SIGINT" | "SIGTERM"): boolean;
  pid: number;
};

export type GuideDeliveryServerShutdownOptions = {
  server: CloseableServer;
  stopOwnedWork(): void | Promise<void>;
  processLike?: GuideDeliveryShutdownProcess;
};

function closeServer(server: CloseableServer): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Quiesces owned work and closes HTTP before restoring Node's normal signal
 * termination. Re-delivering the signal keeps its conventional exit status and
 * cannot leave unrelated legacy timers holding the process open.
 */
export function bindGuideDeliveryServerShutdown(
  options: GuideDeliveryServerShutdownOptions,
): void {
  const processLike = options.processLike ?? process;
  let shuttingDown = false;
  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        try {
          await options.stopOwnedWork();
        } finally {
          await closeServer(options.server);
        }
      } finally {
        processLike.removeListener("SIGTERM", onSigterm);
        processLike.removeListener("SIGINT", onSigint);
        processLike.kill(processLike.pid, signal);
      }
    })();
  };
  const onSigterm = () => shutdown("SIGTERM");
  const onSigint = () => shutdown("SIGINT");
  processLike.once("SIGTERM", onSigterm);
  processLike.once("SIGINT", onSigint);
}

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
