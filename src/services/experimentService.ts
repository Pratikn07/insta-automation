import { prisma } from "../lib/prisma.js";

// Experiments (Insights Tab 3): log a hypothesis + the reel(s) posted to test it,
// and track whether account-level reached-US% moves over time.
//
// HONEST CONSTRAINTS (surfaced in the UI):
// - Geo is account-level only; reached-US% is the whole account, so concurrent
//   experiments can't be isolated from each other.
// - Demographics use a 90-day rolling window and lag ~48h, so the signal is slow
//   and a single reel barely moves it — experiments are multi-week, not next-day.
// - This is CORRELATIONAL, not causal: US% moving after a post ≠ that post caused it.

export interface ExperimentDto {
  id: string;
  hypothesis: string;
  variable: string;
  reelMediaIds: string[];
  status: string;
  baselineUsPct: number | null;
  measuredUsPct: number | null;
  currentUsPct: number | null; // latest reached-US%, for live baseline→current delta
  startedAt: string;
  postedAt: string | null;
  conclusion: string | null;
  // Auto-experiment fields (null for manual experiments).
  origin: string;
  mediaId: string | null;
  usFitScore: number | null;
  culturalCues: string[];
  baselineEngagedUsPct: number | null;
  measuredEngagedUsPct: number | null;
  windowReachShare: number | null;
  suggestedVerdict: string | null;
  attributionConfidence: string | null;
}

export interface UsReachTrendPoint {
  capturedAt: string;
  usPct: number | null;
}

// One point per snapshot with US% at both windows, for reached AND engaged. The
// 14d line is the "who did my RECENT reels pull" thermometer; the 90d line is
// the slow baseline. When 14d dips below 90d, recent content skewed non-US.
export interface GeoWindowPoint {
  capturedAt: string;
  reachedUs90: number | null;
  reachedUs14: number | null;
  engagedUs90: number | null;
  engagedUs14: number | null;
  reachedIn14: number | null;
  engagedIn14: number | null;
}

/**
 * Latest reached-US% (the metric experiments track). Pinned to the 90d baseline
 * — the table now also holds 14d rows, which must NOT leak into experiment
 * baseline/measure math. Null if no snapshot yet.
 */
async function latestReachedUsPct(): Promise<number | null> {
  const row = await prisma.geoDemographicSnapshot.findFirst({
    where: { stage: "reached", timeframe: "last_90_days" },
    orderBy: { capturedAt: "desc" },
    select: { usPct: true },
  });
  return row?.usPct ?? null;
}

/** Latest 14d ENGAGED-US% — the responsive signal auto-experiments track. */
async function latestEngagedUsPct14d(): Promise<number | null> {
  const row = await prisma.geoDemographicSnapshot.findFirst({
    where: { stage: "engaged", timeframe: "last_14_days" },
    orderBy: { capturedAt: "desc" },
    select: { usPct: true },
  });
  return row?.usPct ?? null;
}

// A reel must own at least this share of its 14-day window's reach before we'll
// suggest a verdict — below it, other reels confound the account-level US%, so we
// stay honest and label it inconclusive.
const DOMINANCE_THRESHOLD = 0.5;
// Auto-experiments measure once the reel has had ~2 weeks to accrue its window.
const MEASURE_AFTER_DAYS = 14;

type ExperimentRow = Awaited<ReturnType<typeof prisma.experiment.findFirst>>;

function toDto(e: NonNullable<ExperimentRow>, currentUsPct: number | null): ExperimentDto {
  return {
    id: e.id,
    hypothesis: e.hypothesis,
    variable: e.variable,
    reelMediaIds: e.reelMediaIds,
    status: e.status,
    baselineUsPct: e.baselineUsPct,
    measuredUsPct: e.measuredUsPct,
    currentUsPct,
    startedAt: e.startedAt.toISOString(),
    postedAt: e.postedAt?.toISOString() ?? null,
    conclusion: e.conclusion,
    origin: e.origin,
    mediaId: e.mediaId,
    usFitScore: e.usFitScore,
    culturalCues: e.culturalCues,
    baselineEngagedUsPct: e.baselineEngagedUsPct,
    measuredEngagedUsPct: e.measuredEngagedUsPct,
    windowReachShare: e.windowReachShare,
    suggestedVerdict: e.suggestedVerdict,
    attributionConfidence: e.attributionConfidence,
  };
}

export async function listExperiments(): Promise<ExperimentDto[]> {
  const [rows, current] = await Promise.all([
    prisma.experiment.findMany({ orderBy: { createdAt: "desc" } }),
    latestReachedUsPct(),
  ]);
  return rows.map((e) => toDto(e, current));
}

