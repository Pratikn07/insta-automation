import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Read-only.
//
//   node scripts/inspect-user.mjs                 → recent activity grouped by user
//   node scripts/inspect-user.mjs <igUserId>      → full timeline for one numeric IG user id
//
// NOTE: we store the numeric Instagram user id, NOT the @username. To find a
// specific person (e.g. "alaira024"), match them by WHAT they did and WHEN in
// the grouped view, grab their igUserId, then re-run with that id.
function userIdOf(p) {
  if (!p || typeof p !== "object") return null;
  return p.senderId ?? p.fromId ?? null;
}

async function timelineForConversationsOf(igUserId) {
  // Pull this user's conversations, then all events tied to them (by conversationId
  // or by senderId/fromId in the payload).
  const convos = await prisma.conversation.findMany({
    where: { igUserId },
    include: { keyword: { select: { keyword: true } } },
    orderBy: { createdAt: "asc" },
  });
  const convoIds = new Set(convos.map((c) => c.id));

  const recent = await prisma.eventLog.findMany({ orderBy: { createdAt: "asc" }, take: 2000 });
  const mine = recent.filter((e) => {
    const p = e.payload ?? {};
    return userIdOf(p) === igUserId || (p.conversationId && convoIds.has(p.conversationId));
  });

  console.log(`\n=== Timeline for igUserId=${igUserId} ===`);
  console.log(`Conversations: ${convos.length}`);
  for (const c of convos) {
    console.log(`  • ${c.createdAt.toISOString()}  state=${c.state}  kw=${c.keyword?.keyword}  id=${c.id}`);
  }
  console.log(`\nEvents:`);
  for (const e of mine) {
    const p = e.payload ?? {};
    let d = "";
    if (e.kind === "message_received" || e.kind === "message_unhandled") d = `"${(p.text ?? "").slice(0, 40)}"`;
    else if (e.kind === "comment_received") d = `"${(p.text ?? "").slice(0, 40)}"`;
    else if (e.kind === "dm_failed") d = `sub=${p.subcode} stage=${p.stage ?? "?"}`;
    else if (e.kind === "dm_sent") d = `kind=${p.kind} src=${p.source ?? "comment"}`;
    else if (e.kind === "keyword_matched") d = `kw=${p.keyword} src=${p.source ?? "comment"}`;
    console.log(`  ${e.createdAt.toISOString()}  ${String(e.kind).padEnd(18)}  ${d}`);
  }
}

async function recentGrouped() {
  const since = new Date(Date.now() - 3 * 60 * 60 * 1000); // last 3h
  const events = await prisma.eventLog.findMany({
    where: { createdAt: { gte: since }, kind: { in: ["comment_received", "message_received", "keyword_matched", "dm_sent", "dm_failed", "message_unhandled", "done_received", "sequence_completed"] } },
    orderBy: { createdAt: "asc" },
  });

  // Group by user id where we have one.
  const byUser = new Map();
  for (const e of events) {
    const uid = userIdOf(e.payload);
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(e);
  }

  console.log(`Recent activity (last 3h), grouped by numeric IG user id.`);
  console.log(`We do NOT store usernames — match "alaira024" by their actions/timing below.\n`);

  // Most recently active users first.
  const sorted = [...byUser.entries()].sort(
    (a, b) => b[1][b[1].length - 1].createdAt - a[1][a[1].length - 1].createdAt,
  );
  for (const [uid, evs] of sorted) {
    const last = evs[evs.length - 1].createdAt.toISOString();
    console.log(`● igUserId=${uid}   (last active ${last})`);
    for (const e of evs) {
      const p = e.payload ?? {};
      let d = "";
      if (e.kind === "message_received" || e.kind === "message_unhandled" || e.kind === "comment_received")
        d = `"${(p.text ?? "").slice(0, 35)}"`;
      else if (e.kind === "dm_failed") d = `sub=${p.subcode}`;
      else if (e.kind === "dm_sent" || e.kind === "keyword_matched") d = `src=${p.source ?? "comment"}`;
      console.log(`    ${e.createdAt.toISOString()}  ${String(e.kind).padEnd(18)}  ${d}`);
    }
    console.log("");
  }
  if (sorted.length === 0) console.log("(no user-attributable activity in the last 3h)");
}

async function main() {
  const arg = process.argv[2];
  if (arg) await timelineForConversationsOf(arg);
  else await recentGrouped();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
