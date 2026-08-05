import { ArrowDownRight, ArrowRight, ArrowUpRight, Clock, Info, RefreshCw, TrendingUp } from "lucide-react";
import type { FollowerDailyAddsPoint, FollowerStock } from "@/lib/types";
import { formatSignedCount, type FollowerFlowSummary } from "@/lib/followerFlow";
import { describeFreshness } from "@/lib/homeDashboard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DailyAddsChart, REGION_COLORS, REGION_LABELS } from "./DailyAddsChart";
import { EmptyPanel, PanelShell } from "./PanelShell";
import { SpikeCandidates } from "./SpikeCandidates";

interface FollowerFlowPanelProps {
  points: FollowerDailyAddsPoint[];
  stock: FollowerStock | null;
  summary: FollowerFlowSummary | null;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  selectedDay?: string | null;
  onDaySelect?: (day: string) => void;
  // ISO "now" for the staleness pill (injected, never Date.now(), so the panel
  // stays deterministic under renderToStaticMarkup like the rest of Home).
  now?: string;
}

// The follower feed snapshots 4×/day, so anything past ~2 days old means the
// worker has stalled — and this panel drives the headline rate AND the Home
// header date, so a silent freeze here is worse than on the reached/engaged card.
const FOLLOWER_STALE_AFTER_DAYS = 2;

const trendStyles = {
  accelerating: {
    label: "Accelerating",
    Icon: ArrowUpRight,
    badge: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
    glow: "from-emerald-400/20 via-emerald-400/5 to-transparent",
  },
  steady: {
    label: "Holding steady",
    Icon: ArrowRight,
    badge: "border-amber-300/25 bg-amber-300/10 text-amber-200",
    glow: "from-amber-300/15 via-amber-300/5 to-transparent",
  },
  slowing: {
    label: "Slowing",
    Icon: ArrowDownRight,
    badge: "border-rose-400/25 bg-rose-400/10 text-rose-300",
    glow: "from-rose-400/15 via-rose-400/5 to-transparent",
  },
} as const;

export function FollowerFlowPanel({
  points,
  stock,
  summary,
  isLoading,
  isError,
  onRetry,
  selectedDay,
  onDaySelect,
  now,
}: FollowerFlowPanelProps) {
  if (isLoading) {
    return <Skeleton className="h-96 rounded-2xl" />;
  }

  if (isError) {
    return (
      <PanelShell tall>
        <EmptyPanel
          title="Follower flow couldn't load"
          body="The rest of your dashboard is still available. Retry this panel when you're ready."
          action={<Button variant="outline" size="sm" onClick={onRetry}><RefreshCw className="size-3.5" /> Retry</Button>}
          Icon={TrendingUp}
          accentClassName="bg-sky-400/10 text-sky-300"
        />
      </PanelShell>
    );
  }

  if (!summary || !stock) {
    return (
      <PanelShell tall>
        <EmptyPanel
          title="Waiting for follower snapshots"
          body="Daily adds need two days of follower geography. The snapshot worker fills this in automatically."
          Icon={TrendingUp}
          accentClassName="bg-sky-400/10 text-sky-300"
        />
      </PanelShell>
    );
  }

  const style = trendStyles[summary.trend];
  const TrendIcon = style.Icon;
  const freshness = now
    ? describeFreshness(stock.capturedAt, now, FOLLOWER_STALE_AFTER_DAYS)
    : null;
  const regionLegend = [
    { key: "us" as const, sum: summary.window7.us },
    { key: "southAsian" as const, sum: summary.window7.southAsian },
    { key: "anglosphere" as const, sum: summary.window7.anglosphere },
    { key: "other" as const, sum: summary.window7.other },
  ];

  return (
    <PanelShell className="relative overflow-hidden">
      <div className={cn("pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b", style.glow)} />
      <div className="relative space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-sky-300">
              <TrendingUp className="size-4" /> Follower flow
            </div>
            <h2 className="text-xl font-semibold tracking-tight">Where are your followers coming from?</h2>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", style.badge)}>
              <TrendIcon className="size-3.5" /> {style.label}
            </span>
            {freshness?.isStale && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-[11px] font-medium text-amber-200">
                <Clock className="size-3" /> Snapshots {freshness.label}
              </span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/15 px-4 py-3">
          <div className="text-xs text-muted-foreground">
            Where your new followers come from (7 days)
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {regionLegend.map(({ key, sum }) => (
              <span key={key} className="inline-flex items-center gap-1.5 text-xs text-foreground">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: REGION_COLORS[key] }} />
                <span className="font-semibold tabular-nums">{formatSignedCount(sum)}</span>
                <span className="text-muted-foreground">{REGION_LABELS[key]}</span>
              </span>
            ))}
          </div>
          {summary.window7.unattributed !== 0 && (
            <p className="mt-2 border-t border-white/5 pt-2 text-[11px] leading-relaxed text-muted-foreground">
              {formatSignedCount(summary.window7.unattributed)} more Meta counted but couldn't place —
              countries crossing its top-{stock.countriesReported} reporting cutoff.
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-foreground">Daily net adds by region</span>
            <span className="text-muted-foreground">Line = 7-day average</span>
          </div>
          <DailyAddsChart
            points={points}
            selectedDay={selectedDay}
            onDaySelect={onDaySelect}
          />
        </div>

        <SpikeCandidates points={points} />

        <div className="flex gap-3 rounded-xl border border-violet-400/15 bg-violet-400/5 p-3.5 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0 text-violet-300" />
          <p>
            Net adds (follows minus unfollows) diffed from Meta's follower geography, bucketed by UTC day.
            Meta reports only its top countries and lags about two days — the dashed newest bars can still shift,
            and days Meta skips are absorbed into the next bar.
          </p>
        </div>
      </div>
    </PanelShell>
  );
}
