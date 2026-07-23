import { prisma } from "../lib/prisma.js";

// Assembles the read models for the Insights tab. Geo-fit, performance, and the
// conversion line are kept as SEPARATE blocks — never summed into one number.

export interface ConversionLine {
  keywordComments: number; // conversations opened from this reel's keywords
  gateDelivered: number; // those that actually received the gate (gatedAt set)
  completed: number; // reached DONE → guide delivered
}

export interface LeaderboardRow {
  mediaId: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  postedAt: string | null;
  usFitScore: number | null;
  confidence: string | null;
  mediaAudioType: string | null;
  videoUnavailable: boolean;
  analyzed: boolean; // has a content profile yet?
  // A compact performance summary from the latest snapshot (shown alongside, not fused).
  views: number | null;
  reach: number | null;
  skipRate: number | null;
  conversion: ConversionLine;
  // Share of reach that entered the funnel (keywordComments ÷ reach, as %). Null
  // when reach is below MIN_REACH_FLOOR — too small a denominator to trust (a
  // 195-reach reel with 27 comments is 13.85%, pure noise). This is the honest,
  // directly-attributable per-reel signal the growth lab recommends on.
  captureRatePct: number | null;
}

// Below this reach, capture rate is dominated by denominator noise, so we report
// null ("not enough reach to judge") rather than a misleading spike.
const MIN_REACH_FLOOR = 500;

/** Per-reel conversion counts, keyed by mediaId. */
async function conversionByMedia(): Promise<Map<string, ConversionLine>> {
  // Attribution comes from event_log `keyword_matched`, which stamps the reel's
  // mediaId AND the conversationId for every comment that fired a keyword. We can
  // NOT use Conversation → Keyword.mediaId: every keyword is global (mediaId =
  // null), so that join attributes nothing and leaves every reel at zero. DM-
  // sourced matches carry no mediaId and are naturally excluded here.
  const [events, convos] = await Promise.all([
    prisma.eventLog.findMany({ where: { kind: "keyword_matched" }, select: { payload: true } }),
    prisma.conversation.findMany({ select: { id: true, state: true, gatedAt: true } }),
  ]);

  const convoById = new Map(convos.map((c) => [c.id, c]));
  // mediaId → set of conversationIds (dedupes any repeat match on one conversation).
  const byMedia = new Map<string, Set<string>>();
  for (const e of events) {
    const p = e.payload as { mediaId?: string | null; conversationId?: string | null };
    if (!p.mediaId || !p.conversationId) continue;
    let set = byMedia.get(p.mediaId);
    if (!set) byMedia.set(p.mediaId, (set = new Set()));
    set.add(p.conversationId);
  }

  const map = new Map<string, ConversionLine>();
  for (const [mediaId, convoIds] of byMedia) {
    const line: ConversionLine = { keywordComments: 0, gateDelivered: 0, completed: 0 };
    for (const id of convoIds) {
      const c = convoById.get(id);
      line.keywordComments++;
      if (c?.gatedAt) line.gateDelivered++;
      if (c?.state === "completed") line.completed++;
    }
    map.set(mediaId, line);
  }
  return map;
}

/** keywordComments ÷ reach as a 2-dp %, or null below the reach floor. */
function captureRate(keywordComments: number, reach: number | null): number | null {
  if (!reach || reach < MIN_REACH_FLOOR || keywordComments <= 0) return null;
  return Math.round((keywordComments / reach) * 10000) / 100;
}

/** The Leaderboard: every known reel, scored reels first. */
export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  const [reels, conversion] = await Promise.all([
    prisma.reelMeta.findMany({
      include: {
        contentProfile: { select: { mediaId: true } },
        perfSnapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
      },
      // Scored reels first (desc), unscored last; then newest.
      orderBy: [{ usFitScore: { sort: "desc", nulls: "last" } }, { postedAt: "desc" }],
    }),
    conversionByMedia(),
  ]);

  return reels.map((r) => {
    const perf = r.perfSnapshots[0];
    const conv = conversion.get(r.mediaId) ?? {
      keywordComments: 0,
      gateDelivered: 0,
      completed: 0,
    };
    return {
      mediaId: r.mediaId,
      caption: r.caption,
      thumbnailUrl: r.thumbnailUrl,
      permalink: r.permalink,
      postedAt: r.postedAt?.toISOString() ?? null,
      usFitScore: r.usFitScore,
      confidence: r.confidence,
      mediaAudioType: r.manualAudioType ?? r.mediaAudioType,
      videoUnavailable: r.videoUnavailable,
      analyzed: r.contentProfile !== null,
      views: perf?.views ?? null,
      reach: perf?.reach ?? null,
      skipRate: perf?.skipRate ?? null,
      conversion: conv,
      captureRatePct: captureRate(conv.keywordComments, perf?.reach ?? null),
    };
  });
}