export async function createExperiment(input: {
  hypothesis: string;
  variable: string;
  reelMediaIds: string[];
  postedAt?: string | null;
}): Promise<ExperimentDto> {
  const baseline = await latestReachedUsPct();
  const created = await prisma.experiment.create({
    data: {
      hypothesis: input.hypothesis,
      variable: input.variable,
      reelMediaIds: input.reelMediaIds,
      baselineUsPct: baseline,
      postedAt: input.postedAt ? new Date(input.postedAt) : null,
      status: "running",
      origin: "manual",
      culturalCues: [], // never NULL — the DTO types this field non-null
    },
  });
  return toDto(created, baseline);
}

/**
 * Update an experiment. `measure: true` re-reads the current reached-US% into
 * measuredUsPct (the "Measure now" button). Status/postedAt/conclusion are manual.
 */
export async function updateExperiment(
  id: string,
  input: {
    status?: string;
    postedAt?: string | null;
    conclusion?: string | null;
    measure?: boolean;
  },
): Promise<ExperimentDto> {
  const current = await latestReachedUsPct();
  const data: {
    status?: string;
    postedAt?: Date | null;
    conclusion?: string | null;
    measuredUsPct?: number | null;
  } = {};
  if (input.status !== undefined) data.status = input.status;
  if (input.postedAt !== undefined) data.postedAt = input.postedAt ? new Date(input.postedAt) : null;
  if (input.conclusion !== undefined) data.conclusion = input.conclusion;
  if (input.measure) data.measuredUsPct = current;

  const updated = await prisma.experiment.update({ where: { id }, data });
  return toDto(updated, current);
}

/**
 * The reached-US% time series for the legacy trend chart. Pinned to the 90d
 * baseline so it stays the stable line the Experiments tab already renders.
 */
export async function getUsReachTrend(): Promise<UsReachTrendPoint[]> {
  const rows = await prisma.geoDemographicSnapshot.findMany({
    where: { stage: "reached", timeframe: "last_90_days" },
    orderBy: { capturedAt: "asc" },
    select: { capturedAt: true, usPct: true },
  });
  return rows.map((r) => ({ capturedAt: r.capturedAt.toISOString(), usPct: r.usPct }));
}

/**
 * The windowed geo thermometer: for each snapshot time, US% (and recent-IN%) at
 * both 14d and 90d for reached + engaged. Grouped by capturedAt rounded to the
 * minute so the (stage,timeframe) rows written in one tick collapse to one point.
 */
export async function getGeoWindowTrend(): Promise<GeoWindowPoint[]> {
  const rows = await prisma.geoDemographicSnapshot.findMany({
    where: { stage: { in: ["reached", "engaged"] } },
    orderBy: { capturedAt: "asc" },
    select: { capturedAt: true, stage: true, timeframe: true, usPct: true, inPct: true },
  });

  // Bucket by minute — one snapshot tick writes several rows microseconds apart.
  const buckets = new Map<string, GeoWindowPoint>();
  for (const r of rows) {
    const key = r.capturedAt.toISOString().slice(0, 16); // yyyy-mm-ddThh:mm
    const pt =
      buckets.get(key) ??
      ({
        capturedAt: r.capturedAt.toISOString(),
        reachedUs90: null,
        reachedUs14: null,
        engagedUs90: null,
        engagedUs14: null,
        reachedIn14: null,
        engagedIn14: null,
      } as GeoWindowPoint);
    const is14 = r.timeframe === "last_14_days";
    if (r.stage === "reached") {
      if (is14) {
        pt.reachedUs14 = r.usPct;
        pt.reachedIn14 = r.inPct;
      } else pt.reachedUs90 = r.usPct;
    } else if (r.stage === "engaged") {
      if (is14) {
        pt.engagedUs14 = r.usPct;
        pt.engagedIn14 = r.inPct;
      } else pt.engagedUs90 = r.usPct;
    }
    buckets.set(key, pt);
  }
  return [...buckets.values()];
}

// ── Auto-experiments ──────────────────────────────────────────────────────────
// Called by the snapshot worker. Two phases, both idempotent + non-throwing at
// the caller. Auto-experiments never fabricate a verdict — they only SUGGEST one
// when a reel demonstrably dominated its window's reach.

/**
 * For each reel that (a) has a Gemini profile, (b) was posted, and (c) doesn't
 * already have an auto-experiment, create one — stamping the reel's US-fit score,
 * its US cultural cues, and the baseline 14d engaged-US% at this moment.
 * Only reels posted recently qualify, so a baseline is meaningful (we never
 * backfill fake baselines onto old reels). Returns count created.
 */
