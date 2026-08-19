import type { FollowerDailyAddsPoint } from "./types";
import { formatSignedCount, type ChartRegion } from "./followerFlow";

// Content + hit-testing math for the chart's hover tooltip. Kept out of
// followerFlow.ts (already 470+ lines of rate/geometry math) so both files stay
// focused. Pure: no DOM, no React, no Date.now().

export interface TooltipRow {
  // Region name in region mode, ISO country code in country mode.
  key: string;
  value: number;
  valueLabel: string;
}

export interface TooltipModel {
  heading: string;
  totalLabel: string | null;
  rows: TooltipRow[];
  notes: string[];
  emptyLabel: string | null;
}

/**
 * Which spike days the candidates panel actually renders, newest first.
 *
 * Shared with SpikeCandidates so the tooltip can only ever say "candidates
 * below" about a day that IS below. Browser-verified the alternative: with the
 * panel capped at two spikes, all four spike tooltips still advertised
 * candidates, and hovering Jul 11 or Jul 15 pointed at nothing.
 *
 * Two, because four spike cards rendered ~1800px of text under the chart. Enough
 * to compare a recent event against the one before it.
 */
export const MAX_SPIKES_SHOWN = 2;

export function shownSpikeDays(points: FollowerDailyAddsPoint[]): string[] {
  return points
    .filter((p) => p.spike)
    .map((p) => p.day)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, MAX_SPIKES_SHOWN);
}

// Same order the bars stack in, so the tooltip reads top-to-bottom like the bar.
const REGION_ORDER: ChartRegion[] = ["us", "southAsian", "anglosphere", "other"];

/**
 * How to read the hovered point's rows: the four regions by default, or an
 * explicit country stack. Mirrors StackSpec in followerFlow.ts so the tooltip
 * and the bars can never disagree about what a segment is.
 */
export interface TooltipStack {
  keys: string[];
  valueOf: (point: FollowerDailyAddsPoint, key: string) => number;
}

const REGION_TOOLTIP_STACK: TooltipStack = {
  keys: REGION_ORDER,
  valueOf: (p, key) => p[key as ChartRegion] ?? 0,
};

const GAP_NOTES: Partial<Record<FollowerDailyAddsPoint["basis"], string>> = {
  pending: "Waiting for Meta to refresh",
  no_snapshot: "No snapshot captured",
  no_prior_day: "Series start — nothing to diff against",
  stale: "Absorbed into the next bar",
};

// This is an abstract Pacific day key; UTC formatting prevents browser date shifting.
function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

