import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { lockJourneyIdentity } from "./journeyIdentityLock.js";

/**
 * Database access for historical journey reconciliation (QA-15).
 *
 * Extracted from scripts/reconcile-journeys.ts so the evidence query and the write path
 * can be tested against a real Postgres. They decide which conversation a journey is
 * anchored to, which in turn decides which comment a historical recovery campaign would
 * publicly reply to — and neither had any test at all.
 */

export type ReconciliationRow = {
  id: string;
  igUserId: string;
  keywordId: string;
  createdAt: Date;
  state: string;
  completedAt: Date | null;
  hasSentGate: boolean;
};

/**
 * Every conversation, oldest first, with the §24 tier-2 signal: did Meta accept this
 * journey's gate DM?
 */
export async function loadReconciliationRows(cutoff = new Date()): Promise<ReconciliationRow[]> {
  return prisma.$queryRaw<ReconciliationRow[]>`
    SELECT
      c."id",
      c."ig_user_id"   AS "igUserId",
      c."keyword_id"   AS "keywordId",
      c."created_at"   AS "createdAt",
      CASE
        WHEN c."completed_at" IS NOT NULL AND c."completed_at" <= ${cutoff}
          THEN c."state"::text
        WHEN c."state"::text = 'completed' THEN 'awaiting_done'
        ELSE c."state"::text
      END AS "state",
      CASE WHEN c."completed_at" <= ${cutoff} THEN c."completed_at" ELSE NULL END AS "completedAt",
      -- Meta accepted the gate: EITHER a dm_sent event for this conversation, OR a
      -- gate_queue row that reached 'sent' (QA-15).
      --
      -- gate_queue alone is NOT sufficient, and reading it alone was the defect. It is a
      -- FAILURE queue — a gate accepted on the first attempt never creates a row there.
      -- Measured against production: 3,438 of 4,543 conversations holding a confirmed
      -- gate were invisible to this query, and 30 canonical choices are wrong as a
      -- result, every one of them a repeat asker.
      --
      -- The selector already reads both, with this same reasoning. Reconciliation feeds
      -- the selector, so disagreeing with it here meant the two answered "was this gated?"
      -- differently about the same conversation.
      (
        EXISTS (
          SELECT 1 FROM "event_log" e
          WHERE e."kind" = 'dm_sent'
            AND e."payload"->>'conversationId' = c."id"::text
            AND e."created_at" <= ${cutoff}
        )
        OR EXISTS (
          SELECT 1 FROM "gate_queue" g
          WHERE g."conversation_id" = c."id"
            AND g."status" = 'sent'
            AND g."updated_at" <= ${cutoff}
        )
        OR EXISTS (
          SELECT 1 FROM "dm_recovery_reminder" r
          WHERE r."conversation_id" = c."id"
            AND r."accepted_at" IS NOT NULL
            AND r."accepted_at" <= ${cutoff}
            AND r."instagram_gate_message_id" IS NOT NULL
        )
      ) AS "hasSentGate"
    FROM "conversations" c
    WHERE c."created_at" <= ${cutoff}
    ORDER BY c."ig_user_id", c."keyword_id", c."created_at" ASC, c."id" ASC
  `;
}

/**
 * Would this window be declined because the live path owns an overlapping journey?
 *
 * Read-only, so the DRY RUN can report declines. Without it the dry run counted zero
 * every time — declines were only tallied inside the `--write` branch — which made the
 * review artifact quietly disagree with what applying it would do. That is the same
 * defect QA-14 exists to fix, in the tool meant to make this reviewable.
 *
 * Advisory only. `applyReconciledWindow` re-checks inside its transaction, because a
 * journey can go live between the report and the write.
 */
export async function hasOverlappingLiveIntent(
  w: { igUserId: string; keywordId: string; windowStartedAt: Date; windowExpiresAt: Date },
  now = new Date(),
): Promise<boolean> {
  const found = await prisma.journeyIntent.findFirst({
    where: {
      igUserId: w.igUserId,
      keywordId: w.keywordId,
      windowStartedAt: { lte: w.windowExpiresAt },
      windowExpiresAt: { gte: w.windowStartedAt, gt: now },
      completedAt: null,
    },
    select: { id: true },
  });
  return found !== null;
}

