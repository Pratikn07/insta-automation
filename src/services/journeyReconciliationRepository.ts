import { prisma } from "../lib/prisma.js";

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
export async function loadReconciliationRows(): Promise<ReconciliationRow[]> {
  return prisma.$queryRaw<ReconciliationRow[]>`
    SELECT
      c."id",
      c."ig_user_id"   AS "igUserId",
      c."keyword_id"   AS "keywordId",
      c."created_at"   AS "createdAt",
      c."state"::text  AS "state",
      c."completed_at" AS "completedAt",
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
            AND (e."payload"->>'conversationId')::uuid = c."id"
        )
        OR EXISTS (
          SELECT 1 FROM "gate_queue" g
          WHERE g."conversation_id" = c."id" AND g."status" = 'sent'
        )
      ) AS "hasSentGate"
    FROM "conversations" c
    ORDER BY c."ig_user_id", c."keyword_id", c."created_at" ASC
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
): Promise<{ outcome: "written" | "skipped_live_intent"; intentId: string }> {
  return prisma.$transaction(async (tx) => {
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
    const overlapping = await tx.journeyIntent.findFirst({
      where: {
        igUserId: w.igUserId,
        keywordId: w.keywordId,
        windowStartedAt: { lte: w.windowExpiresAt },
        windowExpiresAt: { gte: w.windowStartedAt },
      },
      orderBy: { windowStartedAt: "asc" },
    });

    // A journey the live path is still driving must not be repointed underneath it: its
    // canonical conversation is what the gate and DONE flow are running against, and
    // moving it mid-flight would strand someone waiting for their guide. Reported rather
    // than silently skipped, so the run's output names every window it declined to touch.
    if (overlapping && overlapping.completedAt === null && overlapping.windowExpiresAt > now) {
      return { outcome: "skipped_live_intent" as const, intentId: overlapping.id };
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

    return { outcome: "written" as const, intentId: intent.id };
  });
}
