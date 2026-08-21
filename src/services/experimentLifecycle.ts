import type { ExperimentState } from "../config/experimentRegistry.js";
import { env } from "../config/env.js";
import { RECOVERY_TIMING_V2_CUTOVER_AT } from "../config/recoveryTimingSchedule.js";
import { DM_RECOVERY_TIMING_EXPERIMENT_VERSION } from "./dmRecoveryTimingExperiment.js";

export type ExperimentLifecycleContext = {
  recoveryVersion: string;
  recoveryStartAt: string | undefined;
  now: Date;
};

const SHARED_RECOVERY_FLAG_KEYS = new Set([
  "DM_RECOVERY_ENABLED",
  "DM_RECOVERY_WESTERN_ONLY",
  "DM_RECOVERY_FAILURE_RATE_PERCENT",
]);

function isV2Active(context: ExperimentLifecycleContext): boolean {
  const startAt = context.recoveryStartAt ? new Date(context.recoveryStartAt) : null;
  const approvedCutover = new Date(RECOVERY_TIMING_V2_CUTOVER_AT);
  return (
    context.recoveryVersion === DM_RECOVERY_TIMING_EXPERIMENT_VERSION &&
    startAt !== null &&
    Number.isFinite(startAt.getTime()) &&
    startAt.getTime() === approvedCutover.getTime() &&
    Number.isFinite(context.now.getTime()) &&
    context.now >= approvedCutover
  );
}

/**
 * The recovery experiments share one production pipeline, so their UI lifecycle
 * must turn over at the same instant as assignment does. Code may be deployed
 * before the cutover; that alone must not conclude V1 or claim V2 is active.
 */
export function resolveExperimentState(
  key: string,
  context: ExperimentLifecycleContext,
  declaredState: ExperimentState = "not_started",
): ExperimentState {
  if (key !== "recovery-reminder-timing" && key !== "recovery-reminder-timing-v2") {
    return declaredState;
  }

  const v2Active = isV2Active(context);

  if (key === "recovery-reminder-timing-v2") {
    return v2Active ? "running" : "not_started";
  }
  return v2Active ? "ended" : "running";
}

/**
 * Recovery V1 and V2 are sequential views over one live pipeline. Before the
 * approved cutover the shared operational controls belong to V1; afterwards they
 * belong to V2. V1-only historical settings never move, because V2 does not read
 * them.
 */
export function resolveExperimentOwnedFlagKeys(
  key: string,
  declaredFlagKeys: readonly string[],
  context: ExperimentLifecycleContext,
): string[] {
  if (key !== "recovery-reminder-timing" && key !== "recovery-reminder-timing-v2") {
    return [...declaredFlagKeys];
  }

  const shared = [...SHARED_RECOVERY_FLAG_KEYS];
  if (key === "recovery-reminder-timing") {
    return isV2Active(context) ? [...declaredFlagKeys] : [...declaredFlagKeys, ...shared];
  }
  return isV2Active(context) ? [...declaredFlagKeys] : [];
}

export function resolveFlagExperimentKey(
  flagKey: string,
  declaredExperimentKey: string | undefined,
  context: ExperimentLifecycleContext,
): string | undefined {
  if (!SHARED_RECOVERY_FLAG_KEYS.has(flagKey)) return declaredExperimentKey;
  return isV2Active(context)
    ? "recovery-reminder-timing-v2"
    : "recovery-reminder-timing";
}

function configuredContext(now: Date): ExperimentLifecycleContext {
  return {
    recoveryVersion: env.DM_RECOVERY_EXPERIMENT_VERSION,
    recoveryStartAt: env.DM_RECOVERY_EXPERIMENT_START_AT,
    now,
  };
}

export function configuredExperimentState(
  key: string,
  declaredState: ExperimentState,
  now = new Date(),
): ExperimentState {
  return resolveExperimentState(
    key,
    configuredContext(now),
    declaredState,
  );
}

export function configuredExperimentOwnedFlagKeys(
  key: string,
  declaredFlagKeys: readonly string[],
  now = new Date(),
): string[] {
  return resolveExperimentOwnedFlagKeys(key, declaredFlagKeys, configuredContext(now));
}

export function configuredFlagExperimentKey(
  flagKey: string,
  declaredExperimentKey: string | undefined,
  now = new Date(),
): string | undefined {
  return resolveFlagExperimentKey(flagKey, declaredExperimentKey, configuredContext(now));
}
