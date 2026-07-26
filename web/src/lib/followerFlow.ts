import type { FollowerDailyAddsPoint, FollowerStock } from "./types";

// Pure math for the FollowerFlowPanel. Every function takes its inputs
// explicitly (no Date.now()) so this file stays testable like homeDashboard.
//
// The core rule inherited from the backend: a multi-day-span point carries the
// adds of the gap days it absorbed, so every rate divides by Σ spanDays (days
// actually covered), never by the number of points.

export type FlowTrend = "accelerating" | "steady" | "slowing";

const MEASURED_BASES = new Set(["diff", "multi_day_span"]);

function isMeasured(p: FollowerDailyAddsPoint): boolean {
  return MEASURED_BASES.has(p.basis) && p.total !== null && p.spanDays !== null;
}

function round(value: number, precision = 1): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function lastNDays(points: FollowerDailyAddsPoint[], windowDays: number): FollowerDailyAddsPoint[] {
  return windowDays >= points.length ? points : points.slice(points.length - windowDays);
}

export interface RatePerDayOptions {
  windowDays: number;
  includeProvisional: boolean;
}

/**
 * Net adds per covered day over the trailing window. A span-2 catch-up point
 * contributes its full total AND its 2 days to the denominator — so a stale day
 * followed by +168 reads as 84/day, not 168/day. Null when the window covers
 * zero measured days.
 */
export function ratePerDay(
  points: FollowerDailyAddsPoint[],
  { windowDays, includeProvisional }: RatePerDayOptions,
): number | null {
  let total = 0;
  let coveredDays = 0;
  for (const p of lastNDays(points, windowDays)) {
    if (!isMeasured(p)) continue;
    if (!includeProvisional && p.provisional) continue;
    total += p.total!;
    coveredDays += p.spanDays!;
  }
  return coveredDays > 0 ? round(total / coveredDays) : null;
}

export interface RegionWindowSums {
  us: number;
  southAsian: number;
  anglosphere: number;
  other: number;
  total: number;
  // Net followers Meta reported but that couldn't be pinned to a region, as
  // countries crossed its top-N reporting cutoff. total + unattributed reconciles
  // to Meta's reported delta; the four regions alone do NOT.
  unattributed: number;
  coveredDays: number;
  // How many of coveredDays Meta may still revise. The rate counts them; the UI
  // discloses them rather than silently narrowing the window.
  provisionalDays: number;
  usSharePct: number | null; // of attributed total, only when total > 0
  southAsianSharePct: number | null;
}

export function sumRegions(
  points: FollowerDailyAddsPoint[],
  windowDays: number,
): RegionWindowSums {
  const sums = { us: 0, southAsian: 0, anglosphere: 0, other: 0, total: 0, unattributed: 0, coveredDays: 0, provisionalDays: 0 };
  for (const p of lastNDays(points, windowDays)) {
    if (!isMeasured(p)) continue;
    sums.us += p.us ?? 0;
    sums.southAsian += p.southAsian ?? 0;
    sums.anglosphere += p.anglosphere ?? 0;
    sums.other += p.other ?? 0;
    sums.total += p.total!;
    sums.unattributed += p.unattributed ?? 0;
    sums.coveredDays += p.spanDays!;
    if (p.provisional) sums.provisionalDays += p.spanDays!;
  }
  return {
    ...sums,
    usSharePct: sums.total > 0 ? round((sums.us / sums.total) * 100, 0) : null,
    southAsianSharePct: sums.total > 0 ? round((sums.southAsian / sums.total) * 100, 0) : null,
  };
}

export interface BestDay {
  day: string;
  total: number;
  spanDays: number;
  perDay: number;
}

export interface FollowerFlowSummary {
  avgPerDay7: number | null;
  avgPerDay28: number | null;
  trend: FlowTrend;
  bestDay: BestDay | null;
  latestMeasuredDay: string | null;
  measuredDays: number;
  staleDays: number;
  window7: RegionWindowSums;
}

const TREND_RATIO = 0.15;

/**
 * Headline numbers for the panel. Provisional points ARE counted: they're a
 * real part of the window, sumRegions already includes them, and excluding them
 * only from the averages made the panel contradict itself on screen — a 5-day
 * rate printed beside a 7-day region legend and a 7-day US-share tile. It also
 * bent the trend badge, since dropping the 2 newest days removes ~29% of the
 * 7-day window but only ~7% of the 28-day baseline. The panel label and the
 * dashed newest bars carry the "still settling" caveat instead. Null with fewer
 * than 2 measured points — nothing honest to say yet.
 */
