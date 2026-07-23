import { UserPlus, Users, Hourglass } from "lucide-react";
import type { Stats } from "@/lib/types";
import { summarizeFollowerYield } from "@/lib/homeDashboard";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface FollowerYieldPanelProps {
  stats: Stats | undefined;
  isLoading: boolean;
}

/**
 * Funnel follower yield (fix #11): of the non-followers we delivered a guide to,
 * how many followed afterward. A lower bound — measured once a few days after
 * delivery — and correlational, so the copy says "followed after", not "because".
 */
export function FollowerYieldPanel({ stats, isLoading }: FollowerYieldPanelProps) {
  if (isLoading) return <Skeleton className="h-28 rounded-2xl" />;

  const summary = summarizeFollowerYield(stats?.followConversion);
  if (!summary) {
    return (
      <Card className="rounded-2xl border-white/10 bg-card/60">
        <CardContent className="p-4 text-sm text-muted-foreground">
          Follower yield is temporarily unavailable.
        </CardContent>
      </Card>
    );
  }

  const yieldLabel = summary.yieldPct == null ? "—" : `${summary.yieldPct}%`;

  return (
    <Card className="rounded-2xl border-white/10 bg-card/60">
      <CardContent className="grid gap-4 p-4 sm:grid-cols-[1.3fr_repeat(3,0.9fr)] sm:items-center">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-300">
            <UserPlus className="size-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">Funnel follower yield</div>
            <div className="text-xs text-muted-foreground">{summary.headline}</div>
          </div>
        </div>

        <Metric
          Icon={UserPlus}
          tone="text-emerald-300 bg-emerald-400/10"
          value={summary.state === "measured" ? yieldLabel : "—"}
          label={`followed within ${summary.windowDays}d`}
        />
        <Metric
          Icon={Users}
          tone="text-violet-200 bg-violet-400/10"
          value={`${summary.converted}/${summary.rechecked}`}
          label="converted / measured"
        />
        <Metric
          Icon={Hourglass}
          tone="text-amber-200 bg-amber-300/10"
          value={summary.pending}
          label="still measuring"
        />
      </CardContent>
    </Card>
  );
}

function Metric({
  Icon,
  tone,
  value,
  label,
}: {
  Icon: typeof UserPlus;
  tone: string;
  value: string | number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
      <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="size-3.5" />
      </div>
      <div>
        <div className="text-lg font-semibold tabular-nums leading-none">{value}</div>
        <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}
