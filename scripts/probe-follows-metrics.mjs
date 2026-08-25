import dotenv from "dotenv";
import { liveToken } from "./lib/live-token.mjs";

dotenv.config();

const TOKEN = await liveToken();
const IG_USER_ID = process.env.IG_USER_ID;
const VERSIONS = ["v23.0", "v22.0", "v21.0"];
const HOST = "graph.instagram.com";

// FEASIBILITY PROBE (read-only, no DB writes).
//
// The media-insights schema (leaked by an earlier probe's error message) lists
// `follows`, `profile_visits`, `profile_activity` as valid per-reel metrics, and
// `follow_type` as a valid breakdown. This probe confirms they return REAL
// numbers on this account's reels before we add DB columns + a fetcher.
//
// Two things tested per reel:
//   1. metric=follows,profile_visits,profile_activity          (plain per-reel counts)
//   2. metric=reach & breakdown=follow_type & metric_type=total_value
//        → splits a reel's reach into FOLLOWER vs NON-FOLLOWER. Non-follower
//          reach = "new people reached", the acquisition signal we want.
//
// We test the account's biggest and a couple of smaller reels so we can see
// whether Meta returns the split at both high and low volume.

async function get(mediaId, params) {
  let lastErr = null;
  // try newest version first, fall back on the "unsupported for version" error
  for (const version of VERSIONS) {
    const qs = new URLSearchParams({ access_token: TOKEN, ...params });
    const res = await fetch(`https://${HOST}/${version}/${mediaId}/insights?${qs}`);
    const body = await res.json().catch(() => ({}));
    if (!body.error) return { version, body };
    lastErr = { version, status: res.status, ...body.error };
    if (body.error.code !== 100) break; // real error, not a version mismatch — stop
  }
  // never swallow: return the last error so the caller can print it
  return { version: lastErr?.version ?? null, body: { error: lastErr } };
}

function plain(body) {
  const out = {};
  for (const d of body?.data ?? []) {
    const v = d.total_value?.value ?? d.values?.[0]?.value;
    out[d.name] = v ?? null;
  }
  return out;
}

function followSplit(body) {
  const d = (body?.data ?? []).find((x) => x.name === "reach");
  const bd = d?.total_value?.breakdowns?.[0];
  if (!bd) return null;
  const keys = bd.dimension_keys ?? [];
  const idx = keys.indexOf("follow_type");
  const out = {};
  for (const r of bd.results ?? []) {
    const k = idx >= 0 ? r.dimension_values?.[idx] : r.dimension_values?.join("/");
    if (k != null) out[k] = r.value ?? 0;
  }
  return { dimension_keys: keys, split: out };
}

async function main() {
  if (!TOKEN || !IG_USER_ID) {
    console.error("Missing IG_ACCESS_TOKEN / IG_USER_ID");
    process.exit(1);
  }

  // Grab recent reels; also pin the known 142k-reach reel.
  const listUrl = `https://${HOST}/${VERSIONS[0]}/${IG_USER_ID}/media?fields=id,media_product_type&limit=25&access_token=${TOKEN}`;
  const list = await (await fetch(listUrl)).json().catch(() => ({}));
  const reels = (list.data ?? []).filter(
    (m) => m.media_product_type === "REELS" || m.media_product_type === "VIDEO",
  );
  const BIG = "18125995087532598"; // 142k reach
  const ids = [BIG, ...reels.map((r) => r.id).filter((id) => id !== BIG)].slice(0, 4);

  console.log(`Confirming follows + follow_type on ${ids.length} reel(s)\n`);

  const errStr = (e) =>
    e ? `${e.status ?? "?"} code=${e.code ?? "?"}/${e.error_subcode ?? "-"}: ${e.message ?? "unknown"}` : "unknown";

  for (const mediaId of ids) {
    console.log(`═══ MEDIA ${mediaId} ═══`);

    // Each metric alone — so one unsupported metric can't mask the others, and
    // we learn EXACTLY which are available on this account (with period variants).
    for (const metric of ["follows", "profile_visits", "profile_activity", "reach"]) {
      const r = await get(mediaId, { metric });
      if (r.body?.error) console.log(`  ✗ ${metric}: ${errStr(r.body.error)}`);
      else console.log(`  ✅ ${metric} @ ${r.version}:`, plain(r.body));
    }

    // The acquisition split: reach × follow_type.
    for (const extra of [
      { metric: "reach", breakdown: "follow_type", metric_type: "total_value" },
      { metric: "reach", breakdown: "follow_type", metric_type: "total_value", period: "lifetime" },
    ]) {
      const b = await get(mediaId, extra);
      const tag = `reach/follow_type${extra.period ? `+period=${extra.period}` : ""}`;
      if (b.body?.error) {
        console.log(`  ✗ ${tag}: ${errStr(b.body.error)}`);
      } else {
        const split = followSplit(b.body);
        console.log(`  ✅ ${tag} @ ${b.version}:`, JSON.stringify(split));
        if (split?.split) {
          const total = Object.values(split.split).reduce((s, v) => s + v, 0);
          const nonFollower =
            split.split.NON_FOLLOWER ?? split.split.non_follower ?? split.split["NON-FOLLOWER"] ?? 0;
          if (total > 0)
            console.log(`     → ${Math.round((nonFollower / total) * 100)}% of reach was NEW (non-follower)`);
        }
      }
    }
    console.log();
  }
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