/** Full per-reel detail for the drawer: meta + content profile + latest perf + conversion. */
export async function getReelDetail(mediaId: string) {
  const [reel, conversion] = await Promise.all([
    prisma.reelMeta.findUnique({
      where: { mediaId },
      include: {
        contentProfile: true,
        perfSnapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
      },
    }),
    conversionByMedia(),
  ]);
  if (!reel) return null;
  return {
    ...reel,
    postedAt: reel.postedAt?.toISOString() ?? null,
    latestPerf: reel.perfSnapshots[0] ?? null,
    conversion: conversion.get(mediaId) ?? { keywordComments: 0, gateDelivered: 0, completed: 0 },
  };
}

/** Latest account-level geo split per stage (the demoted-comments side-note context). */
export async function getLatestGeo() {
  const stages = ["follower", "engaged", "reached"] as const;
  // Pin to the 90d baseline. The table now also holds last_14_days rows (the
  // Experiments "recent reels" thermometer); without this filter the newest
  // engaged/reached row could be a 14d row, and the header's baseline US% would
  // silently swap to the 14d value. follower is 90d-only anyway.
  const rows = await Promise.all(
    stages.map((stage) =>
      prisma.geoDemographicSnapshot.findFirst({
        where: { stage, timeframe: "last_90_days" },
        orderBy: { capturedAt: "desc" },
      }),
    ),
  );
  return stages.map((stage, i) => {
    const r = rows[i];
    return r
      ? {
          stage,
          usPct: r.usPct,
          inPct: r.inPct,
          totalCounted: r.totalCounted,
          counts: r.counts,
          capturedAt: r.capturedAt.toISOString(),
        }
      : { stage, usPct: null, inPct: null, totalCounted: null, counts: {}, capturedAt: null };
  });
}

// ── Recipe (Tab 2) ───────────────────────────────────────────────────────────
// Contrasts the top US-fit reels vs the bottom ones and mines their shared DNA.
// Built from culturalReferences + setting/cultural scores + reach — NOT hooks or
// audioVibe (validated as non-discriminating / free-text noise on this account).

export interface RecipeReference {
  text: string;
  count: number;
}

export interface RecipeGroup {
  label: string;
  reels: LeaderboardRow[];
  usRefs: RecipeReference[];
  indiaRefs: RecipeReference[];
  avgUsFit: number | null;
  avgSettingScore: number | null;
  avgCulturalScore: number | null;
  // Median, NOT mean: a single viral outlier makes the group mean meaningless
  // (top-group mean reach 19.6k is dragged up ~9x by one 142k reel; the typical
  // top reel reaches ~2.2k). Median is the honest "typical reel" figure.
  medianReach: number | null;
}

export interface RecipeData {
  ready: boolean;
  scoredCount: number;
  top: RecipeGroup | null;
  bottom: RecipeGroup | null;
  checklist: string[];
  // Pearson correlation between usFitScore and reach across ALL scored reels.
  // Surfaced so the UI can state plainly that US-fit does NOT predict reach
  // (measured ≈0 on this account) — the tab describes tone, not performance.
  usFitReachCorr: number | null;
}

// Minimum scored reels before a top-vs-bottom contrast is meaningful (else a
// 1-vs-1 "recipe" would mislead).
const RECIPE_MIN_SCORED = 4;
const RECIPE_GROUP_MAX = 8;

interface CulturalRef {
  text: string;
  region: "us" | "india" | "neutral";
}

function avg(nums: Array<number | null | undefined>): number | null {
  const vals = nums.filter((n): n is number => typeof n === "number");
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
}

// Median — robust to the viral-outlier problem that makes mean reach a lie here.
function median(nums: Array<number | null | undefined>): number | null {
  const vals = nums.filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  if (vals.length === 0) return null;
  const mid = Math.floor(vals.length / 2);
  if (vals.length % 2) return vals[mid] ?? null;
  const lo = vals[mid - 1] ?? 0;
  const hi = vals[mid] ?? 0;
  return Math.round((lo + hi) / 2);
}

