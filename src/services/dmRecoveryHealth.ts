import { prisma } from "../lib/prisma.js";
import { flags } from "./flagService.js";
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

/** How far back the accepted/outcome samples reach. */
const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const AUTO_RECOVERY_THRESHOLD = 3;

/**
 * `auth_or_permission` is latched: broken credentials or a revoked
 * subscription do not heal on their own, and a worker cannot verify that they
 * have been fixed. It is cleared operationally. Everything else describes a
 * condition that can genuinely pass.
 */
const AUTO_RECOVERABLE: ReadonlySet<RecoveryCircuitReason> = new Set([
  "webhook_signal_gap",
  "backlog_anomaly",
  "public_failure_rate",
  "hourly_cap",
  "database_failures",
]);

// Proof that the anomaly has passed, held in memory only: a restart restarts
// the proof window rather than force-closing the stored circuit.
let consecutiveHealthyCount = 0;

// Database failures observed since the last evaluation. Read-and-reset, so the
// threshold means "this many failures within one tick" rather than "ever".
let databaseFailuresSinceLastCheck = 0;

/** Called where a recovery database operation fails. */
export function recordRecoveryDatabaseFailure(): void {
  databaseFailuresSinceLastCheck += 1;
}

type Observations = {
  dueCount: number;
  sentLastHour: number;
  outcomeCount: number;
  publicFailureCount: number;
  acceptedCount: number;
  seenOrEngagedCount: number;
  recentDatabaseFailures: number;
};

/**
 * Read-only. Health evaluation must never change an individual recovery row.
 */
async function collectObservations(now: Date): Promise<Observations> {
  const windowStart = new Date(now.getTime() - HEALTH_WINDOW_MS);
  const oneHourAgo = new Date(now.getTime() - HOUR_MS);

  const [
    dueCount,
    sentLastHour,
    outcomeCount,
    publicFailureCount,
    acceptedCount,
    seenOrEngagedCount,
  ] = await Promise.all([
    prisma.dmRecoveryReminder.count({
      // Rows still inside their retry backoff are not backlog; counting them
      // opened a backlog anomaly for work that is deliberately deferred.
      where: {
        status: "waiting",
        eligibleAt: { lte: now },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
    }),
    prisma.dmRecoveryReminder.count({ where: { sentAt: { gte: oneHourAgo } } }),
    // Denominator: rows that actually reached a public-send outcome. Control,
    // suppressed and tracking-unavailable rows never attempted a send, so
    // including them would dilute the rate towards zero.
    prisma.dmRecoveryReminder.count({
      where: {
        status: { in: ["sent", "send_failed", "send_uncertain"] },
        lastAttemptAt: { gte: windowStart },
      },
    }),
    prisma.dmRecoveryReminder.count({
      where: {
        status: { in: ["send_failed", "send_uncertain"] },
        lastAttemptAt: { gte: windowStart },
      },
    }),
    prisma.dmRecoveryReminder.count({ where: { acceptedAt: { gte: windowStart } } }),
    prisma.dmRecoveryReminder.count({
      where: {
        acceptedAt: { gte: windowStart },
        OR: [{ seenAt: { not: null } }, { engagedAt: { not: null } }],
      },
    }),
  ]);

  const recentDatabaseFailures = databaseFailuresSinceLastCheck;
  databaseFailuresSinceLastCheck = 0;

  return {
    dueCount,
    sentLastHour,
    outcomeCount,
    publicFailureCount,
    acceptedCount,
    seenOrEngagedCount,
    recentDatabaseFailures,
  };
}

function chooseOpenReason(o: Observations, failureRate: number | null): RecoveryCircuitReason | null {
  // A webhook subscription that has silently lapsed looks exactly like nobody
  // reading their DMs, and would make every reminder eligible. Only trusted
  // once the accepted sample is large enough to be meaningful.
  if (
    o.acceptedCount >= env.DM_RECOVERY_MIN_ACCEPTED_HEALTH_SAMPLE &&
    o.seenOrEngagedCount === 0
  ) {
    return "webhook_signal_gap";
  }
  if (o.dueCount >= env.DM_RECOVERY_BACKLOG_ALERT_THRESHOLD) return "backlog_anomaly";
  if (failureRate !== null && failureRate >= flags.percent("DM_RECOVERY_FAILURE_RATE_PERCENT")) {
    return "public_failure_rate";
  }
  if (o.sentLastHour >= env.DM_RECOVERY_HOURLY_CAP) return "hourly_cap";
  if (o.recentDatabaseFailures >= env.DM_RECOVERY_DB_FAILURE_THRESHOLD) {
    return "database_failures";
  }
  return null;
}

/**
 * Open the circuit, emitting `dm_recovery_circuit_opened` only when the stored
 * state actually changes — otherwise every tick during an outage would log.
 */
export async function openRecoveryCircuit(
  reason: RecoveryCircuitReason,
  now: Date,
): Promise<void> {
  consecutiveHealthyCount = 0;

  const before = await prisma.dmRecoveryControl.findUnique({ where: { id: 1 } });
  const changed = !before?.circuitOpen || before.reason !== reason;

  await prisma.dmRecoveryControl.upsert({
    where: { id: 1 },
    create: { id: 1, circuitOpen: true, reason, openedAt: now },
    update: { circuitOpen: true, reason, openedAt: before?.openedAt ?? now },
  });

  if (changed) await logEvent("dm_recovery_circuit_opened", { reason });
}

export async function closeRecoveryCircuit(now: Date): Promise<void> {
  const before = await prisma.dmRecoveryControl.findUnique({ where: { id: 1 } });

  await prisma.dmRecoveryControl.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      circuitOpen: false,
      reason: null,
      openedAt: null,
      resetAt: now,
      resetBy: "health_auto_recovery",
    },
    update: {
      circuitOpen: false,
      reason: null,
      openedAt: null,
      resetAt: now,
      resetBy: "health_auto_recovery",
    },
  });

  if (before?.circuitOpen) {
    await logEvent("dm_recovery_circuit_closed", { reason: before.reason ?? null });
  }
}

