import type { UsWeekOverWeek } from "./followerFlow";
import type { GuideFollowResult } from "./types";

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
 *  - No percentage without a usable baseline. A null or zero prior week yields
 *    counts and an explicit statement that there is nothing to compare against,
 *    never a fabricated "up 100%".
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

/** Percent change, rounded, or null when the baseline cannot support one. */
export function velocityChange(thisWeek: number, lastWeek: number | null): number | null {
  if (lastWeek === null) return null;
  // A zero or negative baseline has no meaningful ratio: "up 100%" from zero is
  // arithmetic, not a finding.
  if (lastWeek <= 0) return null;
  return Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
}

/** The funnel's own window, in whole days, read off the result rather than assumed. */
export function funnelWindowDays(window: { from: string; to: string }): number | null {
  const from = new Date(window.from).getTime();
  const to = new Date(window.to).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;
  return Math.round((to - from) / DAY_MS);
}

export function composeTodaysRead(
  weekOverWeek: UsWeekOverWeek | null,
  funnel: GuideFollowResult | undefined,
): TodaysRead | null {
  if (weekOverWeek === null) return null;

  const { thisWeek, lastWeek, provisionalDays } = weekOverWeek;
  const change = velocityChange(thisWeek, lastWeek);

  let headline: string;
  if (change === null) {
    headline = `You gained ${nf.format(thisWeek)} US followers this week.`;
  } else if (change === 0) {
    headline = "US follower growth held level with last week.";
  } else {
    const direction = change > 0 ? "faster" : "slower";
    headline = `US follower growth is ${Math.abs(change)}% ${direction} than last week.`;
  }
  const headlineWindow = "Last 7 days against the 7 before";

  // The funnel clause. Only the loss is quoted — a reader can act on "1,771
  // never replied" in a way they cannot act on a conversion rate. It is
  // deliberately NOT joined to the headline with "but" or "and": the two
  // measurements cover different cohorts over different windows, and a
  // conjunction would present them as one finding.
  let because: string | null = null;
  let becauseWindow: string | null = null;
  if (funnel) {
    const { numerator, denominator } = funnel.headline.rate;
    const lost = denominator - numerator;
    if (lost > 0) {
      because =
        `Separately, ${nf.format(lost)} of ${nf.format(denominator)} conversations stop at the ` +
        `${funnel.headline.label.toLowerCase()} step — the largest measured loss in the journey.`;
      const days = funnelWindowDays(funnel.window);
      becauseWindow = days === null ? "Funnel window" : `Funnel cohort, last ${days} days`;
    }
  }

  const parts: string[] = [];
  parts.push(change === null ? "No comparable prior week" : "7-day comparison");
  if (provisionalDays > 0) {
    parts.push(`newest ${provisionalDays} ${provisionalDays === 1 ? "day" : "days"} still settling`);
  }
  if (funnel) {
    parts.push(
      funnel.headline.rate.pct === null
        ? `${nf.format(funnel.headline.rate.denominator)} in the funnel — below the minimum sample, counts only`
        : `${nf.format(funnel.headline.rate.denominator)} in the funnel`,
    );
  }

  return { headline, headlineWindow, because, becauseWindow, qualification: parts.join(" / ") };
}
