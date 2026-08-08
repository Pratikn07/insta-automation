import { prisma } from "../src/lib/prisma.js";

/**
 * Give historical journey intents the comment they came from.
 *
 *   npx tsx scripts/backfill-journey-triggers.ts            # dry run, writes nothing
 *   npx tsx scripts/backfill-journey-triggers.ts --write    # apply
 *
 * scripts/reconcile-journeys.ts created 4,187 intents but no triggers, so
 * journey_trigger currently claims that almost nobody ever commented. Feature 4
 * has to post a public reply ON a specific comment, so an intent without one is
 * unusable — and the table is actively misleading until this runs.
 *
 * The ids are recoverable: event_log.keyword_matched carries commentId for most
 * rows, and gate_queue.comment_id covers some that predate it.
 *
 * Safe to re-run. Existing triggers are left alone, and a comment already claimed
 * is skipped rather than overwritten.
 *
 * QA-16: this now sweeps ALIAS conversations too, not only each intent's canonical one.
 * The first version skipped an intent entirely once it had any trigger, so a person who
 * asked three times showed one ask. Aliases are stamped `reused_active` and keep their
 * own timestamp, which is what makes "reply to the newest available source" possible.
 */

const WRITE = process.argv.includes("--write");

type Candidate = {
  intentId: string;
  conversationId: string;
  igUserId: string;
  keywordId: string;
  commentId: string | null;
  mediaId: string | null;
  source: string | null;
  receivedAt: Date;
  /** False for an alias conversation: a later ask on the same journey. */
  isCanonical: boolean;
};

async function loadCandidates(): Promise<Candidate[]> {
  // EVERY conversation in each reconciled window, canonical and alias alike (QA-16).
  //
  // This previously joined only `canonical_conversation_id` and skipped any intent that
  // already had a trigger, so an alias conversation's comment was never recorded: the
  // canonical timeline claimed one ask where there had been two or three.
  //
  // Measured before the change: 749 alias conversations had no trigger row. 480 of them
  // are DM-sourced, where no comment exists to record and Feature 4 excludes the source
  // anyway; 217 have a recoverable comment id; 52 have neither. Of the eligible pool,
  // 142 intents were affected and 54 held a comment NEWER than the one recorded — which
  // is why QA-11's "reply to the newest available source" could not work until this ran.
  //
  // `receivedAt` comes from the conversation's own createdAt rather than the intent's
  // window start: an alias is a LATER ask, and stamping it with the window start would
  // make every trigger look simultaneous and destroy the ordering QA-11 needs.
  return prisma.$queryRaw<Candidate[]>`
    SELECT
      ji."id"                 AS "intentId",
      c."id"                  AS "conversationId",
      ji."ig_user_id"         AS "igUserId",
      ji."keyword_id"         AS "keywordId",
      COALESCE(
        (SELECT e."payload"->>'commentId' FROM "event_log" e
          WHERE e."kind" = 'keyword_matched'
            AND (e."payload"->>'conversationId')::uuid = c."id"
            AND e."payload"->>'commentId' IS NOT NULL
          ORDER BY e."created_at" LIMIT 1),
        (SELECT g."comment_id" FROM "gate_queue" g
          WHERE g."conversation_id" = c."id"
          ORDER BY g."created_at" LIMIT 1)
      )                       AS "commentId",
      (SELECT e."payload"->>'mediaId' FROM "event_log" e
        WHERE e."kind" = 'keyword_matched'
          AND (e."payload"->>'conversationId')::uuid = c."id"
        ORDER BY e."created_at" LIMIT 1) AS "mediaId",
      (SELECT e."payload"->>'source' FROM "event_log" e
        WHERE e."kind" = 'keyword_matched'
          AND (e."payload"->>'conversationId')::uuid = c."id"
        ORDER BY e."created_at" LIMIT 1) AS "source",
      -- The canonical conversation opened the window, so it keeps the window start.
      -- An alias is a later ask and keeps its own creation time.
      CASE WHEN c."id" = ji."canonical_conversation_id"
           THEN ji."window_started_at"
           ELSE c."created_at"
      END                     AS "receivedAt",
      (c."id" = ji."canonical_conversation_id") AS "isCanonical"
    FROM "journey_intent" ji
    JOIN "conversations" c
      ON c."id" = ji."canonical_conversation_id"
      OR c."canonical_intent_id" = ji."id"
    -- Per CONVERSATION, not per intent. The old NOT EXISTS was per intent, so the
    -- moment the canonical conversation had a trigger every alias was skipped.
    WHERE NOT EXISTS (
      SELECT 1 FROM "journey_trigger" jt
      WHERE jt."intent_id" = ji."id" AND jt."conversation_id" = c."id"
    )
    ORDER BY ji."window_started_at" ASC, c."created_at" ASC
  `;
}

