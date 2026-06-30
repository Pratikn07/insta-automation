// Recompute usFitScore for ALL reels that already have a Gemini content profile,
// using the CURRENT usFitScore.ts logic. FREE — reads cached profiles, makes zero
// Gemini/Graph calls. Run this after tuning weights or fixing the scoring so the
// leaderboard reflects the new logic without paying to re-analyze.
//
// Usage:  node --import tsx scripts/rescore-reels.mjs

import "dotenv/config";

const { prisma } = await import("../src/lib/prisma.ts");
const { computeUsFit } = await import("../src/services/usFitScore.ts");

async function main() {
  const profiles = await prisma.reelContentProfile.findMany();
  console.log(`Rescoring ${profiles.length} reels from cached profiles (no API calls) …`);

  let changed = 0;
  for (const p of profiles) {
    const reel = await prisma.reelMeta.findUnique({ where: { mediaId: p.mediaId } });
    if (!reel) continue;

    const fit = computeUsFit(
      p.profile,
      p.source,
      reel.manualAudioType ?? reel.mediaAudioType,
    );

    if (reel.usFitScore !== fit.score || reel.confidence !== fit.confidence) {
      changed++;
      console.log(
        `  ${p.mediaId}: ${reel.usFitScore}/${reel.confidence ?? "—"} → ${fit.score}/${fit.confidence}`,
      );
    }

    await prisma.reelMeta.update({
      where: { mediaId: p.mediaId },
      data: { usFitScore: fit.score, confidence: fit.confidence, scoredAt: new Date() },
    });
  }

  console.log(`Done. ${changed} score(s) changed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("rescore failed:", e);
  process.exit(1);
});
