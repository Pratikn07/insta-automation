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
      isEnabled: () => options.enabled ?? true,
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

  /**
   * The flag is read per tick, not captured when the worker is built.
   *
   * A captured boolean means switching guide delivery off stops new deliveries at
   * the message handler while this worker keeps draining everything already
   * queued — a stop button that appears to have worked and did not. Nothing
   * reconstructs this worker at runtime, so the read has to happen inside the tick.
   */
  it("stops between ticks when the flag is switched off, with no reconstruction", async () => {
    let enabled = true;
    const repository = {
      reconcileExpiredClaims: vi.fn().mockResolvedValue({
        needsReviewDeliveryIds: [],
        releasedDeliveryIds: [],
        terminalDeliveryIds: [],
        completionPending: [],
      }),
      claimDueBatch: vi.fn().mockResolvedValue([]),
    };
    const worker = createGuideDeliveryWorker({
      isEnabled: () => enabled,
      batchSize: 10,
      leaseMs: 300_000,
      repository,
      finalize: vi.fn(),
      processClaimedGuideDelivery: vi.fn(),
      now: () => NOW,
      logger: { error: vi.fn(), warn: vi.fn() },
    });

    await worker();
    expect(repository.claimDueBatch).toHaveBeenCalledTimes(1);

    enabled = false;
    await worker();

    expect(repository.claimDueBatch).toHaveBeenCalledTimes(1);
    expect(repository.reconcileExpiredClaims).toHaveBeenCalledTimes(1);
  });

  it("reconciles before finalizing all-sent work, then claims due work", async () => {
    const complete = claimed("all-sent");
    const due = claimed("due");
    const test = harness({ completionPending: [complete], claimed: [due] });
    await test.worker();
    expect(test.repository.reconcileExpiredClaims).toHaveBeenCalledWith({
      now: NOW,
      limit: 10,
      claimLeaseMs: 300_000,
    });
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

  it("bounds recovery finalization while still claiming a fresh due batch", async () => {
    const completions = Array.from({ length: 11 }, (_, index) => claimed(`complete-${index}`));
    const test = harness({ completionPending: completions });
    await test.worker();
    expect(test.finalize).toHaveBeenCalledTimes(10);
    expect(test.repository.claimDueBatch).toHaveBeenCalledOnce();
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
