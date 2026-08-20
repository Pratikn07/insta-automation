import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

// A single glanceable stat. Deliberately dumb: every string arrives already
// formatted, so the tile has no opinion about follower math and stays trivially
// testable. Domain formatting lives in FollowerKpiRow.
//
// It draws no rules and owns no outer spacing. FollowerKpiRow composes the cells
// into ONE bordered band and passes each cell's padding and dividers in through
// `className`. The version before this anchored itself with a bare `border-t`,
// which resolves to --color-border (#EBE8DF) — 1.12:1 against the ground, where
// every other separator on Home is border-line (1.55:1) or border-foreground
// (16.38:1). That single invisible hairline is why the row read as the gap
// between the two panels around it rather than as content.
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
  /** The one figure that is the score. Set on a single tile per row. */
  emphasis?: boolean;
  /** The band's cell geometry: padding and dividers. Owned by FollowerKpiRow. */
  className?: string;
}

export function KpiTile({
  label,
  value,
  context,
  note,
  isLoading = false,
  trendIcon: TrendIcon = null,
  emphasis = false,
  className,
}: KpiTileProps) {
  // An em-dash set at figure scale is a 60px-tall hole where a number should be,
  // and every tile shows one before the first snapshot lands. A placeholder is
  // not a figure, so it does not get a figure's size.
  const isPlaceholder = value === "—" || value === "";

  return (
    <div className={className}>
      <div className="label-caps">{label}</div>

      {isLoading ? (
        <Skeleton className={cn("mt-3 w-28", emphasis ? "h-9" : "h-7")} />
      ) : (
        <div className="mt-2.5 flex items-baseline gap-2">
          <span
            className={cn(
              "font-medium leading-tight tracking-tight tabular-nums",
              // Emphasis is scale, and only scale. The two supporting figures sit
              // on the `headline` step (1.25rem) and the score on `figure`
              // (1.8rem), so the step is a real one from the recorded type scale
              // rather than the arbitrary 0.4rem nudge this replaced — at 1.8 vs
              // 1.4 the score read as a slightly bigger peer.
              //
              // It is deliberately NOT moss. index.css reserves the accent for
              // "the system is working" and states the rule outright for
              // --color-chart-us: an accent that also means "United States" stops
              // meaning "the system is working". A comment here used to promise an
              // accent the code never applied; the promise was the wrong one.
              isPlaceholder
                ? "text-lg text-muted-foreground"
                : emphasis
                  ? "text-[1.8rem]"
                  : "text-xl",
            )}
          >
            {value}
          </span>
          {/* A direction mark, not a verdict — so muted ink, never moss. All three
              arrows share one colour because the down arrow is the reason: moss
              means "the system is working", and an accelerating week and a slowing
              one cannot both be delivered on a success colour. This is the same
              call Home's read panel already records, where the moss tint was
              dropped because "growth is 40% slower" would otherwise arrive on it.
              Urgent is not the alternative either: index.css scopes it to "the
              thing to do next, not a failure", and a slow week is not a task.
              The verdict belongs to Today's read, which can use words. */}
          {TrendIcon && <TrendIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
        </div>
      )}

      {!isLoading && context && (
        <p className="mt-2.5 max-w-[34ch] text-[12.5px] leading-snug text-foreground/75">
          {context}
        </p>
      )}
      {!isLoading && note && (
        <p className="mt-1.5 max-w-[34ch] text-[11px] leading-snug text-muted-foreground">{note}</p>
      )}
    </div>
  );
}
