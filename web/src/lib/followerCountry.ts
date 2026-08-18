import type { StackSpec } from "./followerFlow";
import type { FollowerDailyAddsPoint } from "./types";

// Country-mode selection for the follower chart. Pure, no Date.now(), all inputs
// explicit — same discipline as followerFlow.ts.
//
// Country data only exists because geo_demographic_snapshot.counts always held
// all ~45 codes Meta reports; the API used to collapse it to four regions. The
// long tail is genuinely noisy (countries crossing Meta's top-45 cutoff), so the
// job here is to surface the short head honestly and fold the rest.

import { COUNTRY_CHART_COLORS } from "./chartPalette";

export const OTHER_KEY = "__other__";

/**
 * Categorical hues, dark-surface steps, validated as a set against the panel
 * surface (#1c1c1c): lightness band, chroma floor, adjacent-pair CVD separation,
 * normal-vision floor, and 3:1 contrast all pass.
 *
 * Eight, not six, because a hue belongs to a COUNTRY, not to a stack position —
 * see colorMapFor. Six show at once; the spare two keep the assignment stable
 * when the range changes which six those are.
 */
export const COUNTRY_PALETTE = [
  ...COUNTRY_CHART_COLORS,
] as const;

// Same slate the region chart uses for "Rest of world" — a fold-up bucket is not
// an entity and must not read as one more country.
export const OTHER_COLOR = "rgb(148 163 184)";

/** How many countries can hold their own colour, bounded by the palette. */
export const MAX_COLORED_COUNTRIES = COUNTRY_PALETTE.length;

/** How many stack their own band at once; the rest fold into Other. */
export const DEFAULT_TOP_N = 6;

export interface CountryRank {
  code: string;
  net: number; // signed sum over the points supplied
  movement: number; // |net|, what ranking is by — a big loss matters as much as a big gain
}

/**
 * Countries ranked by absolute movement over the given points, descending.
 *
 * Ranks by |net| so a country shedding followers can't hide below a smaller
 * gainer. Ties break on code so the order is deterministic across renders.
 */
export function rankCountries(points: FollowerDailyAddsPoint[]): CountryRank[] {
  const net = new Map<string, number>();
  for (const p of points) {
    if (!p.byCountry) continue;
    for (const [code, delta] of Object.entries(p.byCountry)) {
      net.set(code, (net.get(code) ?? 0) + delta);
    }
  }
  return [...net.entries()]
    .map(([code, value]) => ({ code, net: value, movement: Math.abs(value) }))
    .sort((a, b) => b.movement - a.movement || a.code.localeCompare(b.code));
}

/**
 * Country → colour, built ONCE from the full dataset rather than per range.
 *
 * This is the rule that makes the filters trustworthy: a hue belongs to a
 * country, never to a position in the stack. Assigning by index into the
 * range-scoped top-6 would repaint every surviving country the moment a new one
 * entered — the legend would have to be re-read after every date change, and two
 * screenshots of the same country would disagree on its colour.
 *
 * Only the overall top 8 get a hue. Below that the data is Meta's churning
 * top-45 boundary, where a country's per-day delta is mostly reporting noise;
 * those fold into Other rather than being cycled onto a repeated colour.
 */
export function colorMapFor(allPoints: FollowerDailyAddsPoint[]): Map<string, string> {
  const map = new Map<string, string>();
  rankCountries(allPoints)
    .slice(0, MAX_COLORED_COUNTRIES)
    .forEach((entry, i) => map.set(entry.code, COUNTRY_PALETTE[i]!));
  return map;
}

export interface CountryStackOptions {
  // null = automatic: the top N movers in range, everything else folded into
  // Other. A non-empty array = show EXACTLY these countries and nothing else,
  // no Other band. "Select South Africa" has to mean South Africa alone, not
  // South Africa beside a grey bar holding the other 51.
  selected?: readonly string[] | null;
  topN?: number;
}

export interface CountryStack {
  // Stack order, biggest first. Never includes OTHER_KEY.
  keys: string[];
  // Countries folded away: below the cut, muted, or without a stable colour.
  otherCount: number;
  otherNet: number;
  hasOther: boolean;
}

/**
 * Which countries get their own band for this range.
 *
 * Two modes:
 * - **Explicit** (`selected` non-empty): exactly those countries, and NO Other.
 *   The chart is answering "what did these do" — folding the remainder into a
 *   grey band answers a question nobody asked, and at 46 countries that band
 *   dwarfs the one country you picked.
 * - **Automatic** (`selected` null/empty): the top N movers WITHIN the supplied
 *   points, everything else folded. Range-scoped on purpose, so narrowing to a
 *   week surfaces a country that only mattered that week.
 *
 * A country with no stable colour is never drawn as its own band — past the
 * palette there is no hue left that isn't already another country's.
 */
export function resolveCountryStack(
  ranked: CountryRank[],
  colors: Map<string, string>,
  { selected = null, topN = DEFAULT_TOP_N }: CountryStackOptions = {},
): CountryStack {
  const byMovement = new Map(ranked.map((r) => [r.code, r.movement]));
  const byMovementDesc = (a: string, b: string) =>
    (byMovement.get(b) ?? 0) - (byMovement.get(a) ?? 0) || a.localeCompare(b);

  if (selected && selected.length > 0) {
    return {
      keys: selected.filter((code) => colors.has(code)).sort(byMovementDesc),
      otherCount: 0,
      otherNet: 0,
      hasOther: false,
    };
  }

  const chosen = ranked
    .filter((r) => colors.has(r.code))
    .slice(0, topN)
    .map((r) => r.code)
    .sort(byMovementDesc);

  const shown = new Set(chosen);
  const folded = ranked.filter((r) => !shown.has(r.code));
  return {
    keys: chosen,
    otherCount: folded.length,
    otherNet: folded.reduce((sum, r) => sum + r.net, 0),
    hasOther: folded.length > 0,
  };
}

/**
 * The stack the bars and tooltip both read.
 *
 * Includes the folded-up `Other` band as a real series. Without it the bars draw
 * only the named countries while the legend prints an Other total, so a bar
 * whose tooltip claims "+186 net" would render — and itemise — just 157 of it.
 * Other is computed per point from that day's own byCountry, never from the
 * range total, so each bar accounts for exactly its own day.
 */
export function buildCountryStack(keys: string[], hasOther: boolean): StackSpec {
  const shown = new Set(keys);
  return {
    keys: hasOther ? [...keys, OTHER_KEY] : keys,
    valueOf: (point, key) => {
      const byCountry = point.byCountry;
      if (!byCountry) return 0;
      if (key !== OTHER_KEY) return byCountry[key] ?? 0;
      let sum = 0;
      for (const [code, delta] of Object.entries(byCountry)) {
        if (!shown.has(code)) sum += delta;
      }
      return sum;
    },
  };
}

/**
 * "South Africa" from "ZA" via the browser's own CLDR data — no hand-maintained
 * 45-row table to drift out of date. Falls back to the raw code where the
 * runtime has no display name for it.
 */
const displayNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(undefined, { type: "region" })
    : null;

export function countryLabel(code: string): string {
  if (code === OTHER_KEY) return "Other";
  try {
    return displayNames?.of(code) ?? code;
  } catch {
    return code;
  }
}
