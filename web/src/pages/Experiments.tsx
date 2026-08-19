import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { apiRead } from "@/lib/api";
import { people, windowRemaining } from "@/lib/experimentWindow";
import type { ExperimentListItem, ExperimentState, ExperimentsResponse } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const STATE: Record<ExperimentState, { label: string; tone: string; order: number }> = {
  running: { label: "Running", tone: "bg-signal-soft text-signal", order: 0 },
  not_started: { label: "Not started", tone: "bg-muted text-muted-foreground", order: 1 },
  ended: { label: "Ended", tone: "bg-caution-soft text-caution", order: 2 },
};

/**
 * One line per experiment: its name, its state, and the one number that matters.
 *
 * `not_started` is listed here rather than hidden or given its own page, because a
 * list of experiments that could run tomorrow is the most useful thing on it. Those
 * rows show their blocker instead of counts — a row of zeroes reads as "we tried and
 * nobody converted", which is a different and untrue claim.
 */
export function Experiments() {
  const query = useQuery<ExperimentsResponse>({
    queryKey: ["experiments"],
    queryFn: ({ signal }) => apiRead<ExperimentsResponse>("/experiments", { signal }),
  });

  // Running first: it is the only one that can need a decision from you.
  const rows = [...(query.data?.experiments ?? [])].sort(
    (a, b) => STATE[a.state].order - STATE[b.state].order,
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Experiments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Where two things are being compared, so you can tell which works better.
        </p>
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
        <ul className="border-t">
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
  const remaining = windowRemaining(row.summary.endsAt);
  return [...arms, remaining].filter(Boolean).join(" · ");
}
