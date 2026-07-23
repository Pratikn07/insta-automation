import type { Experiment, LeaderboardRow } from "./types";

// Decision logic for the growth lab, kept out of the page component and unit
// tested — same convention as homeDashboard.ts. Capture rate = share of a reel's
// reach that entered the funnel (keyword comments ÷ reach). It is per-reel and
// directly attributable, unlike account-level geo, so it's the honest basis for
// "what should I make more of?".

export interface CaptureLeader {
  row: LeaderboardRow;
  rank: number;
  captureRatePct: number;
  completed: number;
  multipleOfMedian: number | null;
  reason: string;
}

const CAPTURE_LIMIT = 3;

function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function medianOf(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

/**
 * Rank reels by capture rate. Only reels the backend scored above its reach floor
 * (captureRatePct !== null) are eligible, so tiny-denominator spikes are excluded.
 * Each leader gets a reason comparing it to the median eligible reel.
 */
export function rankCaptureLeaders(reels: LeaderboardRow[]): CaptureLeader[] {
  const eligible = reels.filter(
    (r): r is LeaderboardRow & { captureRatePct: number } => typeof r.captureRatePct === "number",
  );
  if (eligible.length === 0) return [];

  const median = medianOf(eligible.map((r) => r.captureRatePct).sort((a, b) => a - b));

  return [...eligible]
    .sort((a, b) => {
      if (b.captureRatePct !== a.captureRatePct) return b.captureRatePct - a.captureRatePct;
      const pb = b.postedAt ? new Date(b.postedAt).getTime() : 0;
      const pa = a.postedAt ? new Date(a.postedAt).getTime() : 0;
      return pb - pa;
    })
    .slice(0, CAPTURE_LIMIT)
    .map((row, index) => {
      const multiple = median > 0 ? round(row.captureRatePct / median, 1) : null;
      const reason =
        multiple !== null && multiple >= 2
          ? `Converts ~${Math.round(multiple)}× your typical reel — make more like this.`
          : "One of your strongest at turning views into the funnel.";
      return {
        row,
        rank: index + 1,
        captureRatePct: row.captureRatePct,
        completed: row.conversion.completed,
        multipleOfMedian: multiple,
        reason,
      };
    });
}

export function formatCaptureRate(pct: number): string {
  return `${pct.toFixed(2)}%`;
}

// ── US-fit experiment recommendations ────────────────────────────────────────
// Groups completed auto-experiments by content feature and turns the relaxed
// attribution evidence into a "test this next" call. Only high/medium-confidence
// experiments count as usable validations — low-confidence (overlapping reels)
// are excluded, matching the backend tiers. Honest by construction: it recommends
// only when the evidence bar is met, and says how much more is needed otherwise.

export type PatternDimension = "hook" | "audio" | "language" | "cue";
export type PatternLabel = "repeat" | "rethink" | "collecting";

export interface LearnedPattern {
  feature: string;
  dimension: PatternDimension;
  positive: number; // usable validations with a non-negative engaged-US shift
  total: number; // usable validations
  meanShift: number; // mean engaged-US delta (pts) across usable validations
  label: PatternLabel;
}

export interface NextTestRecommendation {
  status: "recommended" | "collecting";
  headline: string;
  pattern?: LearnedPattern;
  needMore?: number;
}

const MIN_VALIDATIONS = 2;
const REPEAT_POSITIVE_RATIO = 0.6;
const RETHINK_POSITIVE_RATIO = 0.4;

const DIMENSION_LABEL: Record<PatternDimension, string> = {
  hook: "hooks",
  audio: "audio styles",
  language: "on-screen language",
  cue: "cultural cues",
};

function usableShift(e: Experiment): number | null {
  if (e.attributionConfidence !== "high" && e.attributionConfidence !== "medium") return null;
  if (e.baselineEngagedUsPct == null || e.measuredEngagedUsPct == null) return null;
  return e.measuredEngagedUsPct - e.baselineEngagedUsPct;
}

function featuresOf(e: Experiment): { feature: string; dimension: PatternDimension }[] {
  const out: { feature: string; dimension: PatternDimension }[] = [];
  if (e.hookArchetype?.trim()) out.push({ feature: e.hookArchetype.trim(), dimension: "hook" });
  if (e.audioVibe?.trim()) out.push({ feature: e.audioVibe.trim(), dimension: "audio" });
  if (e.onScreenLang?.trim()) out.push({ feature: e.onScreenLang.trim(), dimension: "language" });
  for (const cue of e.culturalCues ?? []) {
    if (cue?.trim()) out.push({ feature: cue.trim(), dimension: "cue" });
  }
  return out;
}

export function learnedPatterns(experiments: Experiment[]): LearnedPattern[] {
  const groups = new Map<string, { feature: string; dimension: PatternDimension; shifts: number[] }>();
  for (const e of experiments) {
    const shift = usableShift(e);
    if (shift == null) continue;
    for (const f of featuresOf(e)) {
      const key = `${f.dimension}:${f.feature.toLowerCase()}`;
      const g = groups.get(key) ?? { feature: f.feature, dimension: f.dimension, shifts: [] };
      g.shifts.push(shift);
      groups.set(key, g);
    }
  }

  return [...groups.values()]
    .map((g) => {
      const total = g.shifts.length;
      const positive = g.shifts.filter((s) => s >= 0).length;
      const meanShift = round(g.shifts.reduce((a, b) => a + b, 0) / total, 2);
      const ratio = positive / total;
      let label: PatternLabel = "collecting";
      if (total >= MIN_VALIDATIONS && ratio >= REPEAT_POSITIVE_RATIO && meanShift > 0) label = "repeat";
      else if (total >= MIN_VALIDATIONS && ratio <= RETHINK_POSITIVE_RATIO && meanShift < 0)
        label = "rethink";
      return { feature: g.feature, dimension: g.dimension, positive, total, meanShift, label };
    })
    .sort((a, b) => b.meanShift - a.meanShift);
}

function signed(pts: number): string {
  return `${pts >= 0 ? "+" : "−"}${Math.abs(pts).toFixed(1)}`;
}

export function recommendNextTest(experiments: Experiment[]): NextTestRecommendation {
  const patterns = learnedPatterns(experiments);
  const repeats = patterns
    .filter((p) => p.label === "repeat")
    .sort((a, b) => b.meanShift - a.meanShift || b.total - a.total);

  if (repeats.length > 0) {
    const best = repeats[0];
    return {
      status: "recommended",
      pattern: best,
      headline: `Test more ${DIMENSION_LABEL[best.dimension]}: “${best.feature}” was positive in ${best.positive} of ${best.total} clean validations (avg ${signed(best.meanShift)} pts engaged-US).`,
    };
  }

  const bestTotal = patterns[0]?.total ?? 0;
  const needMore = Math.max(1, MIN_VALIDATIONS - bestTotal);
  return {
    status: "collecting",
    needMore,
    headline:
      patterns.length > 0
        ? `Collecting evidence — ${needMore} more clean validation${needMore === 1 ? "" : "s"} before a confident next-test call.`
        : "No measured experiments yet — recommendations unlock after reels finish their 14-day window.",
  };
}
