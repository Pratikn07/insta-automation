import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuideDeliveryUnit } from "@prisma/client";
import type {
  ClaimedGuideDelivery,
  GuideDeliveryRepository,
  PlannedDeliveryRecord,
} from "./guideDeliveryRepository.js";
import {
  createConfiguredGuideDeliveryService,
  createGuideDeliveryService,
} from "./guideDeliveryService.js";

const startedAt = new Date("2026-08-09T12:00:00.000Z");
const windowEnd = new Date("2026-08-10T12:00:00.000Z");
const claimToken = "00000000-0000-4000-8000-000000000099";

function unit(
  position: number,
  kind: "text" | "image" | "file",
  overrides: Partial<GuideDeliveryUnit> = {},
): GuideDeliveryUnit {
  return {
    id: `00000000-0000-4000-8000-${String(position + 10).padStart(12, "0")}`,
    deliveryId: "00000000-0000-4000-8000-000000000001",
    resourceMessageId: `00000000-0000-4000-8000-${String(position + 20).padStart(12, "0")}`,
    position,
    origin: "resource_step",
    kind,
    textSnapshot: kind === "text" ? `snapshot-${position}` : null,
    mediaUrlSnapshot: kind === "text" ? null : `https://cdn.example/${position}`,
    contentFingerprint: String(position + 1).repeat(64),
    status: "pending",
    failureDisposition: null,
    providerMessageId: null,
    attempts: 0,
    sendingAt: null,
    sentAt: null,
    ownerConfirmedAt: null,
    ownerRetryAuthorizedAt: null,
    ownerRetryConsumedAt: null,
    errorCategory: null,
    errorHttpStatus: null,
    errorGraphCode: null,
    errorGraphSubcode: null,
    errorTraceId: null,
    errorTransportCode: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    ...overrides,
  };
}

function delivery(
  units: GuideDeliveryUnit[],
  overrides: Partial<PlannedDeliveryRecord> = {},
): PlannedDeliveryRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    conversationId: "00000000-0000-4000-8000-000000000002",
    resourceId: "00000000-0000-4000-8000-000000000003",
    threadId: "00000000-0000-4000-8000-000000000004",
    triggerKind: "inbound_reply",
    triggerId: "00000000-0000-4000-8000-000000000005",
    triggeredAt: startedAt,
    sendWindowExpiresAt: windowEnd,
    followerAtTrigger: true,
    status: "planned",
    failureCode: null,
    nextAttemptAt: null,
    claimToken: null,
    claimedAt: null,
    claimExpiresAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    units,
    ...overrides,
  };
}

function claimed(record: PlannedDeliveryRecord): ClaimedGuideDelivery {
  return {
    ...record,
    status: "sending",
    claimToken,
    claimedAt: startedAt,
    claimExpiresAt: new Date(startedAt.getTime() + 300_000),
  } as ClaimedGuideDelivery;
}

const input = {
  conversationId: "00000000-0000-4000-8000-000000000002",
  resourceId: "00000000-0000-4000-8000-000000000003",
  igUserId: "ig-user-1",
  threadId: "00000000-0000-4000-8000-000000000004",
  triggerKind: "inbound_reply" as const,
  triggerId: "00000000-0000-4000-8000-000000000005",
  triggeredAt: startedAt,
  sendWindowExpiresAt: windowEnd,
  followerAtTrigger: true,
};

function graphFailure(status: number, secret = "provider rejected private body") {
  return Object.assign(new Error(secret), {
    isAxiosError: true,
    code: "ERR_BAD_REQUEST",
    config: {
      url: "/messages?access_token=URL-TOKEN-SECRET",
      data: "PRIVATE REQUEST BODY",
    },
    response: {
      status,
      data: {
        error: {
          code: status === 429 ? 4 : 100,
          error_subcode: 33,
          fbtrace_id: "safe_trace_1",
          message: secret,
        },
      },
    },
  });
}

