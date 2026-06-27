import { PrismaClient } from "@prisma/client";
import { resolveUsername } from "../dist/src/services/igUserService.js";

const prisma = new PrismaClient();

// Backfill follow status (is_user_follow_business / follower_count / verified) for
// users who DM'd us BEFORE the follow-aware deploy, so their dashboard pill fills in.
//
// HARD CONSTRAINT: Instagram only returns the follow fields when the user is in a
// messaging context. So we ONLY target users who have a message_received on record;
// comment-only users are skipped (the lookup would return null for them anyway).
// Even among messaged users, expect a fraction to come back null — the messaging
// "context" may require a recent/active thread, not just any historical DM. The
// dry run + --limit let you measure the real hit rate before committing.
//
// This is a GET /{igsid} profile lookup — subject to the general Graph per-hour
// rate limit, NOT the 2534025 private-reply burst cap. Still paced to be safe.
//
// Naturally RESUMABLE: once a user's follow_checked_at is set they drop out of the
// target set, so re-running picks up only the still-unresolved remainder.
//
// Usage:
//   node scripts/backfill-follow-status.mjs                 # DRY RUN (no API calls)
//   node scripts/backfill-follow-status.mjs --limit 20 --apply   # resolve 20, paced
//   node scripts/backfill-follow-status.mjs --apply             # resolve ALL targets
//   flags: --limit N (cap), --delay MS (between calls, default 1500)

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const limit = Number(arg("--limit", "0")) || 0; // 0 = no cap
  const delayMs = Number(arg("--delay", "1500"));

  // Users who have ever DM'd us (the only ones IG can answer follow status for).
  const messaged = await prisma.eventLog.findMany({
    where: { kind: "message_received" },
    select: { payload: true },
  });
  const messagedIds = new Set(
    messaged
      .map((e) => (e.payload && typeof e.payload === "object" ? e.payload.senderId : null))
      .filter((v) => typeof v === "string"),
  );

  // Target = messaged AND not yet follow-checked.
  const candidates = await prisma.igUser.findMany({
    where: { id: { in: [...messagedIds] }, followCheckedAt: null },
    select: { id: true, username: true },
    orderBy: { updatedAt: "desc" }, // most recently active first — best odds of a live context
  });

  const targets = limit > 0 ? candidates.slice(0, limit) : candidates;

  console.log(`Messaged users (addressable):       ${messagedIds.size}`);
  console.log(`Unresolved targets:                 ${candidates.length}`);
  console.log(`Will process this run:              ${targets.length}${limit ? ` (--limit ${limit})` : ""}`);

  if (!apply) {
    console.log("\nDRY RUN — no API calls made. Re-run with --apply to resolve.");
    console.log("Sample of who would be resolved:");
    for (const u of targets.slice(0, 10)) console.log(`  ${u.id}  ${u.username ? "@" + u.username : "(no username)"}`);
    return;
  }

  let followers = 0;
  let nonFollowers = 0;
  let stillNull = 0;
  let errors = 0;

  for (let i = 0; i < targets.length; i++) {
    const u = targets[i];
    try {
      const r = await resolveUsername(u.id); // upserts + stamps follow_checked_at
      if (r.isFollower === true) followers++;
      else if (r.isFollower === false) nonFollowers++;
      else stillNull++;
      const tag = r.isFollower === true ? "FOLLOWS" : r.isFollower === false ? "not"     : "null";
      console.log(`  [${i + 1}/${targets.length}] ${r.username ? "@" + r.username : u.id} → ${tag}${r.followerCount != null ? ` (${r.followerCount})` : ""}`);
    } catch (err) {
      errors++;
      console.log(`  [${i + 1}/${targets.length}] ${u.id} → ERROR ${err.message}`);
    }
    if (i < targets.length - 1) await new Promise((res) => setTimeout(res, delayMs));
  }

  console.log(`\nDone. followers=${followers}  not-following=${nonFollowers}  still-null=${stillNull}  errors=${errors}`);
  if (stillNull > 0) {
    console.log(`(${stillNull} returned null — IG had no follow context for them. Expected for some historical DMs.)`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