export async function autoCreateExperimentsForNewReels(): Promise<number> {
  const cutoff = new Date(Date.now() - MEASURE_AFTER_DAYS * 24 * 3600 * 1000);
  const reels = await prisma.reelMeta.findMany({
    where: {
      postedAt: { gte: cutoff }, // recent enough that a baseline is honest
      contentProfile: { isNot: null }, // Gemini has scored it → "what changed" is known
    },
    include: { contentProfile: true },
  });
  if (reels.length === 0) return 0;

  const existing = await prisma.experiment.findMany({
    where: { origin: "auto", mediaId: { in: reels.map((r) => r.mediaId) } },
    select: { mediaId: true },
  });
  const have = new Set(existing.map((e) => e.mediaId));

  const baseline = await latestEngagedUsPct14d();
  let created = 0;
  for (const r of reels) {
    if (have.has(r.mediaId)) continue;
    const cues =
      ((r.contentProfile?.profile as { culturalReferences?: Array<{ text?: string; region?: string }> } | null)
        ?.culturalReferences ?? [])
        .filter((c) => c.region === "us" && c.text)
        .map((c) => c.text as string)
        .slice(0, 6);
    await prisma.experiment.create({
      data: {
        origin: "auto",
        mediaId: r.mediaId,
        hypothesis: `Does "${(r.caption ?? "").slice(0, 60)}" shift engaged-US%?`,
        variable: r.usFitScore != null ? `US-fit ${r.usFitScore}${cues.length ? `: ${cues.join(", ")}` : ""}` : "content",
        reelMediaIds: [r.mediaId],
        usFitScore: r.usFitScore,
        culturalCues: cues,
        baselineEngagedUsPct: baseline,
        baselineUsPct: await latestReachedUsPct(), // keep legacy field populated too
        postedAt: r.postedAt,
        status: "running",
      },
    });
    created++;
  }
  return created;
}

/**
 * For auto-experiments whose reel has now had ~14 days, measure the outcome:
 * compute the reel's share of its 14-day window's reach (attribution power),
 * re-read engaged-US%, and set a SUGGESTED verdict — but only mark high
 * confidence (and thus suggest confirmed/busted) if the reel dominated its
 * window. Otherwise: inconclusive, low confidence. Never flips status itself.
 * Returns count measured.
 */
export async function autoMeasureDueExperiments(): Promise<number> {
  const dueBefore = new Date(Date.now() - MEASURE_AFTER_DAYS * 24 * 3600 * 1000);
  const due = await prisma.experiment.findMany({
    where: { origin: "auto", measuredAt: null, postedAt: { lte: dueBefore }, mediaId: { not: null } },
  });
  if (due.length === 0) return 0;

  const measuredEngaged = await latestEngagedUsPct14d();
  let measured = 0;

  for (const exp of due) {
    if (!exp.mediaId || !exp.postedAt) continue;

    // This reel's reach vs the total reach of all reels live in its 14d window.
    const windowStart = exp.postedAt;
    const windowEnd = new Date(exp.postedAt.getTime() + MEASURE_AFTER_DAYS * 24 * 3600 * 1000);
    const windowReels = await prisma.reelMeta.findMany({
      where: { postedAt: { gte: windowStart, lte: windowEnd } },
      select: { mediaId: true, perfSnapshots: { orderBy: { capturedAt: "desc" }, take: 1, select: { reach: true } } },
    });
    const reachOf = (m: (typeof windowReels)[number]) => m.perfSnapshots[0]?.reach ?? 0;
    const totalReach = windowReels.reduce((s, m) => s + reachOf(m), 0);
    const thisReach = reachOf(windowReels.find((m) => m.mediaId === exp.mediaId) ?? ({} as never)) || 0;
    const share = totalReach > 0 ? thisReach / totalReach : null;

    const base = exp.baselineEngagedUsPct;
    const delta = base != null && measuredEngaged != null ? measuredEngaged - base : null;

    let suggestedVerdict: string;
    let confidence: "high" | "low";
    if (share != null && share >= DOMINANCE_THRESHOLD && delta != null) {
      // This reel owned the window → the US% move is fairly attributable to it.
      confidence = "high";
      suggestedVerdict = delta >= 0 ? "confirmed" : "busted";
    } else {
      confidence = "low";
      suggestedVerdict = "inconclusive"; // overlapping reels — can't isolate
    }

    await prisma.experiment.update({
      where: { id: exp.id },
      data: {
        measuredEngagedUsPct: measuredEngaged,
        windowReachShare: share,
        suggestedVerdict,
        attributionConfidence: confidence,
        measuredAt: new Date(),
      },
    });
    measured++;
  }
  return measured;
}
