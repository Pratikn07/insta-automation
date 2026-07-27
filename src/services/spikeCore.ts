import type { FollowerDailyAddsPoint } from "./followerFlowCore.js";

// Pure core for follower-spike detection and reel attribution (no prisma/env
// imports, so it's testable without a DB — same split as followerFlowCore).
//
// WHAT THIS CAN AND CANNOT SAY. Meta gives no per-reel follower attribution, so
// nothing here proves a reel caused a follower spike. All we can honestly do is
// rank the reels that gained the most REACH while the spike happened and let a
// human judge. That is why the output is a list of `candidates` and never a
// single "driver":
//
// Measured on the live account (2026-07-26), the leading reel FLIPS depending on
// whether the attribution window is ±1 or ±2 days — Jul 23 reads as the "walk
// away from dinner" reel at 77% with ±1 but a different reel at 54% with ±2.
// Reel snapshots land ~6h apart while Meta's demographics lag ~48h, so the two
// series cannot be aligned tightly enough to name one winner.

export type SpikeConfidence = "high" | "medium" | "low";

export interface Spike {
  day: string; // UTC calendar day of the spike
  net: number; // measured net adds that day
  baselineMedian: number; // trailing median it was compared against
  multiple: number; // net / baselineMedian, rounded to 1dp
}

export interface SpikeCandidate {
  mediaId: string;
  reachGained: number; // reach added during the window
  sharePct: number; // of all reach gained in the window, 0..100
}

export interface CandidateRanking {
  candidates: SpikeCandidate[]; // at most 3, highest gain first
  totalReachGained: number;
  confidence: SpikeConfidence;
}

export interface ReelSnapshot {
  mediaId: string;
  capturedAt: number; // epoch ms
  reach: number | null;
}

// Thresholds validated against the live series (see spikeCore.test.ts):
// 2.5x flags exactly the days a human notices; 2.0x also flags a 2.4x day that
// reads as noise, and 3.0x drops a real one.
const SPIKE_MULTIPLE = 2.5;
const SPIKE_FLOOR = 40;
const BASELINE_WINDOW_DAYS = 28;
const MIN_BASELINE_DAYS = 7;

// Mirrors experimentService's HIGH/MEDIUM_SHARE_THRESHOLD so the whole app grades
// reach-share attribution on one scale.
const HIGH_SHARE = 0.5;
const MEDIUM_SHARE = 0.25;

const MAX_CANDIDATES = 3;

// A reel posted just before a window opens gets its first snapshot minutes past
// midnight. Requiring a baseline strictly at-or-before the window start silently
// dropped the actual top candidate on the live Jul 15 spike (first snapshot
// 00:11, window opened 00:00), so a first reading inside this grace counts as a
// baseline — but only when its reach is still near zero, which is what
// distinguishes a fresh post from an existing reel being re-snapshotted.
const BASELINE_GRACE_MS = 6 * 60 * 60 * 1000;
const FRESH_POST_REACH_CEILING = 1000;

// Only these bases carry a real measurement; the rest are gaps or absorbed days.
const MEASURED_BASES = new Set<FollowerDailyAddsPoint["basis"]>(["diff", "multi_day_span"]);

function round(value: number, precision = 1): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Days whose net adds stand well clear of the recent norm.
 *
 * The baseline is a MEDIAN of the trailing window's positive days, not a mean:
 * the spikes we are looking for are large enough to drag a mean upward and hide
 * themselves. Days without a measurement (stale/gap/pending) are neither
 * flagged nor counted toward the baseline.
 */
export function detectSpikes(points: FollowerDailyAddsPoint[]): Spike[] {
  const spikes: Spike[] = [];

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    if (!MEASURED_BASES.has(point.basis) || point.total === null || point.total <= 0) continue;

    const priorNets: number[] = [];
    for (let j = Math.max(0, i - BASELINE_WINDOW_DAYS); j < i; j++) {
      const prior = points[j]!;
      if (!MEASURED_BASES.has(prior.basis) || prior.total === null || prior.total <= 0) continue;
      priorNets.push(prior.total);
    }
    if (priorNets.length < MIN_BASELINE_DAYS) continue;

    const baselineMedian = median(priorNets);
    if (baselineMedian <= 0) continue;
    if (point.total < SPIKE_FLOOR) continue;
    if (point.total < baselineMedian * SPIKE_MULTIPLE) continue;

    spikes.push({
      day: point.day,
      net: point.total,
      baselineMedian,
      multiple: round(point.total / baselineMedian),
    });
  }

  return spikes;
}

/**
 * The reels that gained the most reach during a window, as a share of all reach
 * gained in it.
 *
 * Growth is measured from a PRE-window baseline. Using the first in-window
 * snapshot instead would credit a reel with its entire lifetime reach — on the
 * live data that made a reel whose only 3 snapshots predate the window look like
 * it gained +111K during it.
 */
export function rankCandidates(
  snapshots: ReelSnapshot[],
  windowStartMs: number,
  windowEndMs: number,
): CandidateRanking {
  const byReel = new Map<string, ReelSnapshot[]>();
  for (const snap of snapshots) {
    const list = byReel.get(snap.mediaId);
    if (list) list.push(snap);
    else byReel.set(snap.mediaId, [snap]);
  }

  const gains: SpikeCandidate[] = [];
  for (const [mediaId, list] of byReel) {
    const ordered = [...list].sort((a, b) => a.capturedAt - b.capturedAt);
    const usable = ordered.filter((s) => s.reach !== null);
    if (usable.length === 0) continue;

    const before = usable.filter((s) => s.capturedAt <= windowStartMs).at(-1);
    const inWindow = usable.filter(
      (s) => s.capturedAt > windowStartMs && s.capturedAt <= windowEndMs,
    );
    if (inWindow.length === 0) continue;

    let baselineReach: number | null = before ? before.reach : null;
    if (baselineReach === null) {
      // No pre-window reading: accept a fresh post's near-zero first sample.
      const first = inWindow[0]!;
      const withinGrace = first.capturedAt - windowStartMs <= BASELINE_GRACE_MS;
      if (withinGrace && first.reach! <= FRESH_POST_REACH_CEILING) {
        baselineReach = first.reach;
      } else {
        continue; // cannot separate in-window growth from lifetime reach
      }
    }

    const reachGained = inWindow.at(-1)!.reach! - baselineReach!;
    if (reachGained > 0) gains.push({ mediaId, reachGained, sharePct: 0 });
  }

  const totalReachGained = gains.reduce((sum, g) => sum + g.reachGained, 0);
  gains.sort((a, b) => b.reachGained - a.reachGained);

  const candidates = gains.slice(0, MAX_CANDIDATES).map((g) => ({
    ...g,
    sharePct: totalReachGained > 0 ? Math.round((g.reachGained / totalReachGained) * 100) : 0,
  }));

  const leaderShare =
    totalReachGained > 0 && gains.length > 0 ? gains[0]!.reachGained / totalReachGained : 0;
  const confidence: SpikeConfidence =
    leaderShare >= HIGH_SHARE ? "high" : leaderShare >= MEDIUM_SHARE ? "medium" : "low";

  return { candidates, totalReachGained, confidence };
}
