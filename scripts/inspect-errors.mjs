import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Read-only diagnostic. Surfaces recent error events (esp. failed DM sends)
// plus event-kind counts for context. No writes.
async function main() {
  const limit = Number(process.argv[2] ?? 20);

  console.log("=== EventLog kind counts (all time) ===");
  const counts = await prisma.eventLog.groupBy({
    by: ["kind"],
    _count: { kind: true },
    orderBy: { _count: { kind: "desc" } },
  });
  for (const c of counts) console.log(`  ${c.kind.padEnd(24)} ${c._count.kind}`);

  console.log(`\n=== Last ${limit} error events ===`);
  const errors = await prisma.eventLog.findMany({
    where: { kind: "error" },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  if (errors.length === 0) {
    console.log("  (none found)");
  }

  for (const e of errors) {
    console.log(`\n--- ${e.createdAt.toISOString()}  id=${e.id} ---`);
    console.log(JSON.stringify(e.payload, null, 2));
  }

  // Conversations that were opened but never got a dm_sent gate event —
  // i.e. the gate DM almost certainly failed.
  console.log(`\n=== awaiting_done conversations w/ NO dm_sent event (last 50) ===`);
  const convos = await prisma.conversation.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    where: { igUserId: { not: { startsWith: "fake-" } } },
  });
  let orphanCount = 0;
  for (const convo of convos) {
    const dmEvent = await prisma.eventLog.findFirst({
      where: { kind: "dm_sent", payload: { path: ["conversationId"], equals: convo.id } },
    });
    if (!dmEvent) {
      orphanCount++;
      console.log(
        `  ${convo.createdAt.toISOString()}  igUser=${convo.igUserId}  state=${convo.state}  id=${convo.id}`,
      );
    }
  }
  if (orphanCount === 0) console.log("  (none — every recent convo has a dm_sent)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
