import { ArrowDownRight, ArrowRight, ArrowUpRight, MessageSquareReply, Trophy, Users } from "lucide-react";
import type { FollowerDailyAddsPoint, FollowerStock, FunnelReport, Stats } from "@/lib/types";
import {
  describeStockVsFlow,
  trailingUsSlots,
  formatSignedCount,
  type ComparableWeekResult,
  type FlowTrend,
} from "@/lib/followerFlow";
import { KpiTile } from "./KpiTile";
import { KpiSparkBars } from "./KpiSparkBars";
import { KpiMeter } from "./KpiMeter";

// The three numbers Home exists to answer: is the US audience growing, how big
// is the account, and does the guide funnel earn follows. Formatting lives here
// so KpiTile stays a dumb shell.
const TREND_ICON: Record<FlowTrend, typeof ArrowUpRight> = {
  accelerating: ArrowUpRight,
  steady: ArrowRight,
  slowing: ArrowDownRight,
};

/** Trailing window for the score's series. Two weeks shows shape without noise. */
const SPARK_DAYS = 14;

/** Followers between milestones, matching describeStockVsFlow's own step. */
const MILESTONE_STEP = 1000;

const numberFormat = new Intl.NumberFormat("en-US");

/**
 * The note under the total: the all-regions daily rate, plus the demographics
 * subtotal. When the true total is showing as the headline, the subtotal is
 * named explicitly so the two numbers can't look like a contradiction.
 */
function buildTotalsNote(stock: FollowerStock, avgPerDay7: number | null): string {
  const parts: string[] = [];
  if (avgPerDay7 !== null) {
    parts.push(`${formatSignedCount(Math.round(avgPerDay7))}/day all regions`);
  }
  parts.push(
    stock.followersTotal === null
      ? `Counted across Meta's ${stock.countriesReported} reported countries`
      : `${numberFormat.format(stock.totalCounted)} across Meta's ${stock.countriesReported} reported countries`,
  );
  return parts.join(" · ");
}

interface FollowerKpiRowProps {
  weekComparison: ComparableWeekResult;
  stock: FollowerStock | null;
  avgPerDay7: number | null;
  stats: Stats | undefined;
  /** Guide → follow funnel. Feeds the third tile; see the note on it below. */
  funnel: FunnelReport | undefined;
  /**
   * The daily series. Home already holds it for the chart; the score cell needs
   * it because a week that cannot be COMPARED still has days that were MEASURED,
   * and the cell was rendering an em-dash over the top of them.
   */
  points: FollowerDailyAddsPoint[];
  isFlowLoading: boolean;
  isStatsLoading: boolean;
  isFunnelLoading: boolean;
}

