import { randomUUID } from "node:crypto";
import {
  type GuideAccessAttempt,
  type GuideAccessAttemptState,
  type GuideActionToken,
  type GuideActionTokenAction,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";

const MAX_FOLLOW_CHECKS = 3;
const MAX_FOLLOW_RESPONSES = 2;
const ACTIVE_ATTEMPT_STATES: readonly GuideAccessAttemptState[] = [
  "awaiting_request",
  "checking_follow",
  "awaiting_follow",
  "delivering",
  "needs_review",
];

type Transaction = Prisma.TransactionClient;
export type GuideAccessDatabase = Pick<PrismaClient, "$transaction">;

type LockedAttempt = GuideAccessAttempt & { senderId: string };

class TransactionFenceConflict extends Error {
  constructor(readonly actualState: GuideAccessAttemptState) {
    super("guide access transaction fence conflict");
  }
}

export type CreateGuideAccessAttemptInput = {
  conversationId: string;
  resourceId: string;
  coverVersionId: string | null;
  messagingWindowExpiresAt: Date;
  now?: Date;
};

export type CreateGuideAccessAttemptResult =
  | { kind: "created"; attempt: GuideAccessAttempt }
  | { kind: "loaded"; attempt: GuideAccessAttempt };

export type IssueGuideActionTokenInput = {
  attemptId: string;
  action: GuideActionTokenAction;
  now: Date;
  expiresAt: Date;
};

export type IssueGuideActionTokenResult =
  | { kind: "issued"; token: GuideActionToken }
  | { kind: "replayed"; token: GuideActionToken }
  | { kind: "attempt_not_found" }
  | { kind: "attempt_expired" }
  | { kind: "state_conflict"; actualState: GuideAccessAttemptState };

export type ConsumeGuideActionTokenInput = {
  tokenId: string;
  action: GuideActionTokenAction;
  senderId: string;
  now: Date;
};

export type ConsumeGuideActionTokenResult =
  | { kind: "consumed"; attempt: GuideAccessAttempt }
  | { kind: "already_consumed" }
  | { kind: "not_found" }
  | { kind: "wrong_sender" }
  | { kind: "wrong_action" }
  | { kind: "expired" }
  | { kind: "check_limit_reached" }
  | { kind: "state_conflict"; actualState: GuideAccessAttemptState };

export type GuideAccessTransitionResult =
  | { kind: "transitioned"; attempt: GuideAccessAttempt }
  | { kind: "expired"; attempt: GuideAccessAttempt }
  | { kind: "attempt_not_found" }
  | { kind: "state_conflict"; actualState: GuideAccessAttemptState };

export type BeginGuideAccessCheckingInput = {
  attemptId: string;
  expectedState: "awaiting_request" | "awaiting_follow";
  now: Date;
};

export type MarkGuideAccessAwaitingFollowInput = {
  attemptId: string;
  expectedState: "checking_follow";
  checkedAt: Date;
  now: Date;
};

export type MarkGuideAccessDeliveringInput = MarkGuideAccessAwaitingFollowInput;

export type MarkGuideAccessDeliveredInput = {
  attemptId: string;
  expectedState: "delivering";
};

export type MarkGuideAccessNeedsReviewInput = {
  attemptId: string;
  expectedState: Exclude<GuideAccessAttemptState, "delivered" | "expired">;
  checkedAt?: Date;
};

export type MarkGuideAccessExpiredInput = {
  attemptId: string;
  expectedState: Exclude<GuideAccessAttemptState, "delivered" | "expired">;
  now: Date;
};

export type ReserveGuideFollowResponseInput = {
  attemptId: string;
  expectedState: "awaiting_follow";
  now: Date;
};

export type ReserveGuideFollowResponseResult =
  | { kind: "reserved"; responseNumber: 1 | 2 }
  | { kind: "expired"; attempt: GuideAccessAttempt }
  | { kind: "limit_reached" }
  | { kind: "attempt_not_found" }
  | { kind: "state_conflict"; actualState: GuideAccessAttemptState };

export interface GuideAccessRepository {
  createOrLoadAttempt(
    input: CreateGuideAccessAttemptInput,
  ): Promise<CreateGuideAccessAttemptResult>;
  issueToken(input: IssueGuideActionTokenInput): Promise<IssueGuideActionTokenResult>;
  consumeToken(input: ConsumeGuideActionTokenInput): Promise<ConsumeGuideActionTokenResult>;
  beginChecking(input: BeginGuideAccessCheckingInput): Promise<GuideAccessTransitionResult>;
  markAwaitingFollow(
    input: MarkGuideAccessAwaitingFollowInput,
  ): Promise<GuideAccessTransitionResult>;
  markDelivering(input: MarkGuideAccessDeliveringInput): Promise<GuideAccessTransitionResult>;
  markDelivered(input: MarkGuideAccessDeliveredInput): Promise<GuideAccessTransitionResult>;
  markNeedsReview(input: MarkGuideAccessNeedsReviewInput): Promise<GuideAccessTransitionResult>;
  markExpired(input: MarkGuideAccessExpiredInput): Promise<GuideAccessTransitionResult>;
  reserveFollowResponse(
    input: ReserveGuideFollowResponseInput,
  ): Promise<ReserveGuideFollowResponseResult>;
}

type RepositoryOptions = {
  database?: GuideAccessDatabase;
  idFactory?: () => string;
};

function requireValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) throw new Error(`invalid ${label}`);
}

