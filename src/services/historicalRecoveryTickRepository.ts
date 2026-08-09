import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";

export type HistoricalTickLease = { token: string; expiresAt: Date };

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

/** Acquire the singleton cross-instance lease for one historical worker tick. */
export async function acquireHistoricalTick(
  now: Date,
  expiresAt: Date,
): Promise<HistoricalTickLease | null> {
  if (expiresAt <= now) throw new Error("historical_tick_expiry_must_be_future");

  return prisma.$transaction(async (tx) => {
    await tx.dmRecoveryControl.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
    const control = await tx.dmRecoveryControl.findUnique({
      where: { id: 1 },
      select: { historicalTickToken: true, historicalTickExpiresAt: true },
    });
    if (control?.historicalTickToken && control.historicalTickExpiresAt! > now) return null;

    if (control?.historicalTickToken) {
      await tx.recoveryCampaignBatchRun.updateMany({
        where: { tickToken: control.historicalTickToken, status: "active" },
        data: { status: "expired", endedAt: now },
      });
    }

    const token = randomUUID();
    await tx.dmRecoveryControl.update({
      where: { id: 1 },
      data: { historicalTickToken: token, historicalTickExpiresAt: expiresAt },
    });
    return { token, expiresAt };
  });
}

/** Open this tick's independently enforced allowance for one running campaign. */
export async function openCampaignBatch(
  tick: HistoricalTickLease,
  campaignId: string,
  now: Date,
): Promise<{ id: string; allowance: number } | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
      const control = await tx.dmRecoveryControl.findUnique({
        where: { id: 1 },
        select: { historicalTickToken: true, historicalTickExpiresAt: true },
      });
      if (
        control?.historicalTickToken !== tick.token ||
        !control.historicalTickExpiresAt ||
        control.historicalTickExpiresAt.getTime() !== tick.expiresAt.getTime() ||
        control.historicalTickExpiresAt <= now
      ) {
        return null;
      }

      await tx.$queryRaw`
        SELECT "id" FROM "recovery_campaign" WHERE "id" = ${campaignId}::uuid FOR UPDATE
      `;
      const campaign = await tx.recoveryCampaign.findUnique({
        where: { id: campaignId },
        select: { state: true, batchSize: true },
      });
      if (!campaign || campaign.state !== "running" || campaign.batchSize < 1) return null;

      const batch = await tx.recoveryCampaignBatchRun.create({
        data: {
          campaignId,
          tickToken: tick.token,
          allowance: campaign.batchSize,
          startedAt: now,
          leaseExpiresAt: tick.expiresAt,
        },
        select: { id: true, allowance: true },
      });
      return batch;
    });
  } catch (error) {
    // A second process can pass the lease check before the first batch insert commits.
    // The partial unique index is the authority; the loser simply has no batch.
    if (isUniqueConflict(error)) return null;
    throw error;
  }
}

/** Compare-and-clear a tick lease; a stale process cannot clear its replacement. */
export async function finishHistoricalTick(token: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
    const control = await tx.dmRecoveryControl.findUnique({
      where: { id: 1 },
      select: { historicalTickToken: true },
    });
    if (control?.historicalTickToken !== token) return false;

    await tx.recoveryCampaignBatchRun.updateMany({
      where: { tickToken: token, status: "active" },
      data: { status: "completed", endedAt: now },
    });
    await tx.dmRecoveryControl.update({
      where: { id: 1 },
      data: { historicalTickToken: null, historicalTickExpiresAt: null },
    });
    return true;
  });
}
