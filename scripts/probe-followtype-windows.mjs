import dotenv from "dotenv";
import { liveToken } from "./lib/live-token.mjs";

dotenv.config();

const TOKEN = await liveToken();
const IG_USER_ID = process.env.IG_USER_ID;
const VER = "v23.0";
const HOST = "graph.instagram.com";

// FEASIBILITY PROBE (read-only, no DB writes).
//
// Confirmed: account-level `reach × follow_type` returns FOLLOWER vs NON_FOLLOWER
// and composes with media_product_type (so REELS can be isolated). BUT two
// anomalies must be resolved before building a time-window signal on it:
//   (a) timeframe=last_90_days and last_14_days returned IDENTICAL numbers.
//   (b) a 7-day since/until returned LARGER numbers than the 90-day timeframe.
//
// This probe pins down, empirically, how the window params actually behave, so
// any forward-capture design rests on fact not guess. For each variant it prints
// the follower/non-follower split AND how many daily data points came back.

async function acct(params) {
  const qs = new URLSearchParams({ access_token: TOKEN, ...params });
  const res = await fetch(`https://${HOST}/${VER}/${IG_USER_ID}/insights?${qs}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// total_value shape → {FOLLOWER, NON_FOLLOWER}
function totalSplit(body) {
  const bd = body?.data?.[0]?.total_value?.breakdowns?.[0];
  if (!bd) return null;
  const idx = (bd.dimension_keys ?? []).indexOf("follow_type");
  const out = {};
  for (const r of bd.results ?? []) {
    const k = idx >= 0 ? r.dimension_values?.[idx] : "?";
    out[k] = r.value ?? 0;
  }
  return out;
}

async function show(label, params) {
  const { status, body } = await acct(params);
  if (body?.error) {
    console.log(`  ✗ ${label}: ${status} ${body.error.message}`);
    return;
  }
  const split = totalSplit(body);
  console.log(`  ✅ ${label}: ${JSON.stringify(split)}`);
}

async function main() {
  if (!TOKEN || !IG_USER_ID) {
    console.error("Missing IG_ACCESS_TOKEN / IG_USER_ID");
    process.exit(1);
  }
  const DAY = 24 * 3600;
  const now = Math.floor(Date.now() / 1000);

  console.log("Resolving window-param behavior for reach × follow_type\n");

  // 1) timeframe variants — do they actually differ?
  console.log("── timeframe (metric_type=total_value, period=day) ──");
  for (const tf of ["last_14_days", "last_30_days", "last_90_days"]) {
    await show(`timeframe=${tf}`, {
      metric: "reach",
      period: "day",
      metric_type: "total_value",
      breakdown: "follow_type",
      timeframe: tf,
    });
  }

  // 2) explicit since/until windows of increasing length — should be monotonic
  //    if this is deduped reach; if it grows ~linearly it's summed daily reach.
  console.log("\n── since/until windows (period=day, total_value) ──");
  for (const days of [7, 14, 30, 90]) {
    await show(`last ${days}d (since/until)`, {
      metric: "reach",
      period: "day",
      metric_type: "total_value",
      breakdown: "follow_type",
      since: String(now - days * DAY),
      until: String(now),
    });
  }

  // 3) same 7-day window WITHOUT period=day (does period drive the summing?)
  console.log("\n── 7d since/until, period variants ──");
  for (const period of ["day", "week", "days_28", "lifetime"]) {
    await show(`period=${period}`, {
      metric: "reach",
      period,
      metric_type: "total_value",
      breakdown: "follow_type",
      since: String(now - 7 * DAY),
      until: String(now),
    });
  }
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
