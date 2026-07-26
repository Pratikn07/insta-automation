import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// A single glanceable stat. Deliberately dumb: every string arrives already
// formatted, so the tile has no opinion about follower math and stays trivially
// testable. Domain formatting lives in FollowerKpiRow.
export type KpiTone = "emerald" | "sky" | "violet";

export interface KpiTileProps {
  label: string;
  value: string;
  context?: string | null;
  note?: string | null;
  Icon: LucideIcon;
  tone?: KpiTone;
  isLoading?: boolean;
  trendIcon?: LucideIcon | null;
}

const TONES: Record<KpiTone, { chip: string; value: string; glow: string }> = {
  emerald: {
    chip: "bg-emerald-400/10 text-emerald-300",
    value: "text-emerald-300",
    glow: "from-emerald-400/12 to-transparent",
  },
  sky: {
    chip: "bg-sky-400/10 text-sky-300",
    value: "text-sky-300",
    glow: "from-sky-400/12 to-transparent",
  },
  violet: {
    chip: "bg-violet-400/10 text-violet-200",
    value: "text-violet-200",
    glow: "from-violet-400/12 to-transparent",
  },
};

export function KpiTile({
  label,
  value,
  context,
  note,
  Icon,
  tone = "sky",
  isLoading = false,
  trendIcon: TrendIcon = null,
}: KpiTileProps) {
  const t = TONES[tone];

  return (
    <Card className="relative overflow-hidden rounded-2xl border-white/10 bg-card/85">
      <div className={cn("pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b", t.glow)} />
      <CardContent className="relative p-5 pt-5">
        <div className="flex items-center gap-2.5">
          <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", t.chip)}>
            <Icon className="size-4" />
          </div>
          <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {label}
          </div>
        </div>

        {isLoading ? (
          <Skeleton className="mt-4 h-10 w-28" />
        ) : (
          <div className="mt-4 flex items-baseline gap-2">
            <span className={cn("text-4xl font-semibold tracking-[-0.04em] tabular-nums", t.value)}>
              {value}
            </span>
            {TrendIcon && <TrendIcon className={cn("size-5 shrink-0", t.value)} />}
          </div>
        )}

        {!isLoading && context && (
          <p className="mt-2 text-sm leading-snug text-foreground/80">{context}</p>
        )}
        {!isLoading && note && (
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{note}</p>
        )}
      </CardContent>
    </Card>
  );
}
