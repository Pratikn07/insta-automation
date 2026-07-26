import { ArrowDownRight, ArrowRight, ArrowUpRight, Trophy, UserPlus, Users } from "lucide-react";
import type { FollowerStock, Stats } from "@/lib/types";
import {
  describeStockVsFlow,
  formatSignedCount,
  type FlowTrend,
  type UsWeekOverWeek,
} from "@/lib/followerFlow";
import { summarizeFollowerYield } from "@/lib/homeDashboard";
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

interface FollowerKpiRowProps {
  weekOverWeek: UsWeekOverWeek | null;
  stock: FollowerStock | null;
  avgPerDay7: number | null;
  stats: Stats | undefined;
  isFlowLoading: boolean;
  isStatsLoading: boolean;
}

export function FollowerKpiRow({
  weekOverWeek,
  stock,
  avgPerDay7,
  stats,
  isFlowLoading,
  isStatsLoading,
}: FollowerKpiRowProps) {
  const milestone = stock ? describeStockVsFlow(stock, avgPerDay7) : null;
  const yieldSummary = summarizeFollowerYield(stats?.followConversion);

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
        value={stock === null ? "—" : numberFormat.format(stock.totalCounted)}
        context={
          milestone?.sentence ??
          (stock === null
            ? "Waiting for the next follower snapshot"
            : `Next milestone ${numberFormat.format(milestone!.nextMilestone)}`)
        }
        // The trimmed flow panel no longer prints its own "+108/day" headline,
        // and the daily rate is a must-have number — it lives here, beside the
        // milestone ETA that is derived from it.
        note={
          avgPerDay7 === null
            ? null
            : `${formatSignedCount(Math.round(avgPerDay7))}/day all regions`
        }
        Icon={Trophy}
        tone="sky"
        isLoading={isFlowLoading}
      />

      <KpiTile
        label="Guide → follow yield"
        value={
          yieldSummary?.state === "measured" && yieldSummary.yieldPct !== null
            ? `${yieldSummary.yieldPct}%`
            : "—"
        }
        context={
          yieldSummary === null
            ? "Follower yield is temporarily unavailable"
            : yieldSummary.state === "measured"
              ? `${yieldSummary.converted} of ${yieldSummary.rechecked} non-followers followed after getting their guide`
              : yieldSummary.headline
        }
        note={
          yieldSummary?.state === "measured" && yieldSummary.pending > 0
            ? `${yieldSummary.pending} still measuring`
            : null
        }
        Icon={UserPlus}
        tone="violet"
        isLoading={isStatsLoading}
      />
    </div>
  );
}
