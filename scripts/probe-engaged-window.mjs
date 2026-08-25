import dotenv from "dotenv";
import { liveToken } from "./lib/live-token.mjs";

dotenv.config();

const TOKEN = await liveToken();
const IG_USER_ID = process.env.IG_USER_ID;
const VER = "v23.0";
const HOST = "graph.instagram.com";

// FEASIBILITY PROBE (read-only, no DB writes).
//
// DECIDES whether forward engaged-geo window attribution is even possible.
// We already proved `timeframe` is INERT for the reach metric (14d==30d==90d).
// If engaged_audience_demographics is ALSO inert on timeframe, we cannot window
// it, and per-cycle attribution is impossible — must know before building.
//
// Prints US%/IN% for engaged + reached at each timeframe. If the numbers DIFFER
// across timeframes → windowing works, build it. If IDENTICAL → inert, and we
// need a different attribution design (or the goal isn't reachable this way).

async function fetchGeo(metric, timeframe) {
  const params = new URLSearchParams({
    metric,
    period: "lifetime",
    timeframe,
    breakdown: "country",
    metric_type: "total_value",
    access_token: TOKEN,
  });
  const res = await fetch(`https://${HOST}/${VER}/${IG_USER_ID}/insights?${params}`);
  const body = await res.json().catch(() => ({}));
  if (body.error) return { error: body.error.message };
  const bd = body?.data?.[0]?.total_value?.breakdowns?.[0];
  const counts = {};
  if (bd) {
    const idx = (bd.dimension_keys ?? []).indexOf("country");
    for (const r of bd.results ?? []) {
      const c = idx >= 0 ? r.dimension_values?.[idx] : null;
      if (c) counts[c] = (counts[c] ?? 0) + (r.value ?? 0);
    }
  }
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  return {
    total,
    usPct: total ? Math.round(((counts.US ?? 0) / total) * 1000) / 10 : null,
    inPct: total ? Math.round(((counts.IN ?? 0) / total) * 1000) / 10 : null,
  };
}

async function main() {
  if (!TOKEN || !IG_USER_ID) {
    console.error("Missing IG_ACCESS_TOKEN / IG_USER_ID");
    process.exit(1);
  }
  const timeframes = ["last_14_days", "last_30_days", "last_90_days"];
  for (const metric of ["engaged_audience_demographics", "reached_audience_demographics"]) {
    console.log(`\n=== ${metric} ===`);
    for (const tf of timeframes) {
      const r = await fetchGeo(metric, tf);
      if (r.error) console.log(`  ${tf}: ✗ ${r.error}`);
      else console.log(`  ${tf}: total=${r.total}  US=${r.usPct}%  IN=${r.inPct}%`);
    }
  }
  console.log(
    "\nINTERPRET: if the three timeframes show DIFFERENT totals/US% → windowing works.",
  );
  console.log("If IDENTICAL across all three → timeframe is inert; windowed attribution not possible.");
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
