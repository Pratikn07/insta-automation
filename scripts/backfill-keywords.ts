import { prisma } from "../src/lib/prisma.js";
import { backfillKeyword } from "../src/services/keywordBackfillService.js";

// One-off (safe to re-run): backfill gates for ALL active keywords from the last
// 7 days of received comments. Writes DB rows only — the deployed gate-queue
// worker performs the actual paced delivery.
async function main() {
  const keywords = await prisma.keyword.findMany({
    where: { active: true },
    select: { id: true, keyword: true, mediaId: true },
    orderBy: { keyword: "asc" },
  });

  let total = 0;
  for (const k of keywords) {
    const n = await backfillKeyword(k.id);
    const scope = k.mediaId ? `reel ${k.mediaId}` : "global";
    console.log(`${k.keyword} (${scope}): ${n} gate(s) enqueued`);
    total += n;
  }
  console.log(`\nBackfill complete — ${total} gate(s) enqueued across ${keywords.length} active keywords`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