function compatibleState(action: GuideActionTokenAction): GuideAccessAttemptState {
  return action === "request_guide" ? "awaiting_request" : "awaiting_follow";
}

function withoutSender(attempt: LockedAttempt): GuideAccessAttempt {
  const { senderId: _, ...record } = attempt;
  return record;
}

function withAttemptUpdate(
  attempt: LockedAttempt,
  patch: Partial<GuideAccessAttempt>,
): GuideAccessAttempt {
  return { ...withoutSender(attempt), ...patch };
}

async function lockConversation(tx: Transaction, conversationId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "conversations"
    WHERE "id" = ${conversationId}::uuid
    FOR UPDATE
  `;
  return rows.length === 1;
}

/**
 * Repository lock order is invariant: lock the attempt row first and a token
 * row second. Token identity may be read without a lock only to locate its
 * parent attempt; no mutation occurs before the attempt lock is held.
 */
async function lockAttempt(tx: Transaction, attemptId: string): Promise<LockedAttempt | null> {
  const rows = await tx.$queryRaw<LockedAttempt[]>`
    SELECT
      access_attempt."id",
      access_attempt."conversation_id" AS "conversationId",
      access_attempt."resource_id" AS "resourceId",
      access_attempt."cover_version_id" AS "coverVersionId",
      access_attempt."state",
      access_attempt."last_follow_result" AS "lastFollowResult",
      access_attempt."last_follow_checked_at" AS "lastFollowCheckedAt",
      access_attempt."follow_check_count" AS "followCheckCount",
      access_attempt."follow_response_count" AS "followResponseCount",
      access_attempt."cover_exposure" AS "coverExposure",
      access_attempt."cover_provider_message_id" AS "coverProviderMessageId",
      access_attempt."messaging_window_expires_at" AS "messagingWindowExpiresAt",
      access_attempt."created_at" AS "createdAt",
      access_attempt."updated_at" AS "updatedAt",
      conversation."ig_user_id" AS "senderId"
    FROM "guide_access_attempt" access_attempt
    JOIN "conversations" conversation ON conversation."id" = access_attempt."conversation_id"
    WHERE access_attempt."id" = ${attemptId}::uuid
    FOR UPDATE OF access_attempt
  `;
  return rows[0] ?? null;
}

async function lockToken(tx: Transaction, tokenId: string): Promise<GuideActionToken | null> {
  const rows = await tx.$queryRaw<GuideActionToken[]>`
    SELECT
      "id",
      "attempt_id" AS "attemptId",
      "action",
      "status",
      "expires_at" AS "expiresAt",
      "consumed_at" AS "consumedAt",
      "created_at" AS "createdAt"
    FROM "guide_action_token"
    WHERE "id" = ${tokenId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockActiveToken(
  tx: Transaction,
  attemptId: string,
  action: GuideActionTokenAction,
  now: Date,
): Promise<GuideActionToken | null> {
  const rows = await tx.$queryRaw<GuideActionToken[]>`
    SELECT
      "id",
      "attempt_id" AS "attemptId",
      "action",
      "status",
      "expires_at" AS "expiresAt",
      "consumed_at" AS "consumedAt",
      "created_at" AS "createdAt"
    FROM "guide_action_token"
    WHERE "attempt_id" = ${attemptId}::uuid
      AND "action" = ${action}::"guide_action_token_action"
      AND "status" = 'active'
      AND "expires_at" > ${now}
    ORDER BY "created_at", "id"
    LIMIT 1
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function loadLockedForExpectedState(
  tx: Transaction,
  attemptId: string,
  expectedState: GuideAccessAttemptState,
): Promise<
  | { kind: "ready"; attempt: LockedAttempt }
  | { kind: "attempt_not_found" }
  | { kind: "state_conflict"; actualState: GuideAccessAttemptState }
> {
  const attempt = await lockAttempt(tx, attemptId);
  if (!attempt) return { kind: "attempt_not_found" };
  if (attempt.state !== expectedState) {
    return { kind: "state_conflict", actualState: attempt.state };
  }
  return { kind: "ready", attempt };
}

async function expireLockedAttempt(
  tx: Transaction,
  attempt: LockedAttempt,
  now: Date,
): Promise<{ kind: "expired"; attempt: GuideAccessAttempt }> {
  const updated = await tx.guideAccessAttempt.updateMany({
    where: {
      id: attempt.id,
      state: attempt.state,
      messagingWindowExpiresAt: { lte: now },
    },
    data: { state: "expired" },
  });
  if (updated.count !== 1) throw new TransactionFenceConflict(attempt.state);
  return {
    kind: "expired",
    attempt: withAttemptUpdate(attempt, { state: "expired" }),
  };
}

export function createGuideAccessRepository(
  options: RepositoryOptions = {},
): GuideAccessRepository {
  const database = options.database ?? prisma;
  const idFactory = options.idFactory ?? randomUUID;

  return {
    async createOrLoadAttempt(input) {
      requireValidDate(input.messagingWindowExpiresAt, "guide access window");
      const now = input.now ?? new Date();
      requireValidDate(now, "guide access create time");
      return database.$transaction(async (tx) => {
        if (!(await lockConversation(tx, input.conversationId))) {
          throw new Error("guide access conversation not found");
        }
        const existing = await tx.guideAccessAttempt.findFirst({
          where: {
            conversationId: input.conversationId,
            state: { in: [...ACTIVE_ATTEMPT_STATES] },
          },
          orderBy: { createdAt: "asc" },
        });
        if (existing) {
          const locked = await lockAttempt(tx, existing.id);
          if (locked && ACTIVE_ATTEMPT_STATES.includes(locked.state)) {
            if (locked.messagingWindowExpiresAt > now) {
              return { kind: "loaded" as const, attempt: withoutSender(locked) };
            }
            await expireLockedAttempt(tx, locked, now);
          }
        }

        const created = await tx.guideAccessAttempt.create({
          data: {
            id: idFactory(),
            conversationId: input.conversationId,
            resourceId: input.resourceId,
            coverVersionId: input.coverVersionId,
            messagingWindowExpiresAt: input.messagingWindowExpiresAt,
          },
        });
        return { kind: "created" as const, attempt: created };
      });
    },

    async issueToken(input) {
      requireValidDate(input.now, "guide action issue time");
      requireValidDate(input.expiresAt, "guide action token expiry");
      if (input.expiresAt <= input.now) throw new Error("invalid guide action token expiry");

      return database.$transaction(async (tx) => {
        const attempt = await lockAttempt(tx, input.attemptId);
        if (!attempt) return { kind: "attempt_not_found" as const };
        if (attempt.state !== compatibleState(input.action)) {
          return { kind: "state_conflict" as const, actualState: attempt.state };
        }
        if (attempt.messagingWindowExpiresAt <= input.now) {
          await tx.guideAccessAttempt.updateMany({
            where: { id: attempt.id, state: attempt.state },
            data: { state: "expired" },
          });
          return { kind: "attempt_expired" as const };
        }
        if (input.expiresAt > attempt.messagingWindowExpiresAt) {
          throw new Error("guide action token exceeds messaging window");
        }

        await tx.guideActionToken.updateMany({
          where: { attemptId: attempt.id, status: "active", expiresAt: { lte: input.now } },
          data: { status: "expired" },
        });
        const existing = await lockActiveToken(tx, attempt.id, input.action, input.now);
        if (existing) return { kind: "replayed" as const, token: existing };

        const created = await tx.guideActionToken.create({
          data: {
            id: idFactory(),
            attemptId: attempt.id,
            action: input.action,
            expiresAt: input.expiresAt,
          },
        });
        return { kind: "issued" as const, token: created };
      });
    },

    async consumeToken(input) {
      requireValidDate(input.now, "guide action consumption time");
      try {
        return await database.$transaction(async (tx) => {
          const identity = await tx.guideActionToken.findUnique({
            where: { id: input.tokenId },
            select: { attemptId: true },
          });
          if (!identity) return { kind: "not_found" as const };

          const attempt = await lockAttempt(tx, identity.attemptId);
          if (!attempt) return { kind: "not_found" as const };
          if (attempt.senderId !== input.senderId) return { kind: "wrong_sender" as const };

          const token = await lockToken(tx, input.tokenId);
          if (!token || token.attemptId !== attempt.id) return { kind: "not_found" as const };
          if (token.status === "consumed") return { kind: "already_consumed" as const };
          if (token.status !== "active") return { kind: "expired" as const };
          if (token.action !== input.action) return { kind: "wrong_action" as const };
          if (attempt.messagingWindowExpiresAt <= input.now) {
            await tx.guideAccessAttempt.updateMany({
              where: { id: attempt.id, state: attempt.state },
              data: { state: "expired" },
            });
            await tx.guideActionToken.updateMany({
              where: { id: token.id, status: "active" },
              data: { status: "expired" },
            });
            return { kind: "expired" as const };
          }
          if (token.expiresAt <= input.now) {
            await tx.guideActionToken.updateMany({
              where: { id: token.id, status: "active" },
              data: { status: "expired" },
            });
            return { kind: "expired" as const };
          }
          const expectedState = compatibleState(input.action);
          if (attempt.state !== expectedState) {
            return { kind: "state_conflict" as const, actualState: attempt.state };
          }
          if (attempt.followCheckCount >= MAX_FOLLOW_CHECKS) {
            return { kind: "check_limit_reached" as const };
          }

          const attemptUpdate = await tx.guideAccessAttempt.updateMany({
            where: { id: attempt.id, state: expectedState, followCheckCount: { lt: MAX_FOLLOW_CHECKS } },
            data: {
              state: "checking_follow",
              lastFollowResult: "unknown",
              lastFollowCheckedAt: null,
              followCheckCount: { increment: 1 },
            },
          });
          if (attemptUpdate.count !== 1) {
            return { kind: "state_conflict" as const, actualState: attempt.state };
          }
          const tokenUpdate = await tx.guideActionToken.updateMany({
            where: { id: token.id, status: "active" },
            data: { status: "consumed", consumedAt: input.now },
          });
          if (tokenUpdate.count !== 1) throw new TransactionFenceConflict(attempt.state);

          return {
            kind: "consumed" as const,
            attempt: withAttemptUpdate(attempt, {
              state: "checking_follow",
              lastFollowResult: "unknown",
              lastFollowCheckedAt: null,
              followCheckCount: attempt.followCheckCount + 1,
            }),
          };
        });
      } catch (error) {
        if (error instanceof TransactionFenceConflict) {
          return { kind: "state_conflict" as const, actualState: error.actualState };
        }
        throw error;
      }
    },

    async beginChecking(input) {
      requireValidDate(input.now, "guide follow check time");
      return database.$transaction(async (tx) => {
        const locked = await loadLockedForExpectedState(tx, input.attemptId, input.expectedState);
        if (locked.kind !== "ready") return locked;
        if (locked.attempt.messagingWindowExpiresAt <= input.now) {
          return expireLockedAttempt(tx, locked.attempt, input.now);
        }
        if (locked.attempt.followCheckCount >= MAX_FOLLOW_CHECKS) {
          return { kind: "state_conflict" as const, actualState: locked.attempt.state };
        }
        const updated = await tx.guideAccessAttempt.updateMany({
          where: {
            id: input.attemptId,
            state: input.expectedState,
            followCheckCount: { lt: MAX_FOLLOW_CHECKS },
            messagingWindowExpiresAt: { gt: input.now },
          },
          data: {
            state: "checking_follow",
            lastFollowResult: "unknown",
            lastFollowCheckedAt: null,
            followCheckCount: { increment: 1 },
          },
        });
        if (updated.count !== 1) {
          return { kind: "state_conflict" as const, actualState: locked.attempt.state };
        }
        return {
          kind: "transitioned" as const,
          attempt: withAttemptUpdate(locked.attempt, {
            state: "checking_follow",
            lastFollowResult: "unknown",
            lastFollowCheckedAt: null,
            followCheckCount: locked.attempt.followCheckCount + 1,
          }),
        };
      });
    },

    async markAwaitingFollow(input) {
      requireValidDate(input.checkedAt, "guide follow result time");
      requireValidDate(input.now, "guide access transition time");
      return database.$transaction(async (tx) => {
        const locked = await loadLockedForExpectedState(tx, input.attemptId, input.expectedState);
        if (locked.kind !== "ready") return locked;
        if (locked.attempt.messagingWindowExpiresAt <= input.now) {
          return expireLockedAttempt(tx, locked.attempt, input.now);
        }
        const updated = await tx.guideAccessAttempt.updateMany({
          where: {
            id: input.attemptId,
            state: input.expectedState,
            messagingWindowExpiresAt: { gt: input.now },
          },
          data: {
            state: "awaiting_follow",
            lastFollowResult: "non_follower",
            lastFollowCheckedAt: input.checkedAt,
          },
        });
        if (updated.count !== 1) {
          return { kind: "state_conflict" as const, actualState: locked.attempt.state };
        }
        return {
          kind: "transitioned" as const,
          attempt: withAttemptUpdate(locked.attempt, {
            state: "awaiting_follow",
            lastFollowResult: "non_follower",
            lastFollowCheckedAt: input.checkedAt,
          }),
        };
      });
    },

    async markDelivering(input) {
      requireValidDate(input.checkedAt, "guide follow result time");
      requireValidDate(input.now, "guide access transition time");
      return database.$transaction(async (tx) => {
        const locked = await loadLockedForExpectedState(tx, input.attemptId, input.expectedState);
        if (locked.kind !== "ready") return locked;
        if (locked.attempt.messagingWindowExpiresAt <= input.now) {
          return expireLockedAttempt(tx, locked.attempt, input.now);
        }
        const updated = await tx.guideAccessAttempt.updateMany({
          where: {
            id: input.attemptId,
            state: input.expectedState,
            messagingWindowExpiresAt: { gt: input.now },
          },
          data: {
            state: "delivering",
            lastFollowResult: "follower",
            lastFollowCheckedAt: input.checkedAt,
          },
        });
        if (updated.count !== 1) {
          return { kind: "state_conflict" as const, actualState: locked.attempt.state };
        }
        return {
          kind: "transitioned" as const,
          attempt: withAttemptUpdate(locked.attempt, {
            state: "delivering",
            lastFollowResult: "follower",
            lastFollowCheckedAt: input.checkedAt,
          }),
        };
      });
    },

    async markDelivered(input) {
      return database.$transaction(async (tx) => {
        const locked = await loadLockedForExpectedState(tx, input.attemptId, input.expectedState);
        if (locked.kind !== "ready") return locked;
        const updated = await tx.guideAccessAttempt.updateMany({
          where: { id: input.attemptId, state: input.expectedState },
          data: { state: "delivered" },
        });
        if (updated.count !== 1) {
          return { kind: "state_conflict" as const, actualState: locked.attempt.state };
        }
        return {
          kind: "transitioned" as const,
          attempt: withAttemptUpdate(locked.attempt, { state: "delivered" }),
        };
      });
    },

    async markNeedsReview(input) {
      if (input.checkedAt) requireValidDate(input.checkedAt, "guide review time");
      return database.$transaction(async (tx) => {
        const locked = await loadLockedForExpectedState(tx, input.attemptId, input.expectedState);
        if (locked.kind !== "ready") return locked;
        const data = {
          state: "needs_review" as const,
          ...(input.checkedAt ? { lastFollowCheckedAt: input.checkedAt } : {}),
        };
        const updated = await tx.guideAccessAttempt.updateMany({
          where: { id: input.attemptId, state: input.expectedState },
          data,
        });
        if (updated.count !== 1) {
          return { kind: "state_conflict" as const, actualState: locked.attempt.state };
        }
        return {
          kind: "transitioned" as const,
          attempt: withAttemptUpdate(locked.attempt, data),
        };
      });
    },

    async markExpired(input) {
      requireValidDate(input.now, "guide access expiry time");
      return database.$transaction(async (tx) => {
        const locked = await loadLockedForExpectedState(tx, input.attemptId, input.expectedState);
        if (locked.kind !== "ready") return locked;
        const updated = await tx.guideAccessAttempt.updateMany({
          where: { id: input.attemptId, state: input.expectedState },
          data: { state: "expired" },
        });
        if (updated.count !== 1) {
          return { kind: "state_conflict" as const, actualState: locked.attempt.state };
        }
        return {
          kind: "transitioned" as const,
          attempt: withAttemptUpdate(locked.attempt, { state: "expired" }),
        };
      });
    },

    async reserveFollowResponse(input) {
      requireValidDate(input.now, "guide response reservation time");
      return database.$transaction(async (tx) => {
        const locked = await loadLockedForExpectedState(tx, input.attemptId, input.expectedState);
        if (locked.kind !== "ready") return locked;
        if (locked.attempt.messagingWindowExpiresAt <= input.now) {
          return expireLockedAttempt(tx, locked.attempt, input.now);
        }
        if (locked.attempt.followResponseCount >= MAX_FOLLOW_RESPONSES) {
          return { kind: "limit_reached" as const };
        }
        const updated = await tx.guideAccessAttempt.updateMany({
          where: {
            id: input.attemptId,
            state: input.expectedState,
            followResponseCount: { lt: MAX_FOLLOW_RESPONSES },
            messagingWindowExpiresAt: { gt: input.now },
          },
          data: { followResponseCount: { increment: 1 } },
        });
        if (updated.count !== 1) {
          return { kind: "state_conflict" as const, actualState: locked.attempt.state };
        }
        const responseNumber = (locked.attempt.followResponseCount + 1) as 1 | 2;
        return { kind: "reserved" as const, responseNumber };
      });
    },
  };
}

export const guideAccessRepository = createGuideAccessRepository();
