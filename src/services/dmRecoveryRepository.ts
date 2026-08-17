import { randomUUID } from "node:crypto";
import type { DmRecoveryReminder, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { logEvent } from "./eventLogger.js";
import { recordRecoveryDatabaseFailure } from "./dmRecoveryHealth.js";
import { inferOrigin, type Origin } from "./originInference.js";
import { ORIGIN_PROMPT_VERSION } from "./originClassifier.js";
import {
  decideRecovery,
  type RecoveryDecision,
  type RecoveryPolicyInput,
} from "./dmRecoveryPolicy.js";
import {
  finalizePublicRecoveryDispatch,
  reservePublicRecoveryDispatch,
  startPublicRecoveryDispatch,
} from "./publicRecoveryDispatchRepository.js";
import { resolveCanonicalConversation } from "./canonicalConversation.js";
import { DM_RECOVERY_TIMING_EXPERIMENT_VERSION } from "./dmRecoveryTimingExperiment.js";

export type ClaimedRecovery = DmRecoveryReminder & { claimToken: string };

type AuthorizedRecoverySend = {
  kind: "send_no_confirmed_read_reminder" | "send_settings_fallback";
  dispatchId: string;
  reservationToken: string;
};

export type FinalRecoveryCheck =
  | Exclude<RecoveryDecision, SendDecision>
  | AuthorizedRecoverySend
  | { kind: "pause"; reason: "circuit_open" | "hourly_cap" | "daily_cap" }
  /** Hand the row back to `waiting` without judging the person. */
  | { kind: "release"; reason: string };

/**
 * Historical recovery's own person cooldown, in days (design §39: one historical
 * recovery per person per 30 days). Longer than the prospective 24-hour rule because
 * these reach back weeks, so the stricter window governs when both apply.
 */
const HISTORICAL_COOLDOWN_DAYS = 30;

const COOLDOWN_HOURS_FALLBACK = 24;

type PolicyContext = {
  now: Date;
  conversationCompletedAt: Date | null;
  hasRecentSentReminderForPerson: boolean;
  hasNewerEligibleCandidate: boolean;
  audienceOrigin: Origin;
  audienceOriginConfidence: "high" | "low";
  isAlias: boolean;
};

/**
 * Gather everything decideRecovery needs that does not live on the row.
 *
 * Every read happens inside the caller's transaction, so the decision is made
 * against one consistent snapshot rather than values that could drift between
 * checks.
 */
async function loadPolicyContext(
  tx: Prisma.TransactionClient,
  row: DmRecoveryReminder,
  now: Date,
): Promise<PolicyContext> {
  const canonical = await resolveCanonicalConversation(tx, row.conversationId);
  const convo = await tx.conversation.findUnique({
    where: { id: row.conversationId },
    select: { state: true, completedAt: true, igUserId: true, keywordId: true, canonicalIntentId: true },
  });

  // Completion anywhere in this person's journey for this keyword, not just on the
  // row's own conversation (QA-06).
  //
  // `suppressRecoveriesForCompletionSafely` swallows database errors on purpose so a
  // completion webhook is never lost to a suppression failure. That makes the
  // denormalised stamp a speed optimisation, NOT a safety authority: if it fails, the
  // source conversation stays open and this final check — the last gate before a
  // public post — saw nothing.
  //
  // Two authorities, in order of strength:
  //   1. the canonical intent's completedAt (the journey's own answer, post-Feature 3)
  //   2. any sibling conversation on the same person + keyword that completed
  //
  // (2) exists because intents only cover journeys reconciliation or the live resolver
  // has reached; a pre-Feature-3 pair has siblings but no intent.
  //
  // Measured before the change: 0 live and 0 historical instances, i.e. the best-effort
  // stamp has been succeeding. This closes the latent hole, it does not repair damage.
  const journeyCompletedAt = convo ? await findJourneyCompletion(tx, row, convo) : null;

  const cooldownHours = env.DM_RECOVERY_COOLDOWN_HOURS ?? COOLDOWN_HOURS_FALLBACK;
  const cooldownSince = new Date(now.getTime() - cooldownHours * 60 * 60 * 1000);
  const historicalCooldownSince = new Date(
    now.getTime() - HISTORICAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  );
  const recentAttempt = await tx.publicRecoveryDispatch.findFirst({
    where: {
      igUserId: row.igUserId,
      OR: [
        {
          state: { in: ["reserved", "dispatch_started"] },
        },
        {
          sourceKind: "historical",
          state: { in: ["sent", "uncertain"] },
          dispatchStartedAt: { gt: historicalCooldownSince },
        },
        {
          sourceKind: "prospective",
          sourceId: { not: row.id },
          state: { in: ["sent", "uncertain"] },
          dispatchStartedAt: { gt: cooldownSince },
        },
      ],
    },
    select: { id: true },
  });

  // "The most recently eligible record wins." Due rows are processed oldest
  // first for fairness across people, so without this the OLDEST reminder would
  // win for any one person. Ordering matches the plan: highest eligibleAt, then
  // newest createdAt, then a stable id tie-break.
  const newerCandidate = await tx.dmRecoveryReminder.findFirst({
    where: {
      igUserId: row.igUserId,
      id: { not: row.id },
      status: "waiting",
      eligibleAt: { lte: now },
      OR: [
        { eligibleAt: { gt: row.eligibleAt } },
        { eligibleAt: row.eligibleAt, createdAt: { gt: row.createdAt } },
        { eligibleAt: row.eligibleAt, createdAt: row.createdAt, id: { gt: row.id } },
      ],
    },
    select: { id: true },
  });

  // Classified live from the current name/username rather than read from
  // Two-tier origin resolution.
  //
  // Tier 1 is the stored verdict from the Gemini enrichment pass, which is far
  // more accurate than name tokens (measured on 50 real gate users: 22 caught
  // vs 3). Tier 2 is the pure name-token screen.
  //
  // The fallback is the safety property, not an optimisation. The stored column
  // is null for anyone the worker has not reached yet — a brand-new user, a
  // paused worker, an exhausted budget, or an unset API key — and reading null
  // as "not South Asian" would silently open the gate for exactly the newest
  // people. Falling back keeps the weaker screen instead of no screen.
  const person = await tx.igUser.findUnique({
    where: { id: row.igUserId },
    select: {
      username: true,
      name: true,
      inferredOrigin: true,
      originConfidence: true,
      originMethod: true,
    },
  });

  const origin = resolveAudienceOrigin(person);

  const ownCompletedAt = convo?.state === "completed" ? (convo.completedAt ?? now) : null;

  return {
    now,
    // The earliest completion we can prove, from any of the three sources. Earliest
    // rather than latest because `decideRecovery` only asks "was it delivered before
    // we post", and the earliest proof is the strongest answer to that.
    conversationCompletedAt: earliest(ownCompletedAt, journeyCompletedAt),
    // Either system counts. The flag means "this person was publicly contacted
    // recently", not "this table has a row".
    hasRecentSentReminderForPerson: Boolean(recentAttempt),
    hasNewerEligibleCandidate: Boolean(newerCandidate),
    audienceOrigin: origin.origin,
    audienceOriginConfidence: origin.confidence,
    isAlias: canonical?.role === "alias",
  };
}

/**
 * Completion proven anywhere in this person's journey for this keyword (QA-06).
 *
 * Returns null when nothing proves delivery. Never throws for a missing relation:
 * an unreconciled conversation has no intent, and that is the normal case for
 * anything predating Feature 3.
 */
async function findJourneyCompletion(
  tx: Prisma.TransactionClient,
  row: DmRecoveryReminder,
  convo: { igUserId: string; keywordId: string; canonicalIntentId: string | null },
): Promise<Date | null> {
  // 1. The journey's own answer. Authoritative once Feature 3 owns the journey,
  //    and after QA-05 it is also stamped when completion arrives via an alias.
  const intent = convo.canonicalIntentId
    ? await tx.journeyIntent.findUnique({
        where: { id: convo.canonicalIntentId },
        select: { completedAt: true },
      })
    : null;

  // 2. A sibling conversation for the same person and keyword that completed.
  //    Covers journeys with no intent yet, and any case where the intent stamp
  //    itself was the write that failed.
  const sibling = await tx.conversation.findFirst({
    where: {
      igUserId: convo.igUserId,
      keywordId: convo.keywordId,
      id: { not: row.conversationId },
      completedAt: { not: null },
    },
    orderBy: { completedAt: "asc" },
    select: { completedAt: true },
  });

  return earliest(intent?.completedAt ?? null, sibling?.completedAt ?? null);
}

/** The earlier of two optional instants, or null when both are absent. */
function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

/** Row shape the origin resolver needs. Exported for the test's fixtures. */
export type OriginSource = {
  username: string | null;
  name: string | null;
  inferredOrigin: string | null;
  originConfidence: string | null;
  originMethod: string | null;
} | null;

/**
 * Prefer a stored LLM verdict; otherwise classify the name live.
 *
 * Only a verdict written by the CURRENT prompt version is trusted. The same
 * columns are also written by the one-time backfill script (origin_method
 * "name"), whose values are just the token screen already available here — and
 * by any future prompt. Pinning the version means a prompt change re-earns
 * trust through the worker rather than inheriting it.
 */
export function resolveAudienceOrigin(person: OriginSource): {
  origin: Origin;
  confidence: "high" | "low";
} {
  const stored = person?.inferredOrigin;
  if (person && person.originMethod === ORIGIN_PROMPT_VERSION && isOrigin(stored)) {
    return {
      origin: stored,
      // Anything not exactly "high" reads as low: "high" is the value that
      // withholds a public reminder, so a malformed column must not grant it.
      confidence: person.originConfidence === "high" ? "high" : "low",
    };
  }
  const inferred = inferOrigin(person?.username ?? null, person?.name ?? null);
  return { origin: inferred.origin, confidence: inferred.confidence };
}

const ORIGINS = new Set(["us_western", "south_asian", "other", "unknown"]);

function isOrigin(value: string | null | undefined): value is Origin {
  return typeof value === "string" && ORIGINS.has(value);
}

function toPolicyInput(
  row: DmRecoveryReminder,
  ctx: PolicyContext,
  statusOverride?: string,
): RecoveryPolicyInput {
  return {
    now: ctx.now,
    triggerKind: row.triggerKind,
    status: statusOverride ?? row.status,
    cohort: row.cohort,
    experimentVersionSnapshot: row.experimentVersionSnapshot,
    timingArm: row.timingArm,
    eligibleAt: row.eligibleAt,
    instagramGateMessageId: row.instagramGateMessageId,
    seenAt: row.seenAt,
    engagedAt: row.engagedAt,
    firstEngagementKind: row.firstEngagementKind,
    conversationCompletedAt: ctx.conversationCompletedAt,
    cancelledAt: row.cancelledAt,
    hasRecentSentReminderForPerson: ctx.hasRecentSentReminderForPerson,
    hasNewerEligibleCandidate: ctx.hasNewerEligibleCandidate,
    isSourceCommentAvailable: Boolean(row.commentId),
    audienceOrigin: ctx.audienceOrigin,
    audienceOriginConfidence: ctx.audienceOriginConfidence,
    westernOnly: env.DM_RECOVERY_WESTERN_ONLY,
  };
}

type SendDecision = Extract<
  RecoveryDecision,
  { kind: "send_no_confirmed_read_reminder" | "send_settings_fallback" }
>;

function isSendDecision(decision: RecoveryDecision): decision is SendDecision {
  return (
    decision.kind === "send_no_confirmed_read_reminder" ||
    decision.kind === "send_settings_fallback"
  );
}

/** Persist a terminal or withholding policy result. `wait` needs no write. */
async function persistNonSendDecision(
  tx: Prisma.TransactionClient,
  id: string,
  decision: RecoveryDecision,
  now: Date,
): Promise<void> {
  if (decision.kind === "suppress") {
    await tx.dmRecoveryReminder.update({
      where: { id },
      data: {
        status: "suppressed",
        suppressedAt: now,
        suppressionReason: decision.reason,
      },
    });
    return;
  }
  if (decision.kind === "holdout") {
    // Reconcile a row whose cohort says control but whose status did not.
    await tx.dmRecoveryReminder.update({ where: { id }, data: { status: "control" } });
  }
}

const P2034_RETRY_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * List due recovery reminder IDs ordered by eligibleAt ASC, createdAt ASC.
 */
/**
 * Fetch above the worker's batch size. Rows at the front of the queue are often
 * suppressed during the claim (cooldown, evidence, supersession); without
 * headroom those consume the batch and delay people who could actually be sent.
 */
const DUE_SELECTION_HEADROOM = 3;

const SENDABLE_ASSIGNMENT_WHERE: Prisma.DmRecoveryReminderWhereInput = {
  OR: [
    { experimentVersionSnapshot: null },
    {
      experimentVersionSnapshot: DM_RECOVERY_TIMING_EXPERIMENT_VERSION,
      cohort: "treatment",
      timingArm: { in: ["two_hour", "six_hour"] },
    },
  ],
};

export async function listDueRecoveryIds(now: Date, limit: number): Promise<string[]> {
  const rows = await prisma.dmRecoveryReminder.findMany({
    where: {
      status: "waiting",
      eligibleAt: { lte: now },
      AND: [
        SENDABLE_ASSIGNMENT_WHERE,
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      ],
    },
    select: { id: true },
    orderBy: [{ eligibleAt: "asc" }, { createdAt: "asc" }],
    take: limit * DUE_SELECTION_HEADROOM,
  });
  return rows.map((r) => r.id);
}

/**
 * Claim an eligible waiting recovery row compare-and-set style.
 * Uses a row lock on ig_users in a transaction with retries for serialization conflicts (P2034).
 */
export async function claimRecovery(
  id: string,
  now: Date,
  leaseUntil: Date,
): Promise<ClaimedRecovery | null> {
  let attempt = 0;
  while (attempt < P2034_RETRY_ATTEMPTS) {
    attempt++;
    // Buffered until the transaction commits: an event written inside it
    // survives a rollback as a claim that never happened, and the extra
    // round-trip holds the serializable lock open for longer.
    const pendingEvents: Array<[string, Record<string, unknown>]> = [];
    const claimToken = randomUUID();
    try {
      const claimed = await prisma.$transaction(
        async (tx) => {
          const candidate = await tx.dmRecoveryReminder.findUnique({
            where: { id },
          });

          if (
            !candidate ||
            candidate.status !== "waiting" ||
            candidate.eligibleAt > now ||
            (candidate.nextAttemptAt !== null && candidate.nextAttemptAt > now)
          ) {
            return null;
          }

          // Row lock person to serialize decisions for this user
          try {
            await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "ig_users" WHERE "id" = ${candidate.igUserId} FOR UPDATE
            `;
          } catch {
            // ig_user row lock attempt ignored if user deleted
          }

          const ctx = await loadPolicyContext(tx, candidate, now);
          const decision: RecoveryDecision = ctx.isAlias
            ? { kind: "suppress", reason: "reconciled_alias" }
            : decideRecovery(toPolicyInput(candidate, ctx));

          if (!isSendDecision(decision)) {
            await persistNonSendDecision(tx, id, decision, now);
            if (decision.kind === "suppress") {
              pendingEvents.push([
                "dm_recovery_cooldown_suppressed",
                { id, igUserId: candidate.igUserId, reason: decision.reason },
              ]);
            }
            return null;
          }

          pendingEvents.push([
            "dm_recovery_ready",
            { id, igUserId: candidate.igUserId, triggerKind: candidate.triggerKind },
          ]);

          // Perform atomic compare-and-set claim
          const result = await tx.dmRecoveryReminder.updateMany({
            where: {
              id,
              status: "waiting",
              claimToken: null,
              eligibleAt: { lte: now },
              AND: [
                SENDABLE_ASSIGNMENT_WHERE,
                { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
              ],
            },
            data: {
              status: "sending",
              claimedAt: now,
              claimExpiresAt: leaseUntil,
              claimToken,
            },
          });

          if (result.count === 0) return null;

          const claimedRow = await tx.dmRecoveryReminder.findFirst({
            where: { id, claimToken },
          });

          if (claimedRow) {
            pendingEvents.push([
              "dm_recovery_claimed",
              { id, igUserId: claimedRow.igUserId, status: "sending" },
            ]);
          }

          return claimedRow as ClaimedRecovery | null;
        },
        { isolationLevel: "Serializable" },
      );
      for (const [kind, payload] of pendingEvents) await logEvent(kind, payload);
      return claimed;
    } catch (err: any) {
      if (err?.code === "P2034" && attempt < P2034_RETRY_ATTEMPTS) {
        await sleep(20 + Math.random() * 30);
        continue;
      }
      recordRecoveryDatabaseFailure();
      logger.error({ errorCode: "claim_recovery_failed", id }, "claimRecovery error");
      return null;
    }
  }
  return null;
}

/**
 * Final pre-network authorization check before worker calls Meta.
 * Locks the singleton dm_recovery_control row and checks circuit state, hourly cap, evidence, and cooldown.
 */
export async function authorizeClaimForSend(
  id: string,
  claimToken: string,
  now: Date,
): Promise<FinalRecoveryCheck> {
  try {
    return await prisma.$transaction(async (tx) => {
      const sourceHint = await tx.dmRecoveryReminder.findUnique({
        where: { id },
        select: { igUserId: true },
      });
      if (!sourceHint) return { kind: "release", reason: "stale_claim" };

      await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ig_users" WHERE "id" = ${sourceHint.igUserId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "dm_recovery_reminder" WHERE "id" = ${id}::uuid FOR UPDATE`;

      const control = await tx.dmRecoveryControl.findUnique({ where: { id: 1 } });
      if (control?.circuitOpen) {
        return { kind: "pause", reason: "circuit_open" };
      }

      const row = await tx.dmRecoveryReminder.findUnique({ where: { id } });
      if (
        !row ||
        row.status !== "sending" ||
        row.claimToken !== claimToken ||
        !row.claimExpiresAt ||
        row.claimExpiresAt <= now
      ) {
        return { kind: "release", reason: "stale_claim" };
      }

      // Evidence, a cooldown, or a newer candidate can all arrive during the
      // lease window, so the full policy runs again here — the last moment
      // before a public comment is posted. The row is `sending` because we hold
      // the claim; the policy is asked whether that claim may still proceed.
      const ctx = await loadPolicyContext(tx, row, now);
      const decision: RecoveryDecision = ctx.isAlias
        ? { kind: "suppress", reason: "reconciled_alias" }
        : decideRecovery(toPolicyInput(row, ctx, "waiting"));

      if (!isSendDecision(decision)) {
        return decision;
      }

      const reservation = await reservePublicRecoveryDispatch(tx, {
        sourceKind: "prospective",
        sourceId: row.id,
        attemptNumber: row.attempts + 1,
        igUserId: row.igUserId,
        campaignId: null,
        now,
        leaseExpiresAt: row.claimExpiresAt,
        prospectiveCooldownHours: env.DM_RECOVERY_COOLDOWN_HOURS ?? COOLDOWN_HOURS_FALLBACK,
        globalHourlyCap: env.DM_RECOVERY_HOURLY_CAP ?? 30,
        globalDailyCap: env.DM_RECOVERY_GLOBAL_DAILY_CAP,
      });
      if (reservation.kind === "blocked") {
        if (reservation.reason === "global_hourly_cap_reached") {
          return { kind: "pause", reason: "hourly_cap" };
        }
        if (reservation.reason === "global_daily_cap_reached") {
          return { kind: "pause", reason: "daily_cap" };
        }
        if (reservation.reason === "person_cooldown") {
          return { kind: "suppress", reason: "person_cooldown" };
        }
        return { kind: "release", reason: reservation.reason };
      }

      const sourceUpdated = await tx.dmRecoveryReminder.updateMany({
        where: { id, status: "sending", claimToken },
        data: { lastAttemptAt: now, attempts: row.attempts + 1 },
      });
      if (sourceUpdated.count !== 1) throw new Error("prospective source moved during reservation");

      return {
        kind: decision.kind,
        dispatchId: reservation.dispatchId,
        reservationToken: reservation.reservationToken,
      };
    });
  } catch (err) {
    recordRecoveryDatabaseFailure();
    logger.error({ errorCode: "authorize_claim_failed", id }, "authorizeClaimForSend failed");
    return { kind: "pause", reason: "circuit_open" };
  }
}

export async function startProspectiveDispatch(input: {
  reminderId: string;
  claimToken: string;
  dispatchId: string;
  reservationToken: string;
  now: Date;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const sourceHint = await tx.dmRecoveryReminder.findUnique({
      where: { id: input.reminderId },
      select: { igUserId: true },
    });
    if (!sourceHint) return false;
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ig_users" WHERE "id" = ${sourceHint.igUserId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_reminder" WHERE "id" = ${input.reminderId}::uuid FOR UPDATE`;

    const source = await tx.dmRecoveryReminder.findUnique({ where: { id: input.reminderId } });
    if (
      !source ||
      source.status !== "sending" ||
      source.claimToken !== input.claimToken ||
      !source.claimExpiresAt ||
      source.claimExpiresAt <= input.now
    ) {
      return false;
    }
    return startPublicRecoveryDispatch(tx, input);
  });
}

export async function finalizeProspectiveDispatch(input: {
  reminderId: string;
  claimToken: string;
  dispatchId: string;
  reservationToken: string;
  outcome:
    | { kind: "sent"; at: Date; providerReplyId: string }
    | { kind: "uncertain"; reason: string }
    | {
        kind: "released";
        at: Date;
        reason: string;
        sourceStatus: "waiting" | "send_failed" | "suppressed";
        nextAttemptAt?: Date;
      };
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const sourceHint = await tx.dmRecoveryReminder.findUnique({
      where: { id: input.reminderId },
      select: { igUserId: true },
    });
    if (!sourceHint) return false;
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ig_users" WHERE "id" = ${sourceHint.igUserId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_reminder" WHERE "id" = ${input.reminderId}::uuid FOR UPDATE`;

    const source = await tx.dmRecoveryReminder.findUnique({ where: { id: input.reminderId } });
    if (!source || source.status !== "sending" || source.claimToken !== input.claimToken) {
      return false;
    }
    if (
      !(await finalizePublicRecoveryDispatch(tx, {
        ...(input.outcome.kind === "released"
          ? {
              kind: "released" as const,
              at: input.outcome.at,
              reason: input.outcome.reason,
            }
          : input.outcome),
        dispatchId: input.dispatchId,
        reservationToken: input.reservationToken,
      }))
    ) {
      return false;
    }

    const common = { claimedAt: null, claimExpiresAt: null, claimToken: null };
    const result = await tx.dmRecoveryReminder.updateMany({
      where: { id: input.reminderId, status: "sending", claimToken: input.claimToken },
      data:
        input.outcome.kind === "sent"
          ? {
              ...common,
              status: "sent",
              publicReplyId: input.outcome.providerReplyId,
              sentAt: input.outcome.at,
            }
          : input.outcome.kind === "uncertain"
            ? { ...common, status: "send_uncertain", lastErrorCategory: input.outcome.reason }
            : {
                ...common,
                status: input.outcome.sourceStatus,
                lastErrorCategory: input.outcome.reason,
                nextAttemptAt: input.outcome.nextAttemptAt,
                ...(input.outcome.sourceStatus === "suppressed"
                  ? {
                      suppressedAt: input.outcome.at,
                      suppressionReason: input.outcome.reason,
                    }
                  : {}),
              },
    });
    return result.count === 1;
  });
}

export async function reconcileExpiredProspectiveLeases(
  now: Date,
): Promise<{ released: number; uncertain: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE`;
    const rows = await tx.dmRecoveryReminder.findMany({
      where: {
        status: "sending",
        claimToken: { not: null },
        claimExpiresAt: { lte: now },
        AND: [SENDABLE_ASSIGNMENT_WHERE],
      },
      orderBy: [{ igUserId: "asc" }, { id: "asc" }],
    });
    let released = 0;
    let uncertain = 0;
    for (const row of rows) {
      await tx.$queryRaw`SELECT "id" FROM "ig_users" WHERE "id" = ${row.igUserId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "dm_recovery_reminder" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
      const ledger = await tx.publicRecoveryDispatch.findFirst({
        where: {
          sourceKind: "prospective",
          sourceId: row.id,
          attemptNumber: row.attempts,
          state: { in: ["reserved", "dispatch_started"] },
        },
      });
      const mayHaveDispatched = ledger?.state === "dispatch_started";
      if (ledger) {
        await finalizePublicRecoveryDispatch(
          tx,
          mayHaveDispatched
            ? {
                kind: "uncertain",
                dispatchId: ledger.id,
                reservationToken: ledger.reservationToken,
                reason: "dispatch_lease_expired",
              }
            : {
                kind: "released",
                dispatchId: ledger.id,
                reservationToken: ledger.reservationToken,
                at: now,
                reason: "dispatch_lease_expired",
              },
        );
      }
      const updated = await tx.dmRecoveryReminder.updateMany({
        where: { id: row.id, status: "sending", claimToken: row.claimToken },
        data: mayHaveDispatched
          ? {
              status: "send_uncertain",
              lastErrorCategory: "dispatch_lease_expired",
              claimedAt: null,
              claimExpiresAt: null,
              claimToken: null,
            }
          : {
              status: "waiting",
              lastErrorCategory: "dispatch_lease_expired",
              nextAttemptAt: new Date(now.getTime() + 5 * 60 * 1000),
              claimedAt: null,
              claimExpiresAt: null,
              claimToken: null,
            },
      });
      if (updated.count === 1) {
        if (mayHaveDispatched) uncertain++;
        else released++;
      }
    }
    return { released, uncertain };
  });
}

