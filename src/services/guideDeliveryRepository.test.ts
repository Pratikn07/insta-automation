import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma.js", () => ({ prisma: {} }));

import {
  createGuideDeliveryRepository,
  type GuideDeliveryRepository,
} from "./guideDeliveryRepository.js";

const now = new Date("2026-08-09T12:00:00.000Z");
const staleClaimToken = "00000000-0000-4000-8000-000000000001";

function staleClient() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    eventLog: { create: vi.fn(() => Promise.reject(new Error("unexpected event write"))) },
  };
  return {
    client: {
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    },
    tx,
  };
}

function repositoryWithStaleRows(): GuideDeliveryRepository {
  const { client } = staleClient();
  return createGuideDeliveryRepository(client as never);
}

const safeError = {
  category: "graph_response" as const,
  httpStatus: 503,
  graphCode: 2,
  graphSubcode: null,
  traceId: "trace_1",
  transportCode: null,
};

describe("GuideDeliveryRepository public transition contract", () => {
  it("returns null or false for a stale claim without creating an event", async () => {
    const { client, tx } = staleClient();
    const repository = createGuideDeliveryRepository(client as never);
    const deliveryId = randomUUID();
    const unitId = randomUUID();

    await expect(
      repository.beginUnit({
        deliveryId,
        claimToken: staleClaimToken,
        now,
        maxAttempts: 3,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.markUnitSent({
        deliveryId,
        unitId,
        claimToken: staleClaimToken,
        attempt: 1,
        sentAt: now,
        providerMessageId: "mid-1",
        ownerConfirmedAt: null,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.markUnitFailed({
        deliveryId,
        unitId,
        claimToken: staleClaimToken,
        attempt: 1,
        failedAt: now,
        disposition: "transient",
        nextAttemptAt: new Date(now.getTime() + 60_000),
        error: safeError,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.markUnitUncertain({
        deliveryId,
        unitId,
        claimToken: staleClaimToken,
        attempt: 1,
        uncertainAt: now,
        error: { ...safeError, category: "graph_transport", httpStatus: null },
      }),
    ).resolves.toBe(false);
    await expect(
      repository.releaseClaim({
        deliveryId,
        claimToken: staleClaimToken,
        now,
      }),
    ).resolves.toBe(false);

    expect(tx.eventLog.create).not.toHaveBeenCalled();
  });

  it("rejects raw provider errors before opening a transaction", async () => {
    const transaction = vi.fn(() => Promise.reject(new Error("database must not be called")));
    const repository = createGuideDeliveryRepository({ $transaction: transaction } as never);

    await expect(
      repository.markUnitFailed({
        deliveryId: randomUUID(),
        unitId: randomUUID(),
        claimToken: randomUUID(),
        attempt: 1,
        failedAt: now,
        disposition: "permanent",
        nextAttemptAt: null,
        error: new Error("PRIVATE PROVIDER BODY") as never,
      }),
    ).rejects.toThrow("invalid_graph_error_metadata");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects metadata carrying fields outside the closed allowlist", async () => {
    const transaction = vi.fn(() => Promise.reject(new Error("database must not be called")));
    const repository = createGuideDeliveryRepository({ $transaction: transaction } as never);

    await expect(
      repository.markUnitUncertain({
        deliveryId: randomUUID(),
        unitId: randomUUID(),
        claimToken: randomUUID(),
        attempt: 1,
        uncertainAt: now,
        error: {
          ...safeError,
          providerBody: "PRIVATE PROVIDER BODY",
        } as never,
      }),
    ).rejects.toThrow("invalid_graph_error_metadata");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("requires either a provider receipt or an owner confirmation for sent", async () => {
    const repository = repositoryWithStaleRows();

    await expect(
      repository.markUnitSent({
        deliveryId: randomUUID(),
        unitId: randomUUID(),
        claimToken: randomUUID(),
        attempt: 1,
        sentAt: now,
        providerMessageId: null,
        ownerConfirmedAt: null,
      }),
    ).rejects.toThrow("sent_confirmation_required");
  });
});
