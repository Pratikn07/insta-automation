import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

// A single glanceable stat. Deliberately dumb: every string arrives already
// formatted, so the tile has no opinion about follower math and stays trivially
// testable. Domain formatting lives in FollowerKpiRow.
//
// Maison renders it with no container at all. The old tile was a filled card
// with a tonal glow and an icon chip; here a hairline above the label does the
// separating, and the figure carries the weight. `tone` and `Icon` survive in
// the API because callers and tests still pass them, but this world has no icon
// system and no tonal fills — the accent is reserved for the emphasised figure.
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
}

export function KpiTile({
  label,
  value,
  context,
  note,
  isLoading = false,
  trendIcon: TrendIcon = null,
  emphasis = false,
}: KpiTileProps) {
  // An em-dash set at figure scale is a 60px-tall hole where a number should be,
  // and every tile shows one before the first snapshot lands. A placeholder is
  // not a figure, so it does not get a figure's size.
  const isPlaceholder = value === "—" || value === "";

  return (
    <div className="border-t pt-3">
      <div className="label-caps">{label}</div>

      {isLoading ? (
        <Skeleton className={cn("mt-2.5 w-28", emphasis ? "h-9" : "h-7")} />
      ) : (
        <div className="mt-2 flex items-baseline gap-2">
          <span
            className={cn(
              "font-display leading-[0.9]",
              isPlaceholder
                ? "text-[1.5rem] text-muted-foreground"
                : emphasis
                  ? "text-[2.4rem] text-gold sm:text-[2.9rem]"
                  : "text-[1.7rem]",
            )}
          >
            {value}
          </span>
          {TrendIcon && (
            <TrendIcon className="size-4 shrink-0 text-gold-text" aria-hidden />
          )}
        </div>
      )}

      {!isLoading && context && (
        <p className="mt-2 text-[12.5px] leading-snug text-foreground/75">{context}</p>
      )}
      {!isLoading && note && (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{note}</p>
      )}
    </div>
  );
}
