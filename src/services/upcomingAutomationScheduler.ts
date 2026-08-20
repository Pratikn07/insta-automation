import { startDmRecoveryScheduler } from "./dmRecoveryScheduler.js";
import { runUpcomingAutomationDiscoveryTick } from "./upcomingAutomationWorker.js";

const UPCOMING_AUTOMATION_INTERVAL_MS = 60_000;

type SchedulerDependencies = {
  startScheduler: typeof startDmRecoveryScheduler;
  runTick: typeof runUpcomingAutomationDiscoveryTick;
};

export function startUpcomingAutomationScheduler(
  enabled: boolean,
  dependencies: SchedulerDependencies = {
    startScheduler: startDmRecoveryScheduler,
    runTick: runUpcomingAutomationDiscoveryTick,
  },
): () => void {
  return dependencies.startScheduler({
    enabled,
    intervalMs: UPCOMING_AUTOMATION_INTERVAL_MS,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    runTick: dependencies.runTick,
  });
}
