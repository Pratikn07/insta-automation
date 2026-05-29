import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has("--clean")) {
    const fakeConvos = await prisma.conversation.findMany({
      where: { igUserId: { startsWith: "fake-" } },
      select: { id: true },
    });
    const ids = fakeConvos.map((c) => c.id);

    let removedEvents = 0;
    for (const id of ids) {
      const r = await prisma.eventLog.deleteMany({
        where: { payload: { path: ["conversationId"], equals: id } },
      });
      removedEvents += r.count;
    }
    const removedConvos = await prisma.conversation.deleteMany({
      where: { igUserId: { startsWith: "fake-" } },
    });
    console.log(
      `Removed ${removedConvos.count} fake conversations and ${removedEvents} associated events.`,
    );
    return;
  }

  const keyword = await prisma.keyword.findFirst({ orderBy: { createdAt: "asc" } });
  if (!keyword) {
    console.error("No keyword found — create one in the UI first, then re-run.");
    process.exit(1);
  }

  const now = Date.now();
  const offset = (mins) => new Date(now - mins * 60_000);

  const seeds = [
    {
      igUserId: "fake-7700001",
      state: "awaiting_done",
      createdAt: offset(8),
      completedAt: null,
      events: [
        { kind: "comment_received", offsetMin: 8 },
        { kind: "keyword_matched", offsetMin: 8 },
        { kind: "public_reply_sent", offsetMin: 7 },
        { kind: "dm_sent", offsetMin: 7 },
      ],
    },
    {
      igUserId: "fake-7700002",
      state: "completed",
      createdAt: offset(140),
      completedAt: offset(135),
      events: [
        { kind: "comment_received", offsetMin: 140 },
        { kind: "keyword_matched", offsetMin: 140 },
        { kind: "public_reply_sent", offsetMin: 139 },
        { kind: "dm_sent", offsetMin: 139 },
        { kind: "done_received", offsetMin: 136 },
        { kind: "sequence_completed", offsetMin: 135 },
      ],
    },
    {
      igUserId: "fake-7700003",
      state: "expired",
      createdAt: offset(60 * 30),
      completedAt: null,
      events: [
        { kind: "comment_received", offsetMin: 60 * 30 },
        { kind: "keyword_matched", offsetMin: 60 * 30 },
        { kind: "public_reply_sent", offsetMin: 60 * 30 - 1 },
        { kind: "dm_sent", offsetMin: 60 * 30 - 1 },
      ],
    },
  ];

  for (const seed of seeds) {
    const convo = await prisma.conversation.create({
      data: {
        igUserId: seed.igUserId,
        keywordId: keyword.id,
        state: seed.state,
        createdAt: seed.createdAt,
        completedAt: seed.completedAt,
      },
    });

    for (const e of seed.events) {
      await prisma.eventLog.create({
        data: {
          kind: e.kind,
          payload: {
            conversationId: convo.id,
            igUserId: convo.igUserId,
            fakeSeed: true,
          },
          createdAt: offset(e.offsetMin),
        },
      });
    }

    console.log(`Seeded ${seed.state} conversation ${convo.id} (${seed.igUserId})`);
  }

  console.log("\nRun with --clean to remove all fake-seeded rows.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
