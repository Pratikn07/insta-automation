import { randomUUID } from "node:crypto";
import {
  type GuideAccessAttempt,
  type GuideAccessAttemptState,
  type GuideActionToken,
  type GuideActionTokenAction,
  type GuideFollowResult,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { publishedCoverWhere } from "./guideCoverRepository.js";
import {
  GUIDE_ACCESS_MAX_FOLLOW_CHECKS,
  GUIDE_ACCESS_MAX_FOLLOW_RESPONSES,
} from "./guideAccessPolicy.js";
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
  messagingWindowExpiresAt: Date;
  now?: Date;
};

/**
 * What a parent can actually be sent for this attempt. Resolved inside the attempt
 * transaction so a caller never has to query covers itself and can never substitute a
 * different one.
 */
export type GuideAccessCoverSnapshot = {
  versionId: string;
  /**
   * The guide this cover actually belongs to, carried explicitly.
   *
   * On replay the snapshot is resolved from the attempt's stored id, which can differ
   * from the `resourceId` a caller passes in — an owner repointing `keyword.resourceId`
   * mid-attempt is enough. Without this field a consumer could prepend one guide's cover
   * to another guide's messages and never notice. A consumer must reconcile it.
   */
  resourceId: string;
  dmStoragePath: string;
};

export type CreateGuideAccessAttemptResult =
  | {
      kind: "created";
      attempt: GuideAccessAttempt;
      cover: GuideAccessCoverSnapshot | null;
    }
  | {
      kind: "loaded";
      attempt: GuideAccessAttempt;
      cover: GuideAccessCoverSnapshot | null;
    };

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

export type ReplaceGuideActionTokenInput = IssueGuideActionTokenInput & {
  expectedState: "checking_follow";
};

export type ReplaceGuideActionTokenResult =
  | { kind: "issued"; token: GuideActionToken }
  | { kind: "attempt_not_found" }
  | { kind: "attempt_expired" }
  | { kind: "state_conflict"; actualState: GuideAccessAttemptState };

export type ConsumeGuideActionTokenInput = {
  tokenId: string;
  action: GuideActionTokenAction;
  senderId: string;
  /** Signed provider event time: decides whether the parent acted inside the window. */
  eventAt: Date;
  /** Server processing time: used only for durable row timestamps and leases. */
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

export type ClaimDirectInboundInput = {
  attemptId: string;
  inboundMessageId: string;
  now: Date;
};

export type ClaimDirectInboundResult =
  | { kind: "consumed"; attempt: GuideAccessAttempt }
  | { kind: "already_consumed" }
  | { kind: "attempt_not_found" }
  | { kind: "token_conflict" }
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
  /**
   * The follow answer this review already holds, when there is one.
   *
   * Omitting it leaves `lastFollowResult` as it was — which for a review reached from
   * `checking_follow` means `unknown`, i.e. "we never found out". That is TRUE when the
   * provider could not answer, and FALSE when the check answered and the SEND was the
   * uncertain part. `isRetryableReview` keys on exactly this field, so recording an
   * answer we did have is what stops a gate from being sent to a parent twice.
   */
  followResult?: GuideFollowResult;
};

export type MarkGuideAccessExpiredInput = {
  attemptId: string;
  expectedState: Exclude<GuideAccessAttemptState, "delivered" | "expired">;
  now: Date;
};

export type ReserveGuideFollowResponseInput = {
  attemptId: string;
  expectedState: "checking_follow" | "awaiting_follow";
  now: Date;
};

export type ClaimCoverExposureResult =
  | { kind: "claimed" }
  | { kind: "already_claimed"; exposure: "accepted" | "uncertain" | "failed" }
  | { kind: "attempt_not_found" };

export type SettleCoverExposureInput = {
  attemptId: string;
  exposure: "accepted" | "failed";
  providerMessageId: string | null;
};

export type ReserveGuideFollowResponseResult =
  | { kind: "reserved"; responseNumber: 1 | 2 | 3 }
  | { kind: "expired"; attempt: GuideAccessAttempt }
  | { kind: "limit_reached" }
  | { kind: "attempt_not_found" }
  | { kind: "state_conflict"; actualState: GuideAccessAttemptState };

