import { describe, expect, it, vi } from "vitest";
import {
  createGuideDeliveryCompletionRepository,
  createGuideDeliveryCompletionService,
  type GuideDeliveryCompletionDatabase,
  type GuideDeliveryCompletionRecord,
  type GuideDeliveryCompletionRepository,
} from "./guideDeliveryCompletion.js";

const DELIVERY_ID = "10000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000001";
const THREAD_ID = "30000000-0000-4000-8000-000000000001";
const TRIGGER_ID = "40000000-0000-4000-8000-000000000001";
const CLAIM_TOKEN = "50000000-0000-4000-8000-000000000001";
const TRIGGERED_AT = new Date("2026-08-17T12:00:00.000Z");
const COMPLETED_AT = new Date("2026-08-17T12:02:00.000Z");

function completionRecord(
  overrides: Partial<GuideDeliveryCompletionRecord> = {},
): GuideDeliveryCompletionRecord {
  return {
    id: DELIVERY_ID,
    conversationId: CONVERSATION_ID,
    threadId: THREAD_ID,
    triggerKind: "inbound_reply",
    triggerId: TRIGGER_ID,
    triggeredAt: TRIGGERED_AT,
    sendWindowExpiresAt: new Date("2026-08-17T12:01:00.000Z"),
    followerAtTrigger: true,
    status: "sending",
    claimToken: CLAIM_TOKEN,
    completedAt: null,
    totalUnitCount: 2,
    sentUnitCount: 2,
    ...overrides,
  };
}

function completionHarness(record = completionRecord()) {
  const order: string[] = [];
  const repository: GuideDeliveryCompletionRepository = {
    loadForCompletion: vi.fn().mockResolvedValue(record),
    finalizeAtomically: vi.fn(async () => {
      order.push("delivery-finalized");
      return "completed" as const;
    }),
  };
  const markConversationCompleted = vi.fn(async () => {
    order.push("conversation-completed");
    return { completedAt: COMPLETED_AT };
  });
  const scheduleEngagementFollowUp = vi.fn(async () => {
    order.push("follow-up-scheduled");
    return { scheduled: true, draftId: "draft-1" };
  });
  const markThreadResolved = vi.fn(async () => {
    order.push("thread-resolved");
  });
  const logger = { error: vi.fn() };
  const settleAccessAttempt = vi.fn(async () => {
    order.push("attempt-settled");
    return "settled" as const;
  });
  const service = createGuideDeliveryCompletionService({
    repository,
    markConversationCompleted,
    scheduleEngagementFollowUp,
    markThreadResolved,
    settleAccessAttempt,
    followUpsEnabled: () => true,
    logger,
    now: () => COMPLETED_AT,
  });
  return {
    service,
    repository,
    markConversationCompleted,
    scheduleEngagementFollowUp,
    markThreadResolved,
    settleAccessAttempt,
    logger,
    order,
  };
}