export function summarizeFollowerFlow(
  points: FollowerDailyAddsPoint[],
): FollowerFlowSummary | null {
  const measured = points.filter(isMeasured);
  if (measured.length < 2) return null;

  const avgPerDay7 = ratePerDay(points, { windowDays: 7, includeProvisional: true });
  const avgPerDay28 = ratePerDay(points, { windowDays: 28, includeProvisional: true });

  let trend: FlowTrend = "steady";
  if (avgPerDay7 !== null && avgPerDay28 !== null) {
    const band = Math.max(Math.abs(avgPerDay28) * TREND_RATIO, 1);
    if (avgPerDay7 - avgPerDay28 >= band) trend = "accelerating";
    else if (avgPerDay7 - avgPerDay28 <= -band) trend = "slowing";
  }

  // Rank by per-day rate so a 2-day catch-up bar can't beat a genuinely bigger
  // single day.
  let bestDay: BestDay | null = null;
  for (const p of measured) {
    const perDay = p.total! / p.spanDays!;
    if (!bestDay || perDay > bestDay.perDay) {
      bestDay = { day: p.day, total: p.total!, spanDays: p.spanDays!, perDay: round(perDay) };
    }
  }

  return {
    avgPerDay7,
    avgPerDay28,
    trend,
    bestDay,
    latestMeasuredDay: measured[measured.length - 1]?.day ?? null,
    measuredDays: measured.length,
    staleDays: points.filter((p) => p.basis === "stale" || p.basis === "pending").length,
    window7: sumRegions(points, 7),
  };
}

export interface UsWeekOverWeek {
  thisWeek: number;
  lastWeek: number | null;
  deltaCount: number | null;
  trend: FlowTrend;
  coveredDays: number;
  provisionalDays: number;
}

const WEEK_DAYS = 7;

/**
 * Net US followers gained this week against last week, in real counts.
 *
 * Answers "is my US audience growing?" without percentage-point arithmetic.
 * Both windows reuse sumRegions, so this tile and the region legend under the
 * chart are computed identically and can never disagree on screen.
 *
 * Provisional (still-settling) days are counted, matching
 * summarizeFollowerFlow's includeProvisional: true — excluding them would make
 * this tile contradict the legend beside it, and would bend the trend by
 * stripping a larger share of the newer window than the older one. The count
 * is surfaced as provisionalDays so the UI can disclose it instead.
 *
 * lastWeek is null (and trend "steady") until the prior window covers a full
 * 7 days — a partial prior window makes the comparison misleading, so we
 * withhold it rather than print a number that reads as a real decline.
 */
export function summarizeUsWeekOverWeek(
  points: FollowerDailyAddsPoint[],
): UsWeekOverWeek | null {
  const current = sumRegions(points, WEEK_DAYS);
  if (current.coveredDays === 0) return null;

  // Slice off the current window by point count (sumRegions windows by points),
  // then measure the 7 points before it.
  const priorPoints = points.slice(0, Math.max(points.length - WEEK_DAYS, 0));
  const prior = sumRegions(priorPoints, WEEK_DAYS);
  const lastWeek = prior.coveredDays >= WEEK_DAYS ? prior.us : null;

  let trend: FlowTrend = "steady";
  if (lastWeek !== null) {
    const band = Math.max(Math.abs(lastWeek) * TREND_RATIO, 1);
    if (current.us - lastWeek >= band) trend = "accelerating";
    else if (current.us - lastWeek <= -band) trend = "slowing";
  }

  return {
    thisWeek: current.us,
    lastWeek,
    deltaCount: lastWeek === null ? null : round(current.us - lastWeek, 0),
    trend,
    coveredDays: current.coveredDays,
    provisionalDays: current.provisionalDays,
  };
}

// U+2212 minus, matching formatAudienceDelta.
export function formatSignedCount(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return "0";
}

export interface StockVsFlow {
  stockLabel: string;
  flowLabel: string;
  nextMilestone: number;
  daysToNextMilestone: number | null; // null when flow is zero/negative/unknown
  sentence: string | null;
}

export function describeStockVsFlow(
  stock: FollowerStock,
  avgPerDay7: number | null,
): StockVsFlow {
  const nextMilestone = (Math.floor(stock.totalCounted / 1000) + 1) * 1000;
  const daysToNextMilestone =
    avgPerDay7 !== null && avgPerDay7 > 0
      ? Math.ceil((nextMilestone - stock.totalCounted) / avgPerDay7)
      : null;
  return {
    stockLabel: stock.totalCounted.toLocaleString("en-US"),
    flowLabel: avgPerDay7 === null ? "—" : `${formatSignedCount(round(avgPerDay7, 0))} a day`,
    nextMilestone,
    daysToNextMilestone,
    sentence:
      daysToNextMilestone === null
        ? null
        : `At this pace, about ${daysToNextMilestone} days to ${nextMilestone.toLocaleString("en-US")}.`,
  };
}

// ── Chart geometry ───────────────────────────────────────────────────────────
// All coordinates precomputed here so the SVG component stays a dumb renderer
// and the numbers are assertable with renderToStaticMarkup substring checks.

export type ChartRegion = "us" | "southAsian" | "anglosphere" | "other";
const STACK_ORDER: ChartRegion[] = ["us", "southAsian", "anglosphere", "other"];

export interface ChartSegment {
  region: ChartRegion;
  y: number;
  height: number;
}