export interface GuideAccessRepository {
  createOrLoadAttempt(
    input: CreateGuideAccessAttemptInput,
  ): Promise<CreateGuideAccessAttemptResult>;
  issueToken(input: IssueGuideActionTokenInput): Promise<IssueGuideActionTokenResult>;
  replaceToken(input: ReplaceGuideActionTokenInput): Promise<ReplaceGuideActionTokenResult>;
  consumeToken(input: ConsumeGuideActionTokenInput): Promise<ConsumeGuideActionTokenResult>;
  claimDirectInbound(input: ClaimDirectInboundInput): Promise<ClaimDirectInboundResult>;
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
  claimCoverExposure(input: { attemptId: string }): Promise<ClaimCoverExposureResult>;
  /**
   * Settle the attempt that a durable delivery belongs to, found by conversation.
   *
   * There is no foreign key from `guide_delivery` to `guide_access_attempt`; the partial
   * unique index permits one non-terminal attempt per conversation, so the conversation is
   * an unambiguous handle. Both are idempotent and fenced on `delivering`, so a repeated
   * completion or a late cancel cannot move an attempt that already settled.
   */
  settleAttemptForConversation(input: {
    conversationId: string;
    outcome: "delivered" | "needs_review";
    /**
     * The caller's own send window. A guide delivery built from an attempt copies that
     * attempt's `messagingWindowExpiresAt` verbatim into its `sendWindowExpiresAt`, so
     * this is an exact identity handle: it lets the database refuse a stale callback
     * whose attempt was already force-expired and replaced by a newer one.
     */
    expectedWindowExpiresAt: Date;
  }): Promise<"settled" | "already_settled" | "not_found" | "window_mismatch">;
  /**
   * Operator remedy for an attempt nobody else can clear.
   *
   * Every fault in this flow routes to `needs_review`, which is an ACTIVE state: it blocks
   * the parent's next request for the rest of their messaging window, and no automatic path
   * clears it. This is the one action that does.
   *
   * Refuses any attempt that has, or has had, a delivery — `delivering`, and also any
   * attempt holding `lastFollowResult: "follower"`, which is only reachable by having been
   * `delivering`. Expiring one leaves the conversation with nothing active, so the parent's
   * next message opens a new attempt and sends a SECOND guide while a unit of the first is
   * still retryable — the exact hazard the cancel path had. A stuck delivery is resolved
   * through the delivery review instead, which releases its own attempt correctly.
   *
   * Releasing authorizes nothing: a new attempt must earn its own live follow confirmation.
   * It can, however, mean a parent is sent something they may already have received, which
   * is why the route above it demands an explicit acknowledgement.
   */
  releaseAttemptForConversation(input: {
    conversationId: string;
    actor: string;
    now: Date;
  }): Promise<"released" | "not_found" | "delivering">;
  settleCoverExposure(input: SettleCoverExposureInput): Promise<void>;
  findCoverSnapshot(coverVersionId: string): Promise<GuideAccessCoverSnapshot | null>;
}

/**
 * A snapshot is only usable when the row still carries a DM path. Keeping the id on the
 * attempt while returning a null snapshot preserves owner evidence about which cover was
 * chosen, without ever handing the sender something it cannot send.
 */
function toSnapshot(
  row: { id: string; resourceId: string; dmStoragePath: string | null } | null,
): GuideAccessCoverSnapshot | null {
  if (!row || row.dmStoragePath === null) return null;
  return {
    versionId: row.id,
    resourceId: row.resourceId,
    dmStoragePath: row.dmStoragePath,
  };
}