export function FollowerKpiRow({
  weekComparison,
  stock,
  avgPerDay7,
  funnel,
  points,
  isFlowLoading,
  isStatsLoading,
  isFunnelLoading,
}: FollowerKpiRowProps) {
  const milestone = stock ? describeStockVsFlow(stock, avgPerDay7) : null;
  const comparable = weekComparison.status === "ready" ? weekComparison : null;
  const comparisonContext =
    weekComparison.status === "ready"
      ? `vs ${formatSignedCount(weekComparison.prior.us)} in the prior settled week`
      : {
          not_enough_history: "Waiting for two complete settled weeks",
          missing_day: "A daily measurement is missing",
          provisional_day: "Newest measurements are still settling",
          multi_day_span: "A catch-up span prevents a week-to-week comparison",
          duplicate_day: "Duplicate daily measurements need attention",
        }[weekComparison.reason];

  // The series caption. When the week is comparable the context line already
  // carries the comparison, so this only names what the bars are. When it is not,
  // it says how much of the window was actually measured — the honest reason the
  // figure above it is withheld.
  //
  // It never sums the measured days into a substitute figure. PRODUCT.md's
  // measurement contract withholds the week-over-week claim on exactly these
  // states, and a partial sum printed under "US followers this week" would be a
  // wrong number rather than a withheld one. Showing the shape is allowed:
  // "descriptive charts may still show provisional and catch-up data with their
  // qualifications. The restriction applies to claims, not visibility."
  const sparkSlots = trailingUsSlots(points, SPARK_DAYS);
  const measuredInWindow = sparkSlots.filter((s) => s.value !== null).length;
  const sparkNote =
    sparkSlots.length === 0
      ? null
      : comparable
        ? `Daily US adds · last ${sparkSlots.length} days`
        : `Daily US adds · ${measuredInWindow} of the last ${sparkSlots.length} days measured`;

  // Progress between milestones. describeStockVsFlow rounds UP to the next
  // thousand, so the run-up started one step below it.
  const milestoneBase = stock ? (stock.followersTotal ?? stock.totalCounted) : null;
  const milestoneFraction =
    milestoneBase !== null && milestone
      ? (milestoneBase - (milestone.nextMilestone - MILESTONE_STEP)) / MILESTONE_STEP
      : null;

  // A meter is a number rendered as length, so it is governed by the same rule as
  // the figure: a rate below the funnel's minimum sample is withheld, and drawing
  // a half-filled bar would state the "50%" the text deliberately refuses to
  // print. Gated on the SAME `pct !== null` condition the value uses, so the
  // figure and the mark can never disagree about whether a rate exists.
  // FollowerKpiRow.test.tsx asserts this; it is doctrine, not styling.
  const replyDenominator = funnel?.headline.rate.denominator ?? 0;
  const replyFraction =
    funnel && funnel.headline.rate.pct !== null && replyDenominator > 0
      ? funnel.headline.rate.numerator / replyDenominator
      : null;

  return (
    // ONE band, not three tiles standing on the ground. Home's neighbours both
    // carry a surface — a bordered band with a filled half above, a tinted panel
    // below — so a row with no marks of its own read as the space between them.
    // The fix is the page's own vocabulary, not a card: index.css says structure
    // comes from rules and rows, and --color-card is "never a wrapper around
    // ordinary page content".
    //
    // Ink opens the band and line closes it, the same pair Home uses for "What
    // needs attention" and "Evidence". EVERY rule below names its colour, because
    // the base layer sets `border-color` on `*`: a bare `border-l` ships at
    // #EBE8DF / 1.12:1 and does no separating at all. That is the exact bug this
    // replaced — do not drop the `-line` and `-foreground` suffixes.
    //
    // Not three equal columns either. The US figure is the stated success metric,
    // so it takes the wider column and the figure scale; the other two are
    // supporting facts. An equal 3-up row would say all three matter the same,
    // which PRODUCT.md explicitly says they do not.
    <div className="grid border-t border-t-foreground border-b border-b-line sm:grid-cols-2 lg:grid-cols-[1.35fr_1fr_1fr]">
      <KpiTile
        emphasis
        // Full width at sm: the score gets its own row above the two supporting
        // facts rather than being squeezed into half a tablet.
        className="py-5 sm:col-span-2 sm:py-6 lg:col-span-1 lg:pr-8"
        label="US followers this week"
        value={comparable ? formatSignedCount(comparable.current.us) : "—"}
        context={comparisonContext}
        note={sparkNote}
        visual={
          <KpiSparkBars
            points={points}
            days={SPARK_DAYS}
            title={`Daily US net follower adds over the last ${SPARK_DAYS} days`}
          />
        }
        Icon={Users}
        tone="emerald"
        isLoading={isFlowLoading}
        trendIcon={comparable ? TREND_ICON[comparable.trend] : null}
      />

      <KpiTile
        // Stacked: a rule above. At lg the rule turns vertical and becomes the
        // first divider.
        className="border-t border-t-line py-5 sm:py-6 sm:pr-6 lg:border-t-0 lg:border-l lg:border-l-line lg:px-8"
        label="Total followers"
        // milestone.stockLabel is Instagram's real count when available, so this
        // matches the profile instead of the 45-country subtotal.
        value={milestone?.stockLabel ?? "—"}
        context={
          milestone?.sentence ??
          (stock === null
            ? "Waiting for the next follower snapshot"
            : `Next milestone ${numberFormat.format(milestone!.nextMilestone)}`)
        }
        // Two facts, both load-bearing: the daily rate (the trimmed chart panel
        // gave up its own headline) and the 45-country subtotal, so the smaller
        // number stays visible and explained rather than silently disappearing.
        note={stock === null ? null : buildTotalsNote(stock, avgPerDay7)}
        visual={
          milestoneFraction === null || milestone === null ? undefined : (
            <KpiMeter
              fraction={milestoneFraction}
              title={`Progress toward ${numberFormat.format(milestone.nextMilestone)} followers`}
            />
          )
        }
        Icon={Trophy}
        tone="sky"
        isLoading={isFlowLoading}
      />

      {/*
        Was "Guide → follow yield" (converted ÷ rechecked over non-follower
        deliveries). That tile is dead: the hard follow gate in messageHandler
        returns early for a confirmed non-follower, so post-gate there are ZERO
        such deliveries and its denominator drains to nothing as older ones age
        out of the window.

        It was also pointing at the wrong step. The follow gate converts around
        75% and sees a few hundred people; the reply step loses thousands. So
        Home now carries the funnel's own declared headline, and the detail
        lives one click away.
      */}
      <KpiTile
        // Carries a divider from sm up, since it sits beside Total followers on a
        // tablet as well as on a desktop.
        className="border-t border-t-line py-5 sm:border-l sm:border-l-line sm:py-6 sm:pl-6 lg:border-t-0 lg:pl-8"
        label={funnel?.headline.label ?? "Reply rate"}
        value={
          funnel && funnel.headline.rate.pct !== null
            ? `${funnel.headline.rate.pct}%`
            : funnel
              ? `${numberFormat.format(funnel.headline.rate.numerator)} of ${numberFormat.format(funnel.headline.rate.denominator)}`
              : "—"
        }
        context={
          funnel
            ? `${numberFormat.format(funnel.headline.rate.numerator)} of ${numberFormat.format(funnel.headline.rate.denominator)} answered the unlock DM`
            : "Reply rate is temporarily unavailable"
        }
        // The loss, not the rate, is what a reader can act on — and it is the
        // largest single leak in the funnel by an order of magnitude.
        note={
          funnel
            ? `${numberFormat.format(funnel.headline.rate.denominator - funnel.headline.rate.numerator)} never replied · see Funnels`
            : null
        }
        // The funnel's own hue, because this figure IS the funnel headline. One
        // filled share on a visible track: index.css keeps funnels to ONE colour
        // per chart precisely so length carries the magnitude instead of hue.
        visual={
          replyFraction === null ? undefined : (
            <KpiMeter
              fraction={replyFraction}
              fillClassName="bg-funnel-mark"
              title={`${numberFormat.format(funnel!.headline.rate.numerator)} of ${numberFormat.format(replyDenominator)} answered the unlock DM`}
            />
          )
        }
        Icon={MessageSquareReply}
        tone="violet"
        isLoading={isFunnelLoading || isStatsLoading}
      />
    </div>
  );
}
