import dotenv from "dotenv";
import { liveToken } from "./lib/live-token.mjs";

dotenv.config();

const TOKEN = await liveToken();
const IG_USER_ID = process.env.IG_USER_ID;
const VERSIONS = ["v23.0", "v22.0", "v21.0"];
const HOST = "graph.instagram.com";

// FEASIBILITY PROBE (read-only, no DB writes).
//
// WHY: the follower chart's daily bars are diffs of `follower_demographics`, a
// LIFETIME metric Meta refreshes on its own irregular schedule. When it doesn't
// refresh for two or three days the chart cannot show those days at all — it
// draws one wide catch-up bar carrying the whole span (see followerFlowCore's
// `stale` / `multi_day_span` bases). Worse, demographics only counts followers
// Meta HAS demographic data for, in its top ~45 countries, so even a clean diff
// systematically under-reports real growth (4,355 vs 4,577 on 2026-07-26).
//
// This probe establishes, against the REAL account, whether a trustworthy daily
// follower series exists. Four independent sources, printed side by side so the
// gaps are visible rather than argued about:
//
//   1. followers_count (profile field)  — the exact number the app shows on the
//      profile. profileFetcher.ts already reads it per request and DISCARDS it.
//      Nothing to negotiate: whatever this says is the truth.
//   2. follows_and_unfollows            — day period, total_value, breakdown=
//      follow_type. Meta's own daily follower ledger: gross follows AND
//      unfollows, not just net. Documented for Instagram Login since Mar 2025,
//      requires 100+ followers. Historically flaky (a 2024 bug returned empty
//      breakdowns for months) — hence probing rather than trusting the docs.
//   3. follower_count                   — the legacy daily metric. Dropped from
//      the current metrics table; tested to see whether it still answers.
//   4. follower_demographics            — what we use today, for comparison.
//
// Nothing here is assumed about response shape: breakdown dimension values are
// printed RAW, because the docs list follow_type as FOLLOWER/NON_FOLLOWER/UNKNOWN
// while this metric is widely reported to return FOLLOWS/UNFOLLOWS instead.
//
//   node scripts/probe-follower-daily-metrics.mjs [days]   (default 14, max 90)

const DAYS = Math.min(Math.max(parseInt(process.argv[2] ?? "14", 10) || 14, 1), 90);
const DAY_SECONDS = 24 * 3600;

async function insights(params) {
  let lastErr = null;
  for (const version of VERSIONS) {
    const qs = new URLSearchParams({ access_token: TOKEN, ...params });
    const res = await fetch(`https://${HOST}/${version}/${IG_USER_ID}/insights?${qs}`);
    const body = await res.json().catch(() => ({}));
    if (!body.error) return { version, body };
    lastErr = { version, status: res.status, ...body.error };
    if (body.error.code !== 100) break; // real error, not a version mismatch
  }
  return { version: lastErr?.version ?? null, body: { error: lastErr } };
}

const errStr = (e) =>
  e
    ? `${e.status ?? "?"} code=${e.code ?? "?"}/${e.error_subcode ?? "-"}: ${e.message ?? "unknown"}`
    : "unknown";

// total_value.breakdowns[] → { DIMENSION_VALUE: n }, keys left exactly as Meta
// spelled them. An empty object means Meta returned the metric with no
// breakdown rows, which is the failure mode the 2024 bug produced.
function breakdownOf(body, metricName) {
  const datum = (body?.data ?? []).find((d) => d.name === metricName);
  if (!datum) return null;
  const bds = datum.total_value?.breakdowns ?? [];
  const out = {};
  for (const bd of bds) {
    for (const r of bd.results ?? []) {
      const key = (r.dimension_values ?? []).join("/") || "(no dimension)";
      out[key] = (out[key] ?? 0) + (r.value ?? 0);
    }
  }
  return { total: datum.total_value?.value ?? null, split: out };
}