async function resolveSnapshotById(
  tx: Transaction,
  coverVersionId: string | null,
): Promise<GuideAccessCoverSnapshot | null> {
  if (coverVersionId === null) return null;
  const row = await tx.resourceCoverVersion.findUnique({
    where: { id: coverVersionId },
    select: { id: true, resourceId: true, dmStoragePath: true },
  });
  return toSnapshot(row);
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
              return {
                kind: "loaded" as const,
                attempt: withoutSender(locked),
                // Resolved from the attempt's OWN snapshot id, never a fresh published
                // lookup. A creator publishing a new cover must not change what an
                // in-flight attempt will send.
                cover: await resolveSnapshotById(tx, locked.coverVersionId),
              };
            }
            await expireLockedAttempt(tx, locked, now);
          }
        }

        // One explicit lookup, in this transaction, catalog/row reads only — no Storage.
        const published = await tx.resourceCoverVersion.findFirst({
          where: publishedCoverWhere(input.resourceId),
          select: { id: true, resourceId: true, dmStoragePath: true },
        });
        const created = await tx.guideAccessAttempt.create({
          data: {
            id: idFactory(),
            conversationId: input.conversationId,
            resourceId: input.resourceId,
            coverVersionId: published?.id ?? null,
            messagingWindowExpiresAt: input.messagingWindowExpiresAt,
          },
        });
        return {
          kind: "created" as const,
          attempt: created,
          cover: toSnapshot(published),
        };
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

    async replaceToken(input) {
      requireValidDate(input.now, "guide action replacement time");
      requireValidDate(input.expiresAt, "guide action replacement expiry");
      if (input.expiresAt <= input.now) throw new Error("invalid guide action token expiry");

      return database.$transaction(async (tx) => {
        const attempt = await lockAttempt(tx, input.attemptId);
        if (!attempt) return { kind: "attempt_not_found" as const };
        if (attempt.state !== input.expectedState) {
          return { kind: "state_conflict" as const, actualState: attempt.state };
        }
        if (attempt.messagingWindowExpiresAt <= input.now) {
          await expireLockedAttempt(tx, attempt, input.now);
          return { kind: "attempt_expired" as const };
        }
        if (input.expiresAt > attempt.messagingWindowExpiresAt) {
          throw new Error("guide action token exceeds messaging window");
        }

        await tx.guideActionToken.updateMany({
          where: { attemptId: attempt.id, action: input.action, status: "active" },
          data: { status: "cancelled" },
        });
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
      requireValidDate(input.eventAt, "guide action provider event time");
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
          if (attempt.messagingWindowExpiresAt <= input.eventAt) {
            await expireLockedAttempt(tx, attempt, input.now);
            await tx.guideActionToken.updateMany({
              where: { id: token.id, status: "active" },
              data: { status: "expired" },
            });
            return { kind: "expired" as const };
          }
          if (token.expiresAt <= input.eventAt) {
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
          if (attempt.followCheckCount >= GUIDE_ACCESS_MAX_FOLLOW_CHECKS) {
            return { kind: "check_limit_reached" as const };
          }

          const attemptUpdate = await tx.guideAccessAttempt.updateMany({
            where: {
              id: attempt.id,
              state: expectedState,
              followCheckCount: { lt: GUIDE_ACCESS_MAX_FOLLOW_CHECKS },
              messagingWindowExpiresAt: { gt: input.eventAt },
            },
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

    async claimDirectInbound(input) {
      requireValidDate(input.now, "direct guide inbound claim time");
      return database.$transaction(async (tx) => {
        const attempt = await lockAttempt(tx, input.attemptId);
        if (!attempt) return { kind: "attempt_not_found" as const };

        const existing = await lockToken(tx, input.inboundMessageId);
        if (existing) {
          if (
            existing.attemptId === attempt.id &&
            existing.action === "request_guide" &&
            existing.status === "consumed"
          ) {
            return { kind: "already_consumed" as const };
          }
          return { kind: "token_conflict" as const };
        }

        // A review reached without a definitive follow answer is retryable: the
        // parent was told to try again later, so their next reply must be able to
        // re-check. GUIDE_ACCESS_MAX_FOLLOW_CHECKS below still bounds it. A review that holds a
        // definitive answer (follow-lag limit, or a fault after delivery began)
        // stays terminal and belongs to the owner.
        const retryableReview =
          attempt.state === "needs_review" && attempt.lastFollowResult === "unknown";
        if (
          attempt.state !== "awaiting_request" &&
          attempt.state !== "awaiting_follow" &&
          !retryableReview
        ) {
          return { kind: "state_conflict" as const, actualState: attempt.state };
        }
        if (attempt.messagingWindowExpiresAt <= input.now) {
          await expireLockedAttempt(tx, attempt, input.now);
          return { kind: "expired" as const };
        }
        if (attempt.followCheckCount >= GUIDE_ACCESS_MAX_FOLLOW_CHECKS) {
          return { kind: "check_limit_reached" as const };
        }

        const expectedState = attempt.state;
        const attemptUpdate = await tx.guideAccessAttempt.updateMany({
          where: {
            id: attempt.id,
            state: expectedState,
            // Pin the discriminator too, so a concurrent writer that supplies a
            // definitive answer cannot have its terminal review reopened here.
            ...(retryableReview ? { lastFollowResult: "unknown" as const } : {}),
            followCheckCount: { lt: GUIDE_ACCESS_MAX_FOLLOW_CHECKS },
            messagingWindowExpiresAt: { gt: input.now },
          },
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

        await tx.guideActionToken.create({
          data: {
            id: input.inboundMessageId,
            attemptId: attempt.id,
            action: "request_guide",
            status: "consumed",
            expiresAt: attempt.messagingWindowExpiresAt,
            consumedAt: input.now,
          },
        });
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
    },

    async beginChecking(input) {
      requireValidDate(input.now, "guide follow check time");
      return database.$transaction(async (tx) => {
        const locked = await loadLockedForExpectedState(tx, input.attemptId, input.expectedState);
        if (locked.kind !== "ready") return locked;
        if (locked.attempt.messagingWindowExpiresAt <= input.now) {
          return expireLockedAttempt(tx, locked.attempt, input.now);
        }
        if (locked.attempt.followCheckCount >= GUIDE_ACCESS_MAX_FOLLOW_CHECKS) {
          return { kind: "state_conflict" as const, actualState: locked.attempt.state };
        }
        const updated = await tx.guideAccessAttempt.updateMany({
          where: {
            id: input.attemptId,
            state: input.expectedState,
            followCheckCount: { lt: GUIDE_ACCESS_MAX_FOLLOW_CHECKS },
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
          ...(input.followResult ? { lastFollowResult: input.followResult } : {}),
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

    /**
     * Claim the single cover exposure for this attempt, pessimistically.
     *
     * The claim moves `not_shown -> uncertain` BEFORE the send, because at that moment we
     * genuinely do not know whether Meta will accept it. A crash between here and the
     * settle therefore leaves `uncertain`, which the spec forbids from ever being repeated
     * automatically — the attempt goes to owner review instead. A duplicate action finds
     * `already_claimed` and sends nothing.
     */
    async claimCoverExposure(input) {
      const updated = await database.$transaction(async (tx) => {
        const claimed = await tx.guideAccessAttempt.updateMany({
          where: { id: input.attemptId, coverExposure: "not_shown" },
          data: { coverExposure: "uncertain" },
        });
        if (claimed.count === 1) return { kind: "claimed" as const };
        const attempt = await tx.guideAccessAttempt.findUnique({
          where: { id: input.attemptId },
          select: { coverExposure: true },
        });
        if (!attempt) return { kind: "attempt_not_found" as const };
        return {
          kind: "already_claimed" as const,
          exposure: attempt.coverExposure as "accepted" | "uncertain" | "failed",
        };
      });
      return updated;
    },

    /**
     * Record the definite outcome of a claimed exposure. Only `accepted` makes the cover
     * count as shown for later planning; `failed` means it provably never arrived.
     * Fenced on `uncertain` so a late duplicate cannot overwrite a settled outcome.
     */
    async settleCoverExposure(input) {
      await database.$transaction(async (tx) => {
        await tx.guideAccessAttempt.updateMany({
          where: { id: input.attemptId, coverExposure: "uncertain" },
          data: {
            coverExposure: input.exposure,
            coverProviderMessageId: input.providerMessageId,
          },
        });
      });
    },

    findCoverSnapshot(coverVersionId) {
      return database.$transaction((tx) => resolveSnapshotById(tx, coverVersionId));
    },

    async settleAttemptForConversation(input) {
      return database.$transaction(async (tx) => {
        const attempt = await tx.guideAccessAttempt.findFirst({
          where: {
            conversationId: input.conversationId,
            state: { in: [...ACTIVE_ATTEMPT_STATES] },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, state: true, messagingWindowExpiresAt: true },
        });
        if (!attempt) return "not_found" as const;
        // Only an attempt still mid-delivery may be settled from a ledger outcome. Any
        // other state was already resolved by the action service, and a stale worker
        // callback must not overwrite it.
        if (attempt.state !== "delivering") return "already_settled" as const;
        // The attempt that is active now may not be the one this delivery was built from.
        // Once a window lapses the parent can message again, force-expiring the old
        // attempt and opening a new one that reaches `delivering` under its own, strictly
        // later window. Settling that one would release the conversation mid-flight and
        // permit a duplicate send, so refuse rather than guess.
        if (
          attempt.messagingWindowExpiresAt.getTime() !== input.expectedWindowExpiresAt.getTime()
        ) {
          return "window_mismatch" as const;
        }
        const updated = await tx.guideAccessAttempt.updateMany({
          where: { id: attempt.id, state: "delivering" },
          data: { state: input.outcome },
        });
        return updated.count === 1 ? ("settled" as const) : ("already_settled" as const);
      });
    },

    async releaseAttemptForConversation(input) {
      requireValidDate(input.now, "guide access release time");
      return database.$transaction(async (tx) => {
        if (!(await lockConversation(tx, input.conversationId))) return "not_found" as const;
        const active = await tx.guideAccessAttempt.findFirst({
          where: {
            conversationId: input.conversationId,
            state: { in: [...ACTIVE_ATTEMPT_STATES] },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, state: true, lastFollowResult: true },
        });
        if (!active) return "not_found" as const;
        // `delivering` is the obvious case. `lastFollowResult: "follower"` is the one that
        // hides: an attempt only earns that by reaching `delivering`, and `handleFollower`
        // moves it BACK to `needs_review` when the durable delivery fails to start — leaving
        // a delivery row the owner-review retry can still fire. Releasing that frees the
        // conversation, so the parent's next message opens a new attempt and produces a
        // second full guide, since `deliverGuideForTrigger` dedupes only on the trigger.
        // Reported as `delivering` because the remedy is the same: cancel the delivery,
        // which releases its own attempt correctly.
        if (active.state === "delivering" || active.lastFollowResult === "follower") {
          return "delivering" as const;
        }
        const updated = await tx.guideAccessAttempt.updateMany({
          where: { id: active.id, state: active.state },
          data: { state: "expired" },
        });
        if (updated.count !== 1) return "not_found" as const;
        // Audited in the same transaction as the release. A human deliberately unblocked a
        // parent who may already have received something; that has to be on the record.
        // Conversation-scoped like every other guide event payload — no sender id, no copy.
        await tx.eventLog.create({
          data: {
            kind: "guide_access_owner_action",
            payload: {
              actor: input.actor,
              action: "release_attempt",
              conversationId: input.conversationId,
              attemptId: active.id,
              releasedFrom: active.state,
              at: input.now.toISOString(),
            },
          },
        });
        return "released" as const;
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
        if (locked.attempt.followResponseCount >= GUIDE_ACCESS_MAX_FOLLOW_RESPONSES) {
          return { kind: "limit_reached" as const };
        }
        const updated = await tx.guideAccessAttempt.updateMany({
          where: {
            id: input.attemptId,
            state: input.expectedState,
            followResponseCount: { lt: GUIDE_ACCESS_MAX_FOLLOW_RESPONSES },
            messagingWindowExpiresAt: { gt: input.now },
          },
          data: { followResponseCount: { increment: 1 } },
        });
        if (updated.count !== 1) {
          return { kind: "state_conflict" as const, actualState: locked.attempt.state };
        }
        const responseNumber = (locked.attempt.followResponseCount + 1) as 1 | 2 | 3;
        return { kind: "reserved" as const, responseNumber };
      });
    },
  };
}

export const guideAccessRepository = createGuideAccessRepository();
