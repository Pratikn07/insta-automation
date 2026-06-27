import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// READ-ONLY deep audit of the gating behaviour. Answers, with hard data:
//   A. The gate TRIGGER logic in practice — who gets gated and via which path.
//   B. Every gate FAILURE (2534025 etc.), broken down by path (comment vs dm).
//   C. The full funnel: comment/dm -> gate -> done -> sequence, with drop-off.
//   D. Per-user end-to-end traces for the most recently active users.
//   E. Anything anomalous: gates with no keyword, done with no gate, orphans.
const sep = (t) => console.log(`\n${"=".repeat(70)}\n${t}\n${"=".repeat(70)}`);
const uid = (p) => (p && typeof p === "object" ? (p.senderId ?? p.fromId ?? null) : null);

async function main() {
  // Pull a big recent slice of events once.
  const events = await prisma.eventLog.findMany({ orderBy: { createdAt: "desc" }, take: 4000 });
  const convos = await prisma.conversation.findMany({
    include: { keyword: { select: { keyword: true } } },
  });
  const convoById = new Map(convos.map((c) => [c.id, c]));

  // ---- A. Gate trigger: every gate sent, by path (comment vs dm) ----
  sep("A. GATE TRIGGERS — every gate the bot SENT, by path");
  const gateSent = events.filter((e) => e.kind === "dm_sent");
  const bySource = { dm: 0, comment: 0 };
  for (const e of gateSent) {
    const src = e.payload?.source === "dm" ? "dm" : "comment";
    bySource[src]++;
  }
  console.log(`  dm_sent total: ${gateSent.length}`);
  console.log(`    via DM ("user DM'd a keyword"):       ${bySource.dm}`);
  console.log(`    via comment (private reply):          ${bySource.comment}`);
  console.log(`  → A gate is sent ONLY when an inbound DM/comment contains an active keyword.`);

  // ---- B. Gate failures by path + subcode ----
  sep("B. GATE FAILURES — every dm_failed, by path + subcode");
  const failed = events.filter((e) => e.kind === "dm_failed");
  const fGroup = {};
  for (const e of failed) {
    const stage = e.payload?.stage ?? "?";
    const sub = e.payload?.subcode ?? "?";
    const key = `${stage} / subcode ${sub}`;
    fGroup[key] = (fGroup[key] ?? 0) + 1;
  }
  console.log(`  dm_failed total: ${failed.length}`);
  for (const [k, n] of Object.entries(fGroup).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(45)} ${n}`);
  }
  console.log(`  → gate_private_reply = comment path (Instagram refuses). gate_inbound_dm = DM path.`);

  // ---- C. Funnel + drop-off ----
  sep("C. FUNNEL");
  const count = (k) => events.filter((e) => e.kind === k).length;
  console.log(`  comment_received:     ${count("comment_received")}`);
  console.log(`  message_received:     ${count("message_received")}  (inbound DMs)`);
  console.log(`  keyword_matched:      ${count("keyword_matched")}`);
  console.log(`  dm_sent (gate):       ${count("dm_sent")}`);
  console.log(`  dm_failed (gate):     ${count("dm_failed")}`);
  console.log(`  done_received:        ${count("done_received")}`);
  console.log(`  sequence_completed:   ${count("sequence_completed")}`);
  console.log(`  sequence_failed:      ${count("sequence_failed")}`);
  console.log(`  message_unhandled:    ${count("message_unhandled")}  (DMs that were neither a keyword nor DONE)`);

  // ---- D. Per-user end-to-end traces (most recent 8 users with a conversation) ----
  sep("D. PER-USER TRACES (most recent 8)");
  const usersOrdered = [...convos]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((c) => c.igUserId);
  const seenU = new Set();
  const recentUsers = usersOrdered.filter((u) => (seenU.has(u) ? false : (seenU.add(u), true))).slice(0, 8);

  for (const u of recentUsers) {
    const igu = await prisma.igUser.findUnique({ where: { id: u } });
    const label = igu?.username ? `@${igu.username}` : u;
    const myConvoIds = new Set(convos.filter((c) => c.igUserId === u).map((c) => c.id));
    const mine = events
      .filter((e) => {
        const p = e.payload ?? {};
        return uid(p) === u || (p.conversationId && myConvoIds.has(p.conversationId));
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    console.log(`\n● ${label}  (${u})`);
    for (const e of mine) {
      const p = e.payload ?? {};
      let d = "";
      if (e.kind === "message_received" || e.kind === "comment_received" || e.kind === "message_unhandled")
        d = `"${(p.text ?? "").slice(0, 30)}"`;
      else if (e.kind === "dm_failed") d = `subcode ${p.subcode} (${p.stage})`;
      else if (e.kind === "dm_sent" || e.kind === "keyword_matched") d = `src=${p.source ?? "comment"}`;
      console.log(`    ${e.createdAt.toISOString()}  ${String(e.kind).padEnd(18)} ${d}`);
    }
  }

  // ---- E. Anomalies ----
  sep("E. ANOMALY CHECKS");
  // done_received with no preceding dm_sent in same conversation
  const doneConvos = new Set(events.filter((e) => e.kind === "done_received").map((e) => e.payload?.conversationId));
  const gateConvos = new Set(events.filter((e) => e.kind === "dm_sent").map((e) => e.payload?.conversationId));
  const doneNoGate = [...doneConvos].filter((c) => c && !gateConvos.has(c));
  console.log(`  Conversations with DONE but no gate dm_sent: ${doneNoGate.length}`);
  // awaiting_done convos whose gate failed (orphans)
  const failConvos = new Set(events.filter((e) => e.kind === "dm_failed").map((e) => e.payload?.conversationId));
  const orphans = convos.filter((c) => c.state === "awaiting_done" && failConvos.has(c.id));
  console.log(`  awaiting_done conversations whose gate FAILED (user stuck): ${orphans.length}`);
  console.log(`  → these are people the gate never reached; they can't proceed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