export interface ChartBar {
  day: string;
  endDay: string; // == day for single-day bars
  x: number;
  width: number;
  slots: number; // spanDays for measured bars, 1 for ghosts
  segments: ChartSegment[]; // empty for ghost bars
  ghost: boolean; // no_snapshot / no_prior_day / pending — unknown, not zero
  provisional: boolean;
  basis: FollowerDailyAddsPoint["basis"];
  total: number | null;
  unattributed: number | null; // rank-churn residual for this bar, for the tooltip
}

export interface MeanLinePoint {
  x: number;
  y: number;
  value: number;
}

export interface ChartGeometry {
  bars: ChartBar[];
  meanLine: MeanLinePoint[];
  yMin: number;
  yMax: number;
  zeroY: number;
  width: number;
  height: number;
}

const INSET = 8;
const BAR_FILL = 0.72; // fraction of the slot a bar occupies
const MEAN_WINDOW = 7;

/**
 * Stacked signed bars, one slot per calendar day. Positives stack up from the
 * zero line in STACK_ORDER, negatives stack down — a mixed-sign day never
 * overlaps. A span-N bar occupies its own slot plus the N-1 gap slots it
 * absorbed. Stale days draw nothing (their adds live in the spanning bar).
 */
export function chartGeometry(
  points: FollowerDailyAddsPoint[],
  width = 720,
  height = 220,
): ChartGeometry {
  const slots = Math.max(points.length, 1);
  const slotWidth = (width - INSET * 2) / slots;
  const indexByDay = new Map(points.map((p, i) => [p.day, i]));

  // Y domain always includes zero so negatives have somewhere to go.
  let yMax = 0;
  let yMin = 0;
  for (const p of points) {
    if (!isMeasured(p)) continue;
    let up = 0;
    let down = 0;
    for (const region of STACK_ORDER) {
      const v = p[region] ?? 0;
      if (v > 0) up += v;
      else down += v;
    }
    yMax = Math.max(yMax, up);
    yMin = Math.min(yMin, down);
  }
  const spread = Math.max(yMax - yMin, 1);
  const plotHeight = height - INSET * 2;
  const yOf = (value: number) => round(INSET + ((yMax - value) / spread) * plotHeight);
  const zeroY = yOf(0);

  const bars: ChartBar[] = [];
  for (const p of points) {
    const i = indexByDay.get(p.day)!;

    if (isMeasured(p)) {
      const span = p.spanDays!;
      const startSlot = Math.max(i - (span - 1), 0);
      const x = round(INSET + startSlot * slotWidth + (slotWidth * (1 - BAR_FILL)) / 2);
      const barWidth = round(slotWidth * (i - startSlot) + slotWidth * BAR_FILL);

      let upCursor = 0;
      let downCursor = 0;
      const segments: ChartSegment[] = [];
      for (const region of STACK_ORDER) {
        const v = p[region] ?? 0;
        if (v === 0) continue;
        if (v > 0) {
          segments.push({ region, y: yOf(upCursor + v), height: round((v / spread) * plotHeight) });
          upCursor += v;
        } else {
          segments.push({ region, y: yOf(downCursor), height: round((-v / spread) * plotHeight) });
          downCursor += v;
        }
      }

      bars.push({
        day: p.day,
        endDay: p.day,
        x,
        width: barWidth,
        slots: span,
        segments,
        ghost: false,
        provisional: p.provisional,
        basis: p.basis,
        total: p.total,
        unattributed: p.unattributed,
      });
      continue;
    }

    // Stale days vanish (absorbed later); the rest get a ghost column.
    if (p.basis === "stale") continue;
    bars.push({
      day: p.day,
      endDay: p.day,
      x: round(INSET + i * slotWidth + (slotWidth * (1 - BAR_FILL)) / 2),
      width: round(slotWidth * BAR_FILL),
      slots: 1,
      segments: [],
      ghost: true,
      provisional: false,
      basis: p.basis,
      total: null,
      unattributed: null,
    });
  }

  // Trailing 7-day mean of the per-day rate, spreading span totals evenly over
  // the days they cover. The stable read against snapshot phase jitter.
  const perDayRate: Array<number | null> = points.map(() => null);
  for (const p of points) {
    if (!isMeasured(p)) continue;
    const i = indexByDay.get(p.day)!;
    const rate = p.total! / p.spanDays!;
    for (let back = 0; back < p.spanDays!; back++) {
      const idx = i - back;
      if (idx >= 0) perDayRate[idx] = rate;
    }
  }
  const meanLine: MeanLinePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const window = perDayRate.slice(Math.max(0, i - MEAN_WINDOW + 1), i + 1).filter(
      (v): v is number => v !== null,
    );
    if (window.length < 2) continue;
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    meanLine.push({
      x: round(INSET + i * slotWidth + slotWidth / 2),
      y: yOf(mean),
      value: round(mean),
    });
  }

  return { bars, meanLine, yMin, yMax, zeroY, width, height };
}
