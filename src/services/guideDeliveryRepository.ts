import { randomUUID } from "node:crypto";
import {
  Prisma,
  type GuideDelivery,
  type GuideDeliveryUnit,
  type PrismaClient,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { GraphErrorMetadata, TransportCode } from "./eventLogger.js";
import type {
  GuideDeliveryPlanResult,
  GuideDeliveryTriggerKind,
} from "./guideDeliveryPlanner.js";

const COMPLETION_RECOVERY_LEASE_MS = 5 * 60_000;
const GRAPH_ERROR_CATEGORIES = new Set([
  "graph_response",
  "graph_transport",
  "unknown_error",
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
const GRAPH_ERROR_METADATA_KEYS = new Set([
  "category",
  "httpStatus",
  "graphCode",
  "graphSubcode",
  "traceId",
  "transportCode",
]);

type RepositoryClient = Pick<PrismaClient, "$transaction">;
type Transaction = Prisma.TransactionClient;

export type GuideDeliveryUnitRecord = GuideDeliveryUnit;
export type PlannedDeliveryRecord = GuideDelivery & { units: GuideDeliveryUnitRecord[] };
export type ClaimedGuideDelivery = PlannedDeliveryRecord & {
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
  maxAttempts: number;
};

export type MarkGuideUnitSentInput = {
  deliveryId: string;
  unitId: string;
  claimToken: string;
  attempt: number;
  sentAt: Date;
  providerMessageId: string | null;
  ownerConfirmedAt: Date | null;
};

export type MarkGuideUnitFailedInput = {
  deliveryId: string;
  unitId: string;
  claimToken: string;
  attempt: number;
  failedAt: Date;
  disposition: "transient" | "permanent";
  nextAttemptAt: Date | null;
  error: GraphErrorMetadata;
};

export type MarkGuideUnitUncertainInput = {
  deliveryId: string;
  unitId: string;
  claimToken: string;
  attempt: number;
  uncertainAt: Date;
  error: GraphErrorMetadata;
};

export type ReleaseGuideDeliveryClaimInput = {
  deliveryId: string;
  claimToken: string;
  now: Date;
  nextAttemptAt?: Date | null;
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
  markUnitFailed(input: MarkGuideUnitFailedInput): Promise<boolean>;
  markUnitUncertain(input: MarkGuideUnitUncertainInput): Promise<boolean>;
  releaseClaim(input: ReleaseGuideDeliveryClaimInput): Promise<boolean>;
  reconcileExpiredClaims(now: Date): Promise<ExpiredClaimReconciliation>;
}

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
  sendWindowExpiresAt: Date;
};

async function lockDelivery(tx: Transaction, deliveryId: string): Promise<LockedDelivery | null> {
  const rows = await tx.$queryRaw<LockedDelivery[]>`
    SELECT
      "id",
      "conversation_id" AS "conversationId",
      "resource_id" AS "resourceId",
      "trigger_kind"::text AS "triggerKind",
      "trigger_id" AS "triggerId",
      "status"::text AS "status",
      "failure_code" AS "failureCode",
      "next_attempt_at" AS "nextAttemptAt",
      "claim_token" AS "claimToken",
      "send_window_expires_at" AS "sendWindowExpiresAt"
    FROM "guide_delivery"
    WHERE "id" = ${deliveryId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockAndLoadUnits(
  tx: Transaction,
  deliveryId: string,
): Promise<GuideDeliveryUnitRecord[]> {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "guide_delivery_unit"
    WHERE "delivery_id" = ${deliveryId}::uuid
    ORDER BY "position" ASC
    FOR UPDATE
  `;
  return tx.guideDeliveryUnit.findMany({
    where: { deliveryId },
    orderBy: { position: "asc" },
  });
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

function claimed(record: PlannedDeliveryRecord): ClaimedGuideDelivery {
  if (record.status !== "sending" || record.claimToken === null) {
    throw new Error("guide_delivery_claim_not_recorded");
  }
  return record as ClaimedGuideDelivery;
}

function isDue(delivery: LockedDelivery, now: Date): boolean {
  if (delivery.status === "planned") {
    return delivery.nextAttemptAt === null || delivery.nextAttemptAt <= now;
  }
  return (
    delivery.status === "failed" &&
    delivery.failureCode === "guide_unit_transient" &&
    delivery.nextAttemptAt !== null &&
    delivery.nextAttemptAt <= now
  );
}

function validateLease(now: Date, claimExpiresAt: Date): void {
  if (!(claimExpiresAt > now)) throw new Error("invalid_guide_delivery_lease");
}

function validateBatchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("invalid_guide_delivery_batch_limit");
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
  if (!isGraphErrorMetadata(value)) throw new Error("invalid_graph_error_metadata");
}

function safeErrorEvent(error: GraphErrorMetadata): Record<string, unknown> {
  return {
    category: error.category,
    httpStatus: error.httpStatus,
    graphCode: error.graphCode,
    graphSubcode: error.graphSubcode,
    traceId: error.traceId,
    transportCode: error.transportCode,
  };
}

function eventIdentity(delivery: LockedDelivery): Record<string, unknown> {
  return {
    deliveryId: delivery.id,
    conversationId: delivery.conversationId,
    resourceId: delivery.resourceId,
    triggerKind: delivery.triggerKind,
    triggerId: delivery.triggerId,
  };
}

export function createGuideDeliveryRepository(
  database: RepositoryClient = prisma,
): GuideDeliveryRepository {
  return {
    async createOrLoadPlan(input) {
      return database.$transaction(async (tx) => {
        const emptyPlan = input.plan.ok && input.plan.units.length === 0;
        const rejected = !input.plan.ok || emptyPlan;
        const status = rejected ? "failed" : "planned";
        const failureCode = rejected ? "guide_preflight_failed" : null;
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
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
        `;

        if (inserted[0]) {
          const deliveryId = inserted[0].id;
          if (input.plan.ok && !emptyPlan) {
            await tx.guideDeliveryUnit.createMany({
              data: input.plan.units.map((unit) => ({ ...unit, deliveryId })),
            });
            await tx.eventLog.create({
              data: {
                kind: "guide_delivery_planned",
                payload: {
                  deliveryId,
                  conversationId: input.conversationId,
                  resourceId: input.resourceId,
                  triggerKind: input.triggerKind,
                  triggerId: input.triggerId,
                  unitCount: input.plan.units.length,
                },
              },
            });
          } else if (!input.plan.ok) {
            await tx.eventLog.create({
              data: {
                kind: "guide_delivery_preflight_rejected",
                payload: {
                  deliveryId,
                  conversationId: input.conversationId,
                  resourceId: input.resourceId,
                  triggerKind: input.triggerKind,
                  triggerId: input.triggerId,
                  failureCode,
                  preflightCode: input.plan.error.code,
                  resourceMessageId: input.plan.error.resourceMessageId,
                  authoredOrder: input.plan.error.authoredOrder,
                  unitKind: input.plan.error.unitKind,
                  actualLength: input.plan.error.actualLength,
                  limit: input.plan.error.limit,
                },
              },
            });
          } else {
            await tx.eventLog.create({
              data: {
                kind: "guide_delivery_preflight_rejected",
                payload: {
                  deliveryId,
                  conversationId: input.conversationId,
                  resourceId: input.resourceId,
                  triggerKind: input.triggerKind,
                  triggerId: input.triggerId,
                  failureCode,
                  preflightCode: "empty_plan",
                  unitCount: 0,
                },
              },
            });
          }
        }

        const deliveryId = inserted[0]?.id;
        if (deliveryId) return loadDelivery(tx, deliveryId);

        const existing = await tx.guideDelivery.findUnique({
          where: {
            triggerKind_triggerId: {
              triggerKind: input.triggerKind,
              triggerId: input.triggerId,
            },
          },
          include: { units: { orderBy: { position: "asc" } } },
        });
        if (!existing) throw new Error("guide_delivery_plan_conflict_not_visible");
        return existing;
      });
    },

    async claimById(input) {
      validateLease(input.now, input.claimExpiresAt);
      const claimToken = randomUUID();
      return database.$transaction(async (tx) => {
        const delivery = await lockDelivery(tx, input.deliveryId);
        if (
          !delivery ||
          delivery.claimToken !== null ||
          !isDue(delivery, input.now)
        ) {
          return null;
        }
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        if (units.length === 0) {
          await tx.guideDelivery.updateMany({
            where: {
              id: input.deliveryId,
              claimToken: null,
              status: { in: ["planned", "failed"] },
            },
            data: {
              status: "failed",
              failureCode: "guide_preflight_failed",
              nextAttemptAt: null,
              updatedAt: input.now,
            },
          });
          await tx.eventLog.create({
            data: {
              kind: "guide_delivery_preflight_rejected",
              payload: {
                ...eventIdentity(delivery),
                failureCode: "guide_preflight_failed",
                preflightCode: "empty_plan",
                unitCount: 0,
                detectedAt: input.now.toISOString(),
              },
            },
          });
          return null;
        }
        const allSent = units.length > 0 && units.every((unit) => unit.status === "sent");
        if (delivery.sendWindowExpiresAt <= input.now && !allSent) {
          await tx.guideDelivery.updateMany({
            where: {
              id: input.deliveryId,
              claimToken: null,
              status: { in: ["planned", "failed"] },
            },
            data: {
              status: "failed",
              failureCode: "messaging_window_closed",
              nextAttemptAt: null,
              updatedAt: input.now,
            },
          });
          await tx.eventLog.create({
            data: {
              kind: "guide_delivery_window_closed",
              payload: { ...eventIdentity(delivery), at: input.now.toISOString() },
            },
          });
          return null;
        }

        const updated = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "guide_delivery" AS delivery
          SET
            "status" = 'sending',
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
                AND delivery."failure_code" = 'guide_unit_transient'
                AND delivery."next_attempt_at" IS NOT NULL
              )
            )
            AND (delivery."next_attempt_at" IS NULL OR delivery."next_attempt_at" <= ${input.now})
            AND EXISTS (
              SELECT 1 FROM "guide_delivery_unit" AS unit
              WHERE unit."delivery_id" = delivery."id"
            )
            AND (
              delivery."send_window_expires_at" > ${input.now}
              OR (
                EXISTS (
                  SELECT 1 FROM "guide_delivery_unit" AS unit
                  WHERE unit."delivery_id" = delivery."id"
                )
                AND NOT EXISTS (
                  SELECT 1 FROM "guide_delivery_unit" AS unit
                  WHERE unit."delivery_id" = delivery."id" AND unit."status" <> 'sent'
                )
              )
            )
          RETURNING delivery."id"
        `;
        if (!updated[0]) return null;
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_claimed",
            payload: { ...eventIdentity(delivery), claimedAt: input.now.toISOString() },
          },
        });
        return claimed(await loadDelivery(tx, updated[0].id));
      });
    },

    async claimDueBatch(input) {
      validateLease(input.now, input.claimExpiresAt);
      validateBatchLimit(input.limit);
      const tokens = Array.from({ length: input.limit }, () => randomUUID());
      const tokenValues = Prisma.join(
        tokens.map((token, ordinal) => Prisma.sql`(${ordinal}, ${token}::uuid)`),
      );

      return database.$transaction(async (tx) => {
        const empty = await tx.$queryRaw<LockedDelivery[]>(Prisma.sql`
          WITH zero_unit AS (
            SELECT delivery."id"
            FROM "guide_delivery" AS delivery
            WHERE delivery."status" IN ('planned', 'failed')
              AND delivery."claim_token" IS NULL
              AND (
                delivery."status" = 'planned'
                OR (
                  delivery."failure_code" = 'guide_unit_transient'
                  AND delivery."next_attempt_at" IS NOT NULL
                )
              )
              AND (delivery."next_attempt_at" IS NULL OR delivery."next_attempt_at" <= ${input.now})
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
            "failure_code" = 'guide_preflight_failed',
            "next_attempt_at" = NULL,
            "updated_at" = ${input.now}
          FROM zero_unit
          WHERE delivery."id" = zero_unit."id"
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
                failureCode: "guide_preflight_failed",
                preflightCode: "empty_plan",
                unitCount: 0,
                detectedAt: input.now.toISOString(),
              },
            })),
          });
        }

        const closed = await tx.$queryRaw<LockedDelivery[]>(Prisma.sql`
          WITH expired AS (
            SELECT delivery."id"
            FROM "guide_delivery" AS delivery
            WHERE delivery."status" IN ('planned', 'failed')
              AND delivery."claim_token" IS NULL
              AND (
                delivery."status" = 'planned'
                OR (
                  delivery."failure_code" = 'guide_unit_transient'
                  AND delivery."next_attempt_at" IS NOT NULL
                )
              )
              AND (delivery."next_attempt_at" IS NULL OR delivery."next_attempt_at" <= ${input.now})
              AND delivery."send_window_expires_at" <= ${input.now}
              AND NOT (
                EXISTS (
                  SELECT 1 FROM "guide_delivery_unit" AS unit
                  WHERE unit."delivery_id" = delivery."id"
                )
                AND NOT EXISTS (
                  SELECT 1 FROM "guide_delivery_unit" AS unit
                  WHERE unit."delivery_id" = delivery."id" AND unit."status" <> 'sent'
                )
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

        const claimedRows = await tx.$queryRaw<Array<{ id: string; claimToken: string }>>(
          Prisma.sql`
            WITH tokens ("ordinal", "token") AS (VALUES ${tokenValues}),
            due AS MATERIALIZED (
              SELECT
                delivery."id",
                delivery."next_attempt_at",
                delivery."created_at"
              FROM "guide_delivery" AS delivery
              WHERE delivery."status" IN ('planned', 'failed')
                AND delivery."claim_token" IS NULL
                AND (
                  delivery."status" = 'planned'
                  OR (
                    delivery."failure_code" = 'guide_unit_transient'
                    AND delivery."next_attempt_at" IS NOT NULL
                  )
                )
                AND (delivery."next_attempt_at" IS NULL OR delivery."next_attempt_at" <= ${input.now})
                AND EXISTS (
                  SELECT 1 FROM "guide_delivery_unit" AS unit
                  WHERE unit."delivery_id" = delivery."id"
                )
                AND (
                  delivery."send_window_expires_at" > ${input.now}
                  OR (
                    EXISTS (
                      SELECT 1 FROM "guide_delivery_unit" AS unit
                      WHERE unit."delivery_id" = delivery."id"
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM "guide_delivery_unit" AS unit
                      WHERE unit."delivery_id" = delivery."id" AND unit."status" <> 'sent'
                    )
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
        const byId = new Map(records.map((record) => [record.id, claimed(record)]));
        return claimedRows.map((row) => byId.get(row.id)).filter((row): row is ClaimedGuideDelivery => Boolean(row));
      });
    },

    async beginUnit(input) {
      if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
        throw new Error("invalid_guide_delivery_attempt_cap");
      }
      return database.$transaction(async (tx) => {
        const delivery = await lockDelivery(tx, input.deliveryId);
        if (
          !delivery ||
          delivery.status !== "sending" ||
          delivery.claimToken !== input.claimToken
        ) {
          return null;
        }
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        const unit = units.find((candidate) => candidate.status !== "sent");
        if (!unit) return null;
        const ownerAuthorized =
          unit.ownerRetryAuthorizedAt !== null && unit.ownerRetryConsumedAt === null;
        const retryable =
          unit.status === "pending" ||
          (unit.status === "failed" && unit.failureDisposition === "transient");
        if (!retryable || (unit.attempts >= input.maxAttempts && !ownerAuthorized)) {
          return null;
        }

        const updated = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "guide_delivery_unit" AS unit
          SET
            "status" = 'sending',
            "attempts" = unit."attempts" + 1,
            "sending_at" = ${input.now},
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
            AND unit."delivery_id" = ${input.deliveryId}::uuid
            AND unit."status" IN ('pending', 'failed')
            AND (unit."status" = 'pending' OR unit."failure_disposition" = 'transient')
            AND unit."attempts" = ${unit.attempts}
            AND (
              unit."attempts" < ${input.maxAttempts}
              OR (
                unit."owner_retry_authorized_at" IS NOT NULL
                AND unit."owner_retry_consumed_at" IS NULL
              )
            )
            AND delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING unit."id"
        `;
        if (!updated[0]) return null;
        return tx.guideDeliveryUnit.findUniqueOrThrow({ where: { id: unit.id } });
      });
    },

    async markUnitSent(input) {
      if (
        (input.providerMessageId === null || input.providerMessageId === "") &&
        input.ownerConfirmedAt === null
      ) {
        throw new Error("sent_confirmation_required");
      }
      return database.$transaction(async (tx) => {
        const delivery = await lockDelivery(tx, input.deliveryId);
        if (
          !delivery ||
          delivery.status !== "sending" ||
          delivery.claimToken !== input.claimToken
        ) {
          return false;
        }
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        const unit = units.find((candidate) => candidate.id === input.unitId);
        if (!unit || unit.status !== "sending" || unit.attempts !== input.attempt) {
          return false;
        }

        const updated = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "guide_delivery_unit" AS unit
          SET
            "status" = 'sent',
            "provider_message_id" = ${input.providerMessageId},
            "sent_at" = ${input.sentAt},
            "owner_confirmed_at" = ${input.ownerConfirmedAt},
            "failure_disposition" = NULL,
            "error_category" = NULL,
            "error_http_status" = NULL,
            "error_graph_code" = NULL,
            "error_graph_subcode" = NULL,
            "error_trace_id" = NULL,
            "error_transport_code" = NULL,
            "updated_at" = ${input.sentAt}
          FROM "guide_delivery" AS delivery
          WHERE unit."id" = ${input.unitId}::uuid
            AND unit."delivery_id" = ${input.deliveryId}::uuid
            AND unit."status" = 'sending'
            AND unit."attempts" = ${input.attempt}
            AND delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING unit."id"
        `;
        if (!updated[0]) return false;
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_unit_sent",
            payload: {
              ...eventIdentity(delivery),
              unitId: unit.id,
              position: unit.position,
              unitKind: unit.kind,
              attempt: input.attempt,
              providerMessageId: input.providerMessageId,
              ownerConfirmed: input.ownerConfirmedAt !== null,
              sentAt: input.sentAt.toISOString(),
            },
          },
        });
        return true;
      });
    },

    async markUnitFailed(input) {
      requireGraphErrorMetadata(input.error);
      return database.$transaction(async (tx) => {
        const delivery = await lockDelivery(tx, input.deliveryId);
        if (
          !delivery ||
          delivery.status !== "sending" ||
          delivery.claimToken !== input.claimToken
        ) {
          return false;
        }
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        const unit = units.find((candidate) => candidate.id === input.unitId);
        if (!unit || unit.status !== "sending" || unit.attempts !== input.attempt) {
          return false;
        }

        const updated = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "guide_delivery_unit" AS unit
          SET
            "status" = 'failed',
            "failure_disposition" = ${input.disposition}::"guide_delivery_failure_disposition",
            "error_category" = ${input.error.category},
            "error_http_status" = ${input.error.httpStatus},
            "error_graph_code" = ${input.error.graphCode},
            "error_graph_subcode" = ${input.error.graphSubcode},
            "error_trace_id" = ${input.error.traceId},
            "error_transport_code" = ${input.error.transportCode},
            "updated_at" = ${input.failedAt}
          FROM "guide_delivery" AS delivery
          WHERE unit."id" = ${input.unitId}::uuid
            AND unit."delivery_id" = ${input.deliveryId}::uuid
            AND unit."status" = 'sending'
            AND unit."attempts" = ${input.attempt}
            AND delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING unit."id"
        `;
        if (!updated[0]) return false;

        const nextAttemptAt = input.disposition === "transient" ? input.nextAttemptAt : null;
        const deliveryUpdate = await tx.guideDelivery.updateMany({
          where: { id: input.deliveryId, claimToken: input.claimToken, status: "sending" },
          data: {
            status: "failed",
            failureCode:
              input.disposition === "transient"
                ? "guide_unit_transient"
                : "guide_unit_permanent",
            nextAttemptAt,
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
            updatedAt: input.failedAt,
          },
        });
        if (deliveryUpdate.count !== 1) throw new Error("guide_delivery_claim_lost");
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_unit_failed",
            payload: {
              ...eventIdentity(delivery),
              unitId: unit.id,
              position: unit.position,
              unitKind: unit.kind,
              attempt: input.attempt,
              disposition: input.disposition,
              failedAt: input.failedAt.toISOString(),
              ...safeErrorEvent(input.error),
            },
          },
        });
        return true;
      });
    },

    async markUnitUncertain(input) {
      requireGraphErrorMetadata(input.error);
      return database.$transaction(async (tx) => {
        const delivery = await lockDelivery(tx, input.deliveryId);
        if (
          !delivery ||
          delivery.status !== "sending" ||
          delivery.claimToken !== input.claimToken
        ) {
          return false;
        }
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        const unit = units.find((candidate) => candidate.id === input.unitId);
        if (!unit || unit.status !== "sending" || unit.attempts !== input.attempt) {
          return false;
        }

        const updated = await tx.$queryRaw<Array<{ id: string }>>`
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
            "updated_at" = ${input.uncertainAt}
          FROM "guide_delivery" AS delivery
          WHERE unit."id" = ${input.unitId}::uuid
            AND unit."delivery_id" = ${input.deliveryId}::uuid
            AND unit."status" = 'sending'
            AND unit."attempts" = ${input.attempt}
            AND delivery."id" = ${input.deliveryId}::uuid
            AND delivery."claim_token" = ${input.claimToken}::uuid
            AND delivery."status" = 'sending'
          RETURNING unit."id"
        `;
        if (!updated[0]) return false;
        const deliveryUpdate = await tx.guideDelivery.updateMany({
          where: { id: input.deliveryId, claimToken: input.claimToken, status: "sending" },
          data: {
            status: "needs_review",
            failureCode: "guide_unit_uncertain",
            nextAttemptAt: null,
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
            updatedAt: input.uncertainAt,
          },
        });
        if (deliveryUpdate.count !== 1) throw new Error("guide_delivery_claim_lost");
        await tx.eventLog.create({
          data: {
            kind: "guide_delivery_unit_uncertain",
            payload: {
              ...eventIdentity(delivery),
              unitId: unit.id,
              position: unit.position,
              unitKind: unit.kind,
              attempt: input.attempt,
              uncertainAt: input.uncertainAt.toISOString(),
              ...safeErrorEvent(input.error),
            },
          },
        });
        return true;
      });
    },

    async releaseClaim(input) {
      return database.$transaction(async (tx) => {
        const delivery = await lockDelivery(tx, input.deliveryId);
        if (
          !delivery ||
          delivery.status !== "sending" ||
          delivery.claimToken !== input.claimToken
        ) {
          return false;
        }
        const units = await lockAndLoadUnits(tx, input.deliveryId);
        if (units.some((unit) => unit.status === "sending" || unit.status === "uncertain")) {
          return false;
        }
        const hasTransientFailure = units.some(
          (unit) => unit.status === "failed" && unit.failureDisposition === "transient",
        );
        if (
          units.some(
            (unit) => unit.status === "failed" && unit.failureDisposition === "permanent",
          )
        ) {
          return false;
        }
        const updated = await tx.guideDelivery.updateMany({
          where: { id: input.deliveryId, claimToken: input.claimToken, status: "sending" },
          data: {
            status: hasTransientFailure ? "failed" : "planned",
            failureCode: hasTransientFailure ? "guide_unit_transient" : null,
            nextAttemptAt: input.nextAttemptAt ?? input.now,
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
            updatedAt: input.now,
          },
        });
        if (updated.count !== 1) return false;
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
        const newClaimToken = randomUUID();
        const outcome = await database.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<LockedDelivery[]>`
            SELECT
              "id",
              "conversation_id" AS "conversationId",
              "resource_id" AS "resourceId",
              "trigger_kind"::text AS "triggerKind",
              "trigger_id" AS "triggerId",
              "status"::text AS "status",
              "failure_code" AS "failureCode",
              "next_attempt_at" AS "nextAttemptAt",
              "claim_token" AS "claimToken",
              "send_window_expires_at" AS "sendWindowExpiresAt"
            FROM "guide_delivery"
            WHERE "status" = 'sending'
              AND "claim_token" IS NOT NULL
              AND "claim_expires_at" <= ${now}
            ORDER BY "claim_expires_at", "id"
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          `;
          const delivery = rows[0];
          if (!delivery || delivery.claimToken === null) return { kind: "none" as const };
          const units = await lockAndLoadUnits(tx, delivery.id);
          const sendingUnits = units.filter((unit) => unit.status === "sending");

          if (sendingUnits.length > 0) {
            await tx.guideDeliveryUnit.updateMany({
              where: {
                deliveryId: delivery.id,
                id: { in: sendingUnits.map((unit) => unit.id) },
                status: "sending",
              },
              data: { status: "uncertain", failureDisposition: null, updatedAt: now },
            });
            await tx.guideDelivery.updateMany({
              where: { id: delivery.id, claimToken: delivery.claimToken, status: "sending" },
              data: {
                status: "needs_review",
                failureCode: "guide_unit_uncertain",
                nextAttemptAt: null,
                claimToken: null,
                claimedAt: null,
                claimExpiresAt: null,
                updatedAt: now,
              },
            });
            await tx.eventLog.create({
              data: {
                kind: "guide_delivery_claim_expired_uncertain",
                payload: {
                  ...eventIdentity(delivery),
                  uncertainUnitCount: sendingUnits.length,
                  reconciledAt: now.toISOString(),
                },
              },
            });
            return { kind: "needs_review" as const, deliveryId: delivery.id };
          }

          if (units.length > 0 && units.every((unit) => unit.status === "sent")) {
            const claimExpiresAt = new Date(now.getTime() + COMPLETION_RECOVERY_LEASE_MS);
            const updated = await tx.guideDelivery.updateMany({
              where: { id: delivery.id, claimToken: delivery.claimToken, status: "sending" },
              data: {
                claimToken: newClaimToken,
                claimedAt: now,
                claimExpiresAt,
                updatedAt: now,
              },
            });
            if (updated.count !== 1) return { kind: "none" as const };
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
              delivery: claimed(await loadDelivery(tx, delivery.id)),
            };
          }

          if (units.some((unit) => unit.status === "uncertain")) {
            await tx.guideDelivery.updateMany({
              where: { id: delivery.id, claimToken: delivery.claimToken, status: "sending" },
              data: {
                status: "needs_review",
                failureCode: "guide_unit_uncertain",
                nextAttemptAt: null,
                claimToken: null,
                claimedAt: null,
                claimExpiresAt: null,
                updatedAt: now,
              },
            });
            await tx.eventLog.create({
              data: {
                kind: "guide_delivery_claim_expired_review",
                payload: { ...eventIdentity(delivery), reconciledAt: now.toISOString() },
              },
            });
            return { kind: "needs_review" as const, deliveryId: delivery.id };
          }

          const hasPermanentFailure = units.some(
            (unit) => unit.status === "failed" && unit.failureDisposition === "permanent",
          );
          const hasTransientFailure = units.some(
            (unit) => unit.status === "failed" && unit.failureDisposition === "transient",
          );
          await tx.guideDelivery.updateMany({
            where: { id: delivery.id, claimToken: delivery.claimToken, status: "sending" },
            data: {
              status: hasPermanentFailure ? "failed" : hasTransientFailure ? "failed" : "planned",
              failureCode: hasPermanentFailure
                ? "guide_unit_permanent"
                : hasTransientFailure
                  ? "guide_unit_transient"
                  : null,
              nextAttemptAt: hasPermanentFailure ? null : now,
              claimToken: null,
              claimedAt: null,
              claimExpiresAt: null,
              updatedAt: now,
            },
          });
          await tx.eventLog.create({
            data: {
              kind: hasPermanentFailure
                ? "guide_delivery_claim_expired_terminal"
                : "guide_delivery_claim_expired_released",
              payload: { ...eventIdentity(delivery), reconciledAt: now.toISOString() },
            },
          });
          if (hasPermanentFailure) {
            return { kind: "terminal" as const, deliveryId: delivery.id };
          }
          return { kind: "released" as const, deliveryId: delivery.id };
        });

        if (outcome.kind === "none") break;
        if (outcome.kind === "needs_review") {
          result.needsReviewDeliveryIds.push(outcome.deliveryId);
        } else if (outcome.kind === "released") {
          result.releasedDeliveryIds.push(outcome.deliveryId);
        } else if (outcome.kind === "terminal") {
          result.terminalDeliveryIds.push(outcome.deliveryId);
        } else {
          result.completionPending.push(outcome.delivery);
        }
      }
      return result;
    },
  };
}

export const guideDeliveryRepository = createGuideDeliveryRepository();
