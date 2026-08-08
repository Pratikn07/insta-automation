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
};

async function loadCandidates(): Promise<Candidate[]> {
  // Only intents with NO trigger. Anything the live path created is already
  // correct and must not be touched.
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
      ji."window_started_at"  AS "receivedAt"
    FROM "journey_intent" ji
    JOIN "conversations" c ON c."id" = ji."canonical_conversation_id"
    WHERE NOT EXISTS (
      SELECT 1 FROM "journey_trigger" jt WHERE jt."intent_id" = ji."id"
    )
    ORDER BY ji."window_started_at" ASC
  `;
}

async function main() {
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
  const byKind = new Map<string, number>();

  for (const row of candidates) {
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

    if (!WRITE) {
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
          // These are reconstructed originating triggers: each opened the journey
          // it belongs to. Repeat asks were already collapsed by reconciliation.
          disposition: "new_journey",
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

  console.log(WRITE ? "APPLIED" : "DRY RUN — nothing written");
  console.log(`  intents missing a trigger : ${candidates.length}`);
  console.log(`  triggers ${WRITE ? "created" : "to create"}        : ${wrote}`);
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${kind.padEnd(22)} ${count}`);
  }
  console.log(`  skipped, no comment id    : ${skippedNoComment}  (cannot be publicly replied to)`);
  console.log(`  skipped, comment claimed  : ${skippedClaimed}  (same comment, another keyword)`);
  if (!WRITE) console.log("\nRe-run with --write to apply.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
