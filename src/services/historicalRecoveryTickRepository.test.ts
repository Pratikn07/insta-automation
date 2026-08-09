import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = {
  $queryRaw: vi.fn(),
  dmRecoveryControl: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  recoveryCampaign: { findUnique: vi.fn() },
  recoveryCampaignBatchRun: {
    create: vi.fn(),
    updateMany: vi.fn(),
  },
};
const transaction = vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx));

vi.mock("../lib/prisma.js", () => ({ prisma: { $transaction: transaction } }));

const repository = await import("./historicalRecoveryTickRepository.js");

const now = new Date("2026-08-08T12:00:00Z");
const expiresAt = new Date("2026-08-08T12:05:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  tx.dmRecoveryControl.upsert.mockResolvedValue({ id: 1 });
  tx.$queryRaw.mockResolvedValue([{ id: 1 }]);
  tx.recoveryCampaignBatchRun.updateMany.mockResolvedValue({ count: 0 });
  tx.dmRecoveryControl.update.mockResolvedValue({ id: 1 });
});

describe("historical recovery tick repository", () => {
  it("returns null while a different tick lease is still live", async () => {
    tx.dmRecoveryControl.findUnique.mockResolvedValue({
      historicalTickToken: "84f1d880-ec08-4d36-834e-23adac805df7",
      historicalTickExpiresAt: new Date(now.getTime() + 1),
    });

    await expect(repository.acquireHistoricalTick(now, expiresAt)).resolves.toBeNull();
    expect(tx.dmRecoveryControl.update).not.toHaveBeenCalled();
  });

  it("replaces an expired lease and expires its active batches", async () => {
    const oldToken = "84f1d880-ec08-4d36-834e-23adac805df7";
    tx.dmRecoveryControl.findUnique.mockResolvedValue({
      historicalTickToken: oldToken,
      historicalTickExpiresAt: now,
    });

    const lease = await repository.acquireHistoricalTick(now, expiresAt);

    expect(lease).toEqual({ token: expect.any(String), expiresAt });
    expect(lease?.token).not.toBe(oldToken);
    expect(tx.recoveryCampaignBatchRun.updateMany).toHaveBeenCalledWith({
      where: { tickToken: oldToken, status: "active" },
      data: { status: "expired", endedAt: now },
    });
    expect(tx.dmRecoveryControl.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        historicalTickToken: lease?.token,
        historicalTickExpiresAt: expiresAt,
      },
    });
  });

  it("opens a running campaign batch with the campaign allowance", async () => {
    const token = "e7134e36-bcc7-48dd-8daf-b302dfcd3bb9";
    tx.dmRecoveryControl.findUnique.mockResolvedValue({
      historicalTickToken: token,
      historicalTickExpiresAt: expiresAt,
    });
    tx.recoveryCampaign.findUnique.mockResolvedValue({ state: "running", batchSize: 5 });
    tx.recoveryCampaignBatchRun.create.mockResolvedValue({ id: "batch-1", allowance: 5 });

    await expect(
      repository.openCampaignBatch({ token, expiresAt }, "camp-1", now),
    ).resolves.toEqual({ id: "batch-1", allowance: 5 });
  });

  it("maps a concurrent active-batch conflict to no batch", async () => {
    const token = "e7134e36-bcc7-48dd-8daf-b302dfcd3bb9";
    tx.dmRecoveryControl.findUnique.mockResolvedValue({
      historicalTickToken: token,
      historicalTickExpiresAt: expiresAt,
    });
    tx.recoveryCampaign.findUnique.mockResolvedValue({ state: "running", batchSize: 1 });
    tx.recoveryCampaignBatchRun.create.mockRejectedValue({ code: "P2002" });

    await expect(
      repository.openCampaignBatch({ token, expiresAt }, "camp-1", now),
    ).resolves.toBeNull();
  });

  it("does not let a stale token finish a newer tick", async () => {
    tx.dmRecoveryControl.findUnique.mockResolvedValue({
      historicalTickToken: "new-token",
      historicalTickExpiresAt: expiresAt,
    });

    await expect(repository.finishHistoricalTick("old-token", now)).resolves.toBe(false);
    expect(tx.recoveryCampaignBatchRun.updateMany).not.toHaveBeenCalled();
    expect(tx.dmRecoveryControl.update).not.toHaveBeenCalled();
  });
});
