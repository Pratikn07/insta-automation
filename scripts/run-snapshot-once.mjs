// One-off trigger for the snapshot + Gemini workers, so you can populate the
// Insights tables on demand without waiting for the server's interval timers.
//
// Usage:  node --import tsx scripts/run-snapshot-once.mjs
//   (run from the project root so .env loads and the TS modules resolve)
//
// It runs ONE snapshot tick (upserts ReelMeta, writes perf + geo snapshots,
// enqueues Gemini jobs) then drains a few Gemini queue ticks so some reels get
// scored immediately. Safe to re-run; the snapshot self-throttles on recency, so
// pass FORCE=1 to bypass that guard on a fresh DB.

import "dotenv/config";

const { runSnapshotTick } = await import("../src/services/snapshotWorker.ts");
const { runGeminiQueueTick } = await import("../src/services/geminiQueueWorker.ts");

async function main() {
  console.log("Running snapshot tick …");
  await runSnapshotTick();

  console.log("Draining Gemini queue (up to 4 ticks) …");
  for (let i = 0; i < 4; i++) {
    await runGeminiQueueTick();
  }

  console.log("Done. Check Prisma Studio or GET /api/insights/leaderboard.");
  process.exit(0);
}

main().catch((e) => {
  console.error("run-snapshot-once failed:", e);
  process.exit(1);
});
