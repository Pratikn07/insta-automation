import type { FollowerDailyAddsPoint } from "./types";

// Day-range math for the Follower Flow filters. Pure: no Date.now(), no locale,
// no timezone. Same discipline as followerFlow.ts.
//
// Every value here is an ABSTRACT Pacific analytics day key ("2026-08-09"), not
// an instant. All arithmetic goes through UTC-parsed midnights so a browser in
// any timezone — and either side of a DST transition — gets identical answers.
// Constructing `new Date("2026-08-09")` in local time and adding 86.4e6 ms
// silently repeats or skips a day across a DST boundary.

export interface DayRange {
  from: string; // inclusive
  to: string; // inclusive
}

export type RangePreset = "7d" | "14d" | "30d" | "all";

export const RANGE_PRESETS: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "14d", label: "14d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

const DAY_MS = 86_400_000;

const PRESET_DAYS: Record<Exclude<RangePreset, "all">, number> = {
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

export function shiftDay(day: string, byDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + byDays * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive day count: from === to is 1 day, not 0. */
export function rangeLengthDays(range: DayRange): number {
  const ms = Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`);
  return Math.round(ms / DAY_MS) + 1;
}

/** The full span the data actually covers — what every range is clamped to. */
export function coverageOf(points: FollowerDailyAddsPoint[]): DayRange | null {
  if (points.length === 0) return null;
  return { from: points[0]!.day, to: points[points.length - 1]!.day };
}

export function clampRange(range: DayRange, coverage: DayRange): DayRange {
  // Normalise first: a reversed range would otherwise clamp into an empty one,
  // and the calendar can produce one mid-drag before the second click lands.
  const from = range.from <= range.to ? range.from : range.to;
  const to = range.from <= range.to ? range.to : range.from;
  return {
    from: from < coverage.from ? coverage.from : from,
    to: to > coverage.to ? coverage.to : to,
  };
}

/**
 * A preset resolved against real coverage, counting back INCLUSIVELY from the
 * newest covered day: "7d" ending Aug 9 is Aug 3–Aug 9, seven days.
 *
 * Clamped, so asking for 30 days of a 9-day account yields the 9 days that
 * exist rather than a window mostly outside the data.
 */
export function resolvePreset(preset: RangePreset, coverage: DayRange | null): DayRange | null {
  if (!coverage) return null;
  if (preset === "all") return { ...coverage };
  return clampRange(
    { from: shiftDay(coverage.to, -(PRESET_DAYS[preset] - 1)), to: coverage.to },
    coverage,
  );
}

export function filterPointsToRange(
  points: FollowerDailyAddsPoint[],
  range: DayRange,
): FollowerDailyAddsPoint[] {
  return points.filter((p) => p.day >= range.from && p.day <= range.to);
}

/**
 * The equal-length window immediately before `range`, with no overlap — the
 * baseline the trend badge compares against on an explicit range.
 */
export function precedingRange(range: DayRange): DayRange {
  const length = rangeLengthDays(range);
  const to = shiftDay(range.from, -1);
  return { from: shiftDay(to, -(length - 1)), to };
}

/** "Aug 3 – Aug 9, 2026". UTC formatting keeps the day key from shifting. */
export function formatRangeLabel(range: DayRange): string {
  const fmt = (day: string, withYear: boolean) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" } : {}),
    });
  if (range.from === range.to) return fmt(range.from, true);
  return `${fmt(range.from, false)} – ${fmt(range.to, true)}`;
}

/** "7 days" / "1 day" — for the legend header, which names the active window. */
export function formatRangeSpan(range: DayRange): string {
  const n = rangeLengthDays(range);
  return `${n} day${n === 1 ? "" : "s"}`;
}
