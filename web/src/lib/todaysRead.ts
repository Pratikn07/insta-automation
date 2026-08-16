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
 *  - No read at all beats a hollow one. With no follower geography yet this
 *    returns null and the caller renders the reason instead of a headline
 *    dressed up as a finding.
 */
export interface TodaysRead {
  /** The finding. Always a complete sentence. */
  headline: string;
  /** The measured consequence, when one is available. */
  because: string | null;
  /** What the finding rests on. Always present — a claim travels with its basis. */
  qualification: string;
}

const nf = new Intl.NumberFormat("en-US");

/** Percent change, rounded, or null when the baseline cannot support one. */
export function velocityChange(thisWeek: number, lastWeek: number | null): number | null {
  if (lastWeek === null) return null;
  // A zero or negative baseline has no meaningful ratio: "up 100%" from zero is
  // arithmetic, not a finding.
  if (lastWeek <= 0) return null;
  return Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
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

  // The funnel clause. Only the loss is quoted — a reader can act on "1,771
  // never replied" in a way they cannot act on a conversion rate.
  let because: string | null = null;
  if (funnel) {
    const { numerator, denominator } = funnel.headline.rate;
    const lost = denominator - numerator;
    if (lost > 0) {
      because =
        `${nf.format(lost)} of ${nf.format(denominator)} conversations still stop at the ` +
        `${funnel.headline.label.toLowerCase()} step — the largest measured loss in the journey.`;
    }
  }

  const parts: string[] = [];
  parts.push(
    change === null
      ? "No comparable prior week"
      : `Compared with the prior 7 days`,
  );
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

  return { headline, because, qualification: parts.join(" / ") };
}