// A UTC calendar day as the since/until pair Meta expects. Printed alongside the
// result so a timezone-boundary disagreement is visible rather than silent —
// account insights bucket by the ACCOUNT's timezone, which for this account is
// Pacific, not the UTC midnights these bounds describe.
function dayWindow(daysAgo) {
  const midnight = Math.floor(Date.now() / 1000 / DAY_SECONDS) * DAY_SECONDS;
  const since = midnight - daysAgo * DAY_SECONDS;
  return { since, until: since + DAY_SECONDS, day: new Date(since * 1000).toISOString().slice(0, 10) };
}

async function probeProfileTotal() {
  console.log("── 1. followers_count (profile field) — the truth anchor ──");
  const qs = new URLSearchParams({ access_token: TOKEN, fields: "followers_count,follows_count,media_count" });
  const res = await fetch(`https://${HOST}/${VERSIONS[0]}/${IG_USER_ID}?${qs}`);
  const body = await res.json().catch(() => ({}));
  if (body.error) {
    console.log(`  ✗ ${errStr({ status: res.status, ...body.error })}`);
    return null;
  }
  console.log(`  ✅ followers_count = ${body.followers_count}  (media_count ${body.media_count})`);
  console.log("     → one row per day of THIS number is an exact daily net-add series.\n");
  return body.followers_count ?? null;
}

async function probeFollowsAndUnfollows() {
  console.log(`── 2. follows_and_unfollows — per day, last ${DAYS} days ──`);

  // Shape check first: one day, so a hard failure costs one call not thirty.
  const w = dayWindow(1);
  const shape = await insights({
    metric: "follows_and_unfollows",
    period: "day",
    metric_type: "total_value",
    breakdown: "follow_type",
    since: String(w.since),
    until: String(w.until),
  });
  if (shape.body?.error) {
    console.log(`  ✗ metric unavailable: ${errStr(shape.body.error)}`);
    console.log("     → this account cannot use the daily follower ledger; fall back to source 1.\n");
    return null;
  }
  console.log(`  ✅ supported @ ${shape.version}. Raw one-day payload:`);
  console.log(`     ${JSON.stringify(shape.body.data ?? shape.body)}\n`);

  const rows = [];
  for (let back = DAYS; back >= 1; back--) {
    const win = dayWindow(back);
    const r = await insights({
      metric: "follows_and_unfollows",
      period: "day",
      metric_type: "total_value",
      breakdown: "follow_type",
      since: String(win.since),
      until: String(win.until),
    });
    if (r.body?.error) {
      rows.push({ day: win.day, error: errStr(r.body.error) });
      continue;
    }
    rows.push({ day: win.day, ...(breakdownOf(r.body, "follows_and_unfollows") ?? {}) });
  }

  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.split ?? {})))].sort();
  console.log(`  day          total   ${keys.map((k) => k.padEnd(12)).join("")}`);
  for (const r of rows) {
    if (r.error) {
      console.log(`  ${r.day}   ✗ ${r.error}`);
      continue;
    }
    const cells = keys.map((k) => String(r.split?.[k] ?? "—").padEnd(12)).join("");
    console.log(`  ${r.day}   ${String(r.total ?? "—").padEnd(7)} ${cells}`);
  }

  const measured = rows.filter((r) => !r.error && Object.keys(r.split ?? {}).length > 0);
  console.log(
    `\n  ${measured.length}/${rows.length} days returned breakdown rows.` +
      (measured.length === rows.length
        ? " Complete series — no gaps, no catch-up bars."
        : " GAPS PRESENT — this metric is not a drop-in replacement on its own."),
  );
  console.log(
    "  NOTE: whichever keys appear above are Meta's own spelling. If they read\n" +
      "  FOLLOWS/UNFOLLOWS, net adds = follows − unfollows and the chart can finally\n" +
      "  show churn instead of only the net.\n",
  );
  return rows;
}

async function probeLegacyFollowerCount() {
  console.log(`── 3. follower_count (legacy daily metric) ──`);
  const start = dayWindow(DAYS);
  const end = dayWindow(1);
  const r = await insights({
    metric: "follower_count",
    period: "day",
    since: String(start.since),
    until: String(end.until),
  });
  if (r.body?.error) {
    console.log(`  ✗ ${errStr(r.body.error)}`);
    console.log("     → expected: dropped from the current metrics table. Not a path forward.\n");
    return;
  }
  const values = r.body?.data?.[0]?.values ?? [];
  console.log(`  ✅ supported @ ${r.version}, ${values.length} daily point(s):`);
  for (const v of values) console.log(`     ${v.end_time}  ${v.value}`);
  console.log("     NOTE: this counts NEW follows only (gross), never unfollows.\n");
}

