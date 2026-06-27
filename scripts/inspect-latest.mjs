import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Read-only. Two things:
//  1. The CURRENT stored keyword config (did a save blank/alter gateMessage or
//     re-add a stray char to the keyword?).
//  2. The latest ~30 events chronologically, so we can see exactly what happened
//     most recently and whether the gate is sending or failing.
async function main() {
  console.log("=== Current keyword config (stored in DB) ===");
  const keywords = await prisma.keyword.findMany({
    orderBy: { createdAt: "asc" },
  });
  for (const k of keywords) {
    console.log(`\n  keyword:      ${JSON.stringify(k.keyword)}   (length ${k.keyword.length})`);
    console.log(`  active:       ${k.active}`);
    console.log(`  mediaId:      ${k.mediaId ?? "null (global)"}`);
    console.log(`  publicReply:  ${JSON.stringify(k.publicReply)}`);
    console.log(`  gateMessage:  ${JSON.stringify(k.gateMessage)}`);
    console.log(`  updatedAt:    ${k.updatedAt.toISOString()}`);
  }

  console.log(`\n\n=== Latest 30 events (chronological) ===`);
  const events = await prisma.eventLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  console.log("time (UTC)                  kind                src      detail");
  console.log("-".repeat(95));
  for (const e of events.reverse()) {
    const p = e.payload ?? {};
    const src = p.source ?? "";
    let detail = "";
    if (e.kind === "message_received" || e.kind === "message_unhandled")
      detail = `"${(p.text ?? "").slice(0, 30)}"${p.hadOpenConversation ? "  [open convo]" : ""}`;
    else if (e.kind === "dm_failed") detail = `sub=${p.subcode} stage=${p.stage ?? "?"}`;
    else if (e.kind === "dm_sent") detail = `kind=${p.kind}`;
    else if (e.kind === "keyword_matched") detail = `kw=${p.keyword}`;
    else if (e.kind === "public_reply_sent" || e.kind === "public_reply_failed") detail = "";
    else if (e.kind === "comment_received") detail = `"${(p.text ?? "").slice(0, 25)}"`;
    console.log(
      `${e.createdAt.toISOString()}  ${String(e.kind).padEnd(18)}  ${String(src).padEnd(7)}  ${detail}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
