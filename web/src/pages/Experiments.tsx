import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRead } from "@/lib/api";
import { people, windowRemaining } from "@/lib/experimentWindow";
import type { ExperimentListItem, ExperimentState, ExperimentsResponse } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type LifecycleTab = "active" | "planned" | "concluded";

const STATE: Record<ExperimentState, { label: string; tone: string; tab: LifecycleTab }> = {
  running: { label: "Active", tone: "bg-signal-soft text-signal", tab: "active" },
  not_started: { label: "Planned", tone: "bg-muted text-muted-foreground", tab: "planned" },
  ended: { label: "Concluded", tone: "bg-caution-soft text-caution", tab: "concluded" },
};

const TABS: { key: LifecycleTab; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "planned", label: "Planned" },
  { key: "concluded", label: "Concluded" },
];

const dayFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

/**
 * One line per experiment: its name, its state, and the one number that matters.
 *
 * `not_started` is listed here rather than hidden or given its own page, because a
 * list of experiments that could run tomorrow is the most useful thing on it. Those
 * rows show their blocker instead of counts — a row of zeroes reads as "we tried and
 * nobody converted", which is a different and untrue claim.
 */
export function Experiments() {
  const [tab, setTab] = useState<LifecycleTab>("active");
  const query = useQuery<ExperimentsResponse>({
    queryKey: ["experiments"],
    queryFn: ({ signal }) => apiRead<ExperimentsResponse>("/experiments", { signal }),
  });

  const allRows = query.data?.experiments ?? [];
  const rows = allRows.filter((row) => STATE[row.state].tab === tab);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Experiments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Where two things are being compared, so you can tell which works better.
        </p>
      </div>

      <div role="tablist" aria-label="Experiment lifecycle" className="flex gap-1 border-b">
        {TABS.map((item) => {
          const count = allRows.filter((row) => STATE[row.state].tab === item.key).length;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                "-mb-px min-h-10 border-b-2 px-3 text-[13px] font-medium transition-colors",
                tab === item.key
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label} ({count})
            </button>
          );
        })}
      </div>

      {query.isLoading ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : query.isError ? (
        <p className="border-t py-4 text-[13px] text-muted-foreground">
          Couldn&apos;t load these — the API did not answer. This is a connection problem,
          not an empty list.{" "}
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="underline underline-offset-2 [@media(pointer:coarse)]:min-h-11"
          >
            Try again
          </button>
        </p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.key}>
              <Link
                to={`/experiments/${row.key}`}
                className="grid grid-cols-[1fr_auto_16px] items-center gap-3 border-b py-3.5 transition-[padding] hover:pl-1.5 active:opacity-60 [@media(pointer:coarse)]:min-h-11"
              >
                <span>
                  <span className="block text-sm font-medium">{row.name}</span>
                  <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                    {headline(row)}
                  </span>
                </span>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium",
                    STATE[row.state].tone,
                  )}
                >
                  {STATE[row.state].label}
                </span>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="border-b py-6 text-center text-[13px] text-muted-foreground">
              No {tab} experiments.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * The secondary line. Counts and a countdown while it runs; the blocker otherwise.
 *
 * The arm labels come from the server rather than being written here, so the list
 * and the detail page cannot describe the same arm two different ways.
 */
function headline(row: ExperimentListItem): string {
  if (row.summary.kind === "not_started") return row.summary.blocker;

  const arms = row.summary.arms.map((arm) => `${arm.label} ${people(arm.people)}`);
  if (row.summary.kind === "ended") {
    return [...arms, `Concluded ${dayFormat.format(new Date(row.summary.endedAt))}`].join(" · ");
  }
  const remaining = windowRemaining(row.summary.endsAt);
  return [...arms, remaining].filter(Boolean).join(" · ");
}
