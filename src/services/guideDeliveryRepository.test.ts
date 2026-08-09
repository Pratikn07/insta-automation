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
  it.each([
    {
      label: "transient without either a retry time or terminal reason",
      disposition: "transient",
      nextAttemptAt: null,
      terminalReason: null,
    },
    {
      label: "transient with both a retry time and terminal reason",
      disposition: "transient",
      nextAttemptAt: new Date(now.getTime() + 60_000),
      terminalReason: { code: "messaging_window_closed" },
    },
    {
      label: "permanent with a retry time",
      disposition: "permanent",
      nextAttemptAt: new Date(now.getTime() + 60_000),
      terminalReason: null,
    },
    {
      label: "permanent with a terminal transient reason",
      disposition: "permanent",
      nextAttemptAt: null,
      terminalReason: { code: "messaging_window_closed" },
    },
    {
      label: "attempt exhaustion before the declared cap",
      disposition: "transient",
      nextAttemptAt: null,
      terminalReason: { code: "attempts_exhausted", maxAttempts: 2 },
    },
  ])("rejects $label before opening a transaction", async (failure) => {
    const transaction = vi.fn(() => Promise.reject(new Error("database must not be called")));
    const repository = createGuideDeliveryRepository({ $transaction: transaction } as never);

    await expect(
      repository.markUnitFailed({
        deliveryId: randomUUID(),
        unitId: randomUUID(),
        claimToken: randomUUID(),
        attempt: 1,
        failedAt: now,
        ...failure,
        error: safeError,
      } as never),
    ).rejects.toThrow("invalid_guide_delivery_failure_checkpoint");
    expect(transaction).not.toHaveBeenCalled();
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
        terminalReason: null,
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
