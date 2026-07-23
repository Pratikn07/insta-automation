import { prisma } from "../src/lib/prisma.js";
import { getLeaderboard } from "../src/services/insightsService.js";

// Parity check for Phase A: capture rate + revived conversion counts.
// Expect the Jun-24 sleep reel ~1.39% and 300k+ virals ~0.02–0.05%.
async function main() {
  const rows = await getLeaderboard();
  const withCapture = rows.filter((r) => r.captureRatePct !== null);
  console.log(`reels with a capture rate (reach >= floor): ${withCapture.length}`);
  console.log("\nTop 12 by capture rate:");
  for (const r of [...withCapture].sort((a, b) => b.captureRatePct! - a.captureRatePct!).slice(0, 12)) {
    const cap = r.captureRatePct!.toFixed(2).padStart(5);
    const reach = String(r.reach ?? 0).padStart(7);
    console.log(
      `  ${cap}%  reach ${reach}  comments ${String(r.conversion.keywordComments).padStart(4)}  ` +
        `delivered ${String(r.conversion.completed).padStart(3)}  ${(r.caption ?? "").slice(0, 40).replace(/\n/g, " ")}`,
    );
  }
  const nonZero = rows.filter((r) => r.conversion.keywordComments > 0).length;
  console.log(`\nreels with non-zero conversion (was 0 for ALL before the fix): ${nonZero}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
