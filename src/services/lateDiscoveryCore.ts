// Pure core for Late Discovery Share (no prisma/env imports, so it's testable
// without a DB — same split as spikeCore and followerFlowCore).
//
// WHAT THIS MEASURES, AND WHY IT IS A PROXY.
//
// Meta exposes no query-level data for Instagram: there is no impressions-by-
// query, no rank, no "which search brought this viewer". Search-driven discovery
// therefore cannot be measured directly, and any product that claims to rank
// keywords is estimating from scraped searches. What CAN be measured is the
// SHAPE of a reel's view curve. Recommendation traffic is violently front-loaded
// and is effectively over within 48-72h; search and evergreen resurfacing are a
// slow flat tail. So the share of lifetime views a reel accrues AFTER day seven
// separates "was recommended once" from "keeps being found".
//
// It is a proxy, not a measurement of search. Saves resurfacing a reel, a
// profile visitor working backwards, and a second recommendation wave all land
// in the same number. Label it as discovery, never as search traffic.
//
// MEASURED ON THE LIVE ACCOUNT (2026-08-23, n=79 reels clearing every gate):
//   p10 0.2%   median 8.9%   p90 23.2%   max 41.8%   negatives 0
//   corr(LDS, age)             = -0.002   <- the result that validates the metric
//   corr(LDS, reach)           =  0.194
//   corr(LDS, saves per reach) =  0.195
//   corr(LDS, likes per reach) = -0.206
//
// The age correlation being ~0 is what makes this a content metric rather than
// an artifact of elapsed time: a reel does not accrue late views merely by being
// old. Two reels posted the same day sit at 0.1% and 41.8%. The saves-positive /
// likes-negative split points at reference-value content tailing where emotional
// content does not, but at |r| ~ 0.2 on n=79 that is SUGGESTIVE ONLY and must
// not be stated as a finding in the console.

/** One performance snapshot of one reel, as stored by the snapshot worker. */
export interface LateDiscoverySnapshot {
  capturedAt: number; // epoch ms
  views: number | null;
  reach: number | null;
  shares: number | null;
  saved: number | null;
}

/** Why a reel has no late-discovery reading. Never render one of these as zero. */
export type LateDiscoveryGap =
  | "too_young" // not yet old enough for a tail to exist
  | "no_lifetime_snapshot" // never successfully snapshotted with views
  | "no_day_seven_snapshot" // nothing captured near the day-seven mark
  | "below_reach_floor" // denominator too small to trust
  | "views_regressed"; // Meta revised lifetime views below the day-seven reading

