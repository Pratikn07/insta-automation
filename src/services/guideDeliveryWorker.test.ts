import type { GuideDeliveryUnit } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClaimedGuideDelivery,
  ExpiredClaimReconciliation,
  GuideDeliveryRepository,
  PlannedDeliveryRecord,
} from "./guideDeliveryRepository.js";
import { createGuideDeliveryWorker } from "./guideDeliveryWorker.js";

const now = new Date("2026-08-09T12:00:00.000Z");
const claimToken = "00000000-0000-4000-8000-000000000099";

function unit(status: GuideDeliveryUnit["status"] = "pending"): GuideDeliveryUnit {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    deliveryId: "00000000-0000-4000-8000-000000000001",
    resourceMessageId: "00000000-0000-4000-8000-000000000020",
    position: 0,
    origin: "resource_step",
    kind: "text",
    textSnapshot: "private durable guide",
    mediaUrlSnapshot: null,
    contentFingerprint: "1".repeat(64),
    status,
    failureDisposition: null,
    providerMessageId: status === "sent" ? "provider-id" : null,
    attempts: status === "sent" ? 1 : 0,
    sendingAt: null,
    sentAt: status === "sent" ? now : null,
    ownerConfirmedAt: null,
    ownerRetryAuthorizedAt: null,
    ownerRetryConsumedAt: null,
    errorCategory: null,
    errorHttpStatus: null,
    errorGraphCode: null,
    errorGraphSubcode: null,
    errorTraceId: null,
    errorTransportCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

function claimedDelivery(
  id: string,
  status: GuideDeliveryUnit["status"] = "pending",
  sendWindowExpiresAt = new Date(now.getTime() + 60_000),
): ClaimedGuideDelivery {
  const record: PlannedDeliveryRecord = {
    id,
    conversationId: "00000000-0000-4000-8000-000000000002",
    resourceId: "00000000-0000-4000-8000-000000000003",
    threadId: "00000000-0000-4000-8000-000000000004",
    triggerKind: "inbound_reply",
    triggerId: "00000000-0000-4000-8000-000000000005",
    triggeredAt: now,
    sendWindowExpiresAt,
    followerAtTrigger: true,
    status: "sending",
    failureCode: null,
    nextAttemptAt: null,
    claimToken,
    claimedAt: now,
    claimExpiresAt: new Date(now.getTime() + 120_000),
    startedAt: now,
    completedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    units: [{ ...unit(status), deliveryId: id }],
  };
  return record as ClaimedGuideDelivery;
}

function reconciliation(
  overrides: Partial<ExpiredClaimReconciliation> = {},
): ExpiredClaimReconciliation {
  return {
    needsReviewDeliveryIds: [],
    releasedDeliveryIds: [],
    terminalDeliveryIds: [],
    completionPending: [],
    ...overrides,
  };
}

describe("guide delivery worker", () => {
  const reconcileExpiredClaims = vi.fn();
  const claimDueBatch = vi.fn();
  const finalizeGuideDelivery = vi.fn();
  const processClaimedGuideDelivery = vi.fn();
  const loggerError = vi.fn();

  function subject() {
    return createGuideDeliveryWorker({
      repository: { reconcileExpiredClaims, claimDueBatch } as unknown as GuideDeliveryRepository,
      finalizeGuideDelivery,
      processClaimedGuideDelivery,
      now: () => now,
      batchSize: 7,
      leaseMs: 120_000,
      logger: { error: loggerError },
    });
  }

  beforeEach(() => {
    for (const mock of [
      reconcileExpiredClaims,
      claimDueBatch,
      finalizeGuideDelivery,
      processClaimedGuideDelivery,
      loggerError,
    ]) {
      mock.mockReset();
    }
    reconcileExpiredClaims.mockResolvedValue(reconciliation());
    claimDueBatch.mockResolvedValue([]);
    finalizeGuideDelivery.mockResolvedValue("completed");
    processClaimedGuideDelivery.mockResolvedValue("completed");
  });

  it("leaves stale sending work in review and never routes it to the sender", async () => {
    reconcileExpiredClaims.mockResolvedValue(
      reconciliation({ needsReviewDeliveryIds: ["stale-delivery"] }),
    );

    await expect(subject()()).resolves.toMatchObject({
      needsReviewCount: 1,
      claimedCount: 0,
      processedCount: 0,
    });

    expect(processClaimedGuideDelivery).not.toHaveBeenCalled();
    expect(finalizeGuideDelivery).not.toHaveBeenCalled();
  });

  it("reconciles first, finalizes all-sent work, then claims and processes safely due work", async () => {
    const order: string[] = [];
    const completionOnly = claimedDelivery(
      "completion-delivery",
      "sent",
      new Date(now.getTime() - 1),
    );
    const safelyDue = claimedDelivery("released-delivery");
    reconcileExpiredClaims.mockImplementation(async () => {
      order.push("reconcile");
      return reconciliation({
        releasedDeliveryIds: [safelyDue.id],
        completionPending: [completionOnly],
      });
    });
    finalizeGuideDelivery.mockImplementation(async () => {
      order.push("finalize");
      return "completed";
    });
    claimDueBatch.mockImplementation(async () => {
      order.push("claim");
      return [safelyDue];
    });
    processClaimedGuideDelivery.mockImplementation(async () => {
      order.push("process");
      return "completed";
    });

    await expect(subject()()).resolves.toMatchObject({
      releasedCount: 1,
      completionPendingCount: 1,
      completionFailedCount: 0,
      claimedCount: 1,
      processedCount: 1,
      processingFailedCount: 0,
    });

    expect(order).toEqual(["reconcile", "finalize", "claim", "process"]);
    expect(finalizeGuideDelivery).toHaveBeenCalledWith(completionOnly.id, claimToken);
    expect(processClaimedGuideDelivery).toHaveBeenCalledWith(safelyDue);
    expect(claimDueBatch).toHaveBeenCalledWith({
      now,
      claimExpiresAt: new Date(now.getTime() + 120_000),
      limit: 7,
    });
  });

  it("uses fenced completion only for all-sent reconciliation work after window close", async () => {
    const completionOnly = claimedDelivery(
      "completion-delivery",
      "sent",
      new Date(now.getTime() - 60_000),
    );
    reconcileExpiredClaims.mockResolvedValue(
      reconciliation({ completionPending: [completionOnly] }),
    );

    await subject()();

    expect(finalizeGuideDelivery).toHaveBeenCalledWith(completionOnly.id, claimToken);
    expect(processClaimedGuideDelivery).not.toHaveBeenCalledWith(completionOnly);
  });

  it("isolates one claimed delivery failure and logs no raw error or snapshot", async () => {
    const first = claimedDelivery("delivery-1");
    const second = claimedDelivery("delivery-2");
    claimDueBatch.mockResolvedValue([first, second]);
    processClaimedGuideDelivery
      .mockRejectedValueOnce(new Error("PRIVATE BODY https://secret.example"))
      .mockResolvedValueOnce("completed");

    await expect(subject()()).resolves.toMatchObject({
      claimedCount: 2,
      processedCount: 1,
      processingFailedCount: 1,
    });

    expect(processClaimedGuideDelivery).toHaveBeenCalledTimes(2);
    expect(loggerError).toHaveBeenCalledWith(
      {
        errorCode: "guide_delivery_processing_failed",
        deliveryId: first.id,
        claimedCount: 2,
        processedCount: 0,
        failedCount: 1,
      },
      "Guide delivery processing failed",
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("PRIVATE BODY");
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("private durable guide");
  });
});
