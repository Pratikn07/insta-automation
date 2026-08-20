import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { apiRead } from "@/lib/api";
import type { FlagGroup, FlagView, FlagsResponse } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Grouped by blast radius, loudest first. That part of the old page worked: these
 * sixteen are not peers, and the group that can reach a real person is the one you
 * open during an incident.
 */
const GROUPS: { key: FlagGroup; heading: string }[] = [
  { key: "outbound", heading: "Reaches real people" },
  { key: "experiment", heading: "Measuring something" },
  { key: "assistive", heading: "Nothing leaves the app" },
  { key: "infrastructure", heading: "Not a product choice" },
];

/**
 * The list of switches: one line each, no descriptions, no controls.
 *
 * Both omissions are the point. Three sentences per row made sixteen rows
 * unreadable, and a list you scan should not have a stop button in it — the whole
 * reason stopping is one click is that it should be deliberate, which means it
 * belongs on a page you chose to open.
 */
export function Switches() {
  const query = useQuery<FlagsResponse>({
    queryKey: ["flags"],
    queryFn: ({ signal }) => apiRead<FlagsResponse>("/flags", { signal }),
  });
  const all = query.data?.flags ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Switches</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every switch in the system. Open one to see what it does and change it.
        </p>
      </div>

      {query.isLoading ? (
        <div className="space-y-2 border-t pt-3">
          <Skeleton className="h-8 rounded-md" />
          <Skeleton className="h-8 rounded-md" />
        </div>
      ) : query.isError ? (
        <p className="border-t py-4 text-[13px] text-muted-foreground">
          Couldn&apos;t load your switches — the API did not answer. This is a connection
          problem, not an empty list.{" "}
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="underline underline-offset-2 [@media(pointer:coarse)]:min-h-11"
          >
            Try again
          </button>
        </p>
      ) : (
        GROUPS.map(({ key, heading }) => {
          const rows = all.filter((entry) => entry.group === key);
          if (rows.length === 0) return null;
          return (
            <section key={key}>
              <h2 className="label-caps border-b border-line pb-1.5">{heading}</h2>
              <ul>
                {rows.map((entry) => (
                  <SwitchRow key={entry.key} flag={entry} />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

function SwitchRow({ flag }: { flag: FlagView }) {
  // A percentage reads as its number. "Off" for a rollout at zero would be a second
  // vocabulary for the same fact, and the number is the more useful one.
  const isPercent = flag.kind === "percent";
  const live = isPercent ? (flag.valuePercent ?? 0) > 0 : flag.valueBool === true;

  return (
    <li>
      <Link
        to={`/switches/${flag.key}`}
        className="grid grid-cols-[1fr_auto_auto_16px] items-center gap-3 border-b py-3 transition-[padding] hover:pl-1.5 active:opacity-60 [@media(pointer:coarse)]:min-h-11"
      >
        <span className="text-sm font-medium">{flag.name}</span>
        <span className="text-[12.5px] text-muted-foreground">
          {flag.experimentName ? `part of ${flag.experimentName}` : ""}
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium",
            live ? "bg-signal-soft text-signal" : "bg-muted text-muted-foreground",
          )}
        >
          {isPercent ? `${flag.valuePercent ?? 0}%` : live ? "Live" : "Off"}
        </span>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  );
}
