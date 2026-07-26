import { CheckCircle2, Clock3, RefreshCw, Send } from "lucide-react";
import type { Stats } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface AutomationHealthStripProps {
  stats: Stats | undefined;
  isLoading: boolean;
}

export function AutomationHealthStrip({ stats, isLoading }: AutomationHealthStripProps) {
  if (isLoading) return <Skeleton className="h-24 rounded-2xl" />;

  if (!stats) {
    return (
      <Card className="rounded-2xl border-white/10 bg-card/60">
        <CardContent className="p-4 text-sm text-muted-foreground">Automation health is temporarily unavailable.</CardContent>
      </Card>
    );
  }

  const items = [
    { label: "Sequences today", value: stats.completedToday, Icon: CheckCircle2, tone: "text-emerald-300 bg-emerald-400/10" },
    { label: "Awaiting reply", value: stats.conversationsAwaiting, Icon: Clock3, tone: "text-amber-200 bg-amber-300/10" },
    { label: "Retries queued", value: stats.gateQueuePending, Icon: RefreshCw, tone: "text-violet-200 bg-violet-400/10" },
  ];

  return (
    <Card className="rounded-2xl border-white/10 bg-card/60">
      <CardContent className="grid gap-4 p-4 sm:grid-cols-[1.1fr_repeat(3,1fr)] sm:items-center">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/5 text-muted-foreground">
            <Send className="size-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">Automation health</div>
            <div className="text-xs text-muted-foreground">Quietly keeping your delivery loop visible</div>
          </div>
        </div>
        {items.map(({ label, value, Icon, tone }) => (
          <div key={label} className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
            <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${tone}`}><Icon className="size-3.5" /></div>
            <div>
              <div className="text-lg font-semibold tabular-nums leading-none">{value}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
