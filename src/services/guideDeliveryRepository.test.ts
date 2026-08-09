import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma.js", () => ({ prisma: {} }));

import {
  createGuideDeliveryRepository,
} from "./guideDeliveryRepository.js";

const now = new Date("2026-08-09T12:00:00.000Z");

const safeError = {
  category: "graph_response" as const,
  httpStatus: 503,
  graphCode: 2,
  graphSubcode: null,
  traceId: "trace_1",
  transportCode: null,
};

describe("GuideDeliveryRepository public transition contract", () => {
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
    const transaction = vi.fn(() => Promise.reject(new Error("database must not be called")));
    const repository = createGuideDeliveryRepository({ $transaction: transaction } as never);

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
    expect(transaction).not.toHaveBeenCalled();
  });
});
