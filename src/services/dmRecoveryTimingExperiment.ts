import { createHash } from "node:crypto";

export const DM_RECOVERY_TIMING_EXPERIMENT_VERSION =
  "read-recovery-timing-v2" as const;

export const DM_RECOVERY_TWO_HOUR_ALL_VERSION = "read-recovery-two-hour-all-v1" as const;

export const RECOVERY_TIMING_ARMS = [
  "two_hour",
  "six_hour",
  "no_reminder",
] as const;

export type RecoveryTimingArm = (typeof RECOVERY_TIMING_ARMS)[number];

export type RecoveryTimingSchedule = {
  status: "waiting" | "control";
  cohort: "treatment" | "control";
  eligibleAt: Date;
};

const HASH_SPACE_SIZE = 0x1_0000_0000;
const EXPERIMENT_BUCKETS = 10_000;
const TWO_HOUR_BUCKETS = 4_500;
const SIX_HOUR_BUCKETS = 4_500;
const HOUR_MS = 60 * 60 * 1_000;

/**
 * Maps a follower into one of 10,000 stable buckets for this experiment version.
 * Including the version deliberately permits independent assignment in a future
 * experiment without changing or reusing this frozen cohort allocation.
 */
export function recoveryTimingBucket(igUserId: string): number {
  const hash = createHash("sha256")
    .update(`${DM_RECOVERY_TIMING_EXPERIMENT_VERSION}:${igUserId}`)
    .digest();
  const unsignedPrefix = hash.readUInt32BE(0);

  return Math.floor((unsignedPrefix / HASH_SPACE_SIZE) * EXPERIMENT_BUCKETS);
}

export function assignRecoveryTimingArm(igUserId: string): RecoveryTimingArm {
  const bucket = recoveryTimingBucket(igUserId);

  if (bucket < TWO_HOUR_BUCKETS) return "two_hour";
  if (bucket < TWO_HOUR_BUCKETS + SIX_HOUR_BUCKETS) return "six_hour";
  return "no_reminder";
}

export function timingScheduleForArm(
  arm: RecoveryTimingArm,
  acceptedAt: Date,
): RecoveryTimingSchedule {
  if (arm === "no_reminder") {
    return {
      status: "control",
      cohort: "control",
      eligibleAt: new Date(acceptedAt.getTime()),
    };
  }

  const delayMs = arm === "two_hour" ? 2 * HOUR_MS : 6 * HOUR_MS;
  return {
    status: "waiting",
    cohort: "treatment",
    eligibleAt: new Date(acceptedAt.getTime() + delayMs),
  };
}
