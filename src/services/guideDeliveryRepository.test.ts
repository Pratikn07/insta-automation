import { describe, expect, it, vi } from "vitest";
import type { GraphErrorMetadata } from "./eventLogger.js";
import {
  createGuideDeliveryRepository,
  type GuideDeliveryDatabase,
} from "./guideDeliveryRepository.js";

const DELIVERY_ID = "10000000-0000-4000-8000-000000000001";
const UNIT_ID = "20000000-0000-4000-8000-000000000001";
const CLAIM_TOKEN = "30000000-0000-4000-8000-000000000001";
const STALE_TOKEN = "40000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-17T12:00:00.000Z");
const RETRY_AT = new Date("2026-08-17T12:01:00.000Z");

const SAFE_ERROR: GraphErrorMetadata = {
  category: "graph_response",
  httpStatus: 429,
  graphCode: 4,
  graphSubcode: null,
  traceId: "trace_123",
  transportCode: null,
};

type CapturedQuery = {
  strings: readonly string[];
  values: readonly unknown[];
};

function captureQuery(query: unknown): CapturedQuery {
  const candidate = query as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  return {
    strings: candidate.strings ?? [],
    values: candidate.values ?? [],
  };
}

function normalizedSql(query: CapturedQuery): string {
  return query.strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();
}

function expectDeliveryFence(query: CapturedQuery): void {
  const sql = normalizedSql(query);
  expect(sql).toContain('delivery."id" = ?::uuid');
  expect(sql).toContain('delivery."claim_token" = ?::uuid');
  expect(sql).toContain("delivery.\"status\" = 'sending'");
  expect(query.values).toContain(DELIVERY_ID);
  expect(query.values).toContain(STALE_TOKEN);
}

function expectUnitFence(query: CapturedQuery): void {
  const sql = normalizedSql(query);
  expect(sql).toContain('unit."id" = ?::uuid');
  expect(sql).toContain('unit."delivery_id" = delivery."id"');
  expect(sql).toContain("unit.\"status\" = 'sending'");
  expect(sql).toContain('unit."attempts" = ?');
  expect(query.values).toContain(UNIT_ID);
  expect(query.values).toContain(2);
}

function createRecordingDatabase(unitStatus: "pending" | "sending" = "sending") {
  const queries: CapturedQuery[] = [];
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const captured = captureQuery(query);
      queries.push(captured);
      const sql = normalizedSql(captured);
      if (sql.startsWith("select") && sql.includes('from "guide_delivery" as delivery')) {
        return [
          {
            id: DELIVERY_ID,
            conversationId: "50000000-0000-4000-8000-000000000001",
            resourceId: "60000000-0000-4000-8000-000000000001",
            triggerKind: "inbound_reply",
            triggerId: "70000000-0000-4000-8000-000000000001",
            status: "sending",
            failureCode: null,
            nextAttemptAt: null,
            claimToken: STALE_TOKEN,
            sendWindowExpiresAt: new Date("2026-08-18T12:00:00.000Z"),
          },
        ];
      }
      return [];
    }),
    $executeRaw: vi.fn(async (query: unknown) => {
      queries.push(captureQuery(query));
      return 0;
    }),
    eventLog: {
      create: vi.fn(),
      createMany: vi.fn(),
    },
    guideDelivery: {
      findUnique: vi.fn(),
    },
    guideDeliveryUnit: {
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([
        {
          id: UNIT_ID,
          deliveryId: DELIVERY_ID,
          resourceMessageId: null,
          position: 0,
          origin: "resource_step",
          kind: "text",
          textSnapshot: "private snapshot",
          mediaUrlSnapshot: null,
          contentFingerprint: "a".repeat(64),
          status: unitStatus,
          failureDisposition: null,
          providerMessageId: null,
          attempts: 2,
          sendingAt: NOW,
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
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]),
    },
  };
  const database = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
      operation(tx),
    ),
  } as unknown as GuideDeliveryDatabase;

  return { database, queries, tx };
}

