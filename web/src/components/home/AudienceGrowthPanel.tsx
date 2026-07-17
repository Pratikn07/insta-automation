import { ArrowDownRight, ArrowRight, ArrowUpRight, RefreshCw, Sparkles, UsersRound } from "lucide-react";
import type { GeoWindowPoint } from "@/lib/types";
import { formatAudienceDelta, type AudienceGrowthSummary } from "@/lib/homeDashboard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardSparkline } from "./DashboardSparkline";

interface AudienceGrowthPanelProps {
  points: GeoWindowPoint[];
  summary: AudienceGrowthSummary | null;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

const statusStyles = {
  growing: {
    label: "Growing",
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
  cooling: {
    label: "Cooling",
    Icon: ArrowDownRight,
    badge: "border-rose-400/25 bg-rose-400/10 text-rose-300",
    glow: "from-rose-400/15 via-rose-400/5 to-transparent",
  },
} as const;

export function AudienceGrowthPanel({
  points,
  summary,
  isLoading,
  isError,
  onRetry,
}: AudienceGrowthPanelProps) {
  if (isLoading) {
    return <Skeleton className="min-h-[600px] rounded-2xl" />;
  }

  if (isError) {
    return (
      <PanelShell>
        <EmptyPanel
          title="Audience signal couldn't load"
          body="Your reel data is still available. Retry this panel when you're ready."
          action={<Button variant="outline" size="sm" onClick={onRetry}><RefreshCw className="size-3.5" /> Retry</Button>}
        />
      </PanelShell>
    );
  }

  if (!summary) {
    return (
      <PanelShell>
        <EmptyPanel
          title="Waiting for an audience snapshot"
          body="Once Meta returns two geography windows, this card will compare your recent US audience with the 90-day baseline."
        />
      </PanelShell>
    );
  }

  const style = statusStyles[summary.status];
  const StatusIcon = style.Icon;
  const trendValues = points.map((point) =>
    summary.source === "reached" ? point.reachedUs14 : point.engagedUs14,
  );
  const latest = summary.latestPoint;

  return (
    <PanelShell className="relative overflow-hidden">
      <div className={cn("pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b", style.glow)} />
      <div className="relative space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-emerald-300">
              <UsersRound className="size-4" /> Audience growth
            </div>
            <h2 className="text-xl font-semibold tracking-tight">Is my US audience growing?</h2>
          </div>
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", style.badge)}>
            <StatusIcon className="size-3.5" /> {style.label}
          </span>
        </div>

        <div className="grid items-end gap-5 sm:grid-cols-[auto_1fr]">
          <div>
            <div className="flex items-baseline gap-1">
              <span className="text-6xl font-semibold tracking-[-0.06em] text-white">{summary.currentPct.toFixed(1)}</span>
              <span className="text-2xl font-medium text-emerald-300">%</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              US share of your recently {summary.source} audience
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/15 px-4 py-3">
            <div className="text-xs text-muted-foreground">Compared with your 90-day baseline</div>
            <div className="mt-1 text-lg font-semibold text-white">{formatAudienceDelta(summary.deltaPoints)}</div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-foreground">US audience trend</span>
            <span className="text-muted-foreground">Recent snapshots</span>
          </div>
          <DashboardSparkline values={trendValues} label="US audience trend" />
        </div>

        <div className="space-y-4">
          <ComparisonRow label="Reached" recent={latest.reachedUs14} baseline={latest.reachedUs90} />
          <ComparisonRow label="Engaged" recent={latest.engagedUs14} baseline={latest.engagedUs90} />
        </div>

        <div className="flex gap-3 rounded-xl border border-violet-400/15 bg-violet-400/5 p-3.5 text-xs leading-relaxed text-muted-foreground">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-violet-300" />
          <p>
            This compares the recent 14 days with your 90-day account baseline. It is a directional audience signal—not proof that one reel caused the change.
          </p>
        </div>
      </div>
    </PanelShell>
  );
}

function ComparisonRow({ label, recent, baseline }: { label: string; recent: number | null; baseline: number | null }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">US audience share</span>
      </div>
      <div className="grid grid-cols-[92px_1fr_46px] items-center gap-2 text-[11px]">
        <span className="text-emerald-300">Recent 14 days</span>
        <div className="h-2 overflow-hidden rounded-full bg-white/5">
          <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.min(Math.max(recent ?? 0, 0), 100)}%` }} />
        </div>
        <span className="text-right font-semibold tabular-nums text-foreground">{recent === null ? "—" : `${recent.toFixed(1)}%`}</span>
        <span className="text-muted-foreground">90-day baseline</span>
        <div className="h-2 overflow-hidden rounded-full bg-white/5">
          <div className="h-full rounded-full bg-white/30" style={{ width: `${Math.min(Math.max(baseline ?? 0, 0), 100)}%` }} />
        </div>
        <span className="text-right font-medium tabular-nums text-muted-foreground">{baseline === null ? "—" : `${baseline.toFixed(1)}%`}</span>
      </div>
    </div>
  );
}

function PanelShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("min-h-[600px] rounded-2xl border-white/10 bg-card/85 shadow-xl shadow-black/10", className)}>
      <CardContent className="p-5 sm:p-6">{children}</CardContent>
    </Card>
  );
}

function EmptyPanel({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-[540px] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-emerald-400/10 text-emerald-300">
        <UsersRound className="size-6" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
