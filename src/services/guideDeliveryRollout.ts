import { createHash } from "node:crypto";

export type GuideDeliveryOwner = "legacy" | "ledger";

export function guideDeliveryOwner(input: {
  enabled: boolean;
  rolloutPercent: number;
  cohortIgUserIds: ReadonlySet<string>;
  igUserId: string;
  triggerId: string;
}): GuideDeliveryOwner {
  if (!input.enabled) return "legacy";
  if (
    typeof input.igUserId !== "string" ||
    typeof input.triggerId !== "string" ||
    typeof input.cohortIgUserIds?.has !== "function"
  ) {
    return "legacy";
  }
  if (input.cohortIgUserIds.has(input.igUserId)) return "ledger";
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
