// Drain the ENTIRE Gemini analysis queue in one command — loops until no pending
// jobs remain (or the daily budget stops it), so you don't have to run
// run-snapshot-once.mjs repeatedly. Reads cached profiles for already-done reels
// (no re-charge); only pending reels hit Gemini.
//
// Usage:  node --import tsx scripts/score-all-reels.mjs

import "dotenv/config";

const { prisma } = await import("../src/lib/prisma.ts");
const { runGeminiQueueTick } = await import("../src/services/geminiQueueWorker.ts");

async function pendingCount() {
  return prisma.geminiJob.count({ where: { status: "pending" } });
}

async function main() {
  let pending = await pendingCount();
  console.log(`Starting: ${pending} reels pending analysis.`);

  let rounds = 0;
  // Safety cap so a stuck queue (e.g. budget exhausted, every job erroring) can't
  // loop forever. 40 rounds × batch easily covers a few-hundred-reel catalog.
  const MAX_ROUNDS = 40;

  while (pending > 0 && rounds < MAX_ROUNDS) {
    await runGeminiQueueTick();
    rounds++;
    const next = await pendingCount();
    const done = pending - next;
    console.log(`  round ${rounds}: ${done >= 0 ? done : 0} analyzed, ${next} still pending`);
    // If a round made zero progress, the worker is blocked (budget cap or all
    // remaining jobs failing/backing off) — stop rather than spin.
    if (next >= pending) {
      console.log("  no progress this round — stopping (budget cap or all remaining jobs backing off).");
      break;
    }
    pending = next;
  }

  const scored = await prisma.reelMeta.count({ where: { usFitScore: { not: null } } });
  const cost = await prisma.reelContentProfile.aggregate({ _sum: { costUsd: true } });
  console.log(`Done. ${scored} reels scored. Total spend ≈ $${(cost._sum.costUsd ?? 0).toFixed(4)}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("score-all failed:", e);
  process.exit(1);
});