export interface LateDiscoveryResult {
  mediaId: string;
  /** Share of lifetime views accrued after day seven, as a 1dp %. Null when gapped. */
  ldsPct: number | null;
  /** Set when and only when ldsPct is null. */
  gap: LateDiscoveryGap | null;
  // Evidence. Every figure the reading is derived from, so a caller can show its work.
  daySevenViews: number | null;
  daySevenAt: number | null;
  /** Hours between the day-seven target and the snapshot actually used. */
  daySevenGapHours: number | null;
  lifetimeViews: number | null;
  lifetimeReach: number | null;
  lifetimeAt: number | null;
  /** shares ÷ reach as a 2dp %. Mosseri's strongest non-follower signal. */
  sendsPerReachPct: number | null;
  /** saved ÷ reach as a 2dp %. */
  savesPerReachPct: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const DAY_SEVEN_MS = 7 * DAY_MS;

// How far from the day-seven mark a snapshot may sit and still count.
//
// We do NOT interpolate between snapshots, and we do not backshift the window to
// find a more convenient answer — the same discipline the week-over-week
// interpretation already follows. An interpolated day-seven reading would invent
// the very quantity being measured.
//
// 36h is derived, not chosen: the worker self-throttles to one tick an hour and
// paces per-reel calls, so a healthy reel lands several snapshots a day. On the
// live account the median distance from the day-seven target to the nearest real
// snapshot was 20.9h and 88 of 96 eligible reels fell inside 36h. Tightening to
// 24h drops real reels for no gain in accuracy; widening past 48h starts
// admitting readings that are meaningfully not day seven.
const DAY_SEVEN_TOLERANCE_MS = 36 * 60 * 60 * 1000;

// A reel needs a tail before its tail can be measured. Below this age the
// denominator is still moving fast enough that LDS reads as noise.
const MIN_AGE_MS = 10 * DAY_MS;

// Mirrors insightsService's MIN_REACH_FLOOR so the whole app suppresses thin
// denominators on one scale. Below this, a handful of late views reads as a
// double-digit percentage.
const MIN_REACH_FLOOR = 500;

// A distribution summary below this many readings is withheld rather than
// printed. This is a judgment about what a reader would over-trust, not a
// measured threshold, and it is deliberately stricter than the per-reel gates.
const MIN_SUMMARY_SAMPLE = 8;

function round(value: number, precision = 1): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Nearest-rank percentile over an already-sorted-ascending array. */
function percentile(sortedAsc: number[], fraction: number): number {
  const rank = Math.ceil(fraction * sortedAsc.length);
  const index = Math.min(Math.max(rank, 1), sortedAsc.length) - 1;
  return sortedAsc[index]!;
}

function gapped(mediaId: string, gap: LateDiscoveryGap): LateDiscoveryResult {
  return {
    mediaId,
    ldsPct: null,
    gap,
    daySevenViews: null,
    daySevenAt: null,
    daySevenGapHours: null,
    lifetimeViews: null,
    lifetimeReach: null,
    lifetimeAt: null,
    sendsPerReachPct: null,
    savesPerReachPct: null,
  };
}

function perReach(numerator: number | null, reach: number | null): number | null {
  if (numerator === null || reach === null || reach < MIN_REACH_FLOOR) return null;
  return round((numerator / reach) * 100, 2);
}

/**
 * The late-discovery reading for one reel.
 *
 * Returns a gap reason rather than a number whenever any input is missing or too
 * thin. A reel that stopped being snapshotted mid-life is the dangerous case:
 * its last snapshot is stale, so lifetime views are understated and LDS reads
 * LOWER than the truth. That is why `no_day_seven_snapshot` and a stale lifetime
 * reading are surfaced as gaps and not quietly folded into an average — the
 * failure mode of this metric flatters us, so it has to be visible.
 */
export function computeLateDiscovery(
  mediaId: string,
  postedAtMs: number,
  snapshots: LateDiscoverySnapshot[],
  nowMs: number,
): LateDiscoveryResult {
  if (nowMs - postedAtMs < MIN_AGE_MS) return gapped(mediaId, "too_young");

  const withViews = snapshots.filter((s) => s.views !== null);
  if (withViews.length === 0) return gapped(mediaId, "no_lifetime_snapshot");

  // Lifetime = the newest snapshot that actually carried a views figure.
  let lifetime = withViews[0]!;
  for (const snap of withViews) {
    if (snap.capturedAt > lifetime.capturedAt) lifetime = snap;
  }

  const target = postedAtMs + DAY_SEVEN_MS;
  let daySeven = withViews[0]!;
  for (const snap of withViews) {
    if (Math.abs(snap.capturedAt - target) < Math.abs(daySeven.capturedAt - target)) daySeven = snap;
  }

  const distance = Math.abs(daySeven.capturedAt - target);
  if (distance > DAY_SEVEN_TOLERANCE_MS) return gapped(mediaId, "no_day_seven_snapshot");

  const lifetimeViews = lifetime.views!;
  const daySevenViews = daySeven.views!;
  const lifetimeReach = lifetime.reach;

  if (lifetimeReach === null || lifetimeReach < MIN_REACH_FLOOR) {
    return gapped(mediaId, "below_reach_floor");
  }

  // Meta does revise figures downward. A negative share is not a small negative
  // signal, it is an invalid reading, so it is withheld rather than clamped to
  // zero — clamping would silently mix "no tail" with "bad data".
  if (lifetimeViews < daySevenViews || lifetimeViews <= 0) {
    return gapped(mediaId, "views_regressed");
  }

  return {
    mediaId,
    ldsPct: round(((lifetimeViews - daySevenViews) / lifetimeViews) * 100),
    gap: null,
    daySevenViews,
    daySevenAt: daySeven.capturedAt,
    daySevenGapHours: round(distance / (60 * 60 * 1000)),
    lifetimeViews,
    lifetimeReach,
    lifetimeAt: lifetime.capturedAt,
    sendsPerReachPct: perReach(lifetime.shares, lifetimeReach),
    savesPerReachPct: perReach(lifetime.saved, lifetimeReach),
  };
}

export interface LateDiscoverySummary {
  n: number;
  medianPct: number;
  p10Pct: number;
  p90Pct: number;
}

/**
 * The distribution across reels, or null when too few readings survive.
 *
 * Returns null rather than a summary of three reels: a blank is honest and a
 * reader can act on it, where a median over a thin sample invites a decision the
 * sample cannot carry.
 */
export function summarizeLateDiscovery(
  results: LateDiscoveryResult[],
): { summary: LateDiscoverySummary | null; gaps: Record<LateDiscoveryGap, number> } {
  const gaps: Record<LateDiscoveryGap, number> = {
    too_young: 0,
    no_lifetime_snapshot: 0,
    no_day_seven_snapshot: 0,
    below_reach_floor: 0,
    views_regressed: 0,
  };

  const readings: number[] = [];
  for (const result of results) {
    if (result.gap !== null) gaps[result.gap]++;
    else if (result.ldsPct !== null) readings.push(result.ldsPct);
  }

  if (readings.length < MIN_SUMMARY_SAMPLE) return { summary: null, gaps };

  const sorted = [...readings].sort((a, b) => a - b);
  return {
    summary: {
      n: readings.length,
      medianPct: round(median(sorted)),
      p10Pct: round(percentile(sorted, 0.1)),
      p90Pct: round(percentile(sorted, 0.9)),
    },
    gaps,
  };
}
