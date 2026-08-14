import { ArrowDownRight, ArrowRight, ArrowUpRight, MessageSquareReply, Trophy, Users } from "lucide-react";
import type { FollowerStock, GuideFollowResult, Stats } from "@/lib/types";
import {
  describeStockVsFlow,
  formatSignedCount,
  type FlowTrend,
  type UsWeekOverWeek,
} from "@/lib/followerFlow";
import { KpiTile } from "./KpiTile";

// The three numbers Home exists to answer: is the US audience growing, how big
// is the account, and does the guide funnel earn follows. Formatting lives here
// so KpiTile stays a dumb shell.
const TREND_ICON: Record<FlowTrend, typeof ArrowUpRight> = {
  accelerating: ArrowUpRight,
  steady: ArrowRight,
  slowing: ArrowDownRight,
};

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
  weekOverWeek: UsWeekOverWeek | null;
  stock: FollowerStock | null;
  avgPerDay7: number | null;
  stats: Stats | undefined;
  /** Guide → follow funnel. Feeds the third tile; see the note on it below. */
  funnel: GuideFollowResult | undefined;
  isFlowLoading: boolean;
  isStatsLoading: boolean;
  isFunnelLoading: boolean;
}

export function FollowerKpiRow({
  weekOverWeek,
  stock,
  avgPerDay7,
  funnel,
  isFlowLoading,
  isStatsLoading,
  isFunnelLoading,
}: FollowerKpiRowProps) {
  const milestone = stock ? describeStockVsFlow(stock, avgPerDay7) : null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <KpiTile
        label="US followers this week"
        value={weekOverWeek === null ? "—" : formatSignedCount(weekOverWeek.thisWeek)}
        context={
          weekOverWeek === null
            ? "Needs two days of follower geography"
            : weekOverWeek.lastWeek === null
              ? "Not enough history yet for a week-over-week read"
              : `vs ${formatSignedCount(weekOverWeek.lastWeek)} last week`
        }
        note={
          weekOverWeek && weekOverWeek.provisionalDays > 0
            ? `newest ${weekOverWeek.provisionalDays} still settling`
            : null
        }
        Icon={Users}
        tone="emerald"
        isLoading={isFlowLoading}
        trendIcon={
          weekOverWeek && weekOverWeek.lastWeek !== null
            ? TREND_ICON[weekOverWeek.trend]
            : null
        }
      />

      <KpiTile
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
        Icon={MessageSquareReply}
        tone="violet"
        isLoading={isFunnelLoading || isStatsLoading}
      />
    </div>
  );
}
