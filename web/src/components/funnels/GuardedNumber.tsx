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
 */
const SIZES = {
  hero: {
    value: "text-[2.6rem] sm:text-[3rem] font-medium tracking-[-0.03em]",
    counts: "mt-3 text-[13px] text-foreground/85",
  },
  kpi: {
    value: "text-2xl font-medium tracking-[-0.02em]",
    counts: "mt-1 text-xs text-muted-foreground",
  },
  inline: {
    value: "text-base font-medium tracking-[-0.01em]",
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
        <div className={cn(s.value, "tabular-nums text-foreground")}>{counts}</div>
        <p className={s.counts}>
          {rate.belowMinSample ? "too few to rate" : "nothing measured yet"}
          {unit ? ` · ${unit}` : ""}
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className={cn(s.value, "tabular-nums text-funnel-mark")}>
        {rate.pct}%
      </div>
      <p className={s.counts}>
        <span className="tabular-nums">{counts}</span>
        {unit ? ` ${unit}` : ""}
      </p>
    </div>
  );
}
