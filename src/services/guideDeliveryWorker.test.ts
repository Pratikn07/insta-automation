import { describe, expect, it, vi } from "vitest";
import type { ClaimedGuideDelivery } from "./guideDeliveryRepository.js";
import { createGuideDeliveryWorker } from "./guideDeliveryWorker.js";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const claimed = (id: string): ClaimedGuideDelivery => ({
  id,
  claimToken: `${id}-claim`,
  units: [],
} as unknown as ClaimedGuideDelivery);

function harness(options: { enabled?: boolean; completionPending?: ClaimedGuideDelivery[]; claimed?: ClaimedGuideDelivery[] } = {}) {
  const repository = {
    reconcileExpiredClaims: vi.fn().mockResolvedValue({
      needsReviewDeliveryIds: ["stale-sending"],
      releasedDeliveryIds: ["unbegun"],
      terminalDeliveryIds: [],
      completionPending: options.completionPending ?? [],
    }),
    claimDueBatch: vi.fn().mockResolvedValue(options.claimed ?? []),
  };
  const finalize = vi.fn().mockResolvedValue("completed");
  const processClaimedGuideDelivery = vi.fn().mockResolvedValue("retry_scheduled");
  const logger = { error: vi.fn(), warn: vi.fn() };
  return {
    repository,
    finalize,
    processClaimedGuideDelivery,
    logger,
    worker: createGuideDeliveryWorker({
      enabled: options.enabled ?? true,
      batchSize: 10,
      leaseMs: 300_000,
      repository,
      finalize,
      processClaimedGuideDelivery,
      now: () => NOW,
      logger,
    }),
  };
}

describe("guide delivery worker", () => {
  it("does not touch the ledger or provider processor while disabled", async () => {
    const test = harness({ enabled: false });
    await test.worker();
    expect(test.repository.reconcileExpiredClaims).not.toHaveBeenCalled();
    expect(test.repository.claimDueBatch).not.toHaveBeenCalled();
    expect(test.processClaimedGuideDelivery).not.toHaveBeenCalled();
  });

  it("reconciles before finalizing all-sent work, then claims due work", async () => {
    const complete = claimed("all-sent");
    const due = claimed("due");
    const test = harness({ completionPending: [complete], claimed: [due] });
    await test.worker();
    expect(test.finalize).toHaveBeenCalledWith("all-sent", "all-sent-claim");
    expect(test.repository.claimDueBatch).toHaveBeenCalledWith({
      now: NOW,
      claimExpiresAt: new Date("2026-08-17T12:05:00.000Z"),
      limit: 10,
    });
    expect(test.processClaimedGuideDelivery).toHaveBeenCalledWith(due);
  });

  it("never sends stale provider-boundary work reconciled to review", async () => {
    const test = harness();
    await test.worker();
    expect(test.processClaimedGuideDelivery).not.toHaveBeenCalled();
    expect(test.finalize).not.toHaveBeenCalled();
  });

  it("continues processing later claims when one delivery throws", async () => {
    const first = claimed("first");
    const second = claimed("second");
    const test = harness({ claimed: [first, second] });
    test.processClaimedGuideDelivery.mockRejectedValueOnce(new Error("private failure"));
    await test.worker();
    expect(test.processClaimedGuideDelivery).toHaveBeenCalledTimes(2);
    expect(test.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "guide_delivery_process_failed", deliveryId: "first" }),
      expect.any(String),
    );
    expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain("private failure");
  });
});
