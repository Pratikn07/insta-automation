import { PrismaClient } from "@prisma/client";
import { resolveUsername } from "../dist/src/services/igUserService.js";

const prisma = new PrismaClient();

// EMPIRICAL TEST — settle the open question: can we read follow status for users
// we GATE-DM'd (private reply to their comment) but who NEVER sent us an inbound DM?
//
// Theory we're testing: the follow lookup (GET /{id}?fields=is_user_follow_business)
// needs the user's true MESSAGING IGSID, which we only obtain when THEY message US.
// For comment-originated gates we only have the comment-author id, which may not
// resolve. If the theory is WRONG, these resolve fine and we can backfill ~410 more.
//
// Targets: users with a conversation + a delivered gate DM, NO inbound message_received,
// and follow not yet checked. Tries resolveUsername on a small sample and reports the
// raw outcome (FOLLOWS / not / null / ERROR code). resolveUsername persists on success
// and leaves the row untouched on failure, so this is safe to run.
//
// Usage:  node scripts/probe-comment-only-follow.mjs            # 10 users
//         node scripts/probe-comment-only-follow.mjs --limit 25 # more

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const limit = Number(arg("--limit", "10")) || 10;
  const delayMs = Number(arg("--delay", "1500"));

  // Users who sent us an inbound DM — to EXCLUDE (those already resolve fine).
  const inbound = await prisma.eventLog.findMany({
    where: { kind: "message_received" },
    select: { payload: true },
  });
  const inboundIds = new Set(
    inbound.map((e) => (e.payload && typeof e.payload === "object" ? e.payload.senderId : null)).filter(Boolean),
  );

  // Conversations whose gate DM actually succeeded (dm_sent) — these users got a DM.
  const sent = await prisma.eventLog.findMany({
    where: { kind: "dm_sent" },
    select: { payload: true },
  });
  const sentConvoIds = new Set(
    sent.map((e) => (e.payload && typeof e.payload === "object" ? e.payload.conversationId : null)).filter(Boolean),
  );

  const convos = await prisma.conversation.findMany({
    where: { id: { in: [...sentConvoIds] } },
    select: { igUserId: true },
  });

  // Candidate user ids = got a gate DM, never inbound-messaged.
  const candidateIds = [...new Set(convos.map((c) => c.igUserId))].filter((id) => !inboundIds.has(id));

  const targets = await prisma.igUser.findMany({
    where: { id: { in: candidateIds }, followCheckedAt: null },
    select: { id: true, username: true },
    take: limit,
  });

  console.log(`Candidates (gate-DM'd, never inbound, unresolved): ${candidateIds.length}`);
  console.log(`Probing: ${targets.length}\n`);

  let ok = 0;
  let nullish = 0;
  let errors = 0;

  for (let i = 0; i < targets.length; i++) {
    const u = targets[i];
    try {
      const r = await resolveUsername(u.id);
      if (r.isFollower === true || r.isFollower === false) {
        ok++;
        console.log(`  [${i + 1}] ${u.id} @${r.username ?? "?"} → ${r.isFollower ? "FOLLOWS" : "not"} (${r.followerCount ?? "?"})`);
      } else {
        nullish++;
        console.log(`  [${i + 1}] ${u.id} @${u.username ?? "?"} → null (resolved but no follow data)`);
      }
    } catch (err) {
      errors++;
      const code = err?.response?.data?.error?.code;
      console.log(`  [${i + 1}] ${u.id} @${u.username ?? "?"} → ERROR ${code ?? ""} ${err.message}`);
    }
    if (i < targets.length - 1) await new Promise((res) => setTimeout(res, delayMs));
  }

  console.log(`\nResult: resolved-with-follow=${ok}  null=${nullish}  errors=${errors}`);
  if (ok > 0) {
    console.log(`\n✅ Theory WRONG — comment-DM'd users CAN resolve. Worth backfilling all ${candidateIds.length}.`);
  } else {
    console.log(`\n❌ Theory CONFIRMED — comment-only IDs don't resolve follow status. Badge needs an inbound DM.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
