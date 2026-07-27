import type { FollowerDailyAddsPoint } from "./types";
import { formatSignedCount, type ChartRegion } from "./followerFlow";

// Content + hit-testing math for the chart's hover tooltip. Kept out of
// followerFlow.ts (already 470+ lines of rate/geometry math) so both files stay
// focused. Pure: no DOM, no React, no Date.now().

export interface TooltipRow {
  region: ChartRegion;
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

// Same order the bars stack in, so the tooltip reads top-to-bottom like the bar.
const REGION_ORDER: ChartRegion[] = ["us", "southAsian", "anglosphere", "other"];

const GAP_NOTES: Partial<Record<FollowerDailyAddsPoint["basis"], string>> = {
  pending: "Waiting for Meta to refresh",
  no_snapshot: "No snapshot captured",
  no_prior_day: "Series start — nothing to diff against",
  stale: "Absorbed into the next bar",
};

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
 */
export function tooltipModel(point: FollowerDailyAddsPoint): TooltipModel {
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
  for (const region of REGION_ORDER) {
    const value = point[region];
    if (value === null || value === 0) continue;
    rows.push({ region, value, valueLabel: formatSignedCount(value) });
  }

  const notes: string[] = [];
  // Spike first: it is the reason someone hovered this bar. The candidate reels
  // themselves are too wide for a 200px card, so they live in the panel below.
  if (point.spike) {
    notes.push(`${point.spike.multiple}× your usual day — candidates below`);
  }
  if (point.spanDays !== null && point.spanDays > 1) {
    notes.push("Meta did not refresh in between");
  }
  if (point.provisional) notes.push("Still settling — Meta may revise");
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
