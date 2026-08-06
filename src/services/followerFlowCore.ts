import { regionOf, type FollowerRegion } from "./regionMap.js";

// Pure core of the follower-flow read model (no prisma/env imports, so it's
// testable without a DB — same split as usFitScore / originInference).
//
// follower_demographics is LIFETIME-only (see demographicsFetcher), so each
// snapshot's `counts` is a cumulative {country: totalFollowers} vector and a
// day's adds are the diff between consecutive daily anchors.
//
// HONEST CONSTRAINTS baked into the shape below:
// - Meta reports only the top ~45 countries and the cutoff drifts as the
//   account grows, so 1-2 countries swap in/out of the vector daily. A country
//   missing from one side of a diff has an UNKNOWN value, not zero — diffs run
//   on the key intersection only, and rank-boundary churn is surfaced as
//   `unattributed`, never folded into a region.
// - Meta sometimes skips a refresh (counts byte-identical to the prior day).
//   That day is a data gap, not "gained nobody": it emits nulls and its real
//   adds are absorbed into the next real diff, which then covers `spanDays`
//   calendar days. Rates must divide by days covered, not points counted.
// - Demographics lag ~48h, so the newest days are flagged `provisional`.
// - These are NET adds (follows minus unfollows); negatives are real.

export type DailyAddsBasis =
  | "diff" // normal one-day diff
  | "multi_day_span" // real diff absorbing prior stale/missing days
  | "stale" // Meta didn't refresh; adds absorbed by a later point
  | "no_snapshot" // no follower snapshot captured this day
  | "no_prior_day" // first day in range, nothing to diff against
  | "pending"; // trailing stale day, no later real diff yet

/**
 * Reel that gained notable reach while a spike happened. A CANDIDATE, never a
 * cause: Meta gives no per-reel follower attribution, so this is reach-timing
 * correlation only. Populated by spikeService (which owns the DB join); declared
 * here so this file stays the single definition of a point's shape.
 */
export interface SpikeCandidateInfo {
  mediaId: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  postedAt: string | null;
  reachGained: number;
  sharePct: number;
}

export interface SpikeInfo {
  multiple: number; // net / trailing median, e.g. 4.4
  net: number;
  baselineMedian: number;
  confidence: "high" | "medium" | "low"; // low = several reels overlapped
  candidates: SpikeCandidateInfo[]; // at most 3, largest reach gain first
}

export interface FollowerDailyAddsPoint {
  day: string; // Pacific analytics calendar day, "2026-07-21"
  capturedAt: string | null; // anchor snapshot time, null when no_snapshot
  us: number | null;
  southAsian: number | null;
  anglosphere: number | null;
  other: number | null;
  total: number | null; // sum of the four region deltas
  unattributed: number | null; // rank-boundary churn residual
  reportedTotalDelta: number | null; // diff of Meta's totalCounted (= total + unattributed)
  spanDays: number | null; // calendar days this diff covers (>1 absorbs gaps)
  stale: boolean;
  provisional: boolean;
  basis: DailyAddsBasis;
  // Present only on days that cleared the spike thresholds; absent is normal.
  spike?: SpikeInfo;
}

export interface FollowerStock {
  capturedAt: string;
  totalCounted: number; // sum across Meta's reported countries — NOT the true follower total
  // Instagram's real profile count (followers_count). Null when the profile
  // fetch failed. Differs from totalCounted by the followers living in countries
  // below Meta's ~45-country reporting cutoff — 4,355 vs 4,578 on 2026-07-26.
  followersTotal: number | null;
  us: number;
  southAsian: number;
  anglosphere: number;
  other: number;
  countriesReported: number;
}

export interface AnchorSnapshot {
  day: string;
  capturedAt: Date;
  counts: Record<string, number>;
  totalCounted: number | null;
}

const PROVISIONAL_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

// `counts` is untyped Json in Prisma; nothing else in the codebase indexes into
// it, so guard against non-object shapes and non-numeric values here.
export function asCounts(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => b[k] === a[k]);
}

export interface AnchorDiff {
  us: number;
  southAsian: number;
  anglosphere: number;
  other: number;
  total: number;
  unattributed: number;
  reportedTotalDelta: number | null;
}

/**
 * Diff two cumulative country vectors on their key intersection. Countries on
 * only one side (rank-boundary churn) net into `unattributed`.
 */