function transportFailure(code: string, secret = "PRIVATE TIMEOUT BODY") {
  return Object.assign(new Error(secret), {
    isAxiosError: true,
    code,
    config: { url: "/messages?access_token=URL-TOKEN-SECRET", data: secret },
    response: undefined,
  });
}

describe("deliverGuideForTrigger", () => {
  const findByTrigger = vi.fn();
  const findRecipientIgUserId = vi.fn();
  const createOrLoadPlan = vi.fn();
  const claimById = vi.fn();
  const beginUnit = vi.fn();
  const markUnitSent = vi.fn();
  const markUnitFailed = vi.fn();
  const markUnitUncertain = vi.fn();
  const markWindowClosed = vi.fn();
  const markAttemptsExhausted = vi.fn();
  const loadResourceMessages = vi.fn();
  const sendTrackedText = vi.fn();
  const sendTrackedMedia = vi.fn();
  const finalizeGuideDelivery = vi.fn();
  const sleep = vi.fn();
  const loggerError = vi.fn();
  let clock = startedAt;

  function subject() {
    return createGuideDeliveryService({
      repository: {
        findByTrigger,
        findRecipientIgUserId,
        createOrLoadPlan,
        claimById,
        beginUnit,
        markUnitSent,
        markUnitFailed,
        markUnitUncertain,
        markWindowClosed,
        markAttemptsExhausted,
      } as unknown as GuideDeliveryRepository,
      loadResourceMessages,
      sendTrackedText,
      sendTrackedMedia,
      finalizeGuideDelivery,
      now: () => clock,
      sleep,
      leaseMs: 300_000,
      maxAttempts: 3,
      retryBaseMs: 60_000,
      logger: { error: loggerError },
    });
  }

  function configuredSubject(config: {
    GUIDE_DELIVERY_LEASE_MS: number;
    GUIDE_DELIVERY_MAX_ATTEMPTS: number;
    GUIDE_DELIVERY_RETRY_BASE_MS: number;
  }) {
    return createConfiguredGuideDeliveryService(config, {
      repository: {
        findByTrigger,
        findRecipientIgUserId,
        createOrLoadPlan,
        claimById,
        beginUnit,
        markUnitSent,
        markUnitFailed,
        markUnitUncertain,
        markWindowClosed,
        markAttemptsExhausted,
      } as unknown as GuideDeliveryRepository,
      loadResourceMessages,
      sendTrackedText,
      sendTrackedMedia,
      finalizeGuideDelivery,
      now: () => clock,
      sleep,
      logger: { error: loggerError },
    });
  }

  beforeEach(() => {
    for (const mock of [
      findByTrigger,
      findRecipientIgUserId,
      createOrLoadPlan,
      claimById,
      beginUnit,
      markUnitSent,
      markUnitFailed,
      markUnitUncertain,
      markWindowClosed,
      markAttemptsExhausted,
      loadResourceMessages,
      sendTrackedText,
      sendTrackedMedia,
      finalizeGuideDelivery,
      sleep,
      loggerError,
    ]) {
      mock.mockReset();
    }
    clock = startedAt;
    findByTrigger.mockResolvedValue(null);
    findRecipientIgUserId.mockResolvedValue(input.igUserId);
    loadResourceMessages.mockResolvedValue([]);
    claimById.mockResolvedValue(null);
    markUnitSent.mockResolvedValue(true);
    markUnitFailed.mockResolvedValue(true);
    markUnitUncertain.mockResolvedValue(true);
    markWindowClosed.mockResolvedValue(true);
    markAttemptsExhausted.mockResolvedValue(true);
    sendTrackedText.mockResolvedValue({ messageId: "mid-text" });
    sendTrackedMedia.mockResolvedValue({ messageId: "mid-media" });
    finalizeGuideDelivery.mockResolvedValue("completed");
    sleep.mockResolvedValue(undefined);
  });

  it("preflights a later invalid legacy caption before either tracked sender is called", async () => {
    const privateCaption = `${"x".repeat(1_001)}PRIVATE-CAPTION-SENTINEL`;
    loadResourceMessages.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000020",
        order: 0,
        type: "image",
        body: null,
        mediaUrl: "https://cdn.example/private-image",
      },
      {
        id: "00000000-0000-4000-8000-000000000021",
        order: 1,
        type: "pdf",
        body: privateCaption,
        mediaUrl: "https://cdn.example/private-pdf",
      },
    ]);
    createOrLoadPlan.mockImplementation(async ({ plan }) => {
      expect(plan).toMatchObject({ ok: false, error: { code: "text_too_long" } });
      return delivery([], { status: "failed", failureCode: "guide_preflight_failed" });
    });

    await expect(subject()(input)).resolves.toBe("preflight_failed");

    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(sendTrackedMedia).not.toHaveBeenCalled();
    expect(JSON.stringify({ logs: loggerError.mock.calls })).not.toContain(privateCaption);
  });

  it("replays the first persisted snapshot without loading edited resource messages", async () => {
    const persisted = unit(0, "text", { textSnapshot: "immutable first plan" });
    const existing = delivery([persisted]);
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    beginUnit.mockResolvedValueOnce({ ...persisted, status: "sending", attempts: 1 })
      .mockResolvedValueOnce(null);

    await expect(subject()(input)).resolves.toBe("completed");

    expect(loadResourceMessages).not.toHaveBeenCalled();
    expect(createOrLoadPlan).not.toHaveBeenCalled();
    expect(sendTrackedText).toHaveBeenCalledWith({
      recipientIgUserId: input.igUserId,
      text: "immutable first plan",
      source: "guide_automation",
    });
  });

  it.each(["guide_unit_attempts_exhausted", "messaging_window_closed"])(
    "replays terminal failure %s as needs_review without claiming",
    async (failureCode) => {
      findByTrigger.mockResolvedValue(
        delivery(
          [unit(0, "text", { status: "failed", failureDisposition: "transient" })],
          { status: "failed", failureCode, nextAttemptAt: null },
        ),
      );

      await expect(subject()(input)).resolves.toBe("needs_review");

      expect(claimById).not.toHaveBeenCalled();
      expect(beginUnit).not.toHaveBeenCalled();
      expect(sendTrackedText).not.toHaveBeenCalled();
    },
  );

  it("processes a worker-claimed delivery without reclaiming and uses its durable recipient", async () => {
    const persisted = unit(0, "text", { textSnapshot: "worker snapshot" });
    const workerClaim = claimed(delivery([persisted]));
    findRecipientIgUserId.mockResolvedValue("durable-ig-recipient");
    beginUnit.mockResolvedValue({ ...persisted, status: "sending", attempts: 1 });

    await expect(
      subject().processClaimedGuideDelivery(workerClaim),
    ).resolves.toBe("completed");

    expect(findByTrigger).not.toHaveBeenCalled();
    expect(claimById).not.toHaveBeenCalled();
    expect(findRecipientIgUserId).toHaveBeenCalledWith(workerClaim.id);
    expect(sendTrackedText).toHaveBeenCalledWith({
      recipientIgUserId: "durable-ig-recipient",
      text: "worker snapshot",
      source: "guide_automation",
    });
  });

  it("never sends persisted guide content to a mismatched replay recipient", async () => {
    const persisted = unit(0, "text", { textSnapshot: "private durable guide" });
    const existing = delivery([persisted]);
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    findRecipientIgUserId.mockResolvedValue("durable-conversation-recipient");
    beginUnit.mockResolvedValue({ ...persisted, status: "sending", attempts: 1 });

    await expect(
      subject()({ ...input, igUserId: "wrong-fresh-caller-recipient" }),
    ).resolves.toBe("completed");

    expect(sendTrackedText).toHaveBeenCalledWith(
      expect.objectContaining({ recipientIgUserId: "durable-conversation-recipient" }),
    );
    expect(sendTrackedText).not.toHaveBeenCalledWith(
      expect.objectContaining({ recipientIgUserId: "wrong-fresh-caller-recipient" }),
    );
  });

  it("checkpoints each provider ID before beginning the next unit and paces calls by 800ms", async () => {
    const first = unit(0, "text");
    const second = unit(1, "text");
    const existing = delivery([first, second]);
    const order: string[] = [];
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    beginUnit
      .mockImplementationOnce(async () => {
        order.push("begin-0");
        return { ...first, status: "sending", attempts: 1 };
      })
      .mockImplementationOnce(async () => {
        order.push("begin-1");
        return { ...second, status: "sending", attempts: 1 };
      });
    sendTrackedText
      .mockImplementationOnce(async () => {
        order.push("send-0");
        return { messageId: "mid-0" };
      })
      .mockImplementationOnce(async () => {
        order.push("send-1");
        return { messageId: "mid-1" };
      });
    markUnitSent.mockImplementation(async ({ providerMessageId }) => {
      order.push(`checkpoint-${providerMessageId}`);
      return true;
    });
    sleep.mockImplementation(async (ms) => {
      order.push(`sleep-${ms}`);
    });
    finalizeGuideDelivery.mockImplementation(async () => {
      order.push("finalize");
      return "completed";
    });

    await expect(subject()(input)).resolves.toBe("completed");

    expect(order).toEqual([
      "begin-0",
      "send-0",
      "checkpoint-mid-0",
      "sleep-800",
      "begin-1",
      "send-1",
      "checkpoint-mid-1",
      "finalize",
    ]);
  });

  it("keeps a confirmed image sent and resumes only its transiently rejected caption", async () => {
    const image = unit(0, "image");
    const caption = unit(1, "text");
    const initial = delivery([image, caption]);
    findByTrigger.mockResolvedValueOnce(initial);
    claimById.mockResolvedValueOnce(claimed(initial));
    beginUnit
      .mockResolvedValueOnce({ ...image, status: "sending", attempts: 1 })
      .mockResolvedValueOnce({ ...caption, status: "sending", attempts: 1 });
    sendTrackedMedia.mockResolvedValueOnce({ messageId: "mid-image-confirmed" });
    sendTrackedText.mockRejectedValueOnce(graphFailure(429));

    await expect(subject()(input)).resolves.toBe("retry_scheduled");
    expect(markUnitSent).toHaveBeenCalledWith(
      expect.objectContaining({ unitId: image.id, providerMessageId: "mid-image-confirmed" }),
    );
    expect(markUnitFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        unitId: caption.id,
        disposition: "transient",
        nextAttemptAt: new Date(startedAt.getTime() + 60_000),
        terminalReason: null,
      }),
    );

    const resumed = delivery([
      { ...image, status: "sent", providerMessageId: "mid-image-confirmed", attempts: 1 },
      { ...caption, status: "failed", failureDisposition: "transient", attempts: 1 },
    ], { status: "failed", failureCode: "guide_unit_transient", nextAttemptAt: startedAt });
    findByTrigger.mockResolvedValueOnce(resumed);
    claimById.mockResolvedValueOnce(claimed(resumed));
    beginUnit.mockResolvedValueOnce({
      ...caption,
      status: "sending",
      failureDisposition: null,
      attempts: 2,
    });
    sendTrackedText.mockResolvedValueOnce({ messageId: "mid-caption-confirmed" });

    await expect(subject()(input)).resolves.toBe("completed");

    expect(sendTrackedMedia).toHaveBeenCalledTimes(1);
    expect(sendTrackedText).toHaveBeenCalledTimes(2);
    expect(markUnitSent).toHaveBeenLastCalledWith(
      expect.objectContaining({ unitId: caption.id, providerMessageId: "mid-caption-confirmed" }),
    );
  });

  it("wires the validated lease and retry base into configured direct processing", async () => {
    const text = unit(0, "text");
    const existing = delivery([text]);
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    beginUnit.mockResolvedValue({ ...text, status: "sending", attempts: 2 });
    sendTrackedText.mockRejectedValue(graphFailure(429));

    await expect(configuredSubject({
      GUIDE_DELIVERY_LEASE_MS: 90_000,
      GUIDE_DELIVERY_MAX_ATTEMPTS: 6,
      GUIDE_DELIVERY_RETRY_BASE_MS: 20_000,
    })(input)).resolves.toBe("retry_scheduled");

    expect(claimById).toHaveBeenCalledWith({
      deliveryId: existing.id,
      now: startedAt,
      claimExpiresAt: new Date(startedAt.getTime() + 90_000),
    });
    expect(beginUnit).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 6 }));
    expect(markUnitFailed).toHaveBeenCalledWith(expect.objectContaining({
      nextAttemptAt: new Date(startedAt.getTime() + 40_000),
      terminalReason: null,
    }));
  });

  it("wires the validated attempt cap into configured worker processing", async () => {
    const exhausted = unit(0, "text", {
      status: "failed",
      failureDisposition: "transient",
      attempts: 4,
    });
    const workerClaim = claimed(delivery([exhausted], {
      status: "failed",
      failureCode: "guide_unit_transient",
      nextAttemptAt: startedAt,
    }));

    await expect(configuredSubject({
      GUIDE_DELIVERY_LEASE_MS: 90_000,
      GUIDE_DELIVERY_MAX_ATTEMPTS: 4,
      GUIDE_DELIVERY_RETRY_BASE_MS: 20_000,
    }).processClaimedGuideDelivery(workerClaim)).resolves.toBe("needs_review");

    expect(markAttemptsExhausted).toHaveBeenCalledWith({
      deliveryId: workerClaim.id,
      claimToken,
      exhaustedAt: startedAt,
      maxAttempts: 4,
    });
    expect(beginUnit).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("marks a timeout uncertain, requires review, and never begins a later unit", async () => {
    const first = unit(0, "text");
    const second = unit(1, "text");
    const existing = delivery([first, second]);
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    beginUnit.mockResolvedValueOnce({ ...first, status: "sending", attempts: 1 });
    sendTrackedText.mockRejectedValue(transportFailure("ETIMEDOUT"));

    await expect(subject()(input)).resolves.toBe("needs_review");

    expect(beginUnit).toHaveBeenCalledOnce();
    expect(markUnitUncertain).toHaveBeenCalledWith({
      deliveryId: existing.id,
      unitId: first.id,
      claimToken,
      attempt: 1,
      uncertainAt: startedAt,
      error: {
        category: "graph_transport",
        httpStatus: null,
        graphCode: null,
        graphSubcode: null,
        traceId: null,
        transportCode: "ETIMEDOUT",
      },
    });
    expect(markUnitFailed).not.toHaveBeenCalled();
    expect(finalizeGuideDelivery).not.toHaveBeenCalled();
  });

  it("terminalizes a permanent rejection with no retry time", async () => {
    const text = unit(0, "text");
    const existing = delivery([text]);
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    beginUnit.mockResolvedValue({ ...text, status: "sending", attempts: 1 });
    sendTrackedText.mockRejectedValue(graphFailure(400));

    await expect(subject()(input)).resolves.toBe("needs_review");

    expect(markUnitFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: "permanent",
        nextAttemptAt: null,
        terminalReason: null,
      }),
    );
    expect(finalizeGuideDelivery).not.toHaveBeenCalled();
  });

  it("terminalizes a repeated transient failure at the automatic attempt cap", async () => {
    const exhausted = unit(0, "text", {
      status: "failed",
      failureDisposition: "transient",
      attempts: 3,
    });
    const existing = delivery([exhausted], {
      status: "failed",
      failureCode: "guide_unit_transient",
      nextAttemptAt: startedAt,
    });
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));

    await expect(subject()(input)).resolves.toBe("needs_review");

    expect(markAttemptsExhausted).toHaveBeenCalledWith({
      deliveryId: existing.id,
      claimToken,
      exhaustedAt: startedAt,
      maxAttempts: 3,
    });
    expect(beginUnit).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
  });

  it("atomically terminalizes the transient provider rejection that reaches the attempt cap", async () => {
    const retrying = unit(0, "text", {
      status: "failed",
      failureDisposition: "transient",
      attempts: 2,
    });
    const existing = delivery([retrying], {
      status: "failed",
      failureCode: "guide_unit_transient",
      nextAttemptAt: startedAt,
    });
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    beginUnit.mockResolvedValue({
      ...retrying,
      status: "sending",
      failureDisposition: null,
      attempts: 3,
    });
    sendTrackedText.mockRejectedValue(graphFailure(429));

    await expect(subject()(input)).resolves.toBe("needs_review");

    expect(markUnitFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: existing.id,
        unitId: retrying.id,
        claimToken,
        attempt: 3,
        disposition: "transient",
        nextAttemptAt: null,
        terminalReason: { code: "attempts_exhausted", maxAttempts: 3 },
      }),
    );
    expect(markAttemptsExhausted).not.toHaveBeenCalled();
  });

  it("atomically terminalizes a transient rejection whose backoff reaches the window end", async () => {
    const text = unit(0, "text");
    const nearWindowEnd = new Date(startedAt.getTime() + 30_000);
    const rejectedAt = new Date(startedAt.getTime() + 10_000);
    const existing = delivery([text], { sendWindowExpiresAt: nearWindowEnd });
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    beginUnit.mockResolvedValue({ ...text, status: "sending", attempts: 1 });
    sendTrackedText.mockImplementation(async () => {
      clock = rejectedAt;
      throw graphFailure(429);
    });

    await expect(
      subject()({ ...input, sendWindowExpiresAt: nearWindowEnd }),
    ).resolves.toBe("needs_review");

    expect(markUnitFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: existing.id,
        unitId: text.id,
        claimToken,
        attempt: 1,
        failedAt: rejectedAt,
        disposition: "transient",
        nextAttemptAt: null,
        terminalReason: { code: "messaging_window_closed" },
      }),
    );
    expect(markWindowClosed).not.toHaveBeenCalled();
  });

  it("consumes one owner retry authorization above the cap before the Graph call", async () => {
    const authorizedAt = new Date(startedAt.getTime() - 1_000);
    const authorized = unit(0, "text", {
      status: "failed",
      failureDisposition: "transient",
      attempts: 3,
      ownerRetryAuthorizedAt: authorizedAt,
      ownerRetryConsumedAt: null,
    });
    const existing = delivery([authorized], {
      status: "failed",
      failureCode: "guide_unit_transient",
      nextAttemptAt: startedAt,
    });
    let consumed = false;
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    beginUnit.mockImplementation(async () => {
      consumed = true;
      return {
        ...authorized,
        status: "sending",
        failureDisposition: null,
        attempts: 4,
        ownerRetryConsumedAt: startedAt,
      };
    });
    sendTrackedText.mockImplementation(async () => {
      expect(consumed).toBe(true);
      return { messageId: "mid-owner-authorized" };
    });

    await expect(subject()(input)).resolves.toBe("completed");

    expect(beginUnit).toHaveBeenCalledWith(
      expect.objectContaining({ maxAttempts: 3 }),
    );
    expect(markAttemptsExhausted).not.toHaveBeenCalled();
    expect(markUnitSent).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 4, providerMessageId: "mid-owner-authorized" }),
    );
  });

  it("rechecks the messaging window immediately before each provider call", async () => {
    const first = unit(0, "text");
    const second = unit(1, "text");
    const nearWindowEnd = new Date(startedAt.getTime() + 1_000);
    const existing = delivery([first, second], { sendWindowExpiresAt: nearWindowEnd });
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    beginUnit.mockResolvedValueOnce({ ...first, status: "sending", attempts: 1 });
    sleep.mockImplementation(async () => {
      clock = nearWindowEnd;
    });

    await expect(subject()({ ...input, sendWindowExpiresAt: nearWindowEnd })).resolves.toBe(
      "needs_review",
    );

    expect(sendTrackedText).toHaveBeenCalledOnce();
    expect(markWindowClosed).toHaveBeenCalledWith({
      deliveryId: existing.id,
      claimToken,
      closedAt: nearWindowEnd,
    });
    expect(beginUnit).toHaveBeenCalledOnce();
  });

  it("closes the begun unit when the window expires after begin but before the provider call", async () => {
    const text = unit(0, "text");
    const nearWindowEnd = new Date(startedAt.getTime() + 1_000);
    const existing = delivery([text], { sendWindowExpiresAt: nearWindowEnd });
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    beginUnit.mockImplementation(async () => {
      clock = nearWindowEnd;
      return { ...text, status: "sending", attempts: 1 };
    });

    await expect(
      subject()({ ...input, sendWindowExpiresAt: nearWindowEnd }),
    ).resolves.toBe("needs_review");

    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(sendTrackedMedia).not.toHaveBeenCalled();
    expect(markWindowClosed).toHaveBeenCalledWith({
      deliveryId: existing.id,
      claimToken,
      unitId: text.id,
      attempt: 1,
      closedAt: nearWindowEnd,
    });
  });

  it.each([false, "throws"])(
    "leaves a provider-accepted unit sending when its success checkpoint %s",
    async (checkpointOutcome) => {
      const first = unit(0, "text");
      const second = unit(1, "text");
      const existing = delivery([first, second]);
      findByTrigger.mockResolvedValue(existing);
      claimById.mockResolvedValue(claimed(existing));
      beginUnit.mockResolvedValueOnce({ ...first, status: "sending", attempts: 1 });
      if (checkpointOutcome === false) markUnitSent.mockResolvedValue(false);
      else markUnitSent.mockRejectedValue(new Error("PRIVATE CHECKPOINT FAILURE"));

      await expect(subject()(input)).resolves.toBe("already_processing");

      expect(sendTrackedText).toHaveBeenCalledOnce();
      expect(beginUnit).toHaveBeenCalledOnce();
      expect(markUnitFailed).not.toHaveBeenCalled();
      expect(markUnitUncertain).not.toHaveBeenCalled();
      expect(finalizeGuideDelivery).not.toHaveBeenCalled();
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain("PRIVATE CHECKPOINT FAILURE");
    },
  );

  it("passes only allowlisted provider metadata to checkpoints and logs", async () => {
    const sentinel = "PRIVATE PROVIDER RESPONSE TOKEN-SECRET";
    const text = unit(0, "text", { textSnapshot: "PRIVATE GUIDE SNAPSHOT" });
    const existing = delivery([text]);
    findByTrigger.mockResolvedValue(existing);
    claimById.mockResolvedValue(claimed(existing));
    beginUnit.mockResolvedValue({ ...text, status: "sending", attempts: 1 });
    sendTrackedText.mockRejectedValue(transportFailure("ARBITRARY-SECRET-CODE", sentinel));

    await expect(subject()(input)).resolves.toBe("needs_review");

    const exposed = JSON.stringify({
      uncertainCheckpoint: markUnitUncertain.mock.calls,
      failedCheckpoint: markUnitFailed.mock.calls,
      logs: loggerError.mock.calls,
    });
    for (const secret of [
      sentinel,
      "TOKEN-SECRET",
      "URL-TOKEN-SECRET",
      "PRIVATE REQUEST BODY",
      "PRIVATE GUIDE SNAPSHOT",
      "ARBITRARY-SECRET-CODE",
    ]) {
      expect(exposed).not.toContain(secret);
    }
    expect(markUnitUncertain).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ category: "graph_transport", transportCode: null }),
      }),
    );
  });
});
