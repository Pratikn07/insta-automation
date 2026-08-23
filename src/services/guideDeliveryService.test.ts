import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it, vi } from "vitest";
import type { GraphErrorMetadata } from "./eventLogger.js";
import type {
  GuideDeliveryUnitRecord,
  PlannedDeliveryRecord,
} from "./guideDeliveryRepository.js";
import {
  createGuideDeliveryService,
  type DeliverGuideForTriggerInput,
  type GuideDeliveryServiceRepository,
} from "./guideDeliveryService.js";

const DELIVERY_ID = "10000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000001";
const RESOURCE_ID = "30000000-0000-4000-8000-000000000001";
const THREAD_ID = "40000000-0000-4000-8000-000000000001";
const TRIGGER_ID = "50000000-0000-4000-8000-000000000001";
const CLAIM_TOKEN = "60000000-0000-4000-8000-000000000001";
const START = new Date("2026-08-17T12:00:00.000Z");
const WINDOW_END = new Date("2026-08-17T12:10:00.000Z");

const input: DeliverGuideForTriggerInput = {
  conversationId: CONVERSATION_ID,
  resourceId: RESOURCE_ID,
  igUserId: "ig-user-1",
  threadId: THREAD_ID,
  triggerKind: "inbound_reply",
  triggerId: TRIGGER_ID,
  triggeredAt: START,
  sendWindowExpiresAt: WINDOW_END,
  followerAtTrigger: true,
};

function graphResponseError(status: number, code: number): AxiosError {
  const config = { headers: new AxiosHeaders() } as never;
  return new AxiosError("PRIVATE-PROVIDER-BODY-SENTINEL", "ERR_BAD_REQUEST", config, {}, {
    status,
    statusText: "",
    headers: {},
    config,
    data: {
      error: {
        code,
        message: "PRIVATE-PROVIDER-BODY-SENTINEL",
        fbtrace_id: "safe_trace_1",
      },
    },
  } as never);
}

function transportError(code: string): AxiosError {
  return new AxiosError(
    "PRIVATE-PROVIDER-BODY-SENTINEL",
    code,
    { headers: new AxiosHeaders() } as never,
    {},
  );
}

