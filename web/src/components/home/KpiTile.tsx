import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

// A single glanceable stat. Deliberately dumb: every string arrives already
// formatted, so the tile has no opinion about follower math and stays trivially
// testable. Domain formatting lives in FollowerKpiRow.
//
// It draws no rules and owns no outer spacing. FollowerKpiRow composes the cells
// into ONE bordered band and passes each cell's padding and dividers in through
// `className`. An earlier version anchored itself with a bare `border-t`, which
// resolves to --color-border (#EBE8DF) — 1.12:1 against the #F7F5EF ground,
// where every other separator on Home is border-line (1.55:1) or
// border-foreground (16.38:1). That invisible hairline is why the row read as the
// gap between the two panels around it.
export type KpiTone = "emerald" | "sky" | "violet";

/**
 * Past this many characters, a pre-formatted value is a phrase rather than a
 * figure, and setting it at 3.25rem overflows the column. Defensive: the tile
 * takes an arbitrary already-formatted string, so it cannot assume a short one.
 *
 * Today's longest real caller stays under it. FollowerKpiRow's below-min-sample
 * fallback prints "N of M" instead of a percentage, but GUIDE_FOLLOW_MIN_SAMPLE
 * is 5, so that denominator is single-digit and the string tops out around
 * "4 of 4". Raise the threshold's justification, not the threshold, if a caller
 * ever needs a genuinely long value.
 */
const LONG_VALUE = 8;

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
  /**
   * A minimal mark drawn from the same measurement as the figure — the trailing
   * series, or a meter toward a target. Sits under the figure so the cell has
   * something true to look at, which matters most in the states where the figure
   * itself is withheld.
   */
  visual?: ReactNode;
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
  visual,
  className,
}: KpiTileProps) {
  // At 3.25rem an em-dash is a ~55px-tall hole (52px type on 1.05 leading,
  // measured), and every tile shows one before the first snapshot lands. A
  // placeholder is not a figure, so it does not get a figure's size — the
  // `visual` below carries the cell instead.
  const isPlaceholder = value === "—" || value === "";
  const isLong = value.length > LONG_VALUE;

  return (
    <div className={className}>
      <div className="label-caps">{label}</div>

      {/* The figure group bottom-aligns inside a reserved box so that the score at
          3.25rem and the supporting figures at 2.25rem still drop their visuals
          onto one shared line across the band. Without it the three marks below
          start at three different heights and the row reads ragged.
          Only at lg, because that is the only breakpoint with three columns to
          align: stacked, the reserved height is a void above a placeholder. */}
      {isLoading ? (
        <Skeleton className={cn("mt-4 w-32", emphasis ? "h-12" : "h-9")} />
      ) : (
        <div className="mt-3 flex items-end lg:min-h-[3.4rem]">
          <div className="flex items-baseline gap-2.5">
          <span
            className={cn(
              // The line-height rides INSIDE the text shorthand on purpose. As a
              // separate `leading-[1.05]` class, tailwind-merge treats it as
              // conflicting with the arbitrary `text-[3.25rem]` below and silently
              // drops it, which left the figure on default 1.5 leading and made
              // the shared alignment box useless.
              "font-medium tracking-tight tabular-nums",
              // Emphasis is scale, and only scale. It is deliberately NOT moss:
              // index.css reserves the accent for "the system is working" and
              // states the rule outright on --color-chart-us, that an accent
              // also meaning "United States" stops meaning "the system is
              // working". A comment here once promised an accent the code never
              // applied; the promise was the wrong one.
              isPlaceholder
                ? "text-xl/[1.05] text-muted-foreground"
                : isLong
                  ? "text-2xl/[1.1]"
                  : emphasis
                    ? "text-[3.25rem]/[1.05]"
                    : "text-[2.25rem]/[1.05]",
            )}
          >
            {value}
          </span>
          {TrendIcon && (
            // A direction mark, not a verdict — so muted ink, never moss. All
            // three arrows share one colour because the down arrow is the
            // reason: an accelerating week and a slowing one cannot both be
            // delivered on a success colour. This is the call Home's read panel
            // already records, where the moss tint was dropped because "growth
            // is 40% slower" would otherwise arrive on it. Urgent is not the
            // alternative either: index.css scopes it to "the thing to do next,
            // not a failure", and a slow week is not a task. The verdict belongs
            // to Today's read, which can use words.
            <TrendIcon
              className={cn(
                "shrink-0 text-muted-foreground",
                emphasis ? "size-6" : "size-5",
              )}
              aria-hidden
            />
          )}
          </div>
        </div>
      )}

      {!isLoading && visual && <div className="mt-4">{visual}</div>}

      {!isLoading && context && (
        <p className="mt-3 max-w-[34ch] text-[12.5px] leading-snug text-foreground/75">
          {context}
        </p>
      )}
      {!isLoading && note && (
        <p className="mt-1.5 max-w-[34ch] text-[11px] leading-snug text-muted-foreground">{note}</p>
      )}
    </div>
  );
}
