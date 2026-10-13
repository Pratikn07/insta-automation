import * as React from "react";
import { cn } from "@/lib/utils";
import type { FunnelStageCount } from "@/lib/types";

// The stage list.
//
// NOT a tapering funnel chart. That shape asserts strict sequence — everyone at
// stage N arrived through stage N-1 — and this funnel does not work that way:
// 1,355 of 1,557 guide recipients reach delivery WITHOUT replying, because they
// were already following and were served immediately. A tapering shape would
// draw a sequence that does not exist.
//
// So: horizontal bars on a shared baseline, each drawn against the full cohort
// so lengths are comparable down the list, and the track behind each bar makes
// the LOSS visible rather than only the size. Stages people can join without
// passing the previous one are marked and show no step conversion — the API
// already sends ofPrevPct: null for them; this just refuses to invent one.

export interface FunnelStagesProps {
  stages: FunnelStageCount[];
  cohortSize: number;
  /** Rendered under a stage when a meaningful number was lost reaching it. */
  renderLoss?: (stage: FunnelStageCount, lost: number) => React.ReactNode;
  /** Extra content per stage, keyed by stage key (e.g. a caveat). */
  notes?: Record<string, React.ReactNode>;
  /**
   * Also print each later stage's share of the first stage ("44.7% of all"). Off by
   * default: inside a lane the first stage is the lane, and "of all" would mislead.
   */
  showShareOfEntry?: boolean;
}

export function FunnelStages({
  stages,
  cohortSize,
  renderLoss,
  notes,
  showShareOfEntry = false,
}: FunnelStagesProps) {
  return (
    <ol className="flex list-none flex-col gap-0 p-0">
      {stages.map((stage, i) => {
        const prev = i === 0 ? null : stages[i - 1];
        // Only a real sequential step can "lose" people. Across a joinable
        // stage the difference is a different population; across a
        // coverage-only stage it is a worker that has not caught up. Reporting
        // either as loss states attrition the data does not show.
        const lost =
          prev && !stage.bypassable && !stage.coverageOnly ? prev.count - stage.count : 0;
        const widthPct = cohortSize > 0 ? (stage.count / cohortSize) * 100 : 0;

        return (
          <li key={stage.key} className="border-b border-border/60 py-4 last:border-b-0">
            <div className="mb-2.5 flex items-baseline justify-between gap-5">
              <span className="flex items-baseline gap-2.5">
                <span className="text-sm font-medium" title={stage.definition}>
                  {stage.label}
                </span>
                {stage.bypassable && (
                  <span
                    className="rounded-sm border px-2 py-px text-[10px] uppercase tracking-[0.06em] text-muted-foreground"
                    title="People reach this stage without passing the one above, so no step conversion is shown."
                  >
                    joinable
                  </span>
                )}
              </span>

              <span className="flex shrink-0 items-baseline gap-3.5 whitespace-nowrap">
                <span className="text-lg font-medium tabular-nums tracking-[-0.02em]">
                  {stage.count.toLocaleString()}
                </span>
                <span
                  className={cn(
                    "min-w-[4.5rem] text-right text-xs tabular-nums text-muted-foreground",
                    stage.ofPrevPct === null && "italic",
                  )}
                >
                  {stage.ofPrevPct === null ? "no step" : `${stage.ofPrevPct}%`}
                </span>
                {showShareOfEntry && i > 0 && stage.ofEntryPct !== null ? (
                  <span className="text-right text-xs tabular-nums text-muted-foreground">
                    {`${stage.ofEntryPct}% of all`}
                  </span>
                ) : null}
              </span>
            </div>

            <div
              className="relative h-2.5 overflow-hidden rounded-sm bg-[color:var(--color-funnel-track)]"
              role="img"
              aria-label={`${stage.label}: ${stage.count.toLocaleString()} of ${cohortSize.toLocaleString()}`}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-sm bg-[color:var(--color-funnel-mark)]"
                // A stage with a real but tiny count must still be visible —
                // "5" rendering as nothing reads as a bug, not as a number.
                style={{ width: `${Math.max(widthPct, stage.count > 0 ? 0.15 : 0)}%` }}
              />
            </div>

            {lost > 0 && renderLoss?.(stage, lost)}
            {notes?.[stage.key]}
          </li>
        );
      })}
    </ol>
  );
}
