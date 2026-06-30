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
