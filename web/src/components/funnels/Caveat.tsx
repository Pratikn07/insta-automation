import * as React from "react";
import { cn } from "@/lib/utils";

// A limit on the data, rendered so it cannot be skimmed past.
//
// Promoted from the one-off amber block in Insights.tsx, which was the right
// instinct: the panels most likely to be misread are the ones that need a
// caveat welded to them rather than parked in a footer. On this page two are
// load-bearing rather than decorative:
//
//   - "still following at 21 days: 5" is COVERAGE, not churn. Without the
//     caveat a reader concludes retention collapsed.
//   - the grey block in the read-evidence bar is an absence of tracking, not
//     evidence of being ignored.
//
// Amber, not red: these are limits on what we know, not failures.

export function Caveat({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3",
        className,
      )}
    >
      <span aria-hidden className="mt-[3px] h-auto w-[3px] shrink-0 rounded-full bg-amber-400/70" />
      <p className="text-[12.5px] leading-relaxed text-amber-200/90">{children}</p>
    </div>
  );
}
