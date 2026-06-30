// Cheap daily geo snapshot — writes ONLY the account-level country split (3 stages)
// to geo_demographic_snapshot. No Gemini, no per-reel insights loop, no cost.
//
// Purpose: guarantee the reached-US% trend line (Experiments tab) keeps growing
// even if the main 6h snapshot worker is idle. Point a daily Railway cron (or a
// local cron) at this:
//
//   node --import tsx scripts/snapshot-geo-only.mjs
//
// Unlike the full snapshot worker, this does NOT self-throttle — it always writes
// one fresh set of points, so a once-daily schedule yields one clean daily reading.

import "dotenv/config";

const { prisma } = await import("../src/lib/prisma.ts");
const { fetchAllCountrySplits } = await import("../src/meta/demographicsFetcher.ts");

async function main() {
  console.log("Fetching account geo demographics (3 stages) …");
  const splits = await fetchAllCountrySplits();

  if (splits.length === 0) {
    console.error("No demographic data returned — token/scope issue? Nothing written.");
    process.exit(1);
  }

  for (const s of splits) {
    await prisma.geoDemographicSnapshot.create({
      data: {
        stage: s.stage,
        counts: s.counts,
        usPct: s.usPct,
        inPct: s.inPct,
        totalCounted: s.totalCounted,
      },
    });
    console.log(`  ${s.stage}: US ${s.usPct ?? "—"}%  India ${s.inPct ?? "—"}%  (n=${s.totalCounted})`);
  }

  console.log(`Wrote ${splits.length} geo snapshot rows. Done.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("snapshot-geo-only failed:", e);
  process.exit(1);
});
