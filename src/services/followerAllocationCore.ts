import { regionOf, type FollowerRegion } from "./regionMap.js";
import type { FollowerDailyAddsPoint } from "./followerFlowCore.js";

// Pure core of the "exact total, estimated split" read model (no prisma/env
// imports, same testability split as followerFlowCore).
//
// THE PROBLEM THIS SOLVES
//
// followerFlowCore builds honest points out of follower_demographics alone, and
// honesty there means large holes: Meta refreshes that metric on its own
// schedule, so a skipped refresh produces `stale` days that draw nothing and one
// wide `multi_day_span` bar carrying the whole period. On top of that, the
// metric counts only followers Meta HAS demographic data for, inside its top ~45
// countries, so even a clean one-day diff under-reports real growth — and it
// under-reports it WORST during a spike, because followers arriving from small
// countries push those countries across the top-45 cutoff, where `diffAnchors`
// correctly refuses to guess and files them under `unattributed` (excluded from
// the bars entirely).
//
// WHAT WE DO ABOUT IT
//
// followers_count — the number on the profile — has none of those properties. It
// is live, it has no country cutoff, and it is exact. So:
//
//   totals  come from followers_count       → EXACT, one bar every single day
//   splits  come from follower_demographics → ESTIMATED, apportioned onto those
//                                             totals by the shape Meta reported
//
// Every point this module rewrites is flagged `estimated`, and the untouched
// demographic figure is preserved in `measuredTotal`, so the UI can always say
// which half of a bar is measurement and which is inference. Meta publishes no
// per-country-per-day follower data of any kind — this is the closest honest
// construction available, not a hidden upgrade to the source data.

export interface TotalAnchor {
  day: string;
  capturedAt: Date;
  followersTotal: number;
}

export interface ExactDay {
  netAdds: number;
  /** Calendar days this figure covers; >1 when a followers_count capture was missed. */
  spanDays: number;
}

export interface AllocatedDailyAddsPoint extends FollowerDailyAddsPoint {
  /** Net adds from followers_count. Null before this capture existed, or on gaps. */
  exactTotal: number | null;
  /** What follower_demographics alone reported here, before any apportioning. */
  measuredTotal: number | null;
  /** The split (and possibly the total) was inferred rather than measured on this day. */
  estimated: boolean;
}

