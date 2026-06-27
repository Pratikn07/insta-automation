import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Read-only. Shows recent inbound-DM events WITH timestamps + text, so we can
// separate what happened BEFORE vs AFTER the DM-keyword flow went live.
// The new inbound-keyword handler deployed at ~2026-06-25T02:53:47Z.
const DEPLOY = new Date("2026-06-25T02:53:47Z");

async function main() {
  const events = await prisma.eventLog.findMany({
    where: {
      kind: { in: ["message_received", "message_unhandled", "keyword_matched", "dm_sent"] },
    },
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  console.log(`Deploy of DM-keyword flow: ${DEPLOY.toISOString()}\n`);
  console.log("time (UTC)                  pre/post  kind                source   text / detail");
  console.log("-".repeat(100));

  for (const e of events.reverse()) {
    const when = e.createdAt;
    const tag = when >= DEPLOY ? "POST" : "pre ";
    const p = e.payload ?? {};
    const source = p.source ?? "";
    const detail =
      e.kind === "message_received" || e.kind === "message_unhandled"
        ? `"${(p.text ?? "").slice(0, 30)}"${p.hadOpenConversation ? "  [had open convo]" : ""}`
        : e.kind === "keyword_matched"
          ? `kw=${p.keyword}`
          : e.kind === "dm_sent"
            ? `kind=${p.kind}`
            : "";
    console.log(
      `${when.toISOString()}  ${tag}      ${e.kind.padEnd(18)}  ${String(source).padEnd(7)}  ${detail}`,
    );
  }

  // The decisive check: any inbound DM AFTER deploy that should have matched "sleep".
  const postUnhandled = events.filter(
    (e) => e.kind === "message_unhandled" && e.createdAt >= DEPLOY,
  );
  const postKwDm = events.filter(
    (e) => e.kind === "keyword_matched" && e.payload?.source === "dm" && e.createdAt >= DEPLOY,
  );
  console.log(`\n=== POST-deploy verdict ===`);
  console.log(`  keyword_matched via DM (new path fired):  ${postKwDm.length}`);
  console.log(`  message_unhandled after deploy:           ${postUnhandled.length}`);
  if (postUnhandled.length) {
    console.log(`  ⚠️  post-deploy unhandled texts:`);
    for (const e of postUnhandled) console.log(`        "${e.payload?.text ?? ""}"`);
    console.log(
      `  → if any of those is "sleep"/"Sleep", the new path is NOT matching — investigate.`,
    );
  }
  if (postKwDm.length === 0 && postUnhandled.length === 0) {
    console.log(`  (no inbound DMs since deploy yet — DM "sleep" from a test account to verify)`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
