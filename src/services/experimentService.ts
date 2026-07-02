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

function toDto(
  e: {
    id: string;
    hypothesis: string;
    variable: string;
    reelMediaIds: string[];
    status: string;
    baselineUsPct: number | null;
    measuredUsPct: number | null;
    startedAt: Date;
    postedAt: Date | null;
    conclusion: string | null;
  },
  currentUsPct: number | null,
): ExperimentDto {
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
