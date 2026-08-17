import { randomUUID } from "node:crypto";
import {
  Prisma,
  type GuideDelivery,
  type GuideDeliveryUnit,
  type PrismaClient,
} from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import type { GraphErrorMetadata, TransportCode } from "./eventLogger.js";
import type {
  GuideDeliveryPlanResult,
  GuideDeliveryTriggerKind,
} from "./guideDeliveryPlanner.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const COMPLETION_RECOVERY_LEASE_MS = 5 * 60_000;
const GRAPH_ERROR_CATEGORIES = new Set([
  "graph_response",
  "graph_transport",
  "unknown_error",
]);
const GRAPH_ERROR_METADATA_KEYS = new Set([
  "category",
  "httpStatus",
  "graphCode",
  "graphSubcode",
  "traceId",
  "transportCode",
]);
const TRANSPORT_CODES = new Set<TransportCode>([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "ERR_NETWORK",
  "ERR_CANCELED",
]);

export type GuideDeliveryDatabase = Pick<PrismaClient, "$transaction">;
type Transaction = Prisma.TransactionClient;

export type GuideDeliveryUnitRecord = GuideDeliveryUnit;
export type PlannedDeliveryRecord = GuideDelivery & { units: GuideDeliveryUnitRecord[] };
export type ClaimedGuideDelivery = Omit<PlannedDeliveryRecord, "claimToken" | "status"> & {
  claimToken: string;
  status: "sending";
};

export type CreateGuideDeliveryPlanInput = {
  conversationId: string;
  resourceId: string;
  threadId: string | null;
  triggerKind: GuideDeliveryTriggerKind;
  triggerId: string;
  triggeredAt: Date;
  sendWindowExpiresAt: Date;
  followerAtTrigger: boolean | null;
  plan: GuideDeliveryPlanResult;
};

export type ClaimGuideDeliveryInput = {
  deliveryId: string;
  now: Date;
  claimExpiresAt: Date;
};

export type ClaimDueGuideDeliveriesInput = {
  now: Date;
  claimExpiresAt: Date;
  limit: number;
};

export type BeginGuideUnitInput = {
  deliveryId: string;
  claimToken: string;
  now: Date;
  claimExpiresAt: Date;
};

type GuideUnitCheckpointInput = {
  deliveryId: string;
  unitId: string;
  claimToken: string;
  attempt: number;
  now: Date;
};

export type MarkGuideUnitSentInput = GuideUnitCheckpointInput & {
  providerMessageId: string | null;
  ownerConfirmedAt: Date | null;
};

type GuideUnitFailureCheckpointInput = GuideUnitCheckpointInput & {
  failureCode: string;
  error: GraphErrorMetadata;
};

export type MarkGuideUnitRetryableInput = GuideUnitFailureCheckpointInput & {
  nextAttemptAt: Date;
};

export type MarkGuideUnitFailedInput = GuideUnitFailureCheckpointInput & {
  /** A terminal attempt may still have been a definite transient rejection. */
  failureDisposition?: "permanent" | "transient";
};
export type MarkGuideUnitUncertainInput = GuideUnitFailureCheckpointInput;

export type MarkGuideDeliveryWindowClosedInput = {
  deliveryId: string;
  claimToken: string;
  now: Date;
  unitId?: string;
  attempt?: number;
};

export type ReleaseGuideDeliveryClaimInput = {
  deliveryId: string;
  claimToken: string;
  now: Date;
};

export type ExpiredClaimReconciliation = {
  needsReviewDeliveryIds: string[];
  releasedDeliveryIds: string[];
  terminalDeliveryIds: string[];
  completionPending: ClaimedGuideDelivery[];
};

export interface GuideDeliveryRepository {
  createOrLoadPlan(input: CreateGuideDeliveryPlanInput): Promise<PlannedDeliveryRecord>;
  claimById(input: ClaimGuideDeliveryInput): Promise<ClaimedGuideDelivery | null>;
  claimDueBatch(input: ClaimDueGuideDeliveriesInput): Promise<ClaimedGuideDelivery[]>;
  beginUnit(input: BeginGuideUnitInput): Promise<GuideDeliveryUnitRecord | null>;
  markUnitSent(input: MarkGuideUnitSentInput): Promise<boolean>;
  markUnitRetryable(input: MarkGuideUnitRetryableInput): Promise<boolean>;
  markUnitFailed(input: MarkGuideUnitFailedInput): Promise<boolean>;
  markUnitUncertain(input: MarkGuideUnitUncertainInput): Promise<boolean>;
  markWindowClosed(input: MarkGuideDeliveryWindowClosedInput): Promise<boolean>;
  releaseClaim(input: ReleaseGuideDeliveryClaimInput): Promise<boolean>;
  reconcileExpiredClaims(now: Date): Promise<ExpiredClaimReconciliation>;
}

type RepositoryOptions = {
  database?: GuideDeliveryDatabase;
  maxAttempts?: number;
};

type LockedDelivery = {
  id: string;
  conversationId: string;
  resourceId: string;
  triggerKind: GuideDeliveryTriggerKind;
  triggerId: string;
  status: GuideDelivery["status"];
  failureCode: string | null;
  nextAttemptAt: Date | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  sendWindowExpiresAt: Date;
};

function validateRepositoryOptions(options: RepositoryOptions): number {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("invalid guide delivery attempt cap");
  }
  return maxAttempts;
}

function validateLease(now: Date, claimExpiresAt: Date): void {
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(claimExpiresAt.getTime())) {
    throw new Error("invalid guide delivery lease");
  }
  if (claimExpiresAt <= now) throw new Error("invalid guide delivery lease");
}

function validateBatchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("invalid guide delivery batch limit");
  }
}

