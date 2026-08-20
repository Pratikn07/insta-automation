import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Recover users whose gate was delivered via RETRY but whose conversation had
// already expired, so the DONE-window was closed and their reply was dropped.
//
// Phase 1: re-arm those conversations (state=awaiting_done, gatedAt = retry send
//          time) so a future/forthcoming reply lands.
// Phase 2: for users who ALREADY replied (any inbound message_received) after the
//          retry gate AND within Instagram's 24h window from that reply, deliver
//          the sequence now. Replies older than 24h cannot be messaged (IG window
//          closed) — those are surfaced, not sent.
//
// Historical report only. Its write/send apply path predates durable delivery
// ownership and is retired; current delivery must enter through the live handler.
const IG_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

async function main() {
  if (process.argv.includes("--apply")) {
    console.error(
      "guide_delivery_apply_retired: use the live inbound handler and durable ownership path",
    );
    process.exitCode = 1;
    return;
  }

  // Retry-sent gates: conversationId -> retry send time.
  const retrySends = await prisma.eventLog.findMany({
    where: { kind: "dm_sent", payload: { path: ["source"], equals: "retry" } },
    orderBy: { createdAt: "asc" },
  });
  const retryByConvo = new Map();
  for (const e of retrySends) {
    const cid = e.payload?.conversationId;
    if (cid) retryByConvo.set(cid, e.createdAt);
  }

  const convoIds = [...retryByConvo.keys()];
  const convos = await prisma.conversation.findMany({
    where: { id: { in: convoIds } },
    include: { keyword: { include: { resource: { include: { messages: true } } } } },
  });

  // Already-completed users (any conversation) — never re-deliver to them.
  const completedEvents = await prisma.eventLog.findMany({
    where: { kind: "sequence_completed" },
    select: { payload: true },
  });
  const completedConvoIds = new Set(
    completedEvents.map((e) => e.payload?.conversationId).filter(Boolean),
  );
  const completedConvos = await prisma.conversation.findMany({
    where: { id: { in: [...completedConvoIds] } },
    select: { igUserId: true },
  });
  const completedUsers = new Set(completedConvos.map((c) => c.igUserId));

  let toRearm = 0;
  let toDeliver = [];
  let staleReplies = 0;

  for (const c of convos) {
    if (completedUsers.has(c.igUserId)) continue; // already got the guide
    const retryAt = retryByConvo.get(c.id);

    // Did this user reply after the retry gate?
    const reply = await prisma.eventLog.findFirst({
      where: {
        kind: "message_received",
        payload: { path: ["senderId"], equals: c.igUserId },
        createdAt: { gte: retryAt },
      },
      orderBy: { createdAt: "desc" },
    });

    if (c.state === "expired" || c.state === "awaiting_done") toRearm++;

    if (reply) {
      const replyAge = Date.now() - reply.createdAt.getTime();
      if (replyAge <= IG_REPLY_WINDOW_MS) {
        toDeliver.push({ convo: c, repliedText: reply.payload?.text ?? "" });
      } else {
        staleReplies++; // replied, but IG 24h window now closed — can't message
      }
    }
  }

  console.log(`Retry-gated conversations:        ${convos.length}`);
  console.log(`To re-arm (expired/awaiting):     ${toRearm}`);
  console.log(`Already replied & still in 24h IG window (deliver now): ${toDeliver.length}`);
  console.log(`Replied but IG window closed (surface only):            ${staleReplies}`);

  console.log("\nREAD ONLY. Apply re-arm/delivery is retired; no messages or rows were changed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