describe("finalizeGuideDelivery", () => {
  it("refuses completion bookkeeping until every persisted unit is sent", async () => {
    const harness = completionHarness(completionRecord({ sentUnitCount: 1 }));

    await expect(
      harness.service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN),
    ).resolves.toBe("not_ready");

    expect(harness.markConversationCompleted).not.toHaveBeenCalled();
    expect(harness.scheduleEngagementFollowUp).not.toHaveBeenCalled();
    expect(harness.markThreadResolved).not.toHaveBeenCalled();
    expect(harness.repository.finalizeAtomically).not.toHaveBeenCalled();
  });

  it("runs idempotent bookkeeping in order before the fenced delivery completion", async () => {
    const harness = completionHarness();

    await expect(
      harness.service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN),
    ).resolves.toBe("completed");

    expect(harness.order).toEqual([
      "conversation-completed",
      // The access attempt is settled straight after the ledger state is durable, so it
      // can never be closed before the delivery it belongs to.
      "attempt-settled",
      "follow-up-scheduled",
      "thread-resolved",
      "delivery-finalized",
    ]);
    expect(harness.scheduleEngagementFollowUp).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      threadId: THREAD_ID,
      inboundMessageId: TRIGGER_ID,
      inboundAt: TRIGGERED_AT,
      deliveredAt: COMPLETED_AT,
    });
    expect(harness.markThreadResolved).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      inboundMessageId: TRIGGER_ID,
    });
  });

  it("tolerates follow-up scheduling failure and logs IDs without leaking the error", async () => {
    const harness = completionHarness();
    harness.scheduleEngagementFollowUp.mockRejectedValue(
      new Error("PRIVATE-FOLLOW-UP-ERROR-SENTINEL"),
    );

    await expect(
      harness.service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN),
    ).resolves.toBe("completed");

    expect(harness.markThreadResolved).toHaveBeenCalledOnce();
    expect(harness.repository.finalizeAtomically).toHaveBeenCalledOnce();
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain(
      "PRIVATE-FOLLOW-UP-ERROR-SENTINEL",
    );
    expect(harness.logger.error).toHaveBeenCalledWith(
      {
        errorCode: "follow_up_schedule_failed",
        deliveryId: DELIVERY_ID,
        conversationId: CONVERSATION_ID,
        threadId: THREAD_ID,
        inboundMessageId: TRIGGER_ID,
      },
      "Failed to schedule engagement follow-up after guide delivery",
    );
  });

  it("skips follow-up scheduling when the feature is disabled", async () => {
    const harness = completionHarness();
    const service = createGuideDeliveryCompletionService({
      settleAccessAttempt: async () => "settled" as const,
      repository: harness.repository,
      markConversationCompleted: harness.markConversationCompleted,
      scheduleEngagementFollowUp: harness.scheduleEngagementFollowUp,
      markThreadResolved: harness.markThreadResolved,
      followUpsEnabled: () => false,
      logger: harness.logger,
      now: () => COMPLETED_AT,
    });

    await expect(service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN)).resolves.toBe(
      "completed",
    );
    expect(harness.scheduleEngagementFollowUp).not.toHaveBeenCalled();
  });

  it("returns already_completed without repeating bookkeeping or the completion event", async () => {
    const harness = completionHarness(
      completionRecord({
        status: "completed",
        claimToken: null,
        completedAt: COMPLETED_AT,
      }),
    );

    await expect(
      harness.service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN),
    ).resolves.toBe("already_completed");

    expect(harness.markConversationCompleted).not.toHaveBeenCalled();
    expect(harness.repository.finalizeAtomically).not.toHaveBeenCalled();
  });

  it("returns lost_claim before bookkeeping when the current fence no longer matches", async () => {
    const harness = completionHarness(completionRecord({ claimToken: "different-token" }));

    await expect(
      harness.service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN),
    ).resolves.toBe("lost_claim");
    expect(harness.markConversationCompleted).not.toHaveBeenCalled();
  });

  it("finalizes after the send window closes because completion performs no provider call", async () => {
    const harness = completionHarness(
      completionRecord({ sendWindowExpiresAt: new Date("2020-01-01T00:00:00.000Z") }),
    );

    await expect(
      harness.service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN),
    ).resolves.toBe("completed");
    expect(harness.repository.finalizeAtomically).toHaveBeenCalledOnce();
  });

  it("does not treat a follow-recovery trigger ID as an inbound message ID", async () => {
    const harness = completionHarness(
      completionRecord({ triggerKind: "follow_recovery" }),
    );

    await expect(
      harness.service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN),
    ).resolves.toBe("completed");
    expect(harness.scheduleEngagementFollowUp).not.toHaveBeenCalled();
    expect(harness.markThreadResolved).not.toHaveBeenCalled();
  });
});

