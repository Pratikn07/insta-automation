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

/** Latest reached-US% (the metric experiments track). Null if no snapshot yet. */
async function latestReachedUsPct(): Promise<number | null> {
  const row = await prisma.geoDemographicSnapshot.findFirst({
    where: { stage: "reached" },
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

/** The reached-US% time series for the trend chart. Returns whatever exists (may be 1). */
export async function getUsReachTrend(): Promise<UsReachTrendPoint[]> {
  const rows = await prisma.geoDemographicSnapshot.findMany({
    where: { stage: "reached" },
    orderBy: { capturedAt: "asc" },
    select: { capturedAt: true, usPct: true },
  });
  return rows.map((r) => ({ capturedAt: r.capturedAt.toISOString(), usPct: r.usPct }));
}
