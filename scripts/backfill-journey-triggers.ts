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
 * Safe to re-run. Existing comment-keyword associations are left alone.
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
  sourceEventLogId: string | null;
  receivedAt: Date;
  disposition: string | null;
  publicAcknowledgementState: "pending" | "confirmed" | "failed" | "uncertain";
  acknowledgementErrorCategory: string | null;
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
  // Enumerate every keyword_matched event. The old scalar subquery selected only the
  // first event for a conversation, silently losing later source comments.
  return prisma.$queryRaw<Candidate[]>`
    SELECT
      ji."id"                 AS "intentId",
      c."id"                  AS "conversationId",
      ji."ig_user_id"         AS "igUserId",
      ji."keyword_id"         AS "keywordId",
      src."comment_id"        AS "commentId",
      src."media_id"          AS "mediaId",
      src."source",
      src."event_log_id"      AS "sourceEventLogId",
      src."received_at"       AS "receivedAt",
      src."disposition",
      CASE
        WHEN EXISTS (
          SELECT 1 FROM "event_log" ack
          WHERE ack."kind" = 'public_reply_sent'
            AND ack."payload"->>'commentId' = src."comment_id"
            AND ack."payload"->>'conversationId' = c."id"::text
        ) THEN 'confirmed'
        WHEN EXISTS (
          SELECT 1 FROM "event_log" ack
          WHERE ack."kind" = 'public_reply_failed'
            AND ack."payload"->>'commentId' = src."comment_id"
            AND ack."payload"->>'conversationId' = c."id"::text
        ) THEN 'failed'
        ELSE 'pending'
      END::text               AS "publicAcknowledgementState",
      (
        SELECT ack."payload"->>'category'
        FROM "event_log" ack
        WHERE ack."kind" = 'public_reply_failed'
          AND ack."payload"->>'commentId' = src."comment_id"
          AND ack."payload"->>'conversationId' = c."id"::text
        ORDER BY ack."created_at" DESC, ack."id" DESC
        LIMIT 1
      )                       AS "acknowledgementErrorCategory",
      (c."id" = ji."canonical_conversation_id") AS "isCanonical"
    FROM "journey_intent" ji
    JOIN "conversations" c
      ON c."id" = ji."canonical_conversation_id"
      OR c."canonical_intent_id" = ji."id"
    LEFT JOIN LATERAL (
      SELECT
        e."id" AS "event_log_id",
        e."payload"->>'commentId' AS "comment_id",
        e."payload"->>'mediaId' AS "media_id",
        e."payload"->>'source' AS "source",
        e."created_at" AS "received_at",
        e."payload"->>'journeyDisposition' AS "disposition"
      FROM "event_log" e
      WHERE e."kind" = 'keyword_matched'
        AND e."payload"->>'conversationId' = c."id"::text
        AND e."payload"->>'commentId' IS NOT NULL

      UNION ALL

      SELECT
        NULL::uuid,
        g."comment_id",
        g."media_id",
        NULL::text,
        g."comment_at",
        NULL::text
      FROM "gate_queue" g
      WHERE g."conversation_id" = c."id"
        AND NOT EXISTS (
          SELECT 1 FROM "event_log" e
          WHERE e."kind" = 'keyword_matched'
            AND e."payload"->>'conversationId' = c."id"::text
            AND e."payload"->>'commentId' IS NOT NULL
        )

      UNION ALL

      SELECT
        NULL::uuid,
        NULL::text,
        NULL::text,
        NULL::text,
        c."created_at",
        NULL::text
      WHERE NOT EXISTS (
        SELECT 1 FROM "event_log" e
        WHERE e."kind" = 'keyword_matched'
          AND e."payload"->>'conversationId' = c."id"::text
          AND e."payload"->>'commentId' IS NOT NULL
      ) AND NOT EXISTS (
        SELECT 1 FROM "gate_queue" g WHERE g."conversation_id" = c."id"
      )
    ) src ON TRUE
    ORDER BY
      ji."window_started_at" ASC,
      c."created_at" ASC,
      src."received_at" ASC,
      src."event_log_id" ASC NULLS LAST,
      src."comment_id" ASC NULLS LAST
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

  // One comment can legitimately match two keyword rows (for example "sleep and
  // potty"). Treat each comment-keyword association independently while still
  // absorbing exact replay of the same match.
  const associationKey = (commentId: string, intentId: string) =>
    `${commentId}\u0000${intentId}`;
  const alreadyClaimed = new Set(
    (
      await prisma.journeyTrigger.findMany({
        select: { intentId: true, sourceEvent: { select: { commentId: true } } },
      })
    ).map((t) => associationKey(t.sourceEvent.commentId, t.intentId)),
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
    const key = associationKey(row.commentId, row.intentId);
    if (alreadyClaimed.has(key)) {
      skippedClaimed++;
      continue;
    }
    alreadyClaimed.add(key);

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
      await prisma.$transaction(async (tx) => {
        const sourceEvent = await tx.journeySourceEvent.upsert({
          where: { commentId: row.commentId! },
          create: {
            commentId: row.commentId!,
            mediaId: row.mediaId,
            firstReceivedAt: row.receivedAt,
          },
          update: {},
          select: { id: true, mediaId: true },
        });
        if (sourceEvent.mediaId && row.mediaId && sourceEvent.mediaId !== row.mediaId) {
          throw new Error("journey_source_event_media_conflict");
        }
        if (!sourceEvent.mediaId && row.mediaId) {
          await tx.journeySourceEvent.update({
            where: { id: sourceEvent.id },
            data: { mediaId: row.mediaId },
          });
        }

        const allowedDispositions = new Set([
          "new_journey",
          "reused_active",
          "already_completed_recently",
          "replayed_comment",
        ]);
        const disposition = allowedDispositions.has(row.disposition ?? "")
          ? (row.disposition as
              | "new_journey"
              | "reused_active"
              | "already_completed_recently"
              | "replayed_comment")
          : row.isCanonical
            ? "new_journey"
            : "reused_active";

        await tx.journeyTrigger.create({
          data: {
            sourceEventId: sourceEvent.id,
            sourceEventLogId: row.sourceEventLogId,
            intentId: row.intentId,
            keywordId: row.keywordId,
            conversationId: row.conversationId,
            receivedAt: row.receivedAt,
            triggerKind,
            disposition,
            publicAcknowledgementState: row.publicAcknowledgementState,
            acknowledgementErrorCategory: row.acknowledgementErrorCategory,
          },
        });
      });
      wrote++;
    } catch (err) {
      // A concurrent live trigger could claim the same comment-keyword pair
      // between the read above and this insert. The live row is authoritative.
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
  console.log(`  skipped, association exists: ${s.skippedClaimed}  (same comment + keyword)`);
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
