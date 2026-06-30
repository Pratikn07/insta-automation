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
}

/** Per-reel conversion counts, keyed by mediaId, from the existing tables. */
async function conversionByMedia(): Promise<Map<string, ConversionLine>> {
  // IMPORTANT: count Conversation rows, NOT event_log `comment_received`. The raw
  // comment stream is ~93% mechanical — ~48% our own "Check your DM" public
  // replies (logged with our own IG id as the sender) and ~46% bare keyword
  // comments ("sleep"/"potty"), leaving only ~2.6% organic. A Conversation is
  // created once per keyword-triggered gate and deduped by the app, so it's the
  // honest "this reel drove an intent" count. Never surface a raw comment count.
  //
  // Conversation → Keyword.mediaId. Group in JS (Prisma can't group across the
  // relation cleanly) — the conversation volume here is small (~1.4k rows).
  const convos = await prisma.conversation.findMany({
    select: { state: true, gatedAt: true, keyword: { select: { mediaId: true } } },
  });
  const map = new Map<string, ConversionLine>();
  for (const c of convos) {
    const mediaId = c.keyword?.mediaId;
    if (!mediaId) continue; // global keywords aren't attributable to one reel
    const line = map.get(mediaId) ?? { keywordComments: 0, gateDelivered: 0, completed: 0 };
    line.keywordComments++;
    if (c.gatedAt) line.gateDelivered++;
    if (c.state === "completed") line.completed++;
    map.set(mediaId, line);
  }
  return map;
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
      conversion: conversion.get(r.mediaId) ?? {
        keywordComments: 0,
        gateDelivered: 0,
        completed: 0,
      },
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
  const rows = await Promise.all(
    stages.map((stage) =>
      prisma.geoDemographicSnapshot.findFirst({ where: { stage }, orderBy: { capturedAt: "desc" } }),
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
  avgReach: number | null;
}

export interface RecipeData {
  ready: boolean;
  scoredCount: number;
  top: RecipeGroup | null;
  bottom: RecipeGroup | null;
  checklist: string[];
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
    return { ready: false, scoredCount, top: null, bottom: null, checklist: [] };
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
      avgReach: avg(rows.map((r) => r.perfSnapshots[0]?.reach)),
    };
  };

  const top = buildGroup(topRows, "US-pullers");
  const bottom = buildGroup(bottomRows, "India-leaning / generic");

  // Derive a plain-English checklist from the top group's recurring US refs +
  // its dominant setting strength. Concrete > generic — name the actual refs.
  const checklist: string[] = [];
  const topRefs = top.usRefs.slice(0, 6).map((r) => r.text);
  if (topRefs.length) {
    checklist.push(
      `Name US-specific brands & figures — your top reels lean on: ${topRefs.join(", ")}.`,
    );
  }
  if ((top.avgSettingScore ?? 0) >= 70) {
    checklist.push(
      "Film in a modern / minimalist Western home setting (bright, light-colored, contemporary) — your US-pullers consistently read this way.",
    );
  }
  if ((top.avgUsFit ?? 0) - (bottom.avgUsFit ?? 0) >= 15) {
    checklist.push(
      "Anchor each reel to a concrete US cultural cue (a named store, product, or US parenting norm) rather than a generic tip — that single difference separates your top reels from the bottom.",
    );
  }
  if (bottom.usRefs.length === 0) {
    checklist.push(
      "Avoid culturally-neutral 'generic advice' framing — your lowest reels share an absence of any US-specific reference at all.",
    );
  }

  return { ready: true, scoredCount, top, bottom, checklist };
}
