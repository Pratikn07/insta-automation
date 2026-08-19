import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { apiRead } from "@/lib/api";
import { people, windowRemaining } from "@/lib/experimentWindow";
import type { ExperimentDetailView } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";

const dayFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

/**
 * One experiment's result — or, if it never ran, what it would have compared.
 *
 * Counts in whole people and nothing else. No confidence intervals, no significance
 * bars, no "visitors remaining": the Optimizely pages this design borrows its shape
 * from show 285,991 visitors, and this experiment has 594 sends. `docs/funnels.md`
 * already refuses to print a rate its sample cannot support.
 *
 * No controls here either. An experiment is changed by changing the switches it
 * owns, and those are linked at the bottom — which keeps one switch in one place.
 */
export function ExperimentDetail() {
  const { key = "" } = useParams();
  const query = useQuery<ExperimentDetailView>({
    queryKey: ["experiments", key],
    queryFn: ({ signal }) => apiRead<ExperimentDetailView>(`/experiments/${key}`, { signal }),
  });

  const experiment = query.data;

  return (
    <div className="space-y-5">
      <Link
        to="/experiments"
        className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Experiments
      </Link>

      {query.isLoading ? (
        <Skeleton className="h-56 rounded-lg" />
      ) : query.isError || !experiment ? (
        <p className="text-[13px] text-muted-foreground">
          Couldn&apos;t load this — the API did not answer. This is a connection problem,
          not a missing experiment.
        </p>
      ) : (
        <>
          <h1 className="text-2xl font-medium tracking-tight">{experiment.name}</h1>

          <div className="space-y-3 rounded-lg bg-signal-soft px-4 py-3.5">
            <p className="text-[14.5px] leading-relaxed">{experiment.doesWhat}</p>
            <p className="text-[13.5px] leading-relaxed">
              <span className="font-medium">Who it affects:</span> {experiment.affectsWho}
            </p>
            <p className="text-[13.5px] leading-relaxed">
              <span className="font-medium">What decides it:</span> {experiment.outcome}
            </p>
          </div>

          {experiment.summary.kind === "running" ? (
            <>
              <section aria-labelledby="so-far">
                <h2 id="so-far" className="label-caps border-b border-line pb-1.5">
                  So far
                </h2>
                <ul className="mt-1">
                  {experiment.summary.arms.map((arm) => (
                    <li
                      key={arm.key}
                      className="grid grid-cols-[1fr_auto] items-baseline gap-3 border-b py-2.5"
                    >
                      <span className="text-[13.5px]">{arm.label}</span>
                      <span className="text-lg font-medium tabular-nums">
                        {people(arm.people)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[12.5px] text-muted-foreground">
                  People, not rates. Too few to turn into a percentage honestly.
                </p>
              </section>

              {experiment.summary.notCounted.length > 0 && (
                <section aria-labelledby="skipped">
                  <h2 id="skipped" className="label-caps border-b border-line pb-1.5">
                    Skipped, and why
                  </h2>
                  <ul className="mt-1">
                    {experiment.summary.notCounted.map((row) => (
                      <li
                        key={row.reason}
                        className="grid grid-cols-[1fr_auto] items-baseline gap-3 border-b py-2 text-[13px]"
                      >
                        <span className="text-muted-foreground">{row.reason}</span>
                        <span className="tabular-nums">{people(row.people)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[12.5px] text-muted-foreground">
                    Neither arm: never reminded, and never a control either. Every person is
                    in exactly one row on this page.
                  </p>
                </section>
              )}

              <section className="rounded-md bg-caution-soft px-3.5 py-3 text-[13px] text-caution">
                {experiment.summary.endsAt && (
                  <p className="font-medium">
                    Closes {dayFormat.format(new Date(experiment.summary.endsAt))}
                    {windowRemaining(experiment.summary.endsAt)
                      ? ` · ${windowRemaining(experiment.summary.endsAt)}`
                      : ""}
                  </p>
                )}
                <p className="mt-1">{experiment.summary.whenItEnds}</p>
              </section>
            </>
          ) : (
            <section className="space-y-2 rounded-lg border border-dashed px-4 py-4">
              <h2 className="text-sm font-medium">Not started</h2>
              <p className="text-[13.5px] text-muted-foreground">{experiment.summary.blocker}</p>
              <p className="text-[13.5px]">
                <span className="text-muted-foreground">It would compare:</span>{" "}
                {experiment.summary.wouldCompare}
              </p>
            </section>
          )}

          {experiment.ownedFlags.length > 0 && (
            <section aria-labelledby="its-switches">
              <h2 id="its-switches" className="label-caps border-b border-line pb-1.5">
                Its switches
              </h2>
              <ul>
                {experiment.ownedFlags.map((flag) => (
                  <li key={flag.key}>
                    <Link
                      to={`/switches/${flag.key}`}
                      className="flex items-baseline justify-between gap-3 border-b py-2.5 text-[13.5px] transition-[padding] hover:pl-1.5 [@media(pointer:coarse)]:min-h-11"
                    >
                      <span>{flag.name}</span>
                      <span className="text-muted-foreground">
                        {flag.kind === "percent"
                          ? `${flag.valuePercent ?? 0}%`
                          : flag.valueBool
                            ? "Live"
                            : "Off"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
