import { cn } from "@/lib/utils";
import type { GuardedRate } from "@/lib/types";

// The most important component on the Funnels page.
//
// A percentage over a handful of people is not a number, it is an invitation to
// a decision the sample cannot support. The API already decides this — it
// returns pct: null with belowMinSample: true — and this component's only job is
// to not throw that away. When the sample is thin the COUNTS take the value slot
// and the percentage is never rendered at all: not greyed out, not in
// parentheses, not behind a tooltip. A reader who skims sees "5 of 32", which is
// the truth, rather than "15.6%", which is not.
//
// Counts also travel with a healthy percentage, one line down. "74.8%" alone
// invites a comparison that "202 of 270" immediately qualifies.

export interface GuardedNumberProps {
  rate: GuardedRate;
  /** What the rate is OF, e.g. "answered the unlock DM". */
  unit?: string;
  size?: "hero" | "kpi" | "inline";
  className?: string;
}

/**
 * One colour was used at all three sizes: funnel-soft, which measures 3.32:1 on
 * paper. That clears the 3:1 a LARGE figure needs and fails the 4.5:1 that
 * 16px text needs, so the same token was legal on the hero and illegal on the
 * inline row it also styled. The mark colour (funnel-mark, 8.41:1) is legible at
 * every size, so the rate now uses one value that is right everywhere rather
 * than one that happens to pass at the top of the page.
 *
 * The sizes are steps on the shared figure ladder in index.css, not values
 * chosen here. This file used to hold its own scale, and it drifted from Home's:
 * the two leads landed on 3rem and 3.25rem, and 1.5rem meant "kpi" here and
 * "too long to be a figure" there. Each utility carries its own size, leading,
 * tracking, weight and tabular-nums, so do not re-add `tracking-*` or
 * `tabular-nums` at a call site — the ladder tightens tracking as type grows and
 * a stray class would fight it by stylesheet order.
 */
const SIZES = {
  hero: {
    value: "figure-lead",
    counts: "mt-3 text-[13px] text-foreground/85",
  },
  kpi: {
    value: "figure-small",
    counts: "mt-1 text-xs text-muted-foreground",
  },
  inline: {
    value: "figure-inline",
    counts: "mt-0.5 text-[11px] text-muted-foreground",
  },
} as const;

export function GuardedNumber({ rate, unit, size = "kpi", className }: GuardedNumberProps) {
  const s = SIZES[size];
  const counts = `${rate.numerator.toLocaleString()} of ${rate.denominator.toLocaleString()}`;

  if (rate.pct === null) {
    return (
      <div className={className}>
        {/* Counts occupy the value slot. There is no percentage to hide. */}
        <div className={cn(s.value, "text-foreground")}>{counts}</div>
        <p className={s.counts}>
          {rate.belowMinSample ? "too few to rate" : "nothing measured yet"}
          {unit ? ` · ${unit}` : ""}
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className={cn(s.value, "text-funnel-mark")}>
        {rate.pct}%
      </div>
      <p className={s.counts}>
        <span className="tabular-nums">{counts}</span>
        {unit ? ` ${unit}` : ""}
      </p>
    </div>
  );
}
