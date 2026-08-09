import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GuideDeliveryRepository,
  PlannedDeliveryRecord,
} from "./guideDeliveryRepository.js";
import { createGuideDeliveryCompletion } from "./guideDeliveryCompletion.js";

const triggeredAt = new Date("2026-08-09T12:00:00.000Z");
const completedAt = new Date("2026-08-09T12:01:00.000Z");
const claimToken = "00000000-0000-4000-8000-000000000010";

function delivery(
  overrides: Partial<PlannedDeliveryRecord> = {},
): PlannedDeliveryRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    conversationId: "00000000-0000-4000-8000-000000000002",
    resourceId: "00000000-0000-4000-8000-000000000003",
    threadId: "00000000-0000-4000-8000-000000000004",
    triggerKind: "inbound_reply",
    triggerId: "00000000-0000-4000-8000-000000000005",
    triggeredAt,
    sendWindowExpiresAt: new Date("2026-08-09T11:59:59.000Z"),
    followerAtTrigger: false,
    status: "sending",
    failureCode: null,
    nextAttemptAt: null,
    claimToken,
    claimedAt: triggeredAt,
    claimExpiresAt: new Date("2026-08-09T12:05:00.000Z"),
    startedAt: triggeredAt,
    completedAt: null,
    cancelledAt: null,
    createdAt: triggeredAt,
    updatedAt: triggeredAt,
    units: [
      {
        id: "00000000-0000-4000-8000-000000000006",
        deliveryId: "00000000-0000-4000-8000-000000000001",
        resourceMessageId: "00000000-0000-4000-8000-000000000007",
        position: 0,
        origin: "resource_step",
        kind: "text",
        textSnapshot: "durable snapshot",
        mediaUrlSnapshot: null,
        contentFingerprint: "1".repeat(64),
        status: "sent",
        failureDisposition: null,
        providerMessageId: "mid-confirmed",
        attempts: 1,
        sendingAt: triggeredAt,
        sentAt: completedAt,
        ownerConfirmedAt: null,
        ownerRetryAuthorizedAt: null,
        ownerRetryConsumedAt: null,
        errorCategory: null,
        errorHttpStatus: null,
        errorGraphCode: null,
        errorGraphSubcode: null,
        errorTraceId: null,
        errorTransportCode: null,
        createdAt: triggeredAt,
        updatedAt: completedAt,
      },
    ],
    ...overrides,
  };
}

