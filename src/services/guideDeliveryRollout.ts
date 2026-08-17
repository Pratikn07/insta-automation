import { createHash } from "node:crypto";

export type GuideDeliveryOwner = "legacy" | "ledger";

export function guideDeliveryOwner(input: {
  enabled: boolean;
  rolloutPercent: number;
  cohortIgUserIds: ReadonlySet<string>;
  igUserId: string;
  triggerId: string;
}): GuideDeliveryOwner {
  if (input === null || typeof input !== "object") return "legacy";
  if (input.enabled !== true) return "legacy";
  if (
    typeof input.igUserId !== "string" ||
    typeof input.triggerId !== "string" ||
    input.igUserId.trim().length === 0 ||
    input.triggerId.trim().length === 0
  ) {
    return "legacy";
  }
  let inControlledCohort: unknown;
  try {
    const has = input.cohortIgUserIds?.has;
    if (typeof has !== "function") return "legacy";
    inControlledCohort = has.call(input.cohortIgUserIds, input.igUserId);
  } catch {
    return "legacy";
  }
  if (inControlledCohort === true) return "ledger";
  if (inControlledCohort !== false) return "legacy";
  if (
    !Number.isInteger(input.rolloutPercent) ||
    input.rolloutPercent < 0 ||
    input.rolloutPercent > 100
  ) {
    return "legacy";
  }

  const prefix = createHash("sha256")
    .update(input.triggerId)
    .digest()
    .readUInt32BE(0);
  return prefix % 100 < input.rolloutPercent ? "ledger" : "legacy";
}