export type WindowWrite = {
  igUserId: string;
  keywordId: string;
  canonicalId: string;
  windowStartedAt: Date;
  lastTriggerAt: Date;
  windowExpiresAt: Date;
  completedAt: Date | null;
  /** How the canonical was chosen, recorded on the conversation for review. */
  choice: string;
  aliases: Array<{ id: string; state: string; reason: string }>;
};

export type ReconciliationManifestWrite = {
  runId: string;
  position: number;
  windowKey: string;
  inputFingerprint: string;
  proposedCanonicalId: string;
  evidenceChoice: string;
};

async function countActiveAliasWork(
  db: Prisma.TransactionClient,
  aliasIds: string[],
): Promise<number> {
  if (aliasIds.length === 0) return 0;
  const [activeGates, activeRecoveries, activeDrafts, activeCandidates] = await Promise.all([
    db.gateQueue.count({ where: { conversationId: { in: aliasIds }, status: "sending" } }),
    db.dmRecoveryReminder.count({
      where: { conversationId: { in: aliasIds }, status: "sending" },
    }),
    db.replyDraft.count({
      where: { sourceConversationId: { in: aliasIds }, status: "sending" },
    }),
    db.recoveryCandidate.count({
      where: {
        conversationId: { in: aliasIds },
        outcome: "pending",
        // A claim is already exclusive work, even before the worker stamps
        // dispatchStartedAt. Repointing the conversation during that interval would
        // let a valid reservation continue against an alias that no longer owns the
        // journey. Pre-network claims are short lived, so decline this window and let
        // the lease reconciler release it before a later reconciliation run.
        claimToken: { not: null },
      },
    }),
  ]);
  return activeGates + activeRecoveries + activeDrafts + activeCandidates;
}