// Pearson correlation of two paired series (ignoring pairs with a null on either
// side). Returns null if fewer than 3 usable pairs or zero variance.
function pearson(
  xs: Array<number | null | undefined>,
  ys: Array<number | null | undefined>,
): number | null {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    if (typeof x === "number" && typeof y === "number") pairs.push([x, y]);
  }
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let cov = 0,
    vx = 0,
    vy = 0;
  for (const [x, y] of pairs) {
    cov += (x - mx) * (y - my);
    vx += (x - mx) ** 2;
    vy += (y - my) ** 2;
  }
  if (vx === 0 || vy === 0) return null;
  return Math.round((cov / Math.sqrt(vx * vy)) * 100) / 100; // 2 dp
}

// Flatten + lowercase-dedupe culturalReferences across a group's profiles,
// counting occurrences and splitting by region. Returns the top refs per region.
function aggregateRefs(profiles: Array<{ culturalReferences?: CulturalRef[] }>) {
  const us = new Map<string, number>();
  const india = new Map<string, number>();
  for (const p of profiles) {
    for (const ref of p.culturalReferences ?? []) {
      if (!ref?.text) continue;
      const key = ref.text.trim().toLowerCase();
      if (!key) continue;
      const bucket = ref.region === "us" ? us : ref.region === "india" ? india : null;
      if (bucket) bucket.set(key, (bucket.get(key) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>): RecipeReference[] =>
    [...m.entries()]
      .map(([text, count]) => ({ text, count }))
      .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
      .slice(0, 12);
  return { usRefs: top(us), indiaRefs: top(india) };
}

/**
 * Recipe: top-N vs bottom-N scored reels + the shared DNA contrast + a derived
 * "to make a US reel" checklist. Pure read; gated below RECIPE_MIN_SCORED so a
 * thin contrast can't mislead.
 */
export async function getRecipe(): Promise<RecipeData> {
  const reels = await prisma.reelMeta.findMany({
    where: { usFitScore: { not: null } },
    include: {
      contentProfile: true,
      perfSnapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
    },
    orderBy: { usFitScore: "desc" },
  });

  const scoredCount = reels.length;
  if (scoredCount < RECIPE_MIN_SCORED) {
    return { ready: false, scoredCount, top: null, bottom: null, checklist: [], usFitReachCorr: null };
  }

  // Split into top and bottom halves, capped, non-overlapping.
  const n = Math.min(RECIPE_GROUP_MAX, Math.floor(scoredCount / 2));
  const topRows = reels.slice(0, n);
  const bottomRows = reels.slice(scoredCount - n);

  const toRow = (r: (typeof reels)[number]): LeaderboardRow => {
    const perf = r.perfSnapshots[0];
    return {
      mediaId: r.mediaId,
      caption: r.caption,
      thumbnailUrl: r.thumbnailUrl,
      permalink: r.permalink,
      postedAt: r.postedAt?.toISOString() ?? null,
      usFitScore: r.usFitScore,
      confidence: r.confidence,
      mediaAudioType: r.manualAudioType ?? r.mediaAudioType,
      videoUnavailable: r.videoUnavailable,
      analyzed: r.contentProfile !== null,
      views: perf?.views ?? null,
      reach: perf?.reach ?? null,
      skipRate: perf?.skipRate ?? null,
      conversion: { keywordComments: 0, gateDelivered: 0, completed: 0 }, // not shown in recipe
      captureRatePct: null, // not shown in recipe
    };
  };

  const buildGroup = (rows: typeof reels, label: string): RecipeGroup => {
    const profiles = rows.map((r) => ({
      culturalReferences: (r.contentProfile?.profile as { culturalReferences?: CulturalRef[] } | null)
        ?.culturalReferences,
    }));
    const { usRefs, indiaRefs } = aggregateRefs(profiles);
    return {
      label,
      reels: rows.map(toRow),
      usRefs,
      indiaRefs,
      avgUsFit: avg(rows.map((r) => r.usFitScore)),
      avgSettingScore: avg(rows.map((r) => r.contentProfile?.settingScore)),
      avgCulturalScore: avg(rows.map((r) => r.contentProfile?.culturalScore)),
      medianReach: median(rows.map((r) => r.perfSnapshots[0]?.reach)),
    };
  };

  const top = buildGroup(topRows, "US-styled");
  const bottom = buildGroup(bottomRows, "Generic / India-leaning");

  // Honesty check: does US-fit actually track reach? Measured across ALL scored
  // reels, not just the two groups. On this account it's ≈0 — so the checklist
  // below must describe TONE ("reads as US-aimed"), never promise performance.
  const usFitReachCorr = pearson(
    reels.map((r) => r.usFitScore),
    reels.map((r) => r.perfSnapshots[0]?.reach),
  );

  // Derive a plain-English checklist of what makes a reel READ as US-aimed. This
  // is a style/tone descriptor mined from the high-US-fit group — deliberately
  // NOT framed as a reach or growth lever, because US-fit does not predict reach
  // (usFitReachCorr ≈ 0). Concrete > generic: name the actual references.
  const checklist: string[] = [];
  const topRefs = top.usRefs.slice(0, 6).map((r) => r.text);
  if (topRefs.length) {
    checklist.push(
      `To read as US-aimed, name US-specific brands & figures — your US-styled reels lean on: ${topRefs.join(", ")}.`,
    );
  }
  if ((top.avgSettingScore ?? 0) >= 70) {
    checklist.push(
      "A modern / minimalist Western home setting (bright, light-colored, contemporary) reads as US — your US-styled reels consistently look this way.",
    );
  }
  if ((top.avgUsFit ?? 0) - (bottom.avgUsFit ?? 0) >= 15) {
    checklist.push(
      "A concrete US cultural cue (a named store, product, or US parenting norm) is what separates a US-styled reel from a culturally-neutral one — it's a tone signal, not a reach signal.",
    );
  }
  if (bottom.usRefs.length === 0) {
    checklist.push(
      "Your lowest-US-fit reels share an absence of any US-specific reference — that's what makes them read as culturally neutral rather than US-aimed.",
    );
  }

  return { ready: true, scoredCount, top, bottom, checklist, usFitReachCorr };
}

// ── Per-reel gate-audience origin (Tab: gate-audience breakdown) ──────────────
// For each reel, the inferred ORIGIN of the people who commented a keyword on it
// and reached a conversation. HEAVILY caveated in the UI:
//   1. Origin is a name-based PROXY, not measured geography.
//   2. This only covers KEYWORD-COMMENTERS — a behavior that skews South Asian.
//      Silent followers (where most US followers are) are invisible here.
// So this describes the *gate crowd* per reel, NOT "which reel brings Americans".

export interface ReelOriginRow {
  mediaId: string;
  caption: string | null;
  usFitScore: number | null;
  total: number;
  usWestern: number;
  southAsian: number;
  other: number;
  unknown: number;
  followers: number; // of the above, how many are confirmed followers
}

export async function getReelOriginBreakdown(): Promise<ReelOriginRow[]> {
  // keyword_matched carries mediaId + conversationId; conversation carries the
  // user; ig_users now carries inferred origin. One raw query does the join.
  const rows = await prisma.$queryRaw<
    Array<{
      media_id: string;
      caption: string | null;
      us_fit_score: number | null;
      origin: string | null;
      is_follower: boolean | null;
      n: bigint;
    }>
  >`
    with reel_user as (
      select distinct el.payload->>'mediaId' as media_id, c.ig_user_id
      from event_log el
      join conversations c on c.id = (el.payload->>'conversationId')::uuid
      where el.kind = 'keyword_matched' and el.payload->>'mediaId' is not null
    )
    select ru.media_id,
           rm.caption,
           rm.us_fit_score,
           u.inferred_origin as origin,
           u.is_follower,
           count(*)::bigint as n
    from reel_user ru
    join ig_users u on u.id = ru.ig_user_id
    left join reel_meta rm on rm.media_id = ru.media_id
    group by ru.media_id, rm.caption, rm.us_fit_score, u.inferred_origin, u.is_follower
  `;

  const byReel = new Map<string, ReelOriginRow>();
  for (const r of rows) {
    const row =
      byReel.get(r.media_id) ??
      ({
        mediaId: r.media_id,
        caption: r.caption,
        usFitScore: r.us_fit_score,
        total: 0,
        usWestern: 0,
        southAsian: 0,
        other: 0,
        unknown: 0,
        followers: 0,
      } as ReelOriginRow);
    const n = Number(r.n);
    row.total += n;
    if (r.origin === "us_western") row.usWestern += n;
    else if (r.origin === "south_asian") row.southAsian += n;
    else if (r.origin === "other") row.other += n;
    else row.unknown += n;
    if (r.is_follower) row.followers += n;
    byReel.set(r.media_id, row);
  }
  return [...byReel.values()].sort((a, b) => b.total - a.total);
}
