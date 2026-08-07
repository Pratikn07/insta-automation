import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { logEvent } from "./eventLogger.js";

export type RecoveryCircuitReason =
  | "auth_or_permission"
  | "webhook_signal_gap"
  | "backlog_anomaly"
  | "public_failure_rate"
  | "hourly_cap"
  | "database_failures";

export type RecoveryHealthSnapshot = {
  circuitOpen: boolean;
  reason: RecoveryCircuitReason | null;
  openedAt: Date | null;
  dueCount: number;
  sentLastHour: number;
  recentOutcomeCount: number;
  recentFailureRate: number | null;
  acceptedSignalSample: number;
  positiveSignalSample: number;
};

export type HealthInput = {
  now: Date;
  dueCount: number;
  sentLastHour: number;
  outcomeCount: number;
  publicFailureCount: number;
  acceptedCount: number;
  seenOrEngagedCount: number;
  recentDatabaseFailures: number;
  forcedReason?: RecoveryCircuitReason;
};

// In-memory consecutive healthy count for auto-recovery
let consecutiveHealthyCount = 0;
const AUTO_RECOVERY_THRESHOLD = 3;

const AUTO_RECOVERABLE: ReadonlySet<RecoveryCircuitReason> = new Set([
  "webhook_signal_gap",
  "backlog_anomaly",
  "public_failure_rate",
  "hourly_cap",
  "database_failures",
]);

export async function openRecoveryCircuit(
  reason: RecoveryCircuitReason,
  now: Date,
): Promise<void> {
  consecutiveHealthyCount = 0;
  await prisma.dmRecoveryControl.upsert({
    where: { id: 1 },
    create: { id: 1, circuitOpen: true, reason, openedAt: now },
    update: { circuitOpen: true, reason, openedAt: now },
  });
  await logEvent("dm_recovery_circuit_opened", { reason });
}

export async function closeRecoveryCircuit(now: Date): Promise<void> {
  await prisma.dmRecoveryControl.upsert({
    where: { id: 1 },
    create: { id: 1, circuitOpen: false, reason: null, openedAt: null },
    update: { circuitOpen: false, reason: null, openedAt: null, resetAt: now, resetBy: "health_auto_recovery" },
  });
  await logEvent("dm_recovery_circuit_closed", {});
}

export async function evaluateRecoveryHealth(
  input: HealthInput,
): Promise<RecoveryHealthSnapshot> {
  const failureRate =
    input.outcomeCount >= env.DM_RECOVERY_HEALTH_SAMPLE_SIZE
      ? (input.publicFailureCount / input.outcomeCount) * 100
      : null;

  const snapshot: RecoveryHealthSnapshot = {
    circuitOpen: false,
    reason: null,
    openedAt: null,
    dueCount: input.dueCount,
    sentLastHour: input.sentLastHour,
    recentOutcomeCount: input.outcomeCount,
    recentFailureRate: failureRate,
    acceptedSignalSample: input.acceptedCount,
    positiveSignalSample: input.seenOrEngagedCount,
  };

  let openReason: RecoveryCircuitReason | null = null;

  if (input.forcedReason) {
    openReason = input.forcedReason;
  } else if (
    input.acceptedCount >= env.DM_RECOVERY_MIN_ACCEPTED_HEALTH_SAMPLE &&
    input.seenOrEngagedCount === 0
  ) {
    openReason = "webhook_signal_gap";
  } else if (input.dueCount >= env.DM_RECOVERY_BACKLOG_ALERT_THRESHOLD) {
    openReason = "backlog_anomaly";
  } else if (
    failureRate !== null &&
    failureRate >= env.DM_RECOVERY_FAILURE_RATE_PERCENT
  ) {
    openReason = "public_failure_rate";
  } else if (input.sentLastHour >= env.DM_RECOVERY_HOURLY_CAP) {
    openReason = "hourly_cap";
  } else if (input.recentDatabaseFailures >= env.DM_RECOVERY_DB_FAILURE_THRESHOLD) {
    openReason = "database_failures";
  }

  if (openReason) {
    consecutiveHealthyCount = 0;
    await openRecoveryCircuit(openReason, input.now);
    snapshot.circuitOpen = true;
    snapshot.reason = openReason;
    snapshot.openedAt = input.now;
    return snapshot;
  }

  // Check if we should auto-close
  const control = await prisma.dmRecoveryControl.findUnique({ where: { id: 1 } });
  if (control?.circuitOpen) {
    const currentReason = control.reason as RecoveryCircuitReason | null;
    if (currentReason && !AUTO_RECOVERABLE.has(currentReason)) {
      // Latched (e.g. auth_or_permission), cannot auto-close
      snapshot.circuitOpen = true;
      snapshot.reason = currentReason;
      snapshot.openedAt = control.openedAt;
      return snapshot;
    }

    consecutiveHealthyCount++;
    if (consecutiveHealthyCount >= AUTO_RECOVERY_THRESHOLD) {
      await closeRecoveryCircuit(input.now);
      consecutiveHealthyCount = 0;
    } else {
      snapshot.circuitOpen = true;
      snapshot.reason = currentReason;
      snapshot.openedAt = control.openedAt;
    }
  } else {
    consecutiveHealthyCount = 0;
  }

  return snapshot;
}

/**
 * Reset module-level state for tests.
 */
export function _resetHealthState(): void {
  consecutiveHealthyCount = 0;
}
