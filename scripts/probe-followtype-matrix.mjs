import dotenv from "dotenv";

dotenv.config();

const TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const VER = "v23.0";
const HOST = "graph.instagram.com";

// FEASIBILITY PROBE (read-only, no DB writes).
//
// Findings so far: per-REEL follows/profile_visits are unsupported, and
// reach × follow_type is "Incompatible" at the media level. Meta's docs say
// `follow_type` (FOLLOWER vs NON_FOLLOWER) is an ACCOUNT-level breakdown that
// pairs with `reach`. So the follower-vs-non-follower ("new audience") split is
// available for the WHOLE ACCOUNT over a time window — not per reel.
//
// This probe confirms the account-level pairing and tests the levers that decide
// whether it's usable as a per-window acquisition signal:
//   1. reach × follow_type                          (does the split come back?)
//   2. reach × follow_type × media_product_type     (can we isolate REELS?)
//   3. short window (last_14_days) vs 90d           (can we attribute to recent reels?)
//   4. does `day` period + since/until work         (finest-grained attribution)

async function acct(params) {
  const qs = new URLSearchParams({ access_token: TOKEN, ...params });
  const res = await fetch(`https://${HOST}/${VER}/${IG_USER_ID}/insights?${qs}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function splitByKeys(body) {
  const d = body?.data?.[0];
  const bds = d?.total_value?.breakdowns ?? [];
  const rows = [];
  for (const bd of bds) {
    for (const r of bd.results ?? []) {
      rows.push({ dims: (bd.dimension_keys ?? []).map((k, i) => `${k}=${r.dimension_values?.[i]}`).join(", "), value: r.value });
    }
  }
  return rows;
}

async function run(label, params) {
  const { status, body } = await acct(params);
  if (body?.error) {
    console.log(`  ✗ ${label}: ${status} ${body.error.message}`);
    return;
  }
  console.log(`  ✅ ${label}:`);
  for (const row of splitByKeys(body)) console.log(`       ${row.dims}  →  ${row.value}`);
}

async function main() {
  if (!TOKEN || !IG_USER_ID) {
    console.error("Missing IG_ACCESS_TOKEN / IG_USER_ID");
    process.exit(1);
  }
  console.log(`Account-level reach × follow_type probe (IG_USER ${IG_USER_ID})\n`);

  // 1) The core: reach split by follower vs non-follower, 90-day window.
  await run("reach × follow_type (90d)", {
    metric: "reach",
    period: "day",
    metric_type: "total_value",
    breakdown: "follow_type",
    timeframe: "last_90_days",
  });

  // 2) Add media_product_type so we can isolate REELS reach specifically.
  await run("reach × [follow_type, media_product_type] (90d)", {
    metric: "reach",
    period: "day",
    metric_type: "total_value",
    breakdown: "follow_type,media_product_type",
    timeframe: "last_90_days",
  });

  // 3) Short window — the key to attributing a shift to RECENT reels.
  await run("reach × follow_type (14d)", {
    metric: "reach",
    period: "day",
    metric_type: "total_value",
    breakdown: "follow_type",
    timeframe: "last_14_days",
  });

  // 4) Daily series with an explicit 7-day since/until (finest attribution grain).
  const until = Math.floor(Date.now() / 1000);
  const since = until - 7 * 24 * 3600;
  await run(`reach × follow_type (since/until 7d)`, {
    metric: "reach",
    period: "day",
    metric_type: "total_value",
    breakdown: "follow_type",
    since: String(since),
    until: String(until),
  });
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
