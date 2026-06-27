import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Read-only. Answers ONE question: are people getting the gate DM?
// Splits gate outcomes by path (comment private-reply vs inbound DM) over the
// last N events, and shows the most recent gate attempts in order.
async function main() {
  const N = Number(process.argv[2] ?? 100);

  const events = await prisma.eventLog.findMany({
    where: {
      kind: { in: ["dm_sent", "dm_failed", "public_reply_sent", "public_reply_failed", "keyword_matched"] },
    },
    orderBy: { createdAt: "desc" },
    take: N,
  });

  const tally = {
    dm_sent_comment: 0,
    dm_sent_dm: 0,
    dm_failed_comment: 0,
    dm_failed_dm: 0,
    public_reply_sent: 0,
    public_reply_failed: 0,
    keyword_matched_comment: 0,
    keyword_matched_dm: 0,
  };
  const subcodes = {};

  for (const e of events) {
    const p = e.payload ?? {};
    const src = p.source === "dm" ? "dm" : "comment";
    if (e.kind === "dm_sent") tally[`dm_sent_${src}`]++;
    else if (e.kind === "dm_failed") {
      tally[`dm_failed_${p.stage === "gate_inbound_dm" ? "dm" : "comment"}`]++;
      const sc = p.subcode ?? "?";
      subcodes[sc] = (subcodes[sc] ?? 0) + 1;
    } else if (e.kind === "public_reply_sent") tally.public_reply_sent++;
    else if (e.kind === "public_reply_failed") tally.public_reply_failed++;
    else if (e.kind === "keyword_matched") tally[`keyword_matched_${src}`]++;
  }

  console.log(`=== Gate delivery over last ${N} relevant events ===\n`);

  console.log("COMMENT path (someone comments the keyword):");
  console.log(`  keyword_matched:    ${tally.keyword_matched_comment}`);
  console.log(`  public_reply_sent:  ${tally.public_reply_sent}`);
  console.log(`  gate DM sent:       ${tally.dm_sent_comment}`);
  console.log(`  gate DM FAILED:     ${tally.dm_failed_comment}   ← these people got ONLY the public reply, no DM`);

  console.log("\nDM path (someone DMs the keyword):");
  console.log(`  keyword_matched:    ${tally.keyword_matched_dm}`);
  console.log(`  gate DM sent:       ${tally.dm_sent_dm}`);
  console.log(`  gate DM FAILED:     ${tally.dm_failed_dm}`);

  const totalSent = tally.dm_sent_comment + tally.dm_sent_dm;
  const totalFail = tally.dm_failed_comment + tally.dm_failed_dm;
  const denom = totalSent + totalFail;
  console.log(`\nOverall gate DM success: ${totalSent}/${denom}` + (denom ? `  (${Math.round((100 * totalSent) / denom)}%)` : ""));
  console.log(`Failure subcodes:`, subcodes);

  console.log(`\n=== Most recent 20 gate attempts (chronological) ===`);
  const gate = events.filter((e) => e.kind === "dm_sent" || e.kind === "dm_failed").reverse();
  for (const e of gate.slice(-20)) {
    const p = e.payload ?? {};
    const src = p.source === "dm" || p.stage === "gate_inbound_dm" ? "DM  " : "CMNT";
    const out = e.kind === "dm_sent" ? "✅ SENT      " : `❌ FAILED ${p.subcode ?? ""}`;
    console.log(`  ${e.createdAt.toISOString()}  ${src}  ${out}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
