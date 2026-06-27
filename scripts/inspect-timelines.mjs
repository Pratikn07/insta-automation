import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Read-only. Prints the per-conversation event timeline for the most recent
// conversations so you can see exactly what happened to each commenter:
//   comment_received -> (dm_sent | error) -> (done_received -> sequence_completed)
// Inbound "Hi" messages are NOT in here because messageHandler discards any
// non-DONE message before writing to the DB — their absence is the point.
async function main() {
  const limit = Number(process.argv[2] ?? 12);

  const convos = await prisma.conversation.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    where: { igUserId: { not: { startsWith: "fake-" } } },
    include: { keyword: true },
  });

  for (const c of convos) {
    // Pull every event that references this conversation id.
    const events = await prisma.eventLog.findMany({
      where: { payload: { path: ["conversationId"], equals: c.id } },
      orderBy: { createdAt: "asc" },
    });

    const gateSent = events.some((e) => e.kind === "dm_sent");
    const flag = gateSent ? "✅ gate DM sent" : "❌ gate DM FAILED";

    console.log(
      `\n● ${c.createdAt.toISOString()}  igUser=${c.igUserId}  state=${c.state}  kw=${c.keyword?.keyword ?? "?"}  ${flag}`,
    );
    for (const e of events) {
      const extra =
        e.kind === "error" && e.payload?.err ? `  ${String(e.payload.err).slice(0, 80)}` : "";
      console.log(`    ${e.createdAt.toISOString()}  ${e.kind}${extra}`);
    }
  }

  // Prove the "Hi is never stored" claim: count distinct inbound-message event
  // kinds. You should see only done_received — never any "hi"/"message_received".
  console.log(`\n--- inbound-message event kinds present in event_log ---`);
  const kinds = await prisma.eventLog.groupBy({
    by: ["kind"],
    _count: { kind: true },
    orderBy: { _count: { kind: "desc" } },
  });
  for (const k of kinds) console.log(`  ${k.kind.padEnd(22)} ${k._count.kind}`);
  console.log(
    `\nNote: there is no event kind for a received "Hi" — non-DONE inbound DMs are dropped before any DB write (messageHandler.ts:18).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