function validateFailureCode(failureCode: string): void {
  if (!/^[a-z0-9_]{1,64}$/.test(failureCode)) {
    throw new Error("invalid guide delivery failure code");
  }
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isGraphErrorMetadata(value: unknown): value is GraphErrorMetadata {
  if (!value || typeof value !== "object" || value instanceof Error) return false;
  if (Object.keys(value).some((key) => !GRAPH_ERROR_METADATA_KEYS.has(key))) return false;
  const candidate = value as Partial<GraphErrorMetadata>;
  if (typeof candidate.category !== "string" || !GRAPH_ERROR_CATEGORIES.has(candidate.category)) {
    return false;
  }
  if (
    !isNullableFiniteNumber(candidate.httpStatus) ||
    !isNullableFiniteNumber(candidate.graphCode) ||
    !isNullableFiniteNumber(candidate.graphSubcode)
  ) {
    return false;
  }
  if (
    candidate.traceId !== null &&
    (typeof candidate.traceId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.traceId))
  ) {
    return false;
  }
  return (
    candidate.transportCode === null ||
    (typeof candidate.transportCode === "string" &&
      TRANSPORT_CODES.has(candidate.transportCode as TransportCode))
  );
}

function requireGraphErrorMetadata(value: unknown): asserts value is GraphErrorMetadata {
  if (!isGraphErrorMetadata(value)) throw new Error("invalid graph error metadata");
}

function safeErrorEvent(error: GraphErrorMetadata): Prisma.InputJsonObject {
  return {
    category: error.category,
    httpStatus: error.httpStatus,
    graphCode: error.graphCode,
    graphSubcode: error.graphSubcode,
    traceId: error.traceId,
    transportCode: error.transportCode,
  };
}

function safePreflightError(
  error: Exclude<GuideDeliveryPlanResult, { ok: true }>["error"],
): Prisma.InputJsonObject {
  return {
    code: error.code,
    resourceMessageId: error.resourceMessageId,
    authoredOrder: error.authoredOrder,
    unitKind: error.unitKind,
    actualLength: error.actualLength,
    limit: error.limit,
  };
}

function eventIdentity(delivery: LockedDelivery): Prisma.InputJsonObject {
  return {
    deliveryId: delivery.id,
    conversationId: delivery.conversationId,
    resourceId: delivery.resourceId,
    triggerKind: delivery.triggerKind,
    triggerId: delivery.triggerId,
  };
}

function isDue(delivery: LockedDelivery, now: Date): boolean {
  if (delivery.status === "planned") return true;
  return (
    delivery.status === "failed" &&
    delivery.nextAttemptAt !== null &&
    delivery.nextAttemptAt <= now
  );
}

function asClaimed(record: PlannedDeliveryRecord): ClaimedGuideDelivery {
  if (record.status !== "sending" || record.claimToken === null) {
    throw new Error("guide delivery claim not recorded");
  }
  return record as ClaimedGuideDelivery;
}

async function loadDelivery(
  tx: Transaction,
  deliveryId: string,
): Promise<PlannedDeliveryRecord> {
  return tx.guideDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: { units: { orderBy: { position: "asc" } } },
  });
}

async function lockDelivery(
  tx: Transaction,
  deliveryId: string,
): Promise<LockedDelivery | null> {
  const rows = await tx.$queryRaw<LockedDelivery[]>(Prisma.sql`
    SELECT
      delivery."id",
      delivery."conversation_id" AS "conversationId",
      delivery."resource_id" AS "resourceId",
      delivery."trigger_kind"::text AS "triggerKind",
      delivery."trigger_id" AS "triggerId",
      delivery."status"::text AS "status",
      delivery."failure_code" AS "failureCode",
      delivery."next_attempt_at" AS "nextAttemptAt",
      delivery."claim_token" AS "claimToken",
      delivery."claim_expires_at" AS "claimExpiresAt",
      delivery."send_window_expires_at" AS "sendWindowExpiresAt"
    FROM "guide_delivery" AS delivery
    WHERE delivery."id" = ${deliveryId}::uuid
    FOR UPDATE OF delivery
  `);
  return rows[0] ?? null;
}

async function lockClaimedDelivery(
  tx: Transaction,
  deliveryId: string,
  claimToken: string,
): Promise<LockedDelivery | null> {
  const rows = await tx.$queryRaw<LockedDelivery[]>(Prisma.sql`
    SELECT
      delivery."id",
      delivery."conversation_id" AS "conversationId",
      delivery."resource_id" AS "resourceId",
      delivery."trigger_kind"::text AS "triggerKind",
      delivery."trigger_id" AS "triggerId",
      delivery."status"::text AS "status",
      delivery."failure_code" AS "failureCode",
      delivery."next_attempt_at" AS "nextAttemptAt",
      delivery."claim_token" AS "claimToken",
      delivery."claim_expires_at" AS "claimExpiresAt",
      delivery."send_window_expires_at" AS "sendWindowExpiresAt"
    FROM "guide_delivery" AS delivery
    WHERE delivery."id" = ${deliveryId}::uuid
      AND delivery."claim_token" = ${claimToken}::uuid
      AND delivery."status" = 'sending'
    FOR UPDATE OF delivery
  `);
  return rows[0] ?? null;
}

async function lockAndLoadUnits(
  tx: Transaction,
  deliveryId: string,
): Promise<GuideDeliveryUnitRecord[]> {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT unit."id"
    FROM "guide_delivery_unit" AS unit
    WHERE unit."delivery_id" = ${deliveryId}::uuid
    ORDER BY unit."position" ASC
    FOR UPDATE OF unit
  `);
  return tx.guideDeliveryUnit.findMany({
    where: { deliveryId },
    orderBy: { position: "asc" },
  });
}

function unitEvent(
  delivery: LockedDelivery,
  unit: GuideDeliveryUnitRecord,
  attempt: number,
  at: Date,
): Prisma.InputJsonObject {
  return {
    ...eventIdentity(delivery),
    unitId: unit.id,
    position: unit.position,
    unitKind: unit.kind,
    attempt,
    at: at.toISOString(),
  };
}

async function setWindowClosed(
  tx: Transaction,
  delivery: LockedDelivery,
  now: Date,
): Promise<void> {
  const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "guide_delivery" AS delivery
    SET
      "status" = 'failed',
      "failure_code" = 'messaging_window_closed',
      "next_attempt_at" = NULL,
      "updated_at" = ${now}
    WHERE delivery."id" = ${delivery.id}::uuid
      AND delivery."claim_token" IS NULL
      AND (
        delivery."status" = 'planned'
        OR (
          delivery."status" = 'failed'
          AND delivery."next_attempt_at" IS NOT NULL
          AND delivery."next_attempt_at" <= ${now}
        )
      )
    RETURNING delivery."id"
  `);
  if (updated.length !== 1) throw new Error("guide delivery window close lost state");
  await tx.eventLog.create({
    data: {
      kind: "guide_delivery_window_closed",
      payload: { ...eventIdentity(delivery), at: now.toISOString() },
    },
  });
}