describe("guide delivery completion repository", () => {
  it("fences completion and creates exactly one safe event in the same transaction", async () => {
    let insideTransaction = false;
    const updateMany = vi.fn(async () => {
      expect(insideTransaction).toBe(true);
      return { count: 1 };
    });
    const eventCreate = vi.fn(async (input: unknown) => {
      expect(insideTransaction).toBe(true);
      return input;
    });
    const tx = {
      guideDelivery: { findUnique: vi.fn().mockResolvedValue(completionRecord()), updateMany },
      guideDeliveryUnit: {
        count: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0),
      },
      eventLog: { create: eventCreate },
    };
    const database = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
        insideTransaction = true;
        try {
          return await operation(tx);
        } finally {
          insideTransaction = false;
        }
      }),
    } as unknown as GuideDeliveryCompletionDatabase;
    const repository = createGuideDeliveryCompletionRepository({ database });

    await expect(
      repository.finalizeAtomically({
        deliveryId: DELIVERY_ID,
        claimToken: CLAIM_TOKEN,
        completedAt: COMPLETED_AT,
      }),
    ).resolves.toBe("completed");

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: DELIVERY_ID, status: "sending", claimToken: CLAIM_TOKEN },
      data: {
        status: "completed",
        failureCode: null,
        nextAttemptAt: null,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        completedAt: COMPLETED_AT,
        updatedAt: COMPLETED_AT,
      },
    });
    expect(eventCreate).toHaveBeenCalledOnce();
    const serializedEvent = JSON.stringify(eventCreate.mock.calls[0]);
    expect(serializedEvent).toContain("sequence_completed");
    expect(serializedEvent).toContain(DELIVERY_ID);
    expect(serializedEvent).toContain(CONVERSATION_ID);
    expect(serializedEvent).toContain(TRIGGER_ID);
    expect(serializedEvent).toContain("followerAtTrigger");
    expect(serializedEvent).not.toContain("textSnapshot");
    expect(serializedEvent).not.toContain("mediaUrlSnapshot");
  });

  it("does not create a second event when the delivery is already completed", async () => {
    const tx = {
      guideDelivery: {
        findUnique: vi.fn().mockResolvedValue(
          completionRecord({ status: "completed", claimToken: null, completedAt: COMPLETED_AT }),
        ),
        updateMany: vi.fn(),
      },
      guideDeliveryUnit: { count: vi.fn() },
      eventLog: { create: vi.fn() },
    };
    const database = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx),
      ),
    } as unknown as GuideDeliveryCompletionDatabase;
    const repository = createGuideDeliveryCompletionRepository({ database });

    await expect(
      repository.finalizeAtomically({
        deliveryId: DELIVERY_ID,
        claimToken: CLAIM_TOKEN,
        completedAt: COMPLETED_AT,
      }),
    ).resolves.toBe("already_completed");
    expect(tx.guideDelivery.updateMany).not.toHaveBeenCalled();
    expect(tx.eventLog.create).not.toHaveBeenCalled();
  });
});

// Parent-delivery Task 5. `delivering` is an ACTIVE guide-access attempt state, so an
// attempt left unsettled keeps `createOrLoadAttempt` loading it and blocks the parent's
// next request until the messaging window expires. Completion has to close it.
describe("guide access attempt settlement", () => {
  it("settles the attempt as delivered once every unit is provably sent", async () => {
    const test = completionHarness();

    await expect(test.service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN)).resolves.toBe(
      "completed",
    );

    expect(test.settleAccessAttempt).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      outcome: "delivered",
    });
    // Only after the ledger state is durable — never before.
    expect(test.order.indexOf("conversation-completed")).toBeLessThan(
      test.order.indexOf("attempt-settled"),
    );
  });

  it("still completes the delivery when the attempt cannot be settled", async () => {
    const test = completionHarness();
    test.settleAccessAttempt.mockRejectedValue(new Error("attempt settle exploded"));

    await expect(test.service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN)).resolves.toBe(
      "completed",
    );

    // A stuck attempt is an operator problem; it is not a reason to fail a delivery whose
    // units all provably went out. But it must be visible.
    expect(test.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "access_attempt_settle_failed" }),
      expect.any(String),
    );
  });

  it("settles nothing when the delivery is not ready to complete", async () => {
    const test = completionHarness(completionRecord({ sentUnitCount: 1, totalUnitCount: 2 }));

    await expect(test.service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN)).resolves.toBe(
      "not_ready",
    );

    expect(test.settleAccessAttempt).not.toHaveBeenCalled();
  });

  it("settles nothing on a repeated completion", async () => {
    const test = completionHarness(completionRecord({ status: "completed" }));

    await expect(test.service.finalizeGuideDelivery(DELIVERY_ID, CLAIM_TOKEN)).resolves.toBe(
      "already_completed",
    );

    expect(test.settleAccessAttempt).not.toHaveBeenCalled();
  });
});