function shiftDay(day: string, byDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + byDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * "Jul 20–21" within one month, "Jul 31–Aug 1" across a boundary. Repeating the
 * month on both sides of the dash reads as clutter when it is the same month.
 */
function rangeLabel(fromDay: string, toDay: string): string {
  const from = dayLabel(fromDay);
  const to = dayLabel(toDay);
  const sameMonth = fromDay.slice(0, 7) === toDay.slice(0, 7);
  return sameMonth ? `${from}–${to.split(" ").pop()}` : `${from}–${to}`;
}

/**
 * Display-ready content for one hovered point.
 *
 * Zero-value regions are dropped (a column of zeros is noise), but a measured
 * day where everything nets to zero gets an explicit "No net change" rather than
 * an empty card. The notes carry the caveats that explain odd-looking bars —
 * without them a 2-day combined bar reads as a real spike.
 *
 * `panelDays` is the set of spike days the candidates panel renders (from
 * shownSpikeDays). A spike day outside it still says it was unusual — that is
 * true and worth knowing — but drops the pointer to candidates that aren't there.
 */
export function tooltipModel(
  point: FollowerDailyAddsPoint,
  panelDays: readonly string[] = [],
  stack: TooltipStack = REGION_TOOLTIP_STACK,
): TooltipModel {
  const heading =
    point.spanDays !== null && point.spanDays > 1
      ? rangeLabel(shiftDay(point.day, -(point.spanDays - 1)), point.day)
      : dayLabel(point.day);

  const gapNote = GAP_NOTES[point.basis];
  if (gapNote || point.total === null) {
    return {
      heading,
      totalLabel: null,
      rows: [],
      notes: [gapNote ?? "No measurement for this day"],
      emptyLabel: null,
    };
  }

  const rows: TooltipRow[] = [];
  for (const key of stack.keys) {
    const value = stack.valueOf(point, key);
    if (value === 0) continue;
    rows.push({ key, value, valueLabel: formatSignedCount(value) });
  }

  const notes: string[] = [];
  // Spike first: it is the reason someone hovered this bar. The candidate reels
  // themselves are too wide for a 200px card, so they live in the panel below.
  if (point.spike) {
    const hasPanelCard = panelDays.includes(point.day);
    notes.push(
      `${point.spike.multiple}× your usual day${hasPanelCard ? " — candidates below" : ""}`,
    );
  }
  if (point.spanDays !== null && point.spanDays > 1) {
    notes.push("Meta did not refresh in between");
  }
  if (point.provisional) notes.push("Still settling — Meta may revise");
  // Meta publishes no per-country-per-day follower data, so a split is always
  // inferred from its cumulative demographics. Say so on the bar rather than in
  // a legend nobody reads while hovering: the TOTAL here is exact, the country
  // rows underneath it are the best available estimate.
  if (point.estimated) notes.push("Total exact — country split estimated");
  // The net bar hides the churn behind it: +20 from 400 follows and 380
  // unfollows is a completely different day from +20 from 20 follows, and only
  // follows_and_unfollows can tell them apart. Both sides are required — one
  // alone would render as "0 unfollowed", which reads as a fact rather than as
  // a figure Meta withheld.
  const { follows, unfollows } = point;
  if (typeof follows === "number" && typeof unfollows === "number") {
    notes.push(`${follows} followed, ${unfollows} unfollowed`);
  }
  if (point.unattributed) {
    notes.push(`${formatSignedCount(point.unattributed)} unplaced (top-country cutoff)`);
  }

  return {
    heading,
    totalLabel: `${formatSignedCount(point.total)} net`,
    rows,
    notes,
    emptyLabel: rows.length === 0 ? "No net change" : null,
  };
}

// Matches chartGeometry's own inset.
const INSET = 8;

/** The subset of a ChartBar that hit-testing needs. */
export interface HitTarget {
  day: string;
  x: number;
  width: number;
}

/**
 * Which drawn bar the cursor is nearest, as its `day`, or null outside the plot.
 *
 * Hit-tests against the RENDERED bars rather than computing a slot index,
 * because the two do not correspond one-to-one: chartGeometry gives a span-2
 * catch-up bar two slots wide and draws nothing at all for the stale day it
 * absorbed. Index arithmetic therefore resolved the left half of every span bar
 * to a day with no bar — the span bar's own tooltip was unreachable. Verified in
 * a browser: hovering the wide bar reported the stale gap day instead.
 *
 * The svg is a fixed viewBox scaled by css width, so screen pixels are converted
 * to viewBox units first; comparing raw client x to svg coordinates drifts
 * further off the further right you hover.
 */
export function hitTestDay(
  offsetX: number,
  containerWidth: number,
  viewBoxWidth: number,
  bars: HitTarget[],
): string | null {
  if (containerWidth <= 0 || bars.length === 0) return null;

  const svgX = (offsetX / containerWidth) * viewBoxWidth;
  if (svgX < INSET || svgX > viewBoxWidth - INSET) return null;

  // Inside a bar wins outright; otherwise fall to the nearest bar center so the
  // gaps between bars stay hoverable instead of being dead zones.
  let nearest: { day: string; distance: number } | null = null;
  for (const bar of bars) {
    if (svgX >= bar.x && svgX <= bar.x + bar.width) return bar.day;
    const center = bar.x + bar.width / 2;
    const distance = Math.abs(svgX - center);
    if (!nearest || distance < nearest.distance) nearest = { day: bar.day, distance };
  }
  return nearest?.day ?? null;
}
