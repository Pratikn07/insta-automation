import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// One-time backfill: deliver the guide to users who have an OPEN gate
// (awaiting_done) AND genuinely replied to that gate with something other than the
// literal "Done" (Hi/Followed/Yes/etc.). The live flexible-matching fix handles
// this going forward; this catches the pre-fix backlog.
//
// TWO GUARDS — both are mandatory and were the source of the 2026-06-27 mis-send:
//   (1) REPLY-AFTER-GATE: the user's message must have arrived AFTER the gate was
//       delivered. The keyword DM that OPENS a gate ("Potty") is itself a
//       message_received — it must NOT count as a reply. Without this guard the
//       script delivered to ~22 users who never actually replied (e.g. heba.morsy01).
//   (2) NOT-ALREADY-COMPLETED: never deliver a keyword's guide to a user who has
//       already completed that keyword on any conversation. Without this guard the
//       script re-sent to ~36 already-completed users.
//
// Also bounded to Instagram's 24h messaging window measured from the user's reply;
// older replies can't be messaged and are surfaced, not sent.
//
// Historical report only. Its direct apply path predates durable delivery
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

  const open = await prisma.conversation.findMany({
    where: { state: "awaiting_done" },
    include: { keyword: { include: { resource: { include: { messages: true } } } } },
  });

  // Guard (2): users who already completed a given keyword — key is `${user}:${keywordId}`.
  const completed = await prisma.conversation.findMany({
    where: { state: "completed" },
    select: { igUserId: true, keywordId: true },
  });
  const completedKey = new Set(completed.map((c) => `${c.igUserId}:${c.keywordId}`));

  const deliverable = [];
  let noReply = 0;        // never replied after the gate
  let stale = 0;          // replied, but IG 24h window closed
  let alreadyDone = 0;    // already completed this keyword
  const seenUsers = new Set(); // at most ONE delivery per user per run

  for (const c of open) {
    if (seenUsers.has(c.igUserId)) continue;

    // Guard (2): skip if this user already has this keyword's guide.
    if (completedKey.has(`${c.igUserId}:${c.keywordId}`)) {
      alreadyDone++;
      continue;
    }

    // When was this gate delivered? (dm_sent for this conversation; fall back to
    // the conversation's gatedAt/createdAt.) Used to enforce guard (1).
    const gateEvent = await prisma.eventLog.findFirst({
      where: { kind: "dm_sent", payload: { path: ["conversationId"], equals: c.id } },
      orderBy: { createdAt: "asc" },
    });
    const gateAt = gateEvent?.createdAt ?? c.gatedAt ?? c.createdAt;

    // Guard (1): the user's most recent message that arrived STRICTLY AFTER the gate.
    const lastReply = await prisma.eventLog.findFirst({
      where: {
        kind: "message_received",
        payload: { path: ["senderId"], equals: c.igUserId },
        createdAt: { gt: gateAt },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!lastReply) {
      noReply++;
      continue;
    }

    const age = Date.now() - lastReply.createdAt.getTime();
    if (age <= IG_REPLY_WINDOW_MS) {
      seenUsers.add(c.igUserId);
      deliverable.push({ convo: c, text: lastReply.payload?.text ?? "" });
    } else {
      stale++;
    }
  }

  console.log(`Open (awaiting_done) conversations:               ${open.length}`);
  console.log(`  → replied AFTER gate, within 24h (deliver):     ${deliverable.length}`);
  console.log(`  → replied after gate but window closed (skip):  ${stale}`);
  console.log(`  → never replied after gate (skip):              ${noReply}`);
  console.log(`  → already completed this keyword (skip):        ${alreadyDone}`);

  console.log("\nREAD ONLY. Apply delivery is retired; no messages or rows were changed.");
  if (deliverable.length) {
    console.log("\nSample of who would require current-path review:");
    for (const d of deliverable.slice(0, 10)) console.log(`  ${d.convo.igUserId}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
