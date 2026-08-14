// Shared shapes for the funnel layer.
//
// WHY THIS IS SEPARATE FROM PRISMA. Three consumers need the same funnel
// definition and the same arithmetic:
//   1. the CLI report (scripts/funnel-report.ts), runnable anywhere a
//      DATABASE_URL exists — including a cloud session;
//   2. a future /api/funnels/:key endpoint behind the Funnels tab;
//   3. an MCP client holding a read-only role, running the SQL directly.
// Keeping stages and the summarizer pure means all three agree by construction
// instead of by convention, and the arithmetic is testable with no database.

/** One step in a funnel. */
export interface FunnelStage {
  key: string;
  /** Marketer-facing label. Deliberately not the event name. */
  label: string;
  /**
   * What counts and — more importantly — what does NOT. Surfaced on hover in
   * the UI. A stage a reader can silently misinterpret is worse than no stage:
   * the whole reason the Home yield tile misled was an unstated denominator.
   */
  definition: string;
  /**
   * People can reach this stage WITHOUT passing the one before it, so a step
   * conversion against the previous stage is meaningless — it can exceed 100%.
   *
   * This funnel is not a straight line: someone already following skips the
   * gate and the reply entirely and goes straight to the guide. Marking the
   * branch points is how the renderer avoids printing "150% conversion", which
   * is the kind of number that destroys trust in a dashboard.
   */
  bypassable?: boolean;
}

export interface FunnelStageCount extends FunnelStage {
  count: number;
  /** Share of the entry stage. Null when the cohort is empty. */
  ofEntryPct: number | null;
  /** Share of the previous stage — the step conversion. Null on entry. */
  ofPrevPct: number | null;
}

/**
 * A rate that refuses to lie about its own sample.
 *
 * `pct` is null below the funnel's minSample, mirroring summarizeRetention in
 * followThroughCore. Callers render the counts in that case. This is the single
 * most important convention in the funnel layer: "15.6%" over 32 people and
 * "15.6%" over 3200 are different claims, and only one of them is a number.
 */
export interface GuardedRate {
  numerator: number;
  denominator: number;
  pct: number | null;
  /** True when the rate was suppressed for want of sample. */
  belowMinSample: boolean;
}

/**
 * Which step is THIS funnel's number.
 *
 * Declared per funnel rather than hardcoded, because the first real run moved
 * it: the guide funnel was built assuming the follow gate was the story, and
 * the data said the gate converts fine (76%) while the reply step quietly
 * loses an order of magnitude more people. A funnel that leads with the wrong
 * step sends people to optimise the wrong thing.
 */
export interface FunnelHeadline {
  /** Denominator stage key. */
  fromStage: string;
  /** Numerator stage key. */
  toStage: string;
  label: string;
  /** Why this step, and not another one. Shown under the number. */
  rationale: string;
}

export interface FunnelDef {
  key: string;
  name: string;
  /** The one question this funnel answers, in plain language. */
  question: string;
  stages: FunnelStage[];
  headline: FunnelHeadline;
  /** Below this denominator, rates report null instead of a number. */
  minSample: number;
}

/** Round to one decimal, the precision used throughout the dashboard. */
export function pct1(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function guardedRate(
  numerator: number,
  denominator: number,
  minSample: number,
): GuardedRate {
  // Clamp: a numerator above its denominator means the caller mis-scoped the
  // pool. Surface it as 100% rather than an impossible ratio, and never as a
  // negative "remaining" elsewhere.
  const num = Math.min(numerator, denominator);
  const belowMinSample = denominator < minSample;
  return {
    numerator: num,
    denominator,
    pct: belowMinSample ? null : pct1(num, denominator),
    belowMinSample,
  };
}

/** Stage counts → per-stage shares, given the counts in funnel order. */
export function toStageCounts(
  stages: FunnelStage[],
  counts: Record<string, number>,
): FunnelStageCount[] {
  const entry = counts[stages[0]?.key ?? ""] ?? 0;
  return stages.map((stage, i) => {
    const count = counts[stage.key] ?? 0;
    const prevStage = i === 0 || stage.bypassable ? undefined : stages[i - 1];
    const prev = prevStage ? (counts[prevStage.key] ?? 0) : null;
    return {
      ...stage,
      count,
      ofEntryPct: pct1(count, entry),
      ofPrevPct: prev === null ? null : pct1(count, prev),
    };
  });
}