async function probeDemographicsToday() {
  console.log("── 4. follower_demographics — what the chart uses today ──");
  const r = await insights({
    metric: "follower_demographics",
    period: "lifetime",
    timeframe: "last_90_days",
    breakdown: "country",
    metric_type: "total_value",
  });
  if (r.body?.error) {
    console.log(`  ✗ ${errStr(r.body.error)}\n`);
    return null;
  }
  const bd = breakdownOf(r.body, "follower_demographics");
  const counts = bd?.split ?? {};
  const summed = Object.values(counts).reduce((s, v) => s + v, 0);
  console.log(`  ✅ ${Object.keys(counts).length} countries reported, summing to ${summed}`);
  return summed;
}

// Day boundaries: `reach` is the only follower-adjacent metric that supports
// time_series, so it is the one place Meta will TELL us where it puts midnight.
// The chart buckets by Pacific day; if these end_times are not Pacific midnights
// then any daily series built from since/until is offset from the chart's days.
async function probeDayBoundary() {
  console.log("\n── 5. Which midnight does Meta use? (reach time_series) ──");
  const start = dayWindow(4);
  const end = dayWindow(1);
  const r = await insights({
    metric: "reach",
    period: "day",
    metric_type: "time_series",
    since: String(start.since),
    until: String(end.until),
  });
  if (r.body?.error) {
    console.log(`  ✗ ${errStr(r.body.error)}`);
    return;
  }
  for (const v of r.body?.data?.[0]?.values ?? []) {
    console.log(`     end_time ${v.end_time}   reach ${v.value}`);
  }
  console.log(
    "  → an end_time of 07:00Z or 08:00Z means Meta is already bucketing by\n" +
      "    Pacific midnight, matching ANALYTICS_TIME_ZONE. Anything else means the\n" +
      "    since/until windows above need shifting before they line up.",
  );
}

async function main() {
  if (!TOKEN || !IG_USER_ID) {
    console.error("Missing IG_ACCESS_TOKEN / IG_USER_ID");
    process.exit(1);
  }
  console.log(`Probing daily follower sources for IG user ${IG_USER_ID}\n`);

  const followersTotal = await probeProfileTotal();
  const ledger = await probeFollowsAndUnfollows();
  await probeLegacyFollowerCount();
  const demoSum = await probeDemographicsToday();
  await probeDayBoundary();

  console.log("\n══ RECONCILIATION ══");
  if (followersTotal !== null && demoSum !== null) {
    const gap = followersTotal - demoSum;
    console.log(
      `  followers_count ${followersTotal} − demographics ${demoSum} = ${gap} ` +
        `(${((gap / followersTotal) * 100).toFixed(1)}% of the account is invisible to the chart's source)`,
    );
  }
  if (ledger) {
    const keys = [...new Set(ledger.flatMap((r) => Object.keys(r.split ?? {})))];
    const signed = keys.some((k) => /unfollow/i.test(k));
    // Only net the two sides when Meta actually labelled one of them "unfollows".
    // If the breakdown came back as FOLLOWER/NON_FOLLOWER instead, both keys are
    // follows and subtracting either would invent an unfollow that never happened.
    const sum = ledger
      .filter((r) => !r.error)
      .reduce(
        (acc, r) =>
          acc +
          Object.entries(r.split ?? {}).reduce(
            (s, [k, v]) => s + (signed && /unfollow/i.test(k) ? -v : v),
            0,
          ),
        0,
      );
    console.log(
      `  follows_and_unfollows over ${DAYS} days = ${sum} ` +
        (signed ? "(net: follows − unfollows)" : `(GROSS — no unfollow key in ${JSON.stringify(keys)})`),
    );
    console.log("  → compare against the chart's summed bars for the same window.");
  }
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
