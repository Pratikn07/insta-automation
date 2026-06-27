import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Read-only. Turns the new dm_failed / comment_received logging into the hard
// numbers that identify WHY gate DMs fail (subcode 2534025 and friends):
//   - breakdown by Instagram subcode
//   - within failures: nested (parentId present) vs top-level comments
//   - repeated commentId across failures => duplicate webhooks / already-replied
//   - real (non-seed) dm_sent count => have gate DMs EVER worked in production?
// Run after the new logging has been deployed and real traffic has flowed.
function pct(n, total) {
  return total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`;
}

async function main() {
  // ---- 1. Have gate DMs ever really succeeded? (exclude seeded fakes) ----
  const dmSent = await prisma.eventLog.findMany({ where: { kind: "dm_sent" } });
  const realSent = dmSent.filter((e) => !(e.payload && e.payload.fakeSeed));
  console.log("=== Gate DM successes ===");
  console.log(`  dm_sent total:      ${dmSent.length}`);
  console.log(`  dm_sent REAL:       ${realSent.length}  (non-seed)`);

  // ---- 2. dm_failed breakdown ----
  const failed = await prisma.eventLog.findMany({
    where: { kind: "dm_failed" },
    orderBy: { createdAt: "desc" },
  });
  console.log(`\n=== Gate DM failures (dm_failed): ${failed.length} ===`);

  if (failed.length === 0) {
    console.log("  (none yet — deploy the new logging and let real comments flow)");
  } else {
    // By subcode
    const bySub = {};
    for (const e of failed) {
      const k = `${e.payload?.code ?? "?"} / ${e.payload?.subcode ?? "?"}`;
      bySub[k] = (bySub[k] ?? 0) + 1;
    }
    console.log("\n  By code / subcode:");
    for (const [k, n] of Object.entries(bySub).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(20)} ${n}  (${pct(n, failed.length)})`);
    }

    // Nested vs top-level
    const nested = failed.filter((e) => e.payload?.parentId).length;
    const topLevel = failed.length - nested;
    console.log("\n  Comment type (tests the nested-comment theory):");
    console.log(`    nested (parentId set):  ${nested}  (${pct(nested, failed.length)})`);
    console.log(`    top-level:              ${topLevel}  (${pct(topLevel, failed.length)})`);

    // Repeated commentId => duplicate webhooks / already-replied
    const seen = {};
    for (const e of failed) {
      const cid = e.payload?.commentId;
      if (cid) seen[cid] = (seen[cid] ?? 0) + 1;
    }
    const repeated = Object.values(seen).filter((n) => n > 1).length;
    console.log("\n  Duplicate commentId across failures (duplicate webhooks / already-replied):");
    console.log(`    distinct commentIds:    ${Object.keys(seen).length}`);
    console.log(`    appearing >1 time:      ${repeated}`);

    // A sample of the actual messages
    console.log("\n  Most recent 5 failures:");
    for (const e of failed.slice(0, 5)) {
      console.log(
        `    ${e.createdAt.toISOString()}  sub=${e.payload?.subcode}  parentId=${e.payload?.parentId ?? "—"}  "${e.payload?.message ?? ""}"`,
      );
    }
  }

  // ---- 3. Inbound DMs we now capture (the "Hi") ----
  const inbound = await prisma.eventLog.count({ where: { kind: "message_received" } });
  const unhandled = await prisma.eventLog.findMany({ where: { kind: "message_unhandled" } });
  const hiWithOpen = unhandled.filter((e) => e.payload?.hadOpenConversation).length;
  console.log("\n=== Inbound DMs (newly captured) ===");
  console.log(`  message_received total:        ${inbound}`);
  console.log(`  message_unhandled (not DONE):  ${unhandled.length}`);
  console.log(`    ...of those, user HAD an open gate conversation: ${hiWithOpen}`);
  console.log(
    `    (these are people who replied — e.g. "Hi" — to an active gate but were ignored)`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