export async function getRecoveryHealthSnapshot(now: Date): Promise<RecoveryHealthSnapshot> {
  const o = await collectObservations(now);
  // Reading a snapshot must not consume the failure window an evaluation needs.
  databaseFailuresSinceLastCheck += o.recentDatabaseFailures;

  const control = await prisma.dmRecoveryControl.findUnique({ where: { id: 1 } });
  const failureRate =
    o.outcomeCount >= env.DM_RECOVERY_HEALTH_SAMPLE_SIZE
      ? (o.publicFailureCount / o.outcomeCount) * 100
      : null;

  return {
    circuitOpen: Boolean(control?.circuitOpen),
    reason: (control?.reason as RecoveryCircuitReason | null) ?? null,
    openedAt: control?.openedAt ?? null,
    dueCount: o.dueCount,
    sentLastHour: o.sentLastHour,
    recentOutcomeCount: o.outcomeCount,
    recentFailureRate: failureRate,
    acceptedSignalSample: o.acceptedCount,
    positiveSignalSample: o.seenOrEngagedCount,
  };
}

export async function evaluateRecoveryHealth(now: Date): Promise<RecoveryHealthSnapshot> {
  const o = await collectObservations(now);

  // Only meaningful once the configured sample size is reached; two failures
  // out of three is not a failure rate.
  const failureRate =
    o.outcomeCount >= env.DM_RECOVERY_HEALTH_SAMPLE_SIZE
      ? (o.publicFailureCount / o.outcomeCount) * 100
      : null;

  const snapshot: RecoveryHealthSnapshot = {
    circuitOpen: false,
    reason: null,
    openedAt: null,
    dueCount: o.dueCount,
    sentLastHour: o.sentLastHour,
    recentOutcomeCount: o.outcomeCount,
    recentFailureRate: failureRate,
    acceptedSignalSample: o.acceptedCount,
    positiveSignalSample: o.seenOrEngagedCount,
  };

  const control = await prisma.dmRecoveryControl.findUnique({ where: { id: 1 } });
  const storedReason = (control?.reason as RecoveryCircuitReason | null) ?? null;

  // A latched reason is read first and never replaced. Choosing a new anomaly
  // before this let a recoverable reason overwrite auth_or_permission, after
  // which the three-healthy rule would auto-close a circuit that must only be
  // cleared once someone has verified the credentials.
  if (control?.circuitOpen && storedReason && !AUTO_RECOVERABLE.has(storedReason)) {
    return { ...snapshot, circuitOpen: true, reason: storedReason, openedAt: control.openedAt };
  }

  const openReason = chooseOpenReason(o, failureRate);
  if (openReason) {
    await openRecoveryCircuit(openReason, now);
    return { ...snapshot, circuitOpen: true, reason: openReason, openedAt: now };
  }

  if (!control?.circuitOpen) {
    consecutiveHealthyCount = 0;
    return snapshot;
  }

  const currentReason = storedReason;
  consecutiveHealthyCount += 1;
  if (consecutiveHealthyCount >= AUTO_RECOVERY_THRESHOLD) {
    await closeRecoveryCircuit(now);
    consecutiveHealthyCount = 0;
    return snapshot;
  }

  return { ...snapshot, circuitOpen: true, reason: currentReason, openedAt: control.openedAt };
}

/** Reset module-level state for tests. */
export function _resetHealthState(): void {
  consecutiveHealthyCount = 0;
  databaseFailuresSinceLastCheck = 0;
}
