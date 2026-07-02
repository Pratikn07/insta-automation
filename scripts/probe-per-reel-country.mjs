import dotenv from "dotenv";

dotenv.config();

const TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const VERSIONS = ["v23.0", "v22.0", "v21.0"];
const HOST = "graph.instagram.com";

// FEASIBILITY PROBE (read-only, no DB writes).
//
// Single question: does the PUBLIC Graph API expose a per-REEL country split,
// the way the Instagram app's own reel insights screen shows it?
//
// The IG app uses private endpoints. This probe tests every documented public
// avenue and prints exactly what works, so the decision is data-driven, not
// assumed. We test against the account's HIGHEST-reach reel (most likely to
// have enough volume for Meta to return a geo breakdown at all).
//
// Avenues tested, per media id:
//   1. metric=reach              & breakdown=country   (mirrors account-level call)
//   2. metric=profile_activity   & breakdown=country
//   3. media_product_type=REELS metrics + breakdown=country / =audience_*
//   4. bare `insights` edge with breakdown only (discover supported breakdowns)
// Plus, per media: which breakdowns Meta *says* are valid (error messages often
// enumerate the allowed set — free schema disclosure).

async function call(version, mediaId, params) {
  const qs = new URLSearchParams({ access_token: TOKEN, ...params });
  const url = `https://${HOST}/${version}/${mediaId}/insights?${qs}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  return { ok: !body.error, status: res.status, body, url: url.replace(TOKEN, "TOKEN") };
}

function summarize(body) {
  const rows = [];
  for (const d of body?.data ?? []) {
    const tv = d.total_value;
    if (tv?.breakdowns?.length) {
      for (const bd of tv.breakdowns) {
        const keys = bd.dimension_keys ?? [];
        const idx = keys.indexOf("country");
        const counts = {};
        for (const r of bd.results ?? []) {
          const c = idx >= 0 ? r.dimension_values?.[idx] : r.dimension_values?.join("/");
          if (c != null) counts[c] = (counts[c] ?? 0) + (r.value ?? 0);
        }
        rows.push({ metric: d.name, dimension_keys: keys, counts });
      }
    } else if (typeof tv?.value === "number") {
      rows.push({ metric: d.name, value: tv.value });
    } else if (d.values) {
      rows.push({ metric: d.name, values: d.values });
    }
  }
  return rows;
}

async function tryOne(label, mediaId, params) {
  for (const version of VERSIONS) {
    const { ok, status, body } = await call(version, mediaId, params);
    if (ok) {
      console.log(`  ✅ [${label} @ ${version}] status ${status}`);
      console.dir(summarize(body), { depth: 6 });
      return true;
    }
    const e = body.error ?? {};
    console.log(
      `  ✗ [${label} @ ${version}] ${status} code=${e.code ?? "?"}/${e.error_subcode ?? "-"}: ${e.message ?? "unknown"}`,
    );
    // error message frequently lists the VALID breakdown/metric set — capture it.
    if (e.message && /breakdown|metric|permitted|supported|must be one of/i.test(e.message)) {
      console.log(`      ↳ schema hint: ${e.message}`);
    }
  }
  return false;
}

async function main() {
  if (!TOKEN || !IG_USER_ID) {
    console.error("Missing IG_ACCESS_TOKEN / IG_USER_ID in env");
    process.exit(1);
  }

  // Pull a few real reel ids newest-first; also hardcode the known high-reach one.
  const listUrl = `https://${HOST}/${VERSIONS[0]}/${IG_USER_ID}/media?fields=id,media_product_type,caption&limit=25&access_token=${TOKEN}`;
  const list = await (await fetch(listUrl)).json().catch(() => ({}));
  const reels = (list.data ?? []).filter((m) => m.media_product_type === "REELS" || m.media_product_type === "VIDEO");
  const HIGH_REACH = "18125995087532598"; // 142k reach reel from Supabase
  const ids = [HIGH_REACH, ...reels.map((r) => r.id).filter((id) => id !== HIGH_REACH)].slice(0, 3);

  console.log(`Testing per-reel country availability on ${ids.length} reel(s): ${ids.join(", ")}\n`);

  for (const mediaId of ids) {
    console.log(`\n═══ MEDIA ${mediaId} ═══`);

    // 1) reach + country (the exact shape that works at account level)
    await tryOne("reach+breakdown=country", mediaId, {
      metric: "reach",
      breakdown: "country",
      metric_type: "total_value",
    });

    // 2) profile_activity (has a breakdown dimension on some object types)
    await tryOne("profile_activity+country", mediaId, {
      metric: "profile_activity",
      breakdown: "country",
      metric_type: "total_value",
    });

    // 3) intentionally-wrong breakdown to force Meta to enumerate valid ones
    await tryOne("reach+breakdown=__invalid__ (schema probe)", mediaId, {
      metric: "reach",
      breakdown: "__invalid__",
      metric_type: "total_value",
    });

    // 4) intentionally-wrong metric to force Meta to enumerate valid reel metrics
    await tryOne("metric=__invalid__ (schema probe)", mediaId, {
      metric: "__invalid__",
    });
  }
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
