import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { apiRead } from "@/lib/api";
import { people, windowRemaining } from "@/lib/experimentWindow";
import type {
  ExperimentDetailView,
  RecoveryMetrics,
  RecoveryProportionComparison,
  RecoveryTimingArmSummary,
  RecoveryTimingDecision,
  RecoveryTimingExperimentMetrics,
} from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";

const dayFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
const shortDayFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function percent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function outcome(count: number, matured: number, rate: number | null): string {
  return `${count} / ${matured} (${percent(rate)})`;
}

function derivedOutcome(count: number, matured: number): string {
  return outcome(count, matured, matured === 0 ? null : (count / matured) * 100);
}

function signedPoints(value: number | null): string {
  if (value === null) return "Not enough data";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)} pp`;
}

function comparisonInterval(comparison: RecoveryProportionComparison): string | null {
  const interval = comparison.confidenceInterval95;
  if (!interval) return null;
  const signed = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
  return `95% range ${signed(interval.low)} to ${signed(interval.high)} pp`;
}

function decisionMessage(decision: RecoveryTimingDecision): string {
  switch (decision) {
    case "collecting":
      return "Still collecting complete 48-hour results. There is no winner yet.";
    case "exploratory":
      return "This date slice is exploratory and cannot declare a final winner.";
    case "inconclusive":
      return "The final result is inconclusive. Keep the 6-hour timing unless you choose otherwise.";
    case "safety_review":
      return "Safety review required before choosing a timing.";
    case "two_hour_wins":
      return "The 2-hour reminder is the winner.";
    case "six_hour_wins":
      return "The 6-hour reminder is the winner.";
  }
}

async function loadFullTimingMetrics(signal: AbortSignal): Promise<RecoveryTimingExperimentMetrics | null> {
  const first = await apiRead<RecoveryMetrics>("/recovery-reminders/metrics", { signal });
  const initial = first.timingExperiment;
  if (!initial || initial.reporting.fullExperimentRange) return initial;

  const params = new URLSearchParams({
    from: initial.reporting.coverage.from,
    to: initial.reporting.coverage.to,
    asOf: initial.reporting.asOf,
  });
  const full = await apiRead<RecoveryMetrics>(`/recovery-reminders/metrics?${params}`, { signal });
  return full.timingExperiment;
}

function TimingComparisonTable({ metrics }: { metrics: RecoveryTimingExperimentMetrics }) {
  const arms: Array<{ label: string; summary: RecoveryTimingArmSummary }> = [
    { label: "2 hours", summary: metrics.arms.twoHour },
    { label: "6 hours", summary: metrics.arms.sixHour },
    { label: "No reminder", summary: metrics.arms.noReminder },
  ];
  const comparisons: Array<{
    label: string;
    value: RecoveryProportionComparison;
  }> = [
    { label: "2 vs 6 hours", value: metrics.timingComparison },
    { label: "2 hours vs no reminder", value: metrics.treatmentControlComparisons.twoHour },
    { label: "6 hours vs no reminder", value: metrics.treatmentControlComparisons.sixHour },
  ];

  return (
    <div className="space-y-5">
      <section aria-labelledby="results-comparison" className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="results-comparison" className="text-base font-medium">
              Results comparison
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              {metrics.reporting.resultsCompleteThrough
                ? `48-hour results are complete through ${shortDayFormat.format(new Date(`${metrics.reporting.resultsCompleteThrough}T00:00:00Z`))}. `
                : "No 48-hour results are complete yet. "}
              {people(metrics.reporting.stillCollectingFollowers)} still collecting.
            </p>
          </div>
          <span className="rounded-full bg-signal-soft px-2.5 py-1 text-[11.5px] font-medium text-signal">
            45% / 45% / 10%
          </span>
        </div>

        <p className="text-[11.5px] text-muted-foreground sm:hidden">
          On a small screen, swipe sideways to compare all three.
        </p>
        <div className="overflow-x-auto rounded-lg border">
          <table aria-label="Experiment comparison" className="w-full min-w-[680px] border-collapse text-[13px]">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th scope="col" className="px-3 py-2.5 font-medium text-muted-foreground">
                  Metric
                </th>
                {arms.map((arm) => (
                  <th key={arm.label} scope="col" className="px-3 py-2.5 font-medium">
                    {arm.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t">
                <th scope="row" className="px-3 py-2.5 text-left font-normal text-muted-foreground">
                  Assigned
                </th>
                {arms.map((arm) => <td key={arm.label} className="px-3 py-2.5 tabular-nums">{people(arm.summary.assigned)}</td>)}
              </tr>
              <tr className="border-t">
                <th scope="row" className="px-3 py-2.5 text-left font-normal text-muted-foreground">
                  Complete 48h results
                </th>
                {arms.map((arm) => <td key={arm.label} className="px-3 py-2.5 tabular-nums">{people(arm.summary.matured)}</td>)}
              </tr>
              <tr className="border-y bg-signal-soft/70">
                <th scope="row" className="px-3 py-3 text-left font-medium">
                  Guide completion within 48 hours
                  <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">Primary outcome</span>
                </th>
                {arms.map((arm) => (
                  <td key={arm.label} className="px-3 py-3 font-medium tabular-nums">
                    {outcome(arm.summary.completedWithin48h, arm.summary.matured, arm.summary.completionRate48h)}
                  </td>
                ))}
              </tr>
              <tr className="border-t">
                <th scope="row" className="px-3 py-2.5 text-left font-normal text-muted-foreground">
                  Guide completion within 24 hours
                </th>
                {arms.map((arm) => (
                  <td key={arm.label} className="px-3 py-2.5 tabular-nums">
                    {outcome(arm.summary.completedWithin24h, arm.summary.matured, arm.summary.completionRate24h)}
                  </td>
                ))}
              </tr>
              <tr className="border-t">
                <th scope="row" className="px-3 py-2.5 text-left font-normal text-muted-foreground">
                  Replies within 48 hours
                </th>
                {arms.map((arm) => (
                  <td key={arm.label} className="px-3 py-2.5 tabular-nums">
                    {derivedOutcome(arm.summary.repliedWithin48h, arm.summary.matured)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="direct-comparisons">
        <h2 id="direct-comparisons" className="label-caps border-b border-line pb-1.5">
          Direct comparisons
        </h2>
        <div className="grid gap-2 pt-2 sm:grid-cols-3">
          {comparisons.map((comparison) => (
            <div key={comparison.label} className="rounded-lg border px-3 py-3">
              <p className="text-[12px] text-muted-foreground">{comparison.label}</p>
              <p className="mt-1 text-lg font-medium tabular-nums">
                {signedPoints(comparison.value.differencePercentagePoints)}
              </p>
              {comparisonInterval(comparison.value) && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {comparisonInterval(comparison.value)}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg bg-signal-soft px-4 py-3.5" aria-live="polite">
        <p className="text-[11px] font-medium uppercase tracking-wide text-signal">Decision</p>
        <p className="mt-1 text-[13.5px] font-medium">{decisionMessage(metrics.decision.state)}</p>
        <p className="mt-1 text-[12px] text-muted-foreground">No timing is changed automatically.</p>
      </section>

      <section role="region" aria-labelledby="safety-checks" className="space-y-2">
        <h2 id="safety-checks" className="label-caps border-b border-line pb-1.5">
          Safety checks
        </h2>
        <ul className="grid gap-1.5 text-[12.5px] sm:grid-cols-2">
          {[
            {
              label: `Assignment drift: ${people(metrics.allocation.assignmentDriftFollowers)} followers`,
              review: metrics.allocation.assignmentDriftFollowers > 0,
            },
            { label: "2-hour arm is materially worse", review: metrics.safety.twoHourMateriallyWorse },
            { label: "6-hour arm is materially worse", review: metrics.safety.sixHourMateriallyWorse },
            { label: "Control point estimate shows harm", review: metrics.safety.controlPointEstimateHarm },
            {
              label: "Treatment/control confidence interval shows harm",
              review: metrics.safety.treatmentControlConfidenceHarm,
            },
            { label: "Duplicate-send safety event", review: metrics.safety.duplicateSafetyEvent },
          ].map((check) => (
            <li key={check.label} className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-2">
              <span>{check.label}</span>
              <span className={check.review ? "font-medium text-caution" : "text-muted-foreground"}>
                {check.review ? "Review" : "Clear"}
              </span>
            </li>
          ))}
        </ul>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[12.5px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-2 font-normal">Check</th>
                {arms.map((arm) => <th key={arm.label} className="px-3 py-2 font-normal">{arm.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {[
                { label: "Failed / uncertain sends", value: (arm: RecoveryTimingArmSummary) => `${arm.sendFailed} / ${arm.sendUncertain}` },
                { label: "Send exception rate", value: (arm: RecoveryTimingArmSummary) => percent(arm.sendExceptionRate) },
                { label: "Delayed-signal false-positive rate", value: (arm: RecoveryTimingArmSummary) => percent(arm.delayedSignalFalsePositiveRate) },
                { label: "Late sends", value: (arm: RecoveryTimingArmSummary) => people(arm.lateSendCount) },
                { label: "Confirmed duplicate sends", value: (arm: RecoveryTimingArmSummary) => people(arm.confirmedDuplicateSends) },
              ].map((row) => (
                <tr key={row.label} className="border-t">
                  <th scope="row" className="py-2 text-left font-normal text-muted-foreground">{row.label}</th>
                  {arms.map((arm) => <td key={arm.label} className="px-3 py-2 tabular-nums">{row.value(arm.summary)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/**
 * One experiment's result — or, if it never ran, what it would have compared.
 *
 * Generic experiments stay in whole people. The predeclared recovery-timing V2
 * detail additionally shows rates, uncertainty, and three direct comparisons, while
 * keeping partial evidence explicitly exploratory and never rolling out a result.
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
  const timingQuery = useQuery<RecoveryTimingExperimentMetrics | null>({
    queryKey: ["experiments", key, "timing-metrics"],
    queryFn: ({ signal }) => loadFullTimingMetrics(signal),
    enabled:
      key === "recovery-reminder-timing-v2" && query.data?.state === "running",
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

          {key === "recovery-reminder-timing-v2" && experiment.state === "running" ? (
            timingQuery.isLoading ? (
              <Skeleton className="h-80 rounded-lg" />
            ) : timingQuery.isError ? (
              <section className="rounded-lg border border-dashed px-4 py-4 text-[13px] text-muted-foreground">
                Couldn&apos;t load the timing comparison. The experiment definition is safe, but its
                measurements are temporarily unavailable.
              </section>
            ) : !timingQuery.data ? (
              <section className="rounded-lg border border-dashed px-4 py-4 text-[13px] text-muted-foreground">
                <p className="font-medium text-foreground">No assignments yet</p>
                <p className="mt-1">
                  The three-way comparison will appear after the first eligible follower is assigned.
                </p>
              </section>
            ) : (
              <TimingComparisonTable metrics={timingQuery.data} />
            )
          ) : experiment.summary.kind === "running" || experiment.summary.kind === "ended" ? (
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

              {experiment.summary.kind === "running" ? (
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
              ) : (
                <section className="rounded-md bg-muted px-3.5 py-3 text-[13px]">
                  <p className="font-medium">
                    Concluded {dayFormat.format(new Date(experiment.summary.endedAt))}
                  </p>
                  <p className="mt-1 text-muted-foreground">{experiment.summary.conclusion}</p>
                </section>
              )}
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
