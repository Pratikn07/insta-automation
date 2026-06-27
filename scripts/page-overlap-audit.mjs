import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Read-only. Settles whether the Users page pulls its weight vs. Conversations,
// and whether Activity shows anything the other two can't.
//
//   node scripts/page-overlap-audit.mjs

async function main() {
  // ---- 1. Conversations-per-user distribution -------------------------------
  const convos = await prisma.conversation.findMany({
    select: { igUserId: true },
  });
  const perUser = new Map();
  for (const c of convos) perUser.set(c.igUserId, (perUser.get(c.igUserId) ?? 0) + 1);

  const totalConvos = convos.length;
  const totalUsers = perUser.size;
  const counts = [...perUser.values()];
  const repeaters = counts.filter((n) => n > 1).length;
  const maxConvos = counts.length ? Math.max(...counts) : 0;
  const avg = totalUsers ? (totalConvos / totalUsers).toFixed(2) : "0";

  // Histogram of how many conversations each user has.
  const hist = new Map();
  for (const n of counts) hist.set(n, (hist.get(n) ?? 0) + 1);

  console.log("=== 1. Conversations per user (decides if Users dedupes anything) ===");
  console.log(`Total conversations : ${totalConvos}`);
  console.log(`Distinct users      : ${totalUsers}`);
  console.log(`Avg convos/user     : ${avg}`);
  console.log(`Users w/ >1 convo   : ${repeaters} (${totalUsers ? ((repeaters / totalUsers) * 100).toFixed(1) : 0}%)`);
  console.log(`Max convos by 1 user: ${maxConvos}`);
  console.log(`\n  convos | users`);
  for (const k of [...hist.keys()].sort((a, b) => a - b)) {
    console.log(`  ${String(k).padStart(6)} | ${hist.get(k)}`);
  }

  // ---- 2. Follow status coverage (the other unique Users feature) -----------
  const igUserTotal = await prisma.igUser.count();
  const followResolved = await prisma.igUser.count({
    where: { followCheckedAt: { not: null } },
  });
  const followers = await prisma.igUser.count({ where: { isFollower: true } });

  console.log("\n=== 2. Follow status (the FollowBadge feature unique to Users) ===");
  console.log(`IgUser rows total      : ${igUserTotal}`);
  console.log(`Follow status resolved : ${followResolved} (${igUserTotal ? ((followResolved / igUserTotal) * 100).toFixed(1) : 0}%)`);
  console.log(`Known followers        : ${followers}`);

  // ---- 3. Activity firehose: events that never become a conversation --------
  const byKind = await prisma.eventLog.groupBy({
    by: ["kind"],
    _count: { kind: true },
    orderBy: { _count: { kind: "desc" } },
  });
  const totalEvents = byKind.reduce((s, r) => s + r._count.kind, 0);

  // Kinds that are ONLY visible in Activity — they never produce a Conversation
  // row (so Conversations/Users can never surface them).
  const orphanKinds = new Set([
    "webhook_received",
    "comment_ignored",
    "message_unhandled",
    "error",
  ]);
  const orphanCount = byKind
    .filter((r) => orphanKinds.has(r.kind))
    .reduce((s, r) => s + r._count.kind, 0);

  console.log("\n=== 3. Activity feed: events with NO conversation (Activity-only) ===");
  console.log(`Total events           : ${totalEvents}`);
  console.log(`Activity-only events   : ${orphanCount} (${totalEvents ? ((orphanCount / totalEvents) * 100).toFixed(1) : 0}%)`);
  console.log(`\n  kind | count | activity-only?`);
  for (const r of byKind) {
    console.log(
      `  ${r.kind.padEnd(22)} | ${String(r._count.kind).padStart(6)} | ${orphanKinds.has(r.kind) ? "YES" : ""}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