describe("guide delivery repository transition guards", () => {
  it.each([
    {
      name: "markUnitSent",
      invoke: (repository: ReturnType<typeof createGuideDeliveryRepository>) =>
        repository.markUnitSent({
          deliveryId: DELIVERY_ID,
          unitId: UNIT_ID,
          claimToken: STALE_TOKEN,
          attempt: 2,
          providerMessageId: "mid.1",
          ownerConfirmedAt: null,
          now: NOW,
        }),
    },
    {
      name: "markUnitRetryable",
      invoke: (repository: ReturnType<typeof createGuideDeliveryRepository>) =>
        repository.markUnitRetryable({
          deliveryId: DELIVERY_ID,
          unitId: UNIT_ID,
          claimToken: STALE_TOKEN,
          attempt: 2,
          failureCode: "provider_transient",
          nextAttemptAt: RETRY_AT,
          error: SAFE_ERROR,
          now: NOW,
        }),
    },
    {
      name: "markUnitFailed",
      invoke: (repository: ReturnType<typeof createGuideDeliveryRepository>) =>
        repository.markUnitFailed({
          deliveryId: DELIVERY_ID,
          unitId: UNIT_ID,
          claimToken: STALE_TOKEN,
          attempt: 2,
          failureCode: "provider_permanent",
          error: SAFE_ERROR,
          now: NOW,
        }),
    },
    {
      name: "markUnitUncertain",
      invoke: (repository: ReturnType<typeof createGuideDeliveryRepository>) =>
        repository.markUnitUncertain({
          deliveryId: DELIVERY_ID,
          unitId: UNIT_ID,
          claimToken: STALE_TOKEN,
          attempt: 2,
          failureCode: "provider_outcome_uncertain",
          error: SAFE_ERROR,
          now: NOW,
        }),
    },
  ])("$name returns false and issues only a fully fenced unit mutation", async ({ invoke }) => {
    const { database, queries, tx } = createRecordingDatabase();
    const repository = createGuideDeliveryRepository({ database, maxAttempts: 3 });

    await expect(invoke(repository)).resolves.toBe(false);

    const fencedQuery = queries.find((query) => normalizedSql(query).startsWith("update"));
    expect(fencedQuery).toBeDefined();
    expectDeliveryFence(fencedQuery!);
    expectUnitFence(fencedQuery!);
    expect(tx.eventLog.create).not.toHaveBeenCalled();
    expect(tx.eventLog.createMany).not.toHaveBeenCalled();
  });

  it("beginUnit requires the current delivery claim and sending state before touching a unit", async () => {
    const { database, queries, tx } = createRecordingDatabase("pending");
    const repository = createGuideDeliveryRepository({ database, maxAttempts: 3 });

    await expect(
      repository.beginUnit({
        deliveryId: DELIVERY_ID,
        claimToken: STALE_TOKEN,
        now: NOW,
      }),
    ).resolves.toBeNull();

    const unitUpdate = queries.find((query) => normalizedSql(query).startsWith("update"));
    expect(unitUpdate).toBeDefined();
    expectDeliveryFence(unitUpdate!);
    expect(tx.eventLog.create).not.toHaveBeenCalled();
  });

  it("releaseClaim refuses a stale token and cannot release provider-boundary work", async () => {
    const { database, queries, tx } = createRecordingDatabase();
    const repository = createGuideDeliveryRepository({ database, maxAttempts: 3 });

    await expect(
      repository.releaseClaim({
        deliveryId: DELIVERY_ID,
        claimToken: STALE_TOKEN,
        now: NOW,
      }),
    ).resolves.toBe(false);

    const release = queries.find((query) => normalizedSql(query).startsWith("update"));
    expect(release).toBeDefined();
    expectDeliveryFence(release!);
    expect(normalizedSql(release!)).toContain("not exists");
    expect(normalizedSql(release!)).toContain("unit.\"status\" = 'sending'");
    expect(tx.eventLog.create).not.toHaveBeenCalled();
  });

  it("rejects a sent checkpoint without either a provider receipt or owner confirmation", async () => {
    const { database } = createRecordingDatabase();
    const repository = createGuideDeliveryRepository({ database, maxAttempts: 3 });

    await expect(
      repository.markUnitSent({
        deliveryId: DELIVERY_ID,
        unitId: UNIT_ID,
        claimToken: CLAIM_TOKEN,
        attempt: 1,
        providerMessageId: null,
        ownerConfirmedAt: null,
        now: NOW,
      }),
    ).rejects.toThrow("sent checkpoint requires provider or owner confirmation");
  });

  it.each([
    new Error("PRIVATE PROVIDER BODY"),
    { ...SAFE_ERROR, providerBody: "PRIVATE PROVIDER BODY" },
  ])("rejects raw or non-allowlisted provider metadata before opening a transaction", async (error) => {
    const { database } = createRecordingDatabase();
    const transaction = database.$transaction as unknown as ReturnType<typeof vi.fn>;
    const repository = createGuideDeliveryRepository({ database, maxAttempts: 3 });

    await expect(
      repository.markUnitFailed({
        deliveryId: DELIVERY_ID,
        unitId: UNIT_ID,
        claimToken: CLAIM_TOKEN,
        attempt: 1,
        failureCode: "provider_permanent",
        error: error as GraphErrorMetadata,
        now: NOW,
      }),
    ).rejects.toThrow("invalid graph error metadata");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("preserves a definite transient disposition when the final bounded attempt becomes terminal", async () => {
    const { database, queries } = createRecordingDatabase();
    const repository = createGuideDeliveryRepository({ database, maxAttempts: 3 });

    await repository.markUnitFailed({
      deliveryId: DELIVERY_ID,
      unitId: UNIT_ID,
      claimToken: STALE_TOKEN,
      attempt: 2,
      failureCode: "provider_retry_exhausted",
      failureDisposition: "transient",
      error: SAFE_ERROR,
      now: NOW,
    } as never);

    const unitUpdate = queries.find((query) => {
      const sql = normalizedSql(query);
      return sql.startsWith("update") && sql.includes('guide_delivery_unit" as unit');
    });
    expect(unitUpdate).toBeDefined();
    expect(unitUpdate?.values).toContain("transient");
  });

  it("rejects a non-allowlisted terminal failure disposition before opening a transaction", async () => {
    const { database } = createRecordingDatabase();
    const transaction = database.$transaction as unknown as ReturnType<typeof vi.fn>;
    const repository = createGuideDeliveryRepository({ database, maxAttempts: 3 });

    await expect(
      repository.markUnitFailed({
        deliveryId: DELIVERY_ID,
        unitId: UNIT_ID,
        claimToken: STALE_TOKEN,
        attempt: 2,
        failureCode: "provider_retry_exhausted",
        failureDisposition: "PRIVATE-DISPOSITION-SENTINEL",
        error: SAFE_ERROR,
        now: NOW,
      } as never),
    ).rejects.toThrow("invalid guide delivery failure disposition");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("fences a no-provider window closure and terminalizes the delivery", async () => {
    const { database, queries, tx } = createRecordingDatabase("pending");
    tx.$queryRaw.mockImplementation(async (query: unknown) => {
      const captured = captureQuery(query);
      queries.push(captured);
      const sql = normalizedSql(captured);
      if (sql.startsWith("select") && sql.includes('from "guide_delivery" as delivery')) {
        return [
          {
            id: DELIVERY_ID,
            conversationId: "50000000-0000-4000-8000-000000000001",
            resourceId: "60000000-0000-4000-8000-000000000001",
            triggerKind: "inbound_reply",
            triggerId: "70000000-0000-4000-8000-000000000001",
            status: "sending",
            failureCode: null,
            nextAttemptAt: null,
            claimToken: STALE_TOKEN,
            sendWindowExpiresAt: new Date("2026-08-18T12:00:00.000Z"),
          },
        ];
      }
      if (sql.includes('update "guide_delivery" as delivery')) return [{ id: DELIVERY_ID }];
      return [];
    });
    const repository = createGuideDeliveryRepository({ database, maxAttempts: 3 });

    await (repository as never as {
      markWindowClosed(input: {
        deliveryId: string;
        claimToken: string;
        now: Date;
      }): Promise<boolean>;
    }).markWindowClosed({
      deliveryId: DELIVERY_ID,
      claimToken: STALE_TOKEN,
      now: NOW,
    });

    const deliveryUpdate = queries.find((query) => {
      const sql = normalizedSql(query);
      return sql.startsWith("update") && sql.includes('guide_delivery" as delivery');
    });
    expect(deliveryUpdate).toBeDefined();
    expectDeliveryFence(deliveryUpdate!);
    expect(normalizedSql(deliveryUpdate!)).toContain("messaging_window_closed");
  });

  it("rolls back a begun-unit window checkpoint if the delivery fence is lost", async () => {
    const { database, queries, tx } = createRecordingDatabase();
    tx.$queryRaw.mockImplementation(async (query: unknown) => {
      const captured = captureQuery(query);
      queries.push(captured);
      const sql = normalizedSql(captured);
      if (sql.startsWith("select") && sql.includes('from "guide_delivery" as delivery')) {
        return [
          {
            id: DELIVERY_ID,
            conversationId: "50000000-0000-4000-8000-000000000001",
            resourceId: "60000000-0000-4000-8000-000000000001",
            triggerKind: "inbound_reply",
            triggerId: "70000000-0000-4000-8000-000000000001",
            status: "sending",
            failureCode: null,
            nextAttemptAt: null,
            claimToken: STALE_TOKEN,
            sendWindowExpiresAt: new Date("2026-08-18T12:00:00.000Z"),
          },
        ];
      }
      if (sql.includes('update "guide_delivery_unit" as unit')) return [{ id: UNIT_ID }];
      return [];
    });
    const repository = createGuideDeliveryRepository({ database, maxAttempts: 3 });

    await expect(
      repository.markWindowClosed({
        deliveryId: DELIVERY_ID,
        claimToken: STALE_TOKEN,
        unitId: UNIT_ID,
        attempt: 2,
        now: NOW,
      }),
    ).rejects.toThrow("window checkpoint lost claim");
    expect(tx.eventLog.create).not.toHaveBeenCalled();
  });
});