describe("finalizeGuideDelivery", () => {
  const findById = vi.fn();
  const finalizeCompleted = vi.fn();
  const markCompleted = vi.fn();
  const scheduleEngagementFollowUp = vi.fn();
  const markThreadResolved = vi.fn();
  const loggerError = vi.fn();

  function subject(followUpsEnabled = true) {
    return createGuideDeliveryCompletion({
      repository: { findById, finalizeCompleted } as unknown as GuideDeliveryRepository,
      markCompleted,
      scheduleEngagementFollowUp,
      markThreadResolved,
      followUpsEnabled,
      logger: { error: loggerError },
      now: () => completedAt,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockResolvedValue(delivery());
    markCompleted.mockResolvedValue({ completedAt });
    scheduleEngagementFollowUp.mockResolvedValue({ scheduled: true, draftId: "draft-1" });
    markThreadResolved.mockResolvedValue(undefined);
    finalizeCompleted.mockResolvedValue("completed");
  });

  it.each([
    ["zero-unit", []],
    ["pending-unit", [{ ...delivery().units[0], status: "pending" as const }]],
  ])("refuses completion for a %s delivery", async (_label, units) => {
    findById.mockResolvedValue(delivery({ units }));

    await expect(subject()(delivery().id, claimToken)).resolves.toBe("not_ready");

    expect(markCompleted).not.toHaveBeenCalled();
    expect(scheduleEngagementFollowUp).not.toHaveBeenCalled();
    expect(markThreadResolved).not.toHaveBeenCalled();
    expect(finalizeCompleted).not.toHaveBeenCalled();
  });

  it("runs conversation completion, optional scheduling, thread resolution, then the fenced transition", async () => {
    const order: string[] = [];
    markCompleted.mockImplementation(async () => {
      order.push("markCompleted");
      return { completedAt };
    });
    scheduleEngagementFollowUp.mockImplementation(async () => {
      order.push("scheduleFollowUp");
      return { scheduled: true, draftId: "draft-1" };
    });
    markThreadResolved.mockImplementation(async () => {
      order.push("markThreadResolved");
    });
    finalizeCompleted.mockImplementation(async () => {
      order.push("finalizeCompleted");
      return "completed";
    });

    await expect(subject()(delivery().id, claimToken)).resolves.toBe("completed");

    expect(order).toEqual([
      "markCompleted",
      "scheduleFollowUp",
      "markThreadResolved",
      "finalizeCompleted",
    ]);
    expect(scheduleEngagementFollowUp).toHaveBeenCalledWith({
      conversationId: delivery().conversationId,
      threadId: delivery().threadId,
      inboundMessageId: delivery().triggerId,
      inboundAt: triggeredAt,
      deliveredAt: completedAt,
    });
    expect(markThreadResolved).toHaveBeenCalledWith({
      threadId: delivery().threadId,
      inboundMessageId: delivery().triggerId,
    });
    expect(finalizeCompleted).toHaveBeenCalledWith({
      deliveryId: delivery().id,
      claimToken,
      completedAt,
    });
  });

  it("keeps completion successful when follow-up scheduling fails and logs IDs only", async () => {
    const sentinel = "PRIVATE DATABASE BODY TOKEN-SECRET";
    scheduleEngagementFollowUp.mockRejectedValue(new Error(sentinel));

    await expect(subject()(delivery().id, claimToken)).resolves.toBe("completed");

    expect(markThreadResolved).toHaveBeenCalledOnce();
    expect(finalizeCompleted).toHaveBeenCalledOnce();
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinel);
    expect(loggerError).toHaveBeenCalledWith(
      {
        errorCode: "follow_up_schedule_failed",
        conversationId: delivery().conversationId,
        threadId: delivery().threadId,
        inboundMessageId: delivery().triggerId,
      },
      "Failed to schedule engagement follow-up after guide delivery",
    );
  });

  it("skips scheduling when follow-ups are disabled", async () => {
    await expect(subject(false)(delivery().id, claimToken)).resolves.toBe("completed");

    expect(scheduleEngagementFollowUp).not.toHaveBeenCalled();
    expect(markThreadResolved).toHaveBeenCalledOnce();
    expect(finalizeCompleted).toHaveBeenCalledOnce();
  });

  it("returns already_completed without repeating bookkeeping or the event transition", async () => {
    findById.mockResolvedValue(
      delivery({ status: "completed", claimToken: null, completedAt }),
    );

    await expect(subject()(delivery().id, claimToken)).resolves.toBe("already_completed");

    expect(markCompleted).not.toHaveBeenCalled();
    expect(scheduleEngagementFollowUp).not.toHaveBeenCalled();
    expect(markThreadResolved).not.toHaveBeenCalled();
    expect(finalizeCompleted).not.toHaveBeenCalled();
  });

  it("finalizes a nonempty all-sent plan after the messaging window closes without a Graph dependency", async () => {
    await expect(subject()(delivery().id, claimToken)).resolves.toBe("completed");

    expect(markCompleted).toHaveBeenCalledOnce();
    expect(finalizeCompleted).toHaveBeenCalledOnce();
  });

  it("does not run bookkeeping after the claim is lost", async () => {
    findById.mockResolvedValue(delivery({ claimToken: "00000000-0000-4000-8000-000000000099" }));

    await expect(subject()(delivery().id, claimToken)).resolves.toBe("lost_claim");

    expect(markCompleted).not.toHaveBeenCalled();
    expect(finalizeCompleted).not.toHaveBeenCalled();
  });
});