async function lockAndCountActiveAliasWork(
  tx: Prisma.TransactionClient,
  aliasIds: string[],
): Promise<number> {
  if (aliasIds.length === 0) return 0;

  // Lock every row a worker could claim, including pending rows. A worker that
  // began after this read blocks until reconciliation either declines or makes
  // the row terminal, so check-then-act cannot open between the count and repoint.
  const gates = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status"
    FROM "gate_queue"
    WHERE "conversation_id" = ANY(${aliasIds}::uuid[])
      AND "status" IN ('pending', 'sending')
    FOR UPDATE
  `;
  const recoveries = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status"::text AS "status"
    FROM "dm_recovery_reminder"
    WHERE "conversation_id" = ANY(${aliasIds}::uuid[])
      AND "status"::text IN ('waiting', 'sending')
    FOR UPDATE
  `;
  const drafts = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status"::text AS "status"
    FROM "reply_draft"
    WHERE "source_conversation_id" = ANY(${aliasIds}::uuid[])
      AND "status"::text IN (
        'queued', 'generating', 'pending_approval', 'generation_failed',
        'send_failed', 'sending'
      )
    FOR UPDATE
  `;
  const candidates = await tx.$queryRaw<Array<{ claimToken: string | null }>>`
    SELECT "claim_token" AS "claimToken"
    FROM "recovery_candidate"
    WHERE "conversation_id" = ANY(${aliasIds}::uuid[])
      AND "outcome"::text = 'pending'
    FOR UPDATE
  `;

  return (
    gates.filter((row) => row.status === "sending").length +
    recoveries.filter((row) => row.status === "sending").length +
    drafts.filter((row) => row.status === "sending").length +
    candidates.filter((row) => row.claimToken !== null).length
  );
}

export async function hasActiveAliasWork(aliasIds: string[]): Promise<boolean> {
  return (await countActiveAliasWork(prisma as Prisma.TransactionClient, aliasIds)) > 0;
}

export async function inspectReconciliationPreflight(
  w: { igUserId: string; keywordId: string; windowStartedAt: Date; windowExpiresAt: Date },
  aliasIds: string[],
  now = new Date(),
): Promise<
  | "overlapping_live_intent"
  | "multiple_overlapping_intents"
  | "active_alias_work"
  | null
> {
  const overlaps = await prisma.journeyIntent.findMany({
    where: {
      igUserId: w.igUserId,
      keywordId: w.keywordId,
      windowStartedAt: { lte: w.windowExpiresAt },
      windowExpiresAt: { gte: w.windowStartedAt },
    },
    select: { completedAt: true, windowExpiresAt: true },
    orderBy: [{ windowStartedAt: "asc" }, { id: "asc" }],
  });
  if (overlaps.some((row) => row.completedAt === null && row.windowExpiresAt > now)) {
    return "overlapping_live_intent";
  }
  if (overlaps.length > 1) return "multiple_overlapping_intents";
  if (await hasActiveAliasWork(aliasIds)) return "active_alias_work";
  return null;
}

/**
 * Write one reconciled window: its intent, and every conversation repointed at it.
 *
 * ONE TRANSACTION (QA-15). These were four-plus separate statements — upsert the intent,
 * update the canonical, then update each alias in turn — so a crash or a constraint
 * failure part-way left an intent created with some of its conversations repointed and
 * the rest still raw. A re-run then read that half-written window as its own starting
 * state, and the second interpretation could differ from the first.
 *
 * Nothing here is destructive: aliases are labelled, never deleted (design §24.8).
 */
export async function applyReconciledWindow(
  w: WindowWrite,
  now = new Date(),
  hooks: {
    /** Contract-test seam used to force live resolver interleavings. */
    afterIdentityLock?: () => Promise<void>;
    /** Contract-test seam used to force worker-claim interleavings. */
    afterWorkRowsLocked?: () => Promise<void>;
  } = {},
  manifest?: ReconciliationManifestWrite,
): Promise<{
  outcome:
    | "written"
    | "skipped_live_intent"
    | "skipped_active_work"
    | "skipped_overlapping_intents";
  intentId: string | null;
}> {
  return prisma.$transaction(async (tx) => {
    const finish = async (
      outcome:
        | "written"
        | "skipped_live_intent"
        | "skipped_active_work"
        | "skipped_overlapping_intents",
      intentId: string | null,
      conflictReason: string | null,
    ) => {
      if (manifest) {
        await tx.journeyReconciliationWindow.create({
          data: {
            runId: manifest.runId,
            position: manifest.position,
            windowKey: manifest.windowKey,
            inputFingerprint: manifest.inputFingerprint,
            proposedCanonicalId: manifest.proposedCanonicalId,
            evidenceChoice: manifest.evidenceChoice,
            result: outcome,
            conflictReason,
            intentId,
          },
        });
        await tx.journeyReconciliationRun.update({
          where: { id: manifest.runId },
          data: {
            resumePosition: manifest.position + 1,
            resumeCursor: manifest.windowKey,
          },
        });
      }
      return { outcome, intentId };
    };

    await lockJourneyIdentity(tx, w.igUserId, w.keywordId);
    await hooks.afterIdentityLock?.();

    // Match an existing intent by OVERLAP, not by the exact window key (QA-15).
    //
    // The two paths key a window differently: the live path stamps windowStartedAt from
    // the trigger's receivedAt, reconciliation derives it from conversation.createdAt.
    // The unique index is on the exact timestamp, so a few milliseconds of drift produced
    // a SECOND intent describing the same real request — and the selector's
    // `supersededByNewerJourney` would then read one as superseding the other.
    //
    // Latent today: the closest same-person-keyword pair in production is 2.35 days
    // apart. It becomes real the moment reconciliation is re-run, which the evidence fix
    // above requires.
    const overlappingRows = await tx.$queryRaw<
      Array<{
        id: string;
        completedAt: Date | null;
        windowStartedAt: Date;
        lastTriggerAt: Date;
        windowExpiresAt: Date;
      }>
    >`
      SELECT
        "id",
        "completed_at" AS "completedAt",
        "window_started_at" AS "windowStartedAt",
        "last_trigger_at" AS "lastTriggerAt",
        "window_expires_at" AS "windowExpiresAt"
      FROM "journey_intent"
      WHERE "ig_user_id" = ${w.igUserId}
        AND "keyword_id" = ${w.keywordId}::uuid
        AND "window_started_at" <= ${w.windowExpiresAt}
        AND "window_expires_at" >= ${w.windowStartedAt}
      ORDER BY "window_started_at" ASC, "id" ASC
      FOR UPDATE
    `;

    const liveOverlap = overlappingRows.find(
      (row) => row.completedAt === null && row.windowExpiresAt > now,
    );

    // A journey the live path is still driving must not be repointed underneath it: its
    // canonical conversation is what the gate and DONE flow are running against, and
    // moving it mid-flight would strand someone waiting for their guide. Reported rather
    // than silently skipped, so the run's output names every window it declined to touch.
    if (liveOverlap) {
      return finish("skipped_live_intent", liveOverlap.id, "overlapping_live_intent");
    }
    if (overlappingRows.length > 1) {
      return finish(
        "skipped_overlapping_intents",
        overlappingRows[0]?.id ?? null,
        "multiple_overlapping_intents",
      );
    }
    const overlapping = overlappingRows[0] ?? null;

    const aliasIds = w.aliases.map((alias) => alias.id);
    const activeWork = await lockAndCountActiveAliasWork(tx, aliasIds);
    await hooks.afterWorkRowsLocked?.();
    if (activeWork > 0) {
      return finish("skipped_active_work", overlapping?.id ?? null, "active_alias_work");
    }

    const intent = overlapping
      ? await tx.journeyIntent.update({
          where: { id: overlapping.id },
          data: {
            canonicalConversationId: w.canonicalId,
            // MERGE the two windows rather than overwriting one with the other.
            //
            // The existing intent keeps its own windowStartedAt — that timestamp is its
            // identity in the unique index — so a computed window starting even a
            // millisecond earlier would write a lastTriggerAt that precedes it and
            // violate chk_intent_trigger_after_start. Which is exactly what happened
            // here, and it is the same failure shape as the live-path race: a stamp
            // allowed to move backwards.
            //
            // The merged intent must span both windows, so every bound takes the wider
            // value and the result is monotonic in each field.
            lastTriggerAt: new Date(
              Math.max(
                w.lastTriggerAt.getTime(),
                overlapping.lastTriggerAt.getTime(),
                overlapping.windowStartedAt.getTime(),
              ),
            ),
            windowExpiresAt: new Date(
              Math.max(w.windowExpiresAt.getTime(), overlapping.windowExpiresAt.getTime()),
            ),
            // Earliest completion wins: a later trigger inside the window should read as
            // already-completed rather than re-gating someone.
            completedAt:
              w.completedAt && overlapping.completedAt
                ? new Date(Math.min(w.completedAt.getTime(), overlapping.completedAt.getTime()))
                : (w.completedAt ?? overlapping.completedAt),
          },
        })
      : await tx.journeyIntent.create({
          data: {
            igUserId: w.igUserId,
            keywordId: w.keywordId,
            canonicalConversationId: w.canonicalId,
            windowStartedAt: w.windowStartedAt,
            lastTriggerAt: w.lastTriggerAt,
            windowExpiresAt: w.windowExpiresAt,
            completedAt: w.completedAt,
            reconciledState: "canonical",
          },
        });

    const reconciledAt = new Date();
    await tx.conversation.update({
      where: { id: w.canonicalId },
      data: {
        canonicalIntentId: intent.id,
        reconciliationReason: `canonical:${w.choice}`,
        reconciledAt,
      },
    });
    for (const alias of w.aliases) {
      await tx.conversation.update({
        where: { id: alias.id },
        data: {
          canonicalIntentId: intent.id,
          reconciliationReason: `${alias.state}:${alias.reason}`,
          reconciledAt,
        },
      });
    }

    if (aliasIds.length > 0) {
      await tx.gateQueue.updateMany({
        where: { conversationId: { in: aliasIds }, status: "pending" },
        data: { status: "abandoned", lastError: "reconciled_alias" },
      });
      await tx.dmRecoveryReminder.updateMany({
        where: { conversationId: { in: aliasIds }, status: "waiting" },
        data: {
          status: "suppressed",
          suppressedAt: now,
          suppressionReason: "reconciled_alias",
        },
      });
      await tx.replyDraft.updateMany({
        where: {
          sourceConversationId: { in: aliasIds },
          status: {
            in: ["queued", "generating", "pending_approval", "generation_failed", "send_failed"],
          },
        },
        data: { status: "superseded", errorCode: "reconciled_alias" },
      });
      await tx.recoveryCandidate.updateMany({
        where: {
          conversationId: { in: aliasIds },
          outcome: "pending",
          claimToken: null,
        },
        data: { outcome: "suppressed", suppressionReason: "reconciled_alias" },
      });
    }

    return finish("written", intent.id, null);
  });
}