const MEASURED_BASES = new Set(["diff", "multi_day_span"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function dayKeysBetween(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${toDay}T00:00:00Z`);
  for (let ms = Date.parse(`${fromDay}T00:00:00Z`); ms <= end; ms += DAY_MS) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

function calendarDaysBetween(fromDay: string, toDay: string): number {
  return Math.round(
    (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS,
  );
}

/**
 * Split `total` into integers proportional to `weights`, summing EXACTLY to it.
 *
 * Largest-remainder (Hamilton) apportionment, not plain rounding: three days
 * sharing +1 would each round to 0 and the follower would vanish from the chart.
 * Flooring and then handing the leftover units to the biggest fractional
 * remainders keeps the column total intact whatever the weights look like.
 *
 * All-zero or unusable weights fall back to an even split — the days covered by
 * one diff are equally likely a priori, and the alternative (dumping everything
 * on day one) would invent a spike.
 */
export function apportion(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(Math.trunc(total));

  const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const weightSum = safe.reduce((s, w) => s + w, 0);
  const basis = weightSum > 0 ? safe : new Array<number>(n).fill(1);
  const basisSum = weightSum > 0 ? weightSum : n;

  const exact = basis.map((w) => (magnitude * w) / basisSum);
  const out = exact.map((v) => Math.floor(v));
  let remaining = magnitude - out.reduce((s, v) => s + v, 0);

  const byRemainder = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of byRemainder) {
    if (remaining <= 0) break;
    out[i] = out[i]! + 1;
    remaining--;
  }
  return out.map((v) => v * sign);
}

/**
 * Exact net adds per calendar day from consecutive followers_count anchors.
 *
 * A missed capture spreads its diff evenly over the days it covers rather than
 * landing it all on the day we happened to reconnect. Unlike the demographic
 * path this is rare and short: we control this fetch, and followers_count is
 * never "stale" — it always reports the live number.
 */
export function exactNetAddsByDay(anchors: TotalAnchor[]): Map<string, ExactDay> {
  const out = new Map<string, ExactDay>();
  const ordered = [...anchors].sort((a, b) => a.day.localeCompare(b.day));

  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    const spanDays = calendarDaysBetween(prev.day, cur.day);
    if (spanDays < 1) continue;
    const netAdds = cur.followersTotal - prev.followersTotal;
    const days = dayKeysBetween(prev.day, cur.day).slice(1); // exclude the prior anchor's own day
    const shares = apportion(netAdds, new Array<number>(days.length).fill(1));
    days.forEach((day, idx) => {
      out.set(day, { netAdds: shares[idx]!, spanDays });
    });
  }
  return out;
}

/**
 * Extend the day axis forward to `throughDay` with unmeasured placeholders.
 *
 * buildDailyPoints stops at the newest DEMOGRAPHIC anchor, which is routinely a
 * day or two behind the account because of Meta's ~48h demographics lag.
 * followers_count has no such lag, so without this padding the chart would keep
 * omitting exactly the days the owner most wants to see — today and yesterday.
 * The placeholders carry no measurements; allocateDailyPoints fills them from
 * the exact totals if it can, and they render as ordinary gaps if it cannot.
 */
export function padPointsThrough(
  points: FollowerDailyAddsPoint[],
  throughDay: string,
): FollowerDailyAddsPoint[] {
  if (points.length === 0) return points;
  const lastDay = points[points.length - 1]!.day;
  if (calendarDaysBetween(lastDay, throughDay) <= 0) return points;

  const padded = [...points];
  for (const day of dayKeysBetween(lastDay, throughDay).slice(1)) {
    padded.push({
      day,
      capturedAt: null,
      us: null,
      southAsian: null,
      anglosphere: null,
      other: null,
      total: null,
      unattributed: null,
      byCountry: null,
      reportedTotalDelta: null,
      spanDays: null,
      stale: false,
      provisional: false,
      basis: "no_snapshot",
    });
  }
  return padded;
}

/** Country deltas → the four region buckets the panel stacks. */
function rollUpRegions(byCountry: Record<string, number>): Record<FollowerRegion, number> {
  const sums: Record<FollowerRegion, number> = { us: 0, southAsian: 0, anglosphere: 0, other: 0 };
  for (const [country, delta] of Object.entries(byCountry)) {
    sums[regionOf(country)] += delta;
  }
  return sums;
}

function sumOf(byCountry: Record<string, number>): number {
  return Object.values(byCountry).reduce((s, v) => s + v, 0);
}

/**
 * Grow a measured country vector until it sums to the exact net adds.
 *
 * ONLY the gaining countries are rescaled. The shortfall we are closing is
 * unplaced FOLLOWS — followers below Meta's country cutoff, or with no
 * demographic data at all — so spreading it over countries that Meta says LOST
 * followers would invent losses that were never reported. Negatives pass through
 * exactly as measured and the gainers absorb the whole residual.
 *
 * Returns null when the arithmetic cannot be done honestly (nothing gained, or a
 * target the gainers cannot reach); the caller then keeps Meta's figure as-is.
 */
export function rescaleToExact(
  byCountry: Record<string, number>,
  exactTotal: number,
): Record<string, number> | null {
  const gainers = Object.entries(byCountry).filter(([, v]) => v > 0);
  const losers = Object.entries(byCountry).filter(([, v]) => v < 0);
  const gained = gainers.reduce((s, [, v]) => s + v, 0);
  const lost = losers.reduce((s, [, v]) => s + v, 0); // negative

  if (gained <= 0) return null;
  const targetForGainers = exactTotal - lost;
  if (targetForGainers <= 0) return null;

  const shares = apportion(
    targetForGainers,
    gainers.map(([, v]) => v),
  );
  const out: Record<string, number> = {};
  gainers.forEach(([code], i) => {
    out[code] = shares[i]!;
  });
  for (const [code, v] of losers) out[code] = v;
  return out;
}

/** Country shares of a measured diff, used to give an uncovered day a shape. */
function sharesOf(byCountry: Record<string, number>): Record<string, number> | null {
  const gained = Object.entries(byCountry).filter(([, v]) => v > 0);
  const total = gained.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) return null;
  return Object.fromEntries(gained.map(([code, v]) => [code, v / total]));
}

function withSplit(
  point: FollowerDailyAddsPoint,
  byCountry: Record<string, number>,
  extras: { exactTotal: number | null; measuredTotal: number | null; estimated: boolean; spanDays: number },
): AllocatedDailyAddsPoint {
  const regions = rollUpRegions(byCountry);
  return {
    ...point,
    ...regions,
    total: sumOf(byCountry),
    byCountry,
    // The rank-churn residual has been folded into the countries themselves by
    // the rescale, so leaving the old value here would double-count it in the
    // panel's "N more Meta counted but couldn't place" line.
    unattributed: extras.estimated ? 0 : point.unattributed,
    spanDays: extras.spanDays,
    stale: false,
    basis: "diff",
    exactTotal: extras.exactTotal,
    measuredTotal: extras.measuredTotal,
    estimated: extras.estimated,
  };
}

/**
 * Rewrite demographic points into one exact-total point per calendar day.
 *
 * Three kinds of day come out of this:
 *
 *   1. Meta measured the day cleanly and we know the exact total → the country
 *      shape is Meta's, rescaled up to the true total. `estimated` is true
 *      because the scale factor is inferred, but the shape is measured.
 *   2. Meta's diff covered several days → that diff is apportioned across them,
 *      weighted by how much the account ACTUALLY grew on each (which we know
 *      exactly), then each day is rescaled as in 1. This is what replaces the
 *      wide catch-up bar with real daily bars.
 *   3. Meta has not reported the day at all — most often the newest day or two,
 *      still inside its ~48h lag → the exact total is shown with the most recent
 *      measured country shape applied to it. Without this, today's growth is
 *      simply missing from the chart until Meta catches up.
 *
 * Days with no exact total (before this capture existed) pass through untouched,
 * so historical bars keep reading exactly as they always have.
 */
export function allocateDailyPoints(
  points: FollowerDailyAddsPoint[],
  exactByDay: Map<string, ExactDay>,
): AllocatedDailyAddsPoint[] {
  // 1. Spread every measured demographic diff over the days it covers, weighted
  //    by each day's true growth.
  const placed = new Map<string, Record<string, number>>();
  const measuredOn = new Map<string, number>();

  for (const point of points) {
    if (!MEASURED_BASES.has(point.basis) || !point.byCountry || point.spanDays === null) continue;
    const covered = dayKeysBetween(
      new Date(Date.parse(`${point.day}T00:00:00Z`) - (point.spanDays - 1) * DAY_MS)
        .toISOString()
        .slice(0, 10),
      point.day,
    );
    measuredOn.set(point.day, point.total ?? sumOf(point.byCountry));

    if (covered.length === 1) {
      placed.set(point.day, { ...point.byCountry });
      continue;
    }
    const weights = covered.map((day) => Math.max(exactByDay.get(day)?.netAdds ?? 0, 0));
    for (const [country, delta] of Object.entries(point.byCountry)) {
      const shares = apportion(delta, weights);
      covered.forEach((day, i) => {
        const bucket = placed.get(day) ?? {};
        if (shares[i] !== 0) bucket[country] = (bucket[country] ?? 0) + shares[i]!;
        placed.set(day, bucket);
      });
    }
  }

  // 2. Walk the calendar, rescaling each day onto its exact total. `lastShape`
  //    trails behind so a day Meta never reported can still be given a shape.
  let lastShape: Record<string, number> | null = null;
  const out: AllocatedDailyAddsPoint[] = [];

  for (const point of points) {
    const exact = exactByDay.get(point.day) ?? null;
    const dayPlaced = placed.get(point.day) ?? null;
    const measuredTotal = measuredOn.get(point.day) ?? null;

    if (dayPlaced && Object.keys(dayPlaced).length > 0) {
      const shape = sharesOf(dayPlaced);
      if (shape) lastShape = shape;
    }

    // No exact total for this day: nothing to anchor to, so leave the honest
    // demographic point exactly as followerFlowCore built it.
    if (!exact) {
      out.push({ ...point, exactTotal: null, measuredTotal, estimated: false });
      continue;
    }

    if (dayPlaced && Object.keys(dayPlaced).length > 0) {
      const rescaled = rescaleToExact(dayPlaced, exact.netAdds);
      if (rescaled) {
        out.push(
          withSplit(point, rescaled, {
            exactTotal: exact.netAdds,
            measuredTotal,
            estimated: true,
            spanDays: 1,
          }),
        );
        continue;
      }
      // Could not reach the exact total by growing the gainers (a shrinking day,
      // or one Meta reported as all-losses). Keep the measurement rather than
      // torture it into shape; the exact figure still rides along for the tooltip.
      out.push(
        withSplit(point, dayPlaced, {
          exactTotal: exact.netAdds,
          measuredTotal,
          estimated: true,
          spanDays: 1,
        }),
      );
      continue;
    }

    // Meta never reported this day. Borrow the most recent measured shape.
    if (lastShape && exact.netAdds > 0) {
      const codes = Object.keys(lastShape);
      const shares = apportion(
        exact.netAdds,
        codes.map((c) => lastShape![c]!),
      );
      const byCountry: Record<string, number> = {};
      codes.forEach((code, i) => {
        if (shares[i] !== 0) byCountry[code] = shares[i]!;
      });
      out.push(
        withSplit(point, byCountry, {
          exactTotal: exact.netAdds,
          measuredTotal: null,
          estimated: true,
          spanDays: 1,
        }),
      );
      continue;
    }

    // We know the total but have no shape to give it — report the total and
    // leave the split null rather than inventing a geography for it.
    out.push({
      ...point,
      total: exact.netAdds,
      us: null,
      southAsian: null,
      anglosphere: null,
      other: null,
      byCountry: null,
      spanDays: 1,
      stale: false,
      basis: "diff",
      exactTotal: exact.netAdds,
      measuredTotal,
      estimated: true,
    });
  }

  return out;
}