function allUnitsSent(units: readonly GuideDeliveryUnitRecord[]): boolean {
  return units.length > 0 && units.every((unit) => unit.status === "sent");
}

export function createGuideDeliveryRepository(
  options: RepositoryOptions = {},
): GuideDeliveryRepository {
  const database = options.database ?? prisma;
  const maxAttempts = validateRepositoryOptions(options);

  return {
    async createOrLoadPlan(input) {
      return database.$transaction(async (tx) => {
        const emptyPlan = input.plan.ok && input.plan.units.length === 0;
        const rejected = !input.plan.ok || emptyPlan;
        const status = rejected ? "failed" : "planned";
        const failureCode = rejected ? "invalid_plan" : null;
        const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "guide_delivery" (
            "conversation_id",
            "resource_id",
            "thread_id",
            "trigger_kind",
            "trigger_id",
            "triggered_at",
            "send_window_expires_at",
            "follower_at_trigger",
            "status",
            "failure_code"
          ) VALUES (
            ${input.conversationId}::uuid,
            ${input.resourceId}::uuid,
            ${input.threadId}::uuid,
            ${input.triggerKind}::"guide_delivery_trigger_kind",
            ${input.triggerId}::uuid,
            ${input.triggeredAt},
            ${input.sendWindowExpiresAt},
            ${input.followerAtTrigger},
            ${status}::"guide_delivery_status",
            ${failureCode}
          )
          ON CONFLICT ("trigger_kind", "trigger_id") DO NOTHING
          RETURNING "id"
        `);

        const insertedId = inserted[0]?.id;
        if (insertedId) {
          if (input.plan.ok && !emptyPlan) {
            await tx.guideDeliveryUnit.createMany({
              data: input.plan.units.map((unit) => ({ ...unit, deliveryId: insertedId })),
            });
            await tx.eventLog.create({
              data: {
                kind: "guide_delivery_planned",
                payload: {
                  deliveryId: insertedId,
                  conversationId: input.conversationId,
                  resourceId: input.resourceId,
                  triggerKind: input.triggerKind,
                  triggerId: input.triggerId,
                  unitCount: input.plan.units.length,
                },
              },
            });
          } else {
            const error = input.plan.ok
              ? {
                  code: "empty_plan",
                  resourceMessageId: null,
                  authoredOrder: null,
                  unitKind: null,
                  actualLength: null,
                  limit: null,
                }
              : safePreflightError(input.plan.error);
            await tx.eventLog.create({
              data: {
                kind: "guide_delivery_preflight_rejected",
                payload: {
                  deliveryId: insertedId,
                  conversationId: input.conversationId,
                  resourceId: input.resourceId,
                  triggerKind: input.triggerKind,
                  triggerId: input.triggerId,
                  failureCode,
                  error,
                },
              },
            });
          }
          return loadDelivery(tx, insertedId);
        }

        const existing = await tx.guideDelivery.findUnique({
          where: {
            triggerKind_triggerId: {
              triggerKind: input.triggerKind,
              triggerId: input.triggerId,
            },
          },
          include: { units: { orderBy: { position: "asc" } } },
        });
        if (!existing) throw new Error("guide delivery plan conflict not visible");
        return existing;
      });
    },

    async claimById(input) {
      validateLease(input.now, input.claimExpiresAt);
      const claimToken = randomUUID();
      return database.$transaction(async (tx) => {
        const delivery = await lockDelivery(tx, input.deliveryId);
        if (!delivery || delivery.claimToken !== null || !isDue(delivery, input.now)) {
          return null;
        }

        const units = await lockAndLoadUnits(tx, input.deliveryId);
        if (units.length === 0) {
          const terminalized = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            UPDATE "guide_delivery" AS delivery
            SET
              "status" = 'failed',
              "failure_code" = 'invalid_plan',
              "next_attempt_at" = NULL,
              "updated_at" = ${input.now}
            WHERE delivery."id" = ${input.deliveryId}::uuid
              AND delivery."claim_token" IS NULL
              AND (
                delivery."status" = 'planned'
                OR (
                  delivery."status" = 'failed'
                  AND delivery."next_attempt_at" IS NOT NULL
                  AND delivery."next_attempt_at" <= ${input.now}
                )
              )
            RETURNING delivery."id"
          `);
          if (terminalized.length === 1) {
            await tx.eventLog.create({
              data: {
                kind: "guide_delivery_preflight_rejected",
                payload: {
                  ...eventIdentity(delivery),
                  failureCode: "invalid_plan",
                  error: { code: "empty_plan" },
                  detectedAt: input.now.toISOString(),
                },
              },
            });
          }
          return null;
        }

        if (delivery.sendWindowExpiresAt <= input.now && !allUnitsSent(units)) {
          await setWindowClosed(tx, delivery, input.now);
          return null;
        }

        const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "guide_delivery" AS delivery
          SET
            "status" = 'sending',
            "failure_code" = NULL,
            "next_attempt_at" = NULL,
            "claim_token" = ${claimToken}::uuid,
            "claimed_at" = ${input.now},
            "claim_expires_at" = ${input.claimExpiresAt},
            "started_at" = COALESCE(delivery."started_at", ${input.now}),
            "updated_at" = ${input.now}
          WHERE delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" IS NULL
            AND (
              delivery."status" = 'planned'
              OR (
                delivery."status" = 'failed'
                AND delivery."next_attempt_at" IS NOT NULL
                AND delivery."next_attempt_at" <= ${input.now}
              )
            )
            AND EXISTS (
              SELECT 1
              FROM "guide_delivery_unit" AS unit
              WHERE unit."delivery_id" = delivery."id"
            )
            AND (
              delivery."send_window_expires_at" > ${input.now}
              OR NOT EXISTS (
                SELECT 1
                FROM "guide_delivery_unit" AS unit
                WHERE unit."delivery_id" = delivery."id"
                  AND unit."status" <> 'sent'
              )
            )
          RETURNING delivery."id"
        `);
        if (updated.length !== 1) return null;
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_claimed",
            payload: { ...eventIdentity(delivery), claimedAt: input.now.toISOString() },
          },
        });
        return asClaimed(await loadDelivery(tx, input.deliveryId));
      });
    },

    async claimDueBatch(input) {
      validateLease(input.now, input.claimExpiresAt);
      validateBatchLimit(input.limit);
      const claimTokens = Array.from({ length: input.limit }, () => randomUUID());
      const tokenValues = Prisma.join(
        claimTokens.map((token, ordinal) => Prisma.sql`(${ordinal}, ${token}::uuid)`),
      );

      return database.$transaction(async (tx) => {
        const empty = await tx.$queryRaw<LockedDelivery[]>(Prisma.sql`
          WITH invalid AS (
            SELECT delivery."id"
            FROM "guide_delivery" AS delivery
            WHERE delivery."claim_token" IS NULL
              AND (
                delivery."status" = 'planned'
                OR (
                  delivery."status" = 'failed'
                  AND delivery."next_attempt_at" IS NOT NULL
                  AND delivery."next_attempt_at" <= ${input.now}
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM "guide_delivery_unit" AS unit
                WHERE unit."delivery_id" = delivery."id"
              )
            ORDER BY COALESCE(delivery."next_attempt_at", delivery."created_at"), delivery."created_at", delivery."id"
            FOR UPDATE OF delivery SKIP LOCKED
            LIMIT ${input.limit}
          )
          UPDATE "guide_delivery" AS delivery
          SET
            "status" = 'failed',
            "failure_code" = 'invalid_plan',
            "next_attempt_at" = NULL,
            "updated_at" = ${input.now}
          FROM invalid
          WHERE delivery."id" = invalid."id"
          RETURNING
            delivery."id",
            delivery."conversation_id" AS "conversationId",
            delivery."resource_id" AS "resourceId",
            delivery."trigger_kind"::text AS "triggerKind",
            delivery."trigger_id" AS "triggerId",
            delivery."status"::text AS "status",
            delivery."failure_code" AS "failureCode",
            delivery."next_attempt_at" AS "nextAttemptAt",
            delivery."claim_token" AS "claimToken",
            delivery."send_window_expires_at" AS "sendWindowExpiresAt"
        `);
        if (empty.length > 0) {
          await tx.eventLog.createMany({
            data: empty.map((delivery) => ({
              kind: "guide_delivery_preflight_rejected",
              payload: {
                ...eventIdentity(delivery),
                failureCode: "invalid_plan",
                error: { code: "empty_plan" },
                detectedAt: input.now.toISOString(),
              },
            })),
          });
        }

        const closed = await tx.$queryRaw<LockedDelivery[]>(Prisma.sql`
          WITH expired AS (
            SELECT delivery."id"
            FROM "guide_delivery" AS delivery
            WHERE delivery."claim_token" IS NULL
              AND (
                delivery."status" = 'planned'
                OR (
                  delivery."status" = 'failed'
                  AND delivery."next_attempt_at" IS NOT NULL
                  AND delivery."next_attempt_at" <= ${input.now}
                )
              )
              AND delivery."send_window_expires_at" <= ${input.now}
              AND EXISTS (
                SELECT 1 FROM "guide_delivery_unit" AS unit
                WHERE unit."delivery_id" = delivery."id"
                  AND unit."status" <> 'sent'
              )
            ORDER BY COALESCE(delivery."next_attempt_at", delivery."created_at"), delivery."created_at", delivery."id"
            FOR UPDATE OF delivery SKIP LOCKED
            LIMIT ${input.limit}
          )
          UPDATE "guide_delivery" AS delivery
          SET
            "status" = 'failed',
            "failure_code" = 'messaging_window_closed',
            "next_attempt_at" = NULL,
            "updated_at" = ${input.now}
          FROM expired
          WHERE delivery."id" = expired."id"
          RETURNING
            delivery."id",
            delivery."conversation_id" AS "conversationId",
            delivery."resource_id" AS "resourceId",
            delivery."trigger_kind"::text AS "triggerKind",
            delivery."trigger_id" AS "triggerId",
            delivery."status"::text AS "status",
            delivery."failure_code" AS "failureCode",
            delivery."next_attempt_at" AS "nextAttemptAt",
            delivery."claim_token" AS "claimToken",
            delivery."send_window_expires_at" AS "sendWindowExpiresAt"
        `);
        if (closed.length > 0) {
          await tx.eventLog.createMany({
            data: closed.map((delivery) => ({
              kind: "guide_delivery_window_closed",
              payload: { ...eventIdentity(delivery), at: input.now.toISOString() },
            })),
          });
        }

        const claimedRows = await tx.$queryRaw<Array<{ claimToken: string; id: string }>>(
          Prisma.sql`
            WITH tokens ("ordinal", "token") AS (VALUES ${tokenValues}),
            due AS MATERIALIZED (
              SELECT
                delivery."id",
                delivery."next_attempt_at",
                delivery."created_at"
              FROM "guide_delivery" AS delivery
              WHERE delivery."claim_token" IS NULL
                AND (
                  delivery."status" = 'planned'
                  OR (
                    delivery."status" = 'failed'
                    AND delivery."next_attempt_at" IS NOT NULL
                    AND delivery."next_attempt_at" <= ${input.now}
                  )
                )
                AND EXISTS (
                  SELECT 1 FROM "guide_delivery_unit" AS unit
                  WHERE unit."delivery_id" = delivery."id"
                )
                AND (
                  delivery."send_window_expires_at" > ${input.now}
                  OR NOT EXISTS (
                    SELECT 1 FROM "guide_delivery_unit" AS unit
                    WHERE unit."delivery_id" = delivery."id"
                      AND unit."status" <> 'sent'
                  )
                )
              ORDER BY COALESCE(delivery."next_attempt_at", delivery."created_at"), delivery."created_at", delivery."id"
              FOR UPDATE OF delivery SKIP LOCKED
              LIMIT ${input.limit}
            ),
            numbered AS (
              SELECT
                due."id",
                row_number() OVER (
                  ORDER BY COALESCE(due."next_attempt_at", due."created_at"), due."created_at", due."id"
                ) - 1 AS "ordinal"
              FROM due
            )
            UPDATE "guide_delivery" AS delivery
            SET
              "status" = 'sending',
              "failure_code" = NULL,
              "next_attempt_at" = NULL,
              "claim_token" = tokens."token",
              "claimed_at" = ${input.now},
              "claim_expires_at" = ${input.claimExpiresAt},
              "started_at" = COALESCE(delivery."started_at", ${input.now}),
              "updated_at" = ${input.now}
            FROM numbered
            JOIN tokens ON tokens."ordinal" = numbered."ordinal"
            WHERE delivery."id" = numbered."id"
            RETURNING delivery."id", delivery."claim_token" AS "claimToken"
          `,
        );
        if (claimedRows.length === 0) return [];

        const records = await tx.guideDelivery.findMany({
          where: { id: { in: claimedRows.map((row) => row.id) } },
          include: { units: { orderBy: { position: "asc" } } },
        });
        await tx.eventLog.createMany({
          data: records.map((delivery) => ({
            kind: "guide_delivery_claimed",
            payload: {
              deliveryId: delivery.id,
              conversationId: delivery.conversationId,
              resourceId: delivery.resourceId,
              triggerKind: delivery.triggerKind,
              triggerId: delivery.triggerId,
              claimedAt: input.now.toISOString(),
            },
          })),
        });
        const recordsById = new Map(records.map((record) => [record.id, asClaimed(record)]));
        return claimedRows
          .map((row) => recordsById.get(row.id))
          .filter((row): row is ClaimedGuideDelivery => row !== undefined);
      });
    },

    async beginUnit(input) {
      validateLease(input.now, input.claimExpiresAt);
      return database.$transaction(async (tx) => {
        const delivery = await lockClaimedDelivery(tx, input.deliveryId, input.claimToken);
        if (!delivery) return null;
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        const unit = units.find((candidate) => candidate.status !== "sent");
        if (!unit || (unit.status !== "pending" && unit.status !== "retryable")) return null;

        const ownerAuthorized =
          unit.ownerRetryAuthorizedAt !== null && unit.ownerRetryConsumedAt === null;
        if (unit.attempts >= maxAttempts && !ownerAuthorized) return null;

        const renewed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "guide_delivery" AS delivery
          SET
            "claim_expires_at" = ${input.claimExpiresAt},
            "updated_at" = ${input.now}
          WHERE delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
            AND delivery."claim_expires_at" > ${input.now}
          RETURNING delivery."id"
        `);
        if (renewed.length !== 1) return null;

        const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "guide_delivery_unit" AS unit
          SET
            "status" = 'sending',
            "attempts" = unit."attempts" + 1,
            "sending_at" = ${input.now},
            "sent_at" = NULL,
            "owner_confirmed_at" = NULL,
            "failure_disposition" = NULL,
            "provider_message_id" = NULL,
            "error_category" = NULL,
            "error_http_status" = NULL,
            "error_graph_code" = NULL,
            "error_graph_subcode" = NULL,
            "error_trace_id" = NULL,
            "error_transport_code" = NULL,
            "owner_retry_consumed_at" = CASE
              WHEN unit."owner_retry_authorized_at" IS NOT NULL
                AND unit."owner_retry_consumed_at" IS NULL
              THEN ${input.now}
              ELSE unit."owner_retry_consumed_at"
            END,
            "updated_at" = ${input.now}
          FROM "guide_delivery" AS delivery
          WHERE unit."id" = ${unit.id}::uuid
            AND unit."delivery_id" = delivery."id"
            AND unit."status" IN ('pending', 'retryable')
            AND unit."attempts" = ${unit.attempts}
            AND (
              unit."attempts" < ${maxAttempts}
              OR (
                unit."owner_retry_authorized_at" IS NOT NULL
                AND unit."owner_retry_consumed_at" IS NULL
              )
            )
            AND delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
            AND delivery."claim_expires_at" = ${input.claimExpiresAt}
          RETURNING unit."id"
        `);
        if (updated.length !== 1) return null;
        const begun = await tx.guideDeliveryUnit.findUniqueOrThrow({ where: { id: unit.id } });
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_unit_started",
            payload: unitEvent(delivery, begun, begun.attempts, input.now),
          },
        });
        return begun;
      });
    },

    async markUnitSent(input) {
      if (
        (input.providerMessageId === null || input.providerMessageId === "") &&
        input.ownerConfirmedAt === null
      ) {
        throw new Error("sent checkpoint requires provider or owner confirmation");
      }
      return database.$transaction(async (tx) => {
        const delivery = await lockClaimedDelivery(tx, input.deliveryId, input.claimToken);
        if (!delivery) return false;
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        const unit = units.find((candidate) => candidate.id === input.unitId);
        if (!unit || unit.status !== "sending" || unit.attempts !== input.attempt) return false;

        const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "guide_delivery_unit" AS unit
          SET
            "status" = 'sent',
            "provider_message_id" = ${input.providerMessageId},
            "sent_at" = ${input.now},
            "owner_confirmed_at" = ${input.ownerConfirmedAt},
            "failure_disposition" = NULL,
            "error_category" = NULL,
            "error_http_status" = NULL,
            "error_graph_code" = NULL,
            "error_graph_subcode" = NULL,
            "error_trace_id" = NULL,
            "error_transport_code" = NULL,
            "updated_at" = ${input.now}
          FROM "guide_delivery" AS delivery
          WHERE unit."id" = ${input.unitId}::uuid
            AND unit."delivery_id" = delivery."id"
            AND unit."status" = 'sending'
            AND unit."attempts" = ${input.attempt}
            AND delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING unit."id"
        `);
        if (updated.length !== 1) return false;
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_unit_sent",
            payload: {
              ...unitEvent(delivery, unit, input.attempt, input.now),
              providerMessageId: input.providerMessageId,
              ownerConfirmed: input.ownerConfirmedAt !== null,
            },
          },
        });
        return true;
      });
    },

    async markUnitRetryable(input) {
      validateFailureCode(input.failureCode);
      requireGraphErrorMetadata(input.error);
      if (!Number.isFinite(input.nextAttemptAt.getTime()) || input.nextAttemptAt <= input.now) {
        throw new Error("invalid guide delivery retry time");
      }
      return database.$transaction(async (tx) => {
        const delivery = await lockClaimedDelivery(tx, input.deliveryId, input.claimToken);
        if (!delivery) return false;
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        const unit = units.find((candidate) => candidate.id === input.unitId);
        if (!unit || unit.status !== "sending" || unit.attempts !== input.attempt) return false;

        const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "guide_delivery_unit" AS unit
          SET
            "status" = 'retryable',
            "failure_disposition" = 'transient',
            "error_category" = ${input.error.category},
            "error_http_status" = ${input.error.httpStatus},
            "error_graph_code" = ${input.error.graphCode},
            "error_graph_subcode" = ${input.error.graphSubcode},
            "error_trace_id" = ${input.error.traceId},
            "error_transport_code" = ${input.error.transportCode},
            "updated_at" = ${input.now}
          FROM "guide_delivery" AS delivery
          WHERE unit."id" = ${input.unitId}::uuid
            AND unit."delivery_id" = delivery."id"
            AND unit."status" = 'sending'
            AND unit."attempts" = ${input.attempt}
            AND delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING unit."id"
        `);
        if (updated.length !== 1) return false;

        const deliveryUpdated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "guide_delivery" AS delivery
          SET
            "status" = 'failed',
            "failure_code" = ${input.failureCode},
            "next_attempt_at" = ${input.nextAttemptAt},
            "claim_token" = NULL,
            "claimed_at" = NULL,
            "claim_expires_at" = NULL,
            "updated_at" = ${input.now}
          WHERE delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING delivery."id"
        `);
        if (deliveryUpdated.length !== 1) throw new Error("guide delivery retry checkpoint lost claim");
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_unit_retryable",
            payload: {
              ...unitEvent(delivery, unit, input.attempt, input.now),
              nextAttemptAt: input.nextAttemptAt.toISOString(),
              error: safeErrorEvent(input.error),
            },
          },
        });
        return true;
      });
    },

    async markUnitFailed(input) {
      validateFailureCode(input.failureCode);
      requireGraphErrorMetadata(input.error);
      const failureDisposition = input.failureDisposition ?? "permanent";
      if (failureDisposition !== "permanent" && failureDisposition !== "transient") {
        throw new Error("invalid guide delivery failure disposition");
      }
      return database.$transaction(async (tx) => {
        const delivery = await lockClaimedDelivery(tx, input.deliveryId, input.claimToken);
        if (!delivery) return false;
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        const unit = units.find((candidate) => candidate.id === input.unitId);
        if (!unit || unit.status !== "sending" || unit.attempts !== input.attempt) return false;

        const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "guide_delivery_unit" AS unit
          SET
            "status" = 'failed',
            "failure_disposition" = ${failureDisposition}::"guide_delivery_failure_disposition",
            "error_category" = ${input.error.category},
            "error_http_status" = ${input.error.httpStatus},
            "error_graph_code" = ${input.error.graphCode},
            "error_graph_subcode" = ${input.error.graphSubcode},
            "error_trace_id" = ${input.error.traceId},
            "error_transport_code" = ${input.error.transportCode},
            "updated_at" = ${input.now}
          FROM "guide_delivery" AS delivery
          WHERE unit."id" = ${input.unitId}::uuid
            AND unit."delivery_id" = delivery."id"
            AND unit."status" = 'sending'
            AND unit."attempts" = ${input.attempt}
            AND delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING unit."id"
        `);
        if (updated.length !== 1) return false;
        const deliveryUpdated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "guide_delivery" AS delivery
          SET
            "status" = 'failed',
            "failure_code" = ${input.failureCode},
            "next_attempt_at" = NULL,
            "claim_token" = NULL,
            "claimed_at" = NULL,
            "claim_expires_at" = NULL,
            "updated_at" = ${input.now}
          WHERE delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING delivery."id"
        `);
        if (deliveryUpdated.length !== 1) throw new Error("guide delivery failure checkpoint lost claim");
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_unit_failed",
            payload: {
              ...unitEvent(delivery, unit, input.attempt, input.now),
              error: safeErrorEvent(input.error),
            },
          },
        });
        return true;
      });
    },

    async markUnitUncertain(input) {
      validateFailureCode(input.failureCode);
      requireGraphErrorMetadata(input.error);
      return database.$transaction(async (tx) => {
        const delivery = await lockClaimedDelivery(tx, input.deliveryId, input.claimToken);
        if (!delivery) return false;
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        const unit = units.find((candidate) => candidate.id === input.unitId);
        if (!unit || unit.status !== "sending" || unit.attempts !== input.attempt) return false;

        const updated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "guide_delivery_unit" AS unit
          SET
            "status" = 'uncertain',
            "failure_disposition" = NULL,
            "error_category" = ${input.error.category},
            "error_http_status" = ${input.error.httpStatus},
            "error_graph_code" = ${input.error.graphCode},
            "error_graph_subcode" = ${input.error.graphSubcode},
            "error_trace_id" = ${input.error.traceId},
            "error_transport_code" = ${input.error.transportCode},
            "updated_at" = ${input.now}
          FROM "guide_delivery" AS delivery
          WHERE unit."id" = ${input.unitId}::uuid
            AND unit."delivery_id" = delivery."id"
            AND unit."status" = 'sending'
            AND unit."attempts" = ${input.attempt}
            AND delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING unit."id"
        `);
        if (updated.length !== 1) return false;
        const deliveryUpdated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "guide_delivery" AS delivery
          SET
            "status" = 'needs_review',
            "failure_code" = ${input.failureCode},
            "next_attempt_at" = NULL,
            "claim_token" = NULL,
            "claimed_at" = NULL,
            "claim_expires_at" = NULL,
            "updated_at" = ${input.now}
          WHERE delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING delivery."id"
        `);
        if (deliveryUpdated.length !== 1) throw new Error("guide delivery uncertainty checkpoint lost claim");
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_unit_uncertain",
            payload: {
              ...unitEvent(delivery, unit, input.attempt, input.now),
              error: safeErrorEvent(input.error),
            },
          },
        });
        return true;
      });
    },

    async markWindowClosed(input) {
      const hasUnit = input.unitId !== undefined;
      const hasAttempt = input.attempt !== undefined;
      if (
        hasUnit !== hasAttempt ||
        (hasAttempt && (!Number.isInteger(input.attempt) || input.attempt! < 1))
      ) {
        throw new Error("invalid guide delivery window checkpoint");
      }

      return database.$transaction(async (tx) => {
        const delivery = await lockClaimedDelivery(tx, input.deliveryId, input.claimToken);
        if (!delivery) return false;
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        const closingUnit = hasUnit
          ? units.find((candidate) => candidate.id === input.unitId) ?? null
          : null;

        if (hasUnit) {
          if (
            !closingUnit ||
            closingUnit.status !== "sending" ||
            closingUnit.attempts !== input.attempt
          ) {
            return false;
          }
          const unitUpdated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            UPDATE "guide_delivery_unit" AS unit
            SET
              "status" = 'failed',
              "failure_disposition" = 'permanent',
              "updated_at" = ${input.now}
            FROM "guide_delivery" AS delivery
            WHERE unit."id" = ${closingUnit.id}::uuid
              AND unit."delivery_id" = delivery."id"
              AND unit."status" = 'sending'
              AND unit."attempts" = ${input.attempt}
              AND delivery."id" = ${input.deliveryId}::uuid
              AND delivery."claim_token" = ${input.claimToken}::uuid
              AND delivery."status" = 'sending'
            RETURNING unit."id"
          `);
          if (unitUpdated.length !== 1) return false;
        } else if (units.some((unit) => unit.status === "sending")) {
          return false;
        }

        const deliveryUpdated = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "guide_delivery" AS delivery
          SET
            "status" = 'failed',
            "failure_code" = 'messaging_window_closed',
            "next_attempt_at" = NULL,
            "claim_token" = NULL,
            "claimed_at" = NULL,
            "claim_expires_at" = NULL,
            "updated_at" = ${input.now}
          WHERE delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING delivery."id"
        `);
        if (deliveryUpdated.length !== 1) {
          throw new Error("guide delivery window checkpoint lost claim");
        }
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_window_closed",
            payload: {
              ...eventIdentity(delivery),
              unitId: closingUnit?.id ?? null,
              position: closingUnit?.position ?? null,
              unitKind: closingUnit?.kind ?? null,
              attempt: closingUnit?.attempts ?? null,
              at: input.now.toISOString(),
            },
          },
        });
        return true;
      });
    },

    async releaseClaim(input) {
      return database.$transaction(async (tx) => {
        const released = await tx.$queryRaw<LockedDelivery[]>(Prisma.sql`
          UPDATE "guide_delivery" AS delivery
          SET
            "status" = 'planned',
            "failure_code" = NULL,
            "next_attempt_at" = NULL,
            "claim_token" = NULL,
            "claimed_at" = NULL,
            "claim_expires_at" = NULL,
            "updated_at" = ${input.now}
          WHERE delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
            AND NOT EXISTS (
              SELECT 1
              FROM "guide_delivery_unit" AS unit
              WHERE unit."delivery_id" = delivery."id"
                AND (
                  unit."status" = 'sending'
                  OR unit."status" IN ('failed', 'uncertain', 'cancelled')
                )
            )
          RETURNING
            delivery."id",
            delivery."conversation_id" AS "conversationId",
            delivery."resource_id" AS "resourceId",
            delivery."trigger_kind"::text AS "triggerKind",
            delivery."trigger_id" AS "triggerId",
            delivery."status"::text AS "status",
            delivery."failure_code" AS "failureCode",
            delivery."next_attempt_at" AS "nextAttemptAt",
            delivery."claim_token" AS "claimToken",
            delivery."send_window_expires_at" AS "sendWindowExpiresAt"
        `);
        const delivery = released[0];
        if (!delivery) return false;
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_claim_released",
            payload: { ...eventIdentity(delivery), releasedAt: input.now.toISOString() },
          },
        });
        return true;
      });
    },

    async reconcileExpiredClaims(now) {
      const result: ExpiredClaimReconciliation = {
        needsReviewDeliveryIds: [],
        releasedDeliveryIds: [],
        terminalDeliveryIds: [],
        completionPending: [],
      };

      while (true) {
        const completionClaimToken = randomUUID();
        const outcome = await database.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<LockedDelivery[]>(Prisma.sql`
            SELECT
              delivery."id",
              delivery."conversation_id" AS "conversationId",
              delivery."resource_id" AS "resourceId",
              delivery."trigger_kind"::text AS "triggerKind",
              delivery."trigger_id" AS "triggerId",
              delivery."status"::text AS "status",
              delivery."failure_code" AS "failureCode",
              delivery."next_attempt_at" AS "nextAttemptAt",
              delivery."claim_token" AS "claimToken",
              delivery."send_window_expires_at" AS "sendWindowExpiresAt"
            FROM "guide_delivery" AS delivery
            WHERE delivery."status" = 'sending'
              AND delivery."claim_token" IS NOT NULL
              AND delivery."claim_expires_at" <= ${now}
            ORDER BY delivery."claim_expires_at", delivery."id"
            FOR UPDATE OF delivery SKIP LOCKED
            LIMIT 1
          `);
          const delivery = rows[0];
          if (!delivery || delivery.claimToken === null) return { kind: "none" as const };
          const units = await lockAndLoadUnits(tx, delivery.id);
          const sendingUnits = units.filter((unit) => unit.status === "sending");

          if (sendingUnits.length > 0) {
            const uncertain = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              UPDATE "guide_delivery_unit" AS unit
              SET
                "status" = 'uncertain',
                "failure_disposition" = NULL,
                "updated_at" = ${now}
              FROM "guide_delivery" AS delivery
              WHERE unit."delivery_id" = delivery."id"
                AND unit."status" = 'sending'
                AND delivery."id" = ${delivery.id}::uuid
                AND delivery."claim_token" = ${delivery.claimToken}::uuid
                AND delivery."status" = 'sending'
              RETURNING unit."id"
            `);
            if (uncertain.length !== sendingUnits.length) {
              throw new Error("guide delivery expired sending reconciliation lost units");
            }
            const moved = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              UPDATE "guide_delivery" AS delivery
              SET
                "status" = 'needs_review',
                "failure_code" = 'provider_outcome_uncertain',
                "next_attempt_at" = NULL,
                "claim_token" = NULL,
                "claimed_at" = NULL,
                "claim_expires_at" = NULL,
                "updated_at" = ${now}
              WHERE delivery."id" = ${delivery.id}::uuid
                AND delivery."claim_token" = ${delivery.claimToken}::uuid
                AND delivery."status" = 'sending'
              RETURNING delivery."id"
            `);
            if (moved.length !== 1) throw new Error("guide delivery expired claim lost state");
            await tx.eventLog.create({
              data: {
                kind: "guide_delivery_claim_reconciled",
                payload: {
                  ...eventIdentity(delivery),
                  outcome: "needs_review",
                  uncertainUnitCount: sendingUnits.length,
                  reconciledAt: now.toISOString(),
                },
              },
            });
            return { kind: "needs_review" as const, deliveryId: delivery.id };
          }

          if (allUnitsSent(units)) {
            const claimExpiresAt = new Date(now.getTime() + COMPLETION_RECOVERY_LEASE_MS);
            const reclaimed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              UPDATE "guide_delivery" AS delivery
              SET
                "failure_code" = NULL,
                "next_attempt_at" = NULL,
                "claim_token" = ${completionClaimToken}::uuid,
                "claimed_at" = ${now},
                "claim_expires_at" = ${claimExpiresAt},
                "updated_at" = ${now}
              WHERE delivery."id" = ${delivery.id}::uuid
                AND delivery."claim_token" = ${delivery.claimToken}::uuid
                AND delivery."status" = 'sending'
              RETURNING delivery."id"
            `);
            if (reclaimed.length !== 1) {
              throw new Error("guide delivery completion reclaim lost state");
            }
            await tx.eventLog.create({
              data: {
                kind: "guide_delivery_completion_reclaimed",
                payload: {
                  ...eventIdentity(delivery),
                  unitCount: units.length,
                  reclaimedAt: now.toISOString(),
                },
              },
            });
            return {
              kind: "completion" as const,
              delivery: asClaimed(await loadDelivery(tx, delivery.id)),
            };
          }

          const hasUncertain = units.some((unit) => unit.status === "uncertain");
          const hasTerminalUnit =
            units.length === 0 ||
            units.some(
              (unit) =>
                unit.status === "failed" ||
                unit.status === "cancelled",
            );
          const nextStatus = hasUncertain
            ? "needs_review"
            : hasTerminalUnit
              ? "failed"
              : "planned";
          const failureCode = hasUncertain
            ? "provider_outcome_uncertain"
            : units.length === 0
              ? "invalid_plan"
              : hasTerminalUnit
                ? (delivery.failureCode ?? "provider_permanent")
                : null;

          const released = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            UPDATE "guide_delivery" AS delivery
            SET
              "status" = ${nextStatus}::"guide_delivery_status",
              "failure_code" = ${failureCode},
              "next_attempt_at" = NULL,
              "claim_token" = NULL,
              "claimed_at" = NULL,
              "claim_expires_at" = NULL,
              "updated_at" = ${now}
            WHERE delivery."id" = ${delivery.id}::uuid
              AND delivery."claim_token" = ${delivery.claimToken}::uuid
              AND delivery."status" = 'sending'
            RETURNING delivery."id"
          `);
          if (released.length !== 1) throw new Error("guide delivery expired claim lost state");

          const kind = hasUncertain
            ? "needs_review"
            : hasTerminalUnit
              ? "terminal"
              : "released";
          await tx.eventLog.create({
            data: {
              kind: "guide_delivery_claim_reconciled",
              payload: {
                ...eventIdentity(delivery),
                outcome: kind,
                unitCount: units.length,
                reconciledAt: now.toISOString(),
              },
            },
          });
          return { kind, deliveryId: delivery.id } as
            | { kind: "needs_review"; deliveryId: string }
            | { kind: "terminal"; deliveryId: string }
            | { kind: "released"; deliveryId: string };
        });

        if (outcome.kind === "none") break;
        if (outcome.kind === "needs_review") {
          result.needsReviewDeliveryIds.push(outcome.deliveryId);
        } else if (outcome.kind === "terminal") {
          result.terminalDeliveryIds.push(outcome.deliveryId);
        } else if (outcome.kind === "released") {
          result.releasedDeliveryIds.push(outcome.deliveryId);
        } else {
          result.completionPending.push(outcome.delivery);
        }
      }

      return result;
    },
  };
}

export const guideDeliveryRepository = createGuideDeliveryRepository({
  maxAttempts: env.GUIDE_DELIVERY_MAX_ATTEMPTS,
});