/**
 * Release a paused claim back to waiting or suppress a claim.
 */
export async function releaseOrSuppressClaim(
  id: string,
  decision: FinalRecoveryCheck,
  now: Date,
  claimToken?: string,
): Promise<boolean> {
  // Every non-send outcome must move the row out of `sending`. A row left
  // claimed is reconciled to send_uncertain once its lease expires, which sends
  // a perfectly healthy hold to manual review.
  const data =
    decision.kind === "suppress"
      ? {
          status: "suppressed" as const,
          suppressionReason: decision.reason,
          suppressedAt: now,
          claimedAt: null,
          claimExpiresAt: null,
          claimToken: null,
        }
      : decision.kind === "holdout"
        ? { status: "control" as const, claimedAt: null, claimExpiresAt: null, claimToken: null }
        : // pause, release and wait all hand the row back untouched: the person
          // has not been judged, only deferred.
          { status: "waiting" as const, claimedAt: null, claimExpiresAt: null, claimToken: null };
  const releasesToWaiting =
    decision.kind !== "suppress" && decision.kind !== "holdout";

  try {
    const res = await prisma.dmRecoveryReminder.updateMany({
      where: {
        id,
        status: "sending",
        ...(claimToken ? { claimToken } : {}),
        ...(releasesToWaiting ? { AND: [SENDABLE_ASSIGNMENT_WHERE] } : {}),
      },
      data,
    });
    return res.count > 0;
  } catch {
    recordRecoveryDatabaseFailure();
    return false;
  }
}