export function diffAnchors(prev: AnchorSnapshot, cur: AnchorSnapshot): AnchorDiff {
  const sums: Record<FollowerRegion, number> = { us: 0, southAsian: 0, anglosphere: 0, other: 0 };
  let entered = 0;
  let exited = 0;

  for (const [country, curVal] of Object.entries(cur.counts)) {
    const prevVal = prev.counts[country];
    if (prevVal === undefined) {
      entered += curVal;
    } else {
      sums[regionOf(country)] += curVal - prevVal;
    }
  }
  for (const [country, prevVal] of Object.entries(prev.counts)) {
    if (cur.counts[country] === undefined) exited += prevVal;
  }

  const total = sums.us + sums.southAsian + sums.anglosphere + sums.other;
  const reportedTotalDelta =
    cur.totalCounted !== null && prev.totalCounted !== null
      ? cur.totalCounted - prev.totalCounted
      : null;

  return { ...sums, total, unattributed: entered - exited, reportedTotalDelta };
}

function calendarDaysBetween(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  return Math.round((to - from) / DAY_MS);
}

function nullPoint(day: string, basis: DailyAddsBasis, capturedAt: Date | null): FollowerDailyAddsPoint {
  return {
    day,
    capturedAt: capturedAt ? capturedAt.toISOString() : null,
    us: null,
    southAsian: null,
    anglosphere: null,
    other: null,
    total: null,
    unattributed: null,
    reportedTotalDelta: null,
    spanDays: null,
    stale: basis === "stale" || basis === "pending",
    provisional: false,
    basis,
  };
}

/**
 * Turn ordered daily anchors into one point per calendar day, including null
 * points for gaps so the x-axis never silently compresses.
 */
export function buildDailyPoints(anchors: AnchorSnapshot[]): FollowerDailyAddsPoint[] {
  if (anchors.length === 0) return [];

  const byDay = new Map(anchors.map((a) => [a.day, a]));
  const firstDay = anchors[0]!.day;
  const lastDay = anchors[anchors.length - 1]!.day;
  const newestDayMs = Date.parse(`${lastDay}T00:00:00Z`);

  const points: FollowerDailyAddsPoint[] = [];
  let prevKept: AnchorSnapshot | null = null;
  let lastRealDiffIndex = -1;

  // Synthetic UTC midnights enumerate abstract day labels only; they are never
  // capture instants or query bounds.
  for (let ms = Date.parse(`${firstDay}T00:00:00Z`); ms <= newestDayMs; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const anchor = byDay.get(day);

    if (!anchor) {
      points.push(nullPoint(day, "no_snapshot", null));
      continue;
    }
    if (!prevKept) {
      points.push(nullPoint(day, "no_prior_day", anchor.capturedAt));
      prevKept = anchor;
      lastRealDiffIndex = points.length - 1; // the series baseline counts as measured ground
      continue;
    }
    if (sameCounts(anchor.counts, prevKept.counts)) {
      points.push(nullPoint(day, "stale", anchor.capturedAt));
      continue;
    }

    const diff = diffAnchors(prevKept, anchor);
    const spanDays = calendarDaysBetween(prevKept.day, day);
    points.push({
      day,
      capturedAt: anchor.capturedAt.toISOString(),
      us: diff.us,
      southAsian: diff.southAsian,
      anglosphere: diff.anglosphere,
      other: diff.other,
      total: diff.total,
      unattributed: diff.unattributed,
      reportedTotalDelta: diff.reportedTotalDelta,
      spanDays,
      stale: false,
      provisional: false,
      basis: spanDays > 1 ? "multi_day_span" : "diff",
    });
    prevKept = anchor;
    lastRealDiffIndex = points.length - 1;
  }

  // Stale days after the last real diff have no later point to absorb them yet.
  for (let i = lastRealDiffIndex + 1; i < points.length; i++) {
    if (points[i]!.basis === "stale") points[i]!.basis = "pending";
  }

  // Demographics lag ~48h, so the newest measured days may still shift.
  for (const p of points) {
    const ageDays = Math.round((newestDayMs - Date.parse(`${p.day}T00:00:00Z`)) / DAY_MS);
    if (ageDays < PROVISIONAL_DAYS && (p.basis === "diff" || p.basis === "multi_day_span")) {
      p.provisional = true;
    }
  }

  return points;
}

export function stockFrom(
  anchor: AnchorSnapshot,
  followersTotal: number | null = null,
): FollowerStock {
  const sums: Record<FollowerRegion, number> = { us: 0, southAsian: 0, anglosphere: 0, other: 0 };
  for (const [country, value] of Object.entries(anchor.counts)) {
    sums[regionOf(country)] += value;
  }
  return {
    capturedAt: anchor.capturedAt.toISOString(),
    totalCounted: anchor.totalCounted ?? sums.us + sums.southAsian + sums.anglosphere + sums.other,
    followersTotal,
    ...sums,
    countriesReported: Object.keys(anchor.counts).length,
  };
}
