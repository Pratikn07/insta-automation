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

/**
 * Which slot the cursor is over, or null when it is outside the plot.
 *
 * The svg is a fixed viewBox scaled by css width, so screen pixels must be
 * converted to viewBox units before comparing against slot boundaries —
 * skipping that conversion picks a bar further and further off as you move
 * right.
 */
export function slotFromOffset(
  offsetX: number,
  containerWidth: number,
  viewBoxWidth: number,
  gutterLeft: number,
  slotCount: number,
): number | null {
  if (containerWidth <= 0 || slotCount <= 0) return null;

  const svgX = (offsetX / containerWidth) * viewBoxWidth;
  const plotLeft = INSET + gutterLeft;
  const plotRight = viewBoxWidth - INSET;
  if (svgX < plotLeft) return null;

  const slotWidth = (plotRight - plotLeft) / slotCount;
  if (slotWidth <= 0) return null;

  const index = Math.floor((svgX - plotLeft) / slotWidth);
  return Math.max(0, Math.min(index, slotCount - 1));
}