export type BackfillSummary = {
  conversationsWithoutTrigger: number;
  aliasRows: number;
  wrote: number;
  skippedNoComment: number;
  skippedClaimed: number;
  byKind: Record<string, number>;
};

/**
 * Exported so tests can drive the REAL sweep rather than a re-implementation of its
 * query. QA-16's defect was in the JOIN and the NOT EXISTS, which a test that rebuilt
 * them would reproduce rather than catch.
 */
export async function backfillJourneyTriggers(write: boolean): Promise<BackfillSummary> {
  const candidates = await loadCandidates();

  // journey_trigger.comment_id is globally unique, and one comment can legitimately
  // belong to two intents: someone who comments "sleep and potty" matches two
  // keyword rows, so two guides are genuinely requested. Only the FIRST such intent
  // can own the trigger. Measured: 4 comments in this data, all one person with two
  // keywords. Those intents keep their comment id in the event log; they simply get
  // no trigger row, which is why the summary reports them rather than hiding it.
  const alreadyClaimed = new Set(
    (await prisma.journeyTrigger.findMany({ select: { commentId: true } })).map((t) => t.commentId),
  );

  let wrote = 0;
  let skippedNoComment = 0;
  let skippedClaimed = 0;
  let aliasRows = 0;
  const byKind = new Map<string, number>();

  for (const row of candidates) {
    // Counted before the skips, because this reports what the sweep FOUND.
    if (!row.isCanonical) aliasRows++;

    if (!row.commentId) {
      skippedNoComment++;
      continue;
    }
    if (alreadyClaimed.has(row.commentId)) {
      skippedClaimed++;
      continue;
    }
    alreadyClaimed.add(row.commentId);

    // event_log records source='dm' for a DM-matched keyword. Feature 4 excludes
    // DM-origin journeys (§35), so recording the kind faithfully is what lets the
    // selector filter them out later.
    const triggerKind = row.source === "dm" ? "dm" : "comment";
    byKind.set(triggerKind, (byKind.get(triggerKind) ?? 0) + 1);
    if (!write) {
      wrote++;
      continue;
    }

    try {
      await prisma.journeyTrigger.create({
        data: {
          intentId: row.intentId,
          conversationId: row.conversationId,
          commentId: row.commentId,
          mediaId: row.mediaId,
          receivedAt: row.receivedAt,
          triggerKind,
          // The canonical conversation opened the journey; an alias was a repeat ask
          // inside the same window, which is exactly what `reused_active` means on the
          // live path. Stamping every reconstructed trigger `new_journey` made the
          // history claim each alias had started its own journey (QA-16).
          disposition: row.isCanonical ? "new_journey" : "reused_active",
        },
      });
      wrote++;
    } catch (err) {
      // A concurrent live trigger could claim the same comment between the read
      // above and this insert. Skipping is correct — the live row is authoritative.
      if ((err as { code?: string })?.code === "P2002") {
        skippedClaimed++;
        continue;
      }
      throw err;
    }
  }

  return {
    conversationsWithoutTrigger: candidates.length,
    aliasRows,
    wrote,
    skippedNoComment,
    skippedClaimed,
    byKind: Object.fromEntries(byKind),
  };
}

async function main() {
  const s = await backfillJourneyTriggers(WRITE);

  console.log(WRITE ? "APPLIED" : "DRY RUN — nothing written");
  console.log(`  conversations w/o trigger : ${s.conversationsWithoutTrigger}`);
  console.log(`    of which alias          : ${s.aliasRows}  (later asks on an existing journey)`);
  console.log(`  triggers ${WRITE ? "created" : "to create"}        : ${s.wrote}`);
  for (const [kind, count] of Object.entries(s.byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${kind.padEnd(22)} ${count}`);
  }
  console.log(`  skipped, no comment id    : ${s.skippedNoComment}  (cannot be publicly replied to)`);
  console.log(`  skipped, comment claimed  : ${s.skippedClaimed}  (same comment, another keyword)`);
  if (!WRITE) console.log("\nRe-run with --write to apply.");
}

// Only run as a script, not when imported by a test.
if (process.argv[1]?.includes("backfill-journey-triggers")) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
