import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// One-time backfill: take historical dm_failed (gate_private_reply) events that
// are STILL inside their 7-day private-reply window and enqueue them into
// gate_queue so the already-running worker can retry/recover them. Idempotent:
// skips comments already queued. Read-mostly: only inserts gate_queue rows.
async function main() {
  const apply = process.argv.includes("--apply");
  const windowStart = new Date(Date.now() - PRIVATE_REPLY_WINDOW_MS);

  // All failed gate events still in-window.
  const failed = await prisma.eventLog.findMany({
    where: { kind: "dm_failed", createdAt: { gte: windowStart } },
    orderBy: { createdAt: "asc" },
  });

  // Only the gate private-reply failures (not sequence/public-reply failures).
  const candidates = failed.filter(
    (e) => e.payload && e.payload.stage === "gate_private_reply" && e.payload.conversationId,
  );

  // Already-queued comment IDs (dedupe).
  const existing = await prisma.gateQueue.findMany({ select: { commentId: true } });
  const queued = new Set(existing.map((r) => r.commentId));

  // Build the set of igUserIds who ALREADY received the gate / completed on ANY
  // conversation — via the bot OR (best-effort) any path we logged. We match on
  // USER, not conversation, so someone who later DM'd "sleep" (a new conversation)
  // or otherwise completed is correctly skipped — no duplicate gate to people who
  // already got it. NOTE: manual replies typed by hand in Instagram were never
  // logged, so a user your wife messaged manually may still look unrecovered here.
  const recoveredEvents = await prisma.eventLog.findMany({
    where: { kind: { in: ["dm_sent", "sequence_completed", "done_received"] } },
    select: { payload: true },
  });
  const recoveredConvoIds = new Set(
    recoveredEvents.map((e) => e.payload?.conversationId).filter(Boolean),
  );
  // Map those conversation ids -> their igUserIds.
  const recoveredConvos = await prisma.conversation.findMany({
    where: { id: { in: [...recoveredConvoIds] } },
    select: { igUserId: true },
  });
  const recoveredUsers = new Set(recoveredConvos.map((c) => c.igUserId));

  // Build unique enqueue set keyed by commentId, skipping recovered USERS.
  const seen = new Set();
  const toEnqueue = [];
  let skippedRecoveredUser = 0;
  for (const e of candidates) {
    const commentId = e.payload.commentId;
    const conversationId = e.payload.conversationId;
    if (!commentId || queued.has(commentId) || seen.has(commentId)) continue;
    seen.add(commentId);

    const convo = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { keyword: { select: { gateMessage: true } } },
    });
    if (!convo || !convo.keyword) continue;

    if (recoveredUsers.has(convo.igUserId)) {
      skippedRecoveredUser++;
      continue; // this user already got the gate / completed on some path
    }

    toEnqueue.push({
      conversationId,
      igUserId: convo.igUserId,
      commentId,
      gateMessage: convo.keyword.gateMessage,
      commentAt: e.createdAt, // preserves the real 7-day window per comment
    });
  }

  console.log(`Candidates in-window:            ${candidates.length}`);
  console.log(`Skipped (already queued):        ${candidates.length - seen.size}`);
  console.log(`Skipped (user already recovered): ${skippedRecoveredUser}`);
  console.log(`To enqueue (genuinely lost):     ${toEnqueue.length}`);

  if (!apply) {
    console.log("\nDRY RUN. Re-run with --apply to actually enqueue.");
    return;
  }

  // Stagger nextAttemptAt by 20s increments so they don't all fire in one tick;
  // the worker's per-tick batch + adaptive backoff still governs real pace.
  let i = 0;
  let created = 0;
  for (const row of toEnqueue) {
    await prisma.gateQueue.create({
      data: {
        conversationId: row.conversationId,
        igUserId: row.igUserId,
        commentId: row.commentId,
        gateMessage: row.gateMessage,
        status: "pending",
        attempts: 0,
        commentAt: row.commentAt,
        nextAttemptAt: new Date(Date.now() + i * 20_000),
      },
    });
    created++;
    i++;
  }
  console.log(`\nEnqueued ${created} gate retries. The worker will drain them paced over the coming hours/days.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
