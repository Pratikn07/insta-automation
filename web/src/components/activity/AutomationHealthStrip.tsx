import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, Send } from "lucide-react";
import type { Stats, TokenHealth } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface AutomationHealthStripProps {
  stats: Stats | undefined;
  isLoading: boolean;
}

// Instagram token countdown, rendered ONLY when something is wrong.
//
// The refresh worker is supposed to hold this at "healthy" permanently, so a
// standing "token is fine" badge would be noise nobody reads — and then nobody
// reads it on the day it matters either. It appears only when action is needed.
//
// Worth having even though refreshing is automatic: the worker itself can stop,
// and an unwatched worker is precisely how the 2026-07-26 expiry took the Graph
// API down with nothing raising a hand.
function TokenAlarm({ health }: { health: TokenHealth }) {
  if (health.status === "healthy") return null;

  const critical = health.status === "critical" || health.status === "expired";
  const window = health.status === "expired"
    ? "has expired"
    : `expires in ${health.daysUntilExpiry} ${health.daysUntilExpiry === 1 ? "day" : "days"}`;

  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 sm:col-span-4 ${
        critical
          ? "border-urgent bg-urgent-soft text-urgent"
          : "border-caution bg-caution-soft text-caution"
      }`}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="text-xs leading-relaxed">
        <span className="font-semibold">Instagram token {window}.</span>{" "}
        <span className="text-muted-foreground">
          Auto-refresh should prevent this — if it is showing, generate a new token in the
          Meta App Dashboard and update IG_ACCESS_TOKEN.
        </span>
      </div>
    </div>
  );
}

export function AutomationHealthStrip({ stats, isLoading }: AutomationHealthStripProps) {
  if (isLoading) return <Skeleton className="h-24 rounded-2xl" />;

  if (!stats) {
    return (
      <Card className="rounded-2xl border-border bg-card/60">
        <CardContent className="p-4 text-sm text-muted-foreground">Automation health is temporarily unavailable.</CardContent>
      </Card>
    );
  }

  // An ambiguous gate send is never retried, because the DM may already have
  // landed and a retry would double-send. That makes each one a person who might
  // never have received their gate, with nothing else on screen saying so. It
  // should read as zero almost always, so it replaces the retry tile only when
  // there is something to act on rather than occupying a slot permanently.
  const uncertain = stats.gateQueueSendUncertain ?? 0;

  const items = [
    { label: "Guides today", value: stats.completedToday, Icon: CheckCircle2, tone: "text-signal bg-signal-soft" },
    { label: "Awaiting reply", value: stats.conversationsAwaiting, Icon: Clock3, tone: "text-caution bg-caution-soft" },
    uncertain > 0
      ? { label: "Needs review", value: uncertain, Icon: AlertTriangle, tone: "text-urgent bg-urgent-soft" }
      : { label: "Retries queued", value: stats.gateQueuePending, Icon: RefreshCw, tone: "text-funnel-mark bg-mark-soft" },
  ];

  return (
    <Card className="rounded-2xl border-border bg-card/60">
      <CardContent className="grid gap-4 p-4 sm:grid-cols-[1.1fr_repeat(3,1fr)] sm:items-center">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Send className="size-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">Automation health</div>
            <div className="text-xs text-muted-foreground">Quietly keeping your delivery loop visible</div>
          </div>
        </div>
        {items.map(({ label, value, Icon, tone }) => (
          <div key={label} className="flex items-center gap-3 rounded-xl border border-border bg-card/40 px-3 py-2.5">
            <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${tone}`}><Icon className="size-3.5" /></div>
            <div>
              <div className="text-lg font-semibold tabular-nums leading-none">{value}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
            </div>
          </div>
        ))}
        {stats.tokenHealth && <TokenAlarm health={stats.tokenHealth} />}
      </CardContent>
    </Card>
  );
}