function deliveryUnit(
  overrides: Partial<GuideDeliveryUnitRecord> = {},
): GuideDeliveryUnitRecord {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    deliveryId: DELIVERY_ID,
    resourceMessageId: "80000000-0000-4000-8000-000000000001",
    position: 0,
    origin: "resource_step",
    kind: "text",
    textSnapshot: "First guide unit",
    mediaUrlSnapshot: null,
    contentFingerprint: "a".repeat(64),
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
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

function deliveryRecord(
  units: GuideDeliveryUnitRecord[],
  overrides: Partial<PlannedDeliveryRecord> = {},
): PlannedDeliveryRecord {
  return {
    id: DELIVERY_ID,
    conversationId: CONVERSATION_ID,
    resourceId: RESOURCE_ID,
    threadId: THREAD_ID,
    triggerKind: "inbound_reply",
    triggerId: TRIGGER_ID,
    triggeredAt: START,
    sendWindowExpiresAt: WINDOW_END,
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
    createdAt: START,
    updatedAt: START,
    units,
    ...overrides,
  };
}

type HarnessOptions = {
  existing?: PlannedDeliveryRecord | null;
  messages?: Array<{
    id: string;
    order: number;
    type: "text" | "image" | "pdf";
    body: string | null;
    mediaUrl: string | null;
  }>;
  maxAttempts?: number;
  claimLeaseMs?: number;
};

function harness(options: HarnessOptions = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  let now = START;
  let current = options.existing ?? null;
  let inRepository = false;
  const order: string[] = [];
  const checkpointArguments: unknown[] = [];
  const messages = options.messages ?? [
    { id: "message-1", order: 0, type: "text" as const, body: "Guide", mediaUrl: null },
  ];

  async function repositoryOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    inRepository = true;
    try {
      return await operation();
    } finally {
      inRepository = false;
    }
  }

  const repository: GuideDeliveryServiceRepository = {
    findByTrigger: vi.fn(async () => repositoryOperation(() => current)),
    findRecipientIgUserId: vi.fn(async () => repositoryOperation(() => "persisted-ig-user")),
    createOrLoadPlan: vi.fn(async (request) =>
      repositoryOperation(() => {
        if (current) return current;
        current = deliveryRecord(
          request.plan.ok
            ? request.plan.units.map((planned, index) =>
                deliveryUnit({
                  ...planned,
                  id: `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
                }),
              )
            : [],
          request.plan.ok
            ? {}
            : { status: "failed", failureCode: "invalid_plan", nextAttemptAt: null },
        );
        return current;
      }),
    ),
    claimById: vi.fn(async () =>
      repositoryOperation(() => {
        if (!current) return null;
        if (
          current.status !== "planned" &&
          !(current.status === "failed" && current.nextAttemptAt !== null && current.nextAttemptAt <= now)
        ) {
          return null;
        }
        current.status = "sending";
        current.claimToken = CLAIM_TOKEN;
        current.nextAttemptAt = null;
        return current as PlannedDeliveryRecord & { status: "sending"; claimToken: string };
      }),
    ),
    beginUnit: vi.fn(async () =>
      repositoryOperation(() => {
        if (!current || current.status !== "sending" || current.claimToken !== CLAIM_TOKEN) {
          return null;
        }
        const unit = current.units.find((candidate) => candidate.status !== "sent");
        if (!unit || (unit.status !== "pending" && unit.status !== "retryable")) return null;
        const ownerAuthorized =
          unit.ownerRetryAuthorizedAt !== null && unit.ownerRetryConsumedAt === null;
        if (unit.attempts >= maxAttempts && !ownerAuthorized) return null;
        unit.status = "sending";
        unit.attempts += 1;
        unit.sendingAt = now;
        if (ownerAuthorized) unit.ownerRetryConsumedAt = now;
        order.push(`begin:${unit.position}`);
        return unit;
      }),
    ),
    markUnitSent: vi.fn(async (request) =>
      repositoryOperation(() => {
        checkpointArguments.push(request);
        const unit = current?.units.find((candidate) => candidate.id === request.unitId);
        if (!unit || unit.status !== "sending" || current?.claimToken !== request.claimToken) {
          return false;
        }
        unit.status = "sent";
        unit.providerMessageId = request.providerMessageId;
        unit.sentAt = request.now;
        order.push(`sent:${unit.position}:${request.providerMessageId}`);
        return true;
      }),
    ),
    markUnitRetryable: vi.fn(async (request) =>
      repositoryOperation(() => {
        checkpointArguments.push(request);
        const unit = current?.units.find((candidate) => candidate.id === request.unitId);
        if (!unit || !current) return false;
        unit.status = "retryable";
        unit.failureDisposition = "transient";
        current.status = "failed";
        current.failureCode = request.failureCode;
        current.nextAttemptAt = request.nextAttemptAt;
        current.claimToken = null;
        return true;
      }),
    ),
    markUnitFailed: vi.fn(async (request) =>
      repositoryOperation(() => {
        checkpointArguments.push(request);
        const unit = current?.units.find((candidate) => candidate.id === request.unitId);
        if (!unit || !current) return false;
        unit.status = "failed";
        unit.failureDisposition = request.failureDisposition ?? "permanent";
        current.status = "failed";
        current.failureCode = request.failureCode;
        current.nextAttemptAt = null;
        current.claimToken = null;
        return true;
      }),
    ),
    markUnitUncertain: vi.fn(async (request) =>
      repositoryOperation(() => {
        checkpointArguments.push(request);
        const unit = current?.units.find((candidate) => candidate.id === request.unitId);
        if (!unit || !current) return false;
        unit.status = "uncertain";
        current.status = "needs_review";
        current.failureCode = request.failureCode;
        current.nextAttemptAt = null;
        current.claimToken = null;
        return true;
      }),
    ),
    markWindowClosed: vi.fn(async (request) =>
      repositoryOperation(() => {
        if (!current || current.status !== "sending") return false;
        const unit = request.unitId
          ? current.units.find((candidate) => candidate.id === request.unitId)
          : null;
        if (unit) {
          unit.status = "failed";
          unit.failureDisposition = "permanent";
        }
        current.status = "failed";
        current.failureCode = "messaging_window_closed";
        current.nextAttemptAt = null;
        current.claimToken = null;
        return true;
      }),
    ),
    releaseClaim: vi.fn(async () =>
      repositoryOperation(() => {
        if (!current || current.status !== "sending") return false;
        current.status = "planned";
        current.claimToken = null;
        return true;
      }),
    ),
  };
  const loadResourceMessages = vi.fn().mockResolvedValue(messages);
  const sendText = vi.fn(async () => {
    expect(inRepository).toBe(false);
    order.push("provider:text");
    return { messageId: "mid-text" };
  });
  const sendMedia = vi.fn(async () => {
    expect(inRepository).toBe(false);
    order.push("provider:media");
    return { messageId: "mid-media" };
  });
  const finalizeGuideDelivery = vi.fn(async () => {
    expect(current?.units.every((unit) => unit.status === "sent")).toBe(true);
    order.push("complete");
    if (current) current.status = "completed";
    return "completed" as const;
  });
  const sleep = vi.fn(async () => undefined);
  const logger = { error: vi.fn(), warn: vi.fn() };
  const coverMediaUrl = vi.fn((path: string) => `https://cdn.example.test/${path}`);
  const recordCoverMismatch = vi.fn(async () => undefined);
  const coverDecision = vi.fn(() => "include" as "include" | "omit");

  function service() {
    return createGuideDeliveryService({
      repository,
      loadResourceMessages,
      sendText,
      sendMedia,
      finalizeGuideDelivery,
      coverMediaUrl,
      coverDecision,
      recordCoverMismatch,
      sleep,
      now: () => now,
      logger,
      maxAttempts,
      claimLeaseMs: options.claimLeaseMs ?? 5 * 60_000,
      retryDelayMs: 60_000,
    });
  }

  return {
    service,
    repository,
    loadResourceMessages,
    sendText,
    sendMedia,
    finalizeGuideDelivery,
    coverMediaUrl,
    coverDecision,
    recordCoverMismatch,
    sleep,
    logger,
    order,
    checkpointArguments,
    delivery: () => current,
    setNow(value: Date) {
      now = value;
    },
    isInRepository: () => inRepository,
  };
}

describe("deliverGuideForTrigger", () => {
  it("preflights the whole guide so a later invalid caption causes zero provider calls", async () => {
    const privateCaption = `PRIVATE-CAPTION-${"💛".repeat(985)}`;
    const test = harness({
      messages: [
        { id: "first", order: 0, type: "text", body: "Valid first", mediaUrl: null },
        {
          id: "later",
          order: 1,
          type: "image",
          body: privateCaption,
          mediaUrl: "https://private.example/image.jpg",
        },
      ],
    });

    await expect(test.service()(input)).resolves.toBe("preflight_failed");
    expect(test.sendText).not.toHaveBeenCalled();
    expect(test.sendMedia).not.toHaveBeenCalled();
    expect(test.repository.claimById).not.toHaveBeenCalled();
  });

  it("checkpoints each provider ID before beginning the next unit and completes only after all sent", async () => {
    const test = harness({
      messages: [
        { id: "first", order: 0, type: "text", body: "One", mediaUrl: null },
        { id: "second", order: 1, type: "text", body: "Two", mediaUrl: null },
      ],
    });
    test.sendText
      .mockResolvedValueOnce({ messageId: "mid-one" })
      .mockResolvedValueOnce({ messageId: "mid-two" });

    await expect(test.service()(input)).resolves.toBe("completed");

    expect(test.order).toEqual([
      "begin:0",
      "sent:0:mid-one",
      "begin:1",
      "sent:1:mid-two",
      "complete",
    ]);
    expect(test.sleep).toHaveBeenCalledWith(800);
  });

  it("resumes at a retryable caption without recompiling or resending its confirmed image", async () => {
    const image = deliveryUnit({
      id: "70000000-0000-4000-8000-000000000010",
      position: 0,
      kind: "image",
      textSnapshot: null,
      mediaUrlSnapshot: "https://private.example/image.jpg",
      status: "sent",
      attempts: 1,
      providerMessageId: "mid-existing-image",
      sentAt: START,
    });
    const caption = deliveryUnit({
      id: "70000000-0000-4000-8000-000000000011",
      position: 1,
      textSnapshot: "Caption",
      status: "retryable",
      attempts: 1,
    });
    const test = harness({
      existing: deliveryRecord([image, caption], {
        status: "failed",
        failureCode: "provider_transient",
        nextAttemptAt: START,
      }),
      messages: [{ id: "edited", order: 0, type: "text", body: "Edited guide", mediaUrl: null }],
    });

    await expect(test.service()(input)).resolves.toBe("completed");
    expect(test.loadResourceMessages).not.toHaveBeenCalled();
    expect(test.sendMedia).not.toHaveBeenCalled();
    expect(test.sendText).toHaveBeenCalledOnce();
    expect(image.providerMessageId).toBe("mid-existing-image");
  });

  it("uses the delivery's persisted conversation recipient on replay", async () => {
    const test = harness({ existing: deliveryRecord([deliveryUnit()]) });

    await expect(
      test.service()({ ...input, igUserId: "untrusted-replay-recipient" }),
    ).resolves.toBe("completed");

    expect(test.sendText).toHaveBeenCalledWith({
      recipientIgUserId: "persisted-ig-user",
      text: "First guide unit",
      source: "guide_automation",
    });
  });

  it("persists a definite transient rejection as retryable with a due time", async () => {
    const test = harness();
    test.sendText.mockRejectedValue(graphResponseError(429, 4));

    await expect(test.service()(input)).resolves.toBe("retry_scheduled");
    expect(test.delivery()).toMatchObject({
      status: "failed",
      failureCode: "provider_transient",
      nextAttemptAt: new Date("2026-08-17T12:01:00.000Z"),
    });
    expect(test.delivery()?.units[0]).toMatchObject({
      status: "retryable",
      failureDisposition: "transient",
    });
  });

  it("persists a permanent rejection as terminal without a retry time", async () => {
    const test = harness();
    test.sendText.mockRejectedValue(graphResponseError(400, 100));

    await expect(test.service()(input)).resolves.toBe("needs_review");
    expect(test.delivery()).toMatchObject({
      status: "failed",
      failureCode: "provider_permanent",
      nextAttemptAt: null,
    });
    expect(test.sendText).toHaveBeenCalledOnce();
  });

  it("makes a timed-out unit uncertain, stops, and never sends a later unit", async () => {
    const test = harness({
      messages: [
        { id: "first", order: 0, type: "text", body: "One", mediaUrl: null },
        { id: "second", order: 1, type: "text", body: "Two", mediaUrl: null },
      ],
    });
    test.sendText.mockRejectedValue(transportError("ETIMEDOUT"));

    await expect(test.service()(input)).resolves.toBe("needs_review");
    expect(test.delivery()).toMatchObject({ status: "needs_review", nextAttemptAt: null });
    expect(test.delivery()?.units.map((unit) => unit.status)).toEqual(["uncertain", "pending"]);
    expect(test.sendText).toHaveBeenCalledOnce();
    expect(test.finalizeGuideDelivery).not.toHaveBeenCalled();

    await expect(test.service()(input)).resolves.toBe("needs_review");
    expect(test.sendText).toHaveBeenCalledOnce();
  });

  it("treats a success response without a provider receipt as uncertain", async () => {
    const test = harness();
    test.sendText.mockResolvedValue({ messageId: null });

    await expect(test.service()(input)).resolves.toBe("needs_review");
    expect(test.delivery()?.units[0]?.status).toBe("uncertain");
    expect(test.repository.markUnitSent).not.toHaveBeenCalled();
  });

  it("turns the final bounded transient rejection into terminal failed", async () => {
    const unit = deliveryUnit({ status: "retryable", attempts: 2 });
    const test = harness({
      existing: deliveryRecord([unit], {
        status: "failed",
        failureCode: "provider_transient",
        nextAttemptAt: START,
      }),
    });
    test.sendText.mockRejectedValue(graphResponseError(429, 4));

    await expect(test.service()(input)).resolves.toBe("needs_review");
    expect(unit).toMatchObject({ status: "failed", attempts: 3, failureDisposition: "transient" });
    expect(test.delivery()?.nextAttemptAt).toBeNull();
  });

  it("consumes one explicit owner retry beyond the cap before the Graph call", async () => {
    const unit = deliveryUnit({
      status: "retryable",
      attempts: 3,
      ownerRetryAuthorizedAt: new Date("2026-08-17T11:59:00.000Z"),
    });
    const test = harness({
      existing: deliveryRecord([unit], {
        status: "failed",
        failureCode: "provider_transient",
        nextAttemptAt: START,
      }),
    });
    test.sendText.mockImplementation(async () => {
      expect(unit.ownerRetryConsumedAt).toEqual(START);
      return Promise.reject(graphResponseError(429, 4));
    });

    await expect(test.service()(input)).resolves.toBe("needs_review");
    expect(unit).toMatchObject({ attempts: 4, status: "failed", ownerRetryConsumedAt: START });

    await expect(test.service()(input)).resolves.toBe("needs_review");
    expect(test.sendText).toHaveBeenCalledOnce();
  });

  it("rechecks the messaging window immediately before every provider unit", async () => {
    const test = harness({
      messages: [
        { id: "first", order: 0, type: "text", body: "One", mediaUrl: null },
        { id: "second", order: 1, type: "text", body: "Two", mediaUrl: null },
      ],
    });
    test.sleep.mockImplementation(async () => {
      test.setNow(new Date(WINDOW_END.getTime() + 1));
    });
    test.sendText.mockImplementation(async () => {
      expect(test.isInRepository()).toBe(false);
      expect(test.delivery()?.sendWindowExpiresAt.getTime()).toBeGreaterThan(START.getTime());
      return { messageId: "mid-one" };
    });

    await expect(test.service()(input)).resolves.toBe("needs_review");
    expect(test.sendText).toHaveBeenCalledOnce();
    expect(test.finalizeGuideDelivery).not.toHaveBeenCalled();
    expect(test.delivery()).toMatchObject({
      status: "failed",
      failureCode: "messaging_window_closed",
      nextAttemptAt: null,
    });
  });

  it("renews the claim for each begun unit before crossing the provider boundary", async () => {
    const test = harness({
      claimLeaseMs: 1_000,
      messages: [
        { id: "first", order: 0, type: "text", body: "One", mediaUrl: null },
        { id: "second", order: 1, type: "text", body: "Two", mediaUrl: null },
      ],
    });
    const originalClaim = vi.mocked(test.repository.claimById).getMockImplementation()!;
    vi.mocked(test.repository.claimById).mockImplementation(async (request) => {
      const claimed = await originalClaim(request);
      if (claimed) {
        claimed.claimedAt = request.now;
        claimed.claimExpiresAt = request.claimExpiresAt;
      }
      return claimed;
    });
    const originalBegin = vi.mocked(test.repository.beginUnit).getMockImplementation()!;
    vi.mocked(test.repository.beginUnit).mockImplementation(async (request) => {
      const begun = await originalBegin(request);
      if (!begun) return null;
      if (test.delivery()) {
        test.delivery()!.claimExpiresAt = request.claimExpiresAt;
      }
      if (begun.position === 1) {
        test.setNow(new Date(START.getTime() + 1_100));
      }
      return begun;
    });
    test.sendText
      .mockImplementationOnce(async () => {
        test.setNow(new Date(START.getTime() + 900));
        return { messageId: "mid-one" };
      })
      .mockImplementationOnce(async () => {
        expect(test.delivery()?.claimExpiresAt).toEqual(
          new Date(START.getTime() + 1_900),
        );
        return { messageId: "mid-two" };
      });

    await expect(test.service()(input)).resolves.toBe("completed");
    expect(vi.mocked(test.repository.beginUnit).mock.calls).toEqual([
      [
        expect.objectContaining({
          now: START,
          claimExpiresAt: new Date(START.getTime() + 1_000),
        }),
      ],
      [
        expect.objectContaining({
          now: new Date(START.getTime() + 900),
          claimExpiresAt: new Date(START.getTime() + 1_900),
        }),
      ],
    ]);
  });

  it("does not call the provider if the renewed lease expires after beginUnit returns", async () => {
    const test = harness({ claimLeaseMs: 1_000 });
    const originalBegin = vi.mocked(test.repository.beginUnit).getMockImplementation()!;
    vi.mocked(test.repository.beginUnit).mockImplementation(async (request) => {
      const begun = await originalBegin(request);
      test.setNow(new Date(START.getTime() + 1_001));
      return begun;
    });

    await expect(test.service()(input)).resolves.toBe("already_processing");
    expect(test.sendText).not.toHaveBeenCalled();
    expect(test.sendMedia).not.toHaveBeenCalled();
    expect(test.delivery()?.units[0]).toMatchObject({ status: "sending", attempts: 1 });
  });

  it("does not continue or replay in-process when a success checkpoint loses its fence", async () => {
    const test = harness({
      messages: [
        { id: "first", order: 0, type: "text", body: "One", mediaUrl: null },
        { id: "second", order: 1, type: "text", body: "Two", mediaUrl: null },
      ],
    });
    vi.mocked(test.repository.markUnitSent).mockResolvedValueOnce(false);

    await expect(test.service()(input)).resolves.toBe("already_processing");
    expect(test.delivery()?.units.map((unit) => unit.status)).toEqual(["sending", "pending"]);
    expect(test.sendText).toHaveBeenCalledOnce();
    expect(test.finalizeGuideDelivery).not.toHaveBeenCalled();
  });

  it("leaves an accepted unit sending when its success checkpoint throws", async () => {
    const test = harness({
      messages: [
        { id: "first", order: 0, type: "text", body: "One", mediaUrl: null },
        { id: "second", order: 1, type: "text", body: "Two", mediaUrl: null },
      ],
    });
    vi.mocked(test.repository.markUnitSent).mockRejectedValueOnce(
      new Error("PRIVATE-DATABASE-ERROR-SENTINEL"),
    );

    await expect(test.service()(input)).resolves.toBe("already_processing");
    expect(test.delivery()?.units.map((unit) => unit.status)).toEqual(["sending", "pending"]);
    expect(test.sendText).toHaveBeenCalledOnce();
    expect(test.finalizeGuideDelivery).not.toHaveBeenCalled();
    expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain(
      "PRIVATE-DATABASE-ERROR-SENTINEL",
    );
  });

  it("keeps provider bodies, private snapshots, and URLs out of logs and checkpoint metadata", async () => {
    const privateText = "PRIVATE-TEXT-SENTINEL";
    const test = harness({
      messages: [
        { id: "first", order: 0, type: "text", body: privateText, mediaUrl: null },
      ],
    });
    test.sendText.mockRejectedValue(graphResponseError(429, 4));

    await test.service()(input);

    const serializedSafeBoundaries = JSON.stringify({
      logger: {
        error: test.logger.error.mock.calls,
        warn: test.logger.warn.mock.calls,
      },
      checkpoints: test.checkpointArguments,
    });
    expect(serializedSafeBoundaries).not.toContain("PRIVATE-PROVIDER-BODY-SENTINEL");
    expect(serializedSafeBoundaries).not.toContain(privateText);
    expect(serializedSafeBoundaries).not.toContain("https://private.example");
    const metadata = (test.checkpointArguments[0] as { error: GraphErrorMetadata }).error;
    expect(metadata).toEqual({
      category: "graph_response",
      httpStatus: 429,
      graphCode: 4,
      graphSubcode: null,
      traceId: "safe_trace_1",
      transportCode: null,
    });
  });
});

// Parent-delivery Task 3, service side. The cover joins the SAME durable plan, so it
// must share one claim and one checkpoint sequence with the authored guide. It also has
// to be proven to belong to the guide being compiled — Task 2's snapshot carries its own
// resourceId precisely so this layer can refuse a mismatch.
describe("generated cover in the durable plan", () => {
  const COVER = {
    versionId: "70000000-0000-4000-8000-000000000007",
    resourceId: input.resourceId,
    dmStoragePath: "guide-cover/sleep/dm.png",
  };

  it("sends the cover first, through the same claim and checkpoints as the guide", async () => {
    const test = harness({
      messages: [{ id: "first", order: 0, type: "text", body: "One", mediaUrl: null }],
    });

    await expect(test.service()({ ...input, cover: COVER })).resolves.toBe("completed");

    expect(test.coverMediaUrl).toHaveBeenCalledWith(COVER.dmStoragePath);
    expect(test.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "image",
        url: `https://cdn.example.test/${COVER.dmStoragePath}`,
      }),
    );
    // One claim for both, and the cover's send precedes the authored text.
    expect(test.repository.claimById).toHaveBeenCalledTimes(1);
    expect(test.order.filter((step) => step.startsWith("provider:"))).toEqual([
      "provider:media",
      "provider:text",
    ]);
  });

  it("refuses a cover belonging to a different guide and still delivers the guide", async () => {
    const test = harness({
      messages: [{ id: "first", order: 0, type: "text", body: "One", mediaUrl: null }],
    });

    await expect(
      test.service()({
        ...input,
        cover: { ...COVER, resourceId: "99999999-9999-4999-8999-999999999999" },
      }),
    ).resolves.toBe("completed");

    // Never prepend one guide's cover to another guide's messages.
    expect(test.sendMedia).not.toHaveBeenCalled();
    expect(test.sendText).toHaveBeenCalledTimes(1);
    expect(test.logger.warn).toHaveBeenCalled();
    // A log line alone is not a surface anyone reads; the drop must be recorded.
    expect(test.recordCoverMismatch).toHaveBeenCalledWith({
      deliveryResourceId: input.resourceId,
      coverResourceId: "99999999-9999-4999-8999-999999999999",
      coverVersionId: COVER.versionId,
    });
  });

  it("omits the cover when the parent already saw it in the gate", async () => {
    const test = harness({
      messages: [{ id: "first", order: 0, type: "text", body: "One", mediaUrl: null }],
    });

    await expect(
      test.service()({ ...input, cover: COVER, coverAlreadyShown: true }),
    ).resolves.toBe("completed");

    expect(test.sendMedia).not.toHaveBeenCalled();
    expect(test.coverMediaUrl).not.toHaveBeenCalled();
  });

  it("sends nothing at all when a later authored unit fails preflight", async () => {
    const test = harness({
      messages: [
        { id: "first", order: 0, type: "text", body: "Valid", mediaUrl: null },
        { id: "later", order: 1, type: "image", body: null, mediaUrl: "" },
      ],
    });

    await expect(test.service()({ ...input, cover: COVER })).resolves.toBe("preflight_failed");

    // The cover must not escape ahead of a plan that was rejected as a whole.
    expect(test.sendMedia).not.toHaveBeenCalled();
    expect(test.sendText).not.toHaveBeenCalled();
    expect(test.repository.claimById).not.toHaveBeenCalled();
  });
});

// Parent-delivery Task 6. The rollout fence sits at one call site, before the plan is
// compiled. It governs cover inclusion ONLY.
describe("cover delivery rollout fence", () => {
  const COVER = {
    versionId: "70000000-0000-4000-8000-000000000007",
    resourceId: input.resourceId,
    dmStoragePath: "guide-cover/sleep/dm.png",
  };

  it("omits the cover but still delivers the guide when unselected", async () => {
    const test = harness({
      messages: [{ id: "first", order: 0, type: "text", body: "One", mediaUrl: null }],
    });
    test.coverDecision.mockReturnValue("omit");

    await expect(test.service()({ ...input, cover: COVER })).resolves.toBe("completed");

    // Turning cover delivery off must never withhold an authorized guide.
    expect(test.sendMedia).not.toHaveBeenCalled();
    expect(test.sendText).toHaveBeenCalledTimes(1);
    expect(test.coverMediaUrl).not.toHaveBeenCalled();
  });

  it("consults the fence once, with the guide and the trigger", async () => {
    const test = harness({
      messages: [{ id: "first", order: 0, type: "text", body: "One", mediaUrl: null }],
    });

    await test.service()({ ...input, cover: COVER });

    expect(test.coverDecision).toHaveBeenCalledTimes(1);
    expect(test.coverDecision).toHaveBeenCalledWith({
      resourceId: input.resourceId,
      triggerId: input.triggerId,
    });
  });

  it("never consults the fence when there is no cover to include", async () => {
    const test = harness({
      messages: [{ id: "first", order: 0, type: "text", body: "One", mediaUrl: null }],
    });

    await test.service()(input);

    expect(test.coverDecision).not.toHaveBeenCalled();
  });
});
