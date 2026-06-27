import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Read-only. THE join that tests the consent/region theory:
// for every gate outcome, is the user resolvable (has a username) or
// consent-gated (resolvedAt null)? If failures cluster on consent-gated users
// and successes on resolvable ones, region/consent is the cause.
async function main() {
  // Build a quick lookup of which users are resolved vs not.
  const users = await prisma.igUser.findMany();
  const byId = new Map(users.map((u) => [u.id, u]));
  const status = (id) => {
    const u = byId.get(id);
    if (!u) return "unknown";
    return u.resolvedAt && u.username ? "resolved" : "consent_gated";
  };

  // Gather gate outcomes that carry a user id we can classify.
  // dm_sent/dm_failed store conversationId (not senderId), so map via conversation.
  const convos = await prisma.conversation.findMany({ select: { id: true, igUserId: true } });
  const convoUser = new Map(convos.map((c) => [c.id, c.igUserId]));

  const events = await prisma.eventLog.findMany({
    where: { kind: { in: ["dm_sent", "dm_failed"] } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const grid = {
    sent: { resolved: 0, consent_gated: 0, unknown: 0 },
    failed: { resolved: 0, consent_gated: 0, unknown: 0 },
  };

  for (const e of events) {
    const p = e.payload ?? {};
    const uid = p.senderId ?? convoUser.get(p.conversationId) ?? null;
    if (!uid) continue;
    const bucket = e.kind === "dm_sent" ? "sent" : "failed";
    grid[bucket][status(uid)]++;
  }

  console.log("=== Gate outcome  ×  user resolvability ===\n");
  console.log("                 resolved   consent_gated   unknown");
  console.log(
    `  gate SENT       ${String(grid.sent.resolved).padStart(6)}   ${String(grid.sent.consent_gated).padStart(11)}   ${String(grid.sent.unknown).padStart(7)}`,
  );
  console.log(
    `  gate FAILED     ${String(grid.failed.resolved).padStart(6)}   ${String(grid.failed.consent_gated).padStart(11)}   ${String(grid.failed.unknown).padStart(7)}`,
  );

  console.log(`\nInterpretation:`);
  console.log(`  • FAILED clusters on consent_gated + SENT clusters on resolved`);
  console.log(`      → consent/region IS the driver. Strong evidence.`);
  console.log(`  • both outcomes mix resolved & consent_gated roughly evenly`);
  console.log(`      → consent/region is NOT the driver; look elsewhere.`);

  const totalUsers = users.length;
  const resolved = users.filter((u) => u.resolvedAt && u.username).length;
  console.log(
    `\nAudience split: ${resolved}/${totalUsers} resolvable (${Math.round((100 * resolved) / totalUsers)}%), ` +
      `${totalUsers - resolved} consent-gated (${Math.round((100 * (totalUsers - resolved)) / totalUsers)}%).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
