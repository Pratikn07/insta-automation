import dotenv from "dotenv";

dotenv.config();

const TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;

// FEASIBILITY PROBE (read-only, no DB writes). Validates two claims against the
// REAL account before we build a geo-insight tab:
//
//   1. Can we read a by-country follower split, and turn it into a % breakdown?
//      → follower_demographics / engaged_audience_demographics / reached_audience_demographics
//        with breakdown=country, metric_type=total_value.
//
//   2. Does online_followers (audience-active-by-hour) exist, and does it report
//      in a way that would bias "best time to post" toward the CURRENT (Indian)
//      audience? → online_followers, period=lifetime.
//
// Instagram-Login tokens live on graph.instagram.com. Demographics is newer than
// the app's pinned v21.0, so we try a few versions newest-first and stop at the
// first that works. A single unsupported metric must not mask the others, so each
// metric is requested independently.

const VERSIONS = ["v23.0", "v22.0", "v21.0"];
const HOST = "graph.instagram.com";

async function call(version, metric, extraParams) {
  const params = new URLSearchParams({
    metric,
    access_token: TOKEN,
    ...extraParams,
  });
  const url = `https://${HOST}/${version}/${IG_USER_ID}/insights?${params}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  return { ok: !body.error, status: res.status, body };
}

// Try one metric across versions until one works; returns the working payload.
async function fetchMetric(metric, extraParams) {
  for (const version of VERSIONS) {
    const { ok, status, body } = await call(version, metric, extraParams);
    if (ok) return { version, body };
    const e = body.error ?? {};
    // 100 = unsupported metric/param for this version; keep trying older/newer.
    console.log(
      `    [${metric} @ ${version}] ✗ ${status} ${e.code ?? "?"}/${e.error_subcode ?? "-"}: ${e.message ?? "unknown"}`,
    );
  }
  return null;
}

// Pull the country→count results out of the total_value.breakdowns shape.
function extractCountryCounts(payload) {
  const datum = payload?.data?.[0];
  const breakdowns = datum?.total_value?.breakdowns ?? [];
  const counts = {};
  for (const bd of breakdowns) {
    const keys = bd.dimension_keys ?? [];
    const countryIdx = keys.indexOf("country");
    if (countryIdx === -1) continue;
    for (const r of bd.results ?? []) {
      const country = r.dimension_values?.[countryIdx];
      if (!country) continue;
      counts[country] = (counts[country] ?? 0) + (r.value ?? 0);
    }
  }
  return counts;
}

function printSplit(label, counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  console.log(`\n  ── ${label} ──  (total counted: ${total})`);
  if (total === 0) {
    console.log("    (no data — too few accounts, or metric returned empty)");
    return;
  }
  for (const [country, value] of entries.slice(0, 15)) {
    const pct = ((value / total) * 100).toFixed(1);
    const bar = "█".repeat(Math.round((value / total) * 30));
    const flag = country === "US" ? " 🇺🇸" : country === "IN" ? " 🇮🇳" : "";
    console.log(`    ${country.padEnd(4)} ${pct.padStart(5)}%  ${bar} ${value}${flag}`);
  }
  const us = ((counts.US ?? 0) / total) * 100;
  const ind = ((counts.IN ?? 0) / total) * 100;
  console.log(`    →  US ${us.toFixed(1)}%   vs   India ${ind.toFixed(1)}%`);
}

async function main() {
  if (!TOKEN || !IG_USER_ID) {
    console.error("IG_ACCESS_TOKEN / IG_USER_ID missing — run from project root so .env loads.");
    process.exit(1);
  }

  console.log(`Probing geo demographics for IG user ${IG_USER_ID}\n`);

  // ---- Claim 1: by-country % split, three funnel stages -------------------
  const demoMetrics = [
    ["follower_demographics", "Followers by country (WHO follows you)"],
    ["engaged_audience_demographics", "Engaged audience by country (who interacts)"],
    ["reached_audience_demographics", "Reached audience by country (who the algo SHOWS you to)"],
  ];

  console.log("=== CLAIM 1: country split ===");
  for (const [metric, label] of demoMetrics) {
    const res = await fetchMetric(metric, {
      period: "lifetime",
      timeframe: "last_90_days",
      breakdown: "country",
      metric_type: "total_value",
    });
    if (!res) {
      console.log(`\n  ── ${label} ──  ✗ not available on this token/account`);
      continue;
    }
    const counts = extractCountryCounts(res.body);
    printSplit(`${label}  [${metric} @ ${res.version}]`, counts);
  }

  // ---- Claim 2: online_followers (timing bias) ----------------------------
  console.log("\n\n=== CLAIM 2: online_followers (audience-active-by-hour) ===");
  const online = await fetchMetric("online_followers", { period: "lifetime" });
  if (!online) {
    console.log("  ✗ online_followers not available (needs ≥100 followers / right token).");
  } else {
    const values = online.body?.data?.[0]?.values ?? [];
    console.log(`  ✓ online_followers available @ ${online.version} — ${values.length} hourly buckets.`);
    console.log("    (These hour buckets reflect when your CURRENT followers are active —");
    console.log("     i.e. India hours. This is the metric we'd deliberately INVERT for a US goal.)");
    const sample = values.slice(0, 3).map((v) => JSON.stringify(v.value).slice(0, 60));
    if (sample.length) console.log(`    sample: ${sample.join("  ")}`);
  }

  console.log("\nDone. (read-only — nothing written)\n");
}

main().catch((e) => {
  console.error("Probe crashed:", e.message);
  process.exit(1);
});
