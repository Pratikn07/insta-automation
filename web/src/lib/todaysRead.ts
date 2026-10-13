import type { ComparableWeek, ComparableWeekResult } from "./followerFlow";
import type { FunnelReport } from "./types";

/**
 * Today's read: the one sentence Home opens with.
 *
 * Pure and free of Date.now() so it can be tested without a clock or a network,
 * the same discipline as followerFlow.ts. Every clause it emits is derived from
 * a measurement that already exists; nothing here interprets beyond the
 * arithmetic, because a sentence is a claim and this product does not make
 * claims its samples cannot carry.
 *
 * The rules it will not break:
 *
 *  - No percentage without a usable positive baseline. The calendar comparison
 *    calculates this once; this composer never creates a second rate path.
 *  - The funnel clause repeats the funnel's own guard. When `pct` is null the
 *    sample is below minSample, so the loss is stated as counts and no rate is
 *    printed anywhere in the sentence.
 *  - **Each clause names its own window.** The velocity clause measures 7 days
 *    against the prior 7; the funnel clause measures whatever window the funnel
 *    was actually run over, which defaults to 30 days. An earlier version joined
 *    them into one sentence with neither labelled — exactly the unstated-
 *    denominator failure that `funnels.routes.ts` refuses to commit one layer
 *    below, where the comment reads: "Silently falling back to 30 days would
 *    render a funnel under a label claiming some other range."
 *  - No read at all beats a hollow one. With no follower geography yet this
 *    returns null and the caller renders the reason instead of a headline
 *    dressed up as a finding.
 */
export interface TodaysRead {
  /** The finding. Always a complete sentence, and always about one window. */
  headline: string;
  /** The window the headline measured, in words. */
  headlineWindow: string;
  /** A second measurement, over its own window. Null when unavailable. */
  because: string | null;
  /** The window `because` measured. Null whenever `because` is. */
  becauseWindow: string | null;
  /** What the finding rests on. A claim travels with its basis. */
  qualification: string;
}

const nf = new Intl.NumberFormat("en-US");
const DAY_MS = 24 * 60 * 60 * 1000;

/** The funnel's own window, in whole days, read off the result rather than assumed. */
export function funnelWindowDays(window: { from: string; to: string }): number | null {
  const from = new Date(window.from).getTime();
  const to = new Date(window.to).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;
  return Math.round((to - from) / DAY_MS);
}

export interface FunnelLoss {
  fromStage: string;
  toStage: string;
  fromLabel: string;
  toLabel: string;
  denominator: number;
  numerator: number;
  lost: number;
}

export function largestMeasuredFunnelLoss(funnel: FunnelReport): FunnelLoss | null {
  let largest: FunnelLoss | null = null;
  for (let index = 1; index < funnel.stages.length; index += 1) {
    const previous = funnel.stages[index - 1]!;
    const stage = funnel.stages[index]!;
    if (stage.bypassable || stage.coverageOnly) continue;
    if (!Number.isFinite(previous.count) || !Number.isFinite(stage.count)) continue;

    const lost = previous.count - stage.count;
    if (lost <= 0 || (largest && lost <= largest.lost)) continue;
    largest = {
      fromStage: previous.key,
      toStage: stage.key,
      fromLabel: previous.label,
      toLabel: stage.label,
      denominator: previous.count,
      numerator: stage.count,
      lost,
    };
  }
  return largest;
}

function formatDateKey(day: string): { month: string; day: number } {
  const date = new Date(`${day}T00:00:00Z`);
  return {
    month: date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    day: date.getUTCDate(),
  };
}

function formatWindow(window: ComparableWeek): string {
  const from = formatDateKey(window.from);
  const to = formatDateKey(window.to);
  return from.month === to.month
    ? `${from.month} ${from.day}–${to.day}`
    : `${from.month} ${from.day}–${to.month} ${to.day}`;
}

export function composeTodaysRead(
  comparison: ComparableWeekResult,
  funnel: FunnelReport | undefined,
): TodaysRead | null {
  if (comparison.status !== "ready") return null;

  const { current, prior, changePct } = comparison;

  let headline: string;
  if (changePct === null) {
    headline =
      current.us >= 0
        ? `The latest settled week added ${nf.format(current.us)} US followers.`
        : `The latest settled week lost ${nf.format(Math.abs(current.us))} US followers.`;
  } else if (changePct === 0) {
    headline = "US follower growth held level with the prior settled week.";
  } else {
    const direction = changePct > 0 ? "faster" : "slower";
    headline = `US follower growth is ${Math.abs(changePct)}% ${direction} than the prior settled week.`;
  }
  const headlineWindow = `${formatWindow(current)} against ${formatWindow(prior)}`;

  // The funnel clause. Only the loss is quoted — a reader can act on "1,771
  // never replied" in a way they cannot act on a conversion rate. It is
  // deliberately NOT joined to the headline with "but" or "and": the two
  // measurements cover different cohorts over different windows, and a
  // conjunction would present them as one finding.
  let because: string | null = null;
  let becauseWindow: string | null = null;
  if (funnel) {
    const loss = largestMeasuredFunnelLoss(funnel);
    if (loss) {
      because =
        `Separately, ${nf.format(loss.lost)} of ${nf.format(loss.denominator)} conversations stop between ` +
        `${loss.fromLabel.toLowerCase()} and ${loss.toLabel.toLowerCase()} — the largest measured loss in the journey.`;
      const days = funnelWindowDays(funnel.window);
      becauseWindow = days === null ? "Funnel window" : `Funnel cohort, last ${days} days`;
    }
  }

  const parts = ["14 settled calendar days"];
  if (funnel) {
    parts.push(
      funnel.headline.rate.pct === null
        ? `${nf.format(funnel.headline.rate.denominator)} in the funnel — below the minimum sample, counts only`
        : `${nf.format(funnel.headline.rate.denominator)} in the funnel`,
    );
  }

  return { headline, headlineWindow, because, becauseWindow, qualification: parts.join(" / ") };
}
