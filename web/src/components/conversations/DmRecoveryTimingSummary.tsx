import type {
  RecoveryTimingArmSummary,
  RecoveryTimingDecision,
  RecoveryTimingExperimentMetrics,
} from "../../lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

const dayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});

function formatDay(day: string): string {
  return dayFormat.format(new Date(`${day}T00:00:00Z`));
}

function percent(value: number | null): string {
  return value === null ? "Not enough data" : `${value.toFixed(1)}%`;
}

function signedPoints(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function ArmCard({
  title,
  summary,
  withheld = false,
}: {
  title: string;
  summary: RecoveryTimingArmSummary;
  withheld?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>
          <h3>{title}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <div>
            <dt className="text-xs text-muted-foreground">Matured followers</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{summary.matured}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Still collecting</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{summary.immature}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Completed guides</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{summary.completedWithin48h}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">48-hour completion rate</dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {percent(summary.completionRate48h)}
            </dd>
          </div>
        </dl>
        {withheld ? (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            Intentionally withheld for comparison.
          </p>
        ) : (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            Attempted {summary.attempted} · Sent {summary.sent} · Failed {summary.sendFailed} ·
            Uncertain {summary.sendUncertain}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function decisionMessage(
  decision: RecoveryTimingDecision,
  conservativeDefault: "six_hour" | null,
): string {
  switch (decision) {
    case "collecting":
      return "The experiment is still collecting complete outcomes. No final decision is available yet.";
    case "exploratory":
      return "Exploratory view. A selected date slice cannot declare a final winner.";
    case "inconclusive":
      return conservativeDefault === "six_hour"
        ? "Final result is inconclusive. The 6-hour reminder is the conservative default."
        : "Final result is inconclusive. No automatic timing change will be made.";
    case "safety_review":
      return "Safety review required. No timing change will be made until the flagged evidence is reviewed.";
    case "two_hour_wins":
      return "Final winner: 2-hour reminder.";
    case "six_hour_wins":
      return "Final winner: 6-hour reminder.";
  }
}

function safetyDetails(metrics: RecoveryTimingExperimentMetrics): string[] {
  const details: string[] = [];
  if (metrics.safety.duplicateSafetyEvent) {
    details.push("A duplicate reminder send was confirmed.");
  }
  if (metrics.allocation.assignmentDriftFollowers > 0) {
    details.push(
      `${metrics.allocation.assignmentDriftFollowers} followers have inconsistent arm assignments.`,
    );
  }
  if (metrics.safety.twoHourMateriallyWorse) {
    details.push("The 2-hour arm crossed an operational harm threshold.");
  }
  if (metrics.safety.sixHourMateriallyWorse) {
    details.push("The 6-hour arm crossed an operational harm threshold.");
  }
  if (metrics.safety.controlPointEstimateHarm) {
    details.push("Both reminder arms are materially below the no-reminder point estimate.");
  }
  if (metrics.safety.treatmentControlConfidenceHarm) {
    details.push("A reminder arm is statistically below the no-reminder group.");
  }
  return details;
}

export function DmRecoveryTimingSummary({
  metrics,
}: {
  metrics: RecoveryTimingExperimentMetrics;
}) {
  const { reporting, timingComparison } = metrics;
  const interval = timingComparison.confidenceInterval95;
  const safety = metrics.decision.state === "safety_review" ? safetyDetails(metrics) : [];

  return (
    <section aria-labelledby="recovery-timing-title" className="space-y-4">
      <div>
        <h2 id="recovery-timing-title" className="text-base font-semibold">
          Recovery timing
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Showing guide requests received {formatDay(reporting.range.from)} to{" "}
          {formatDay(reporting.range.to)}.
        </p>
        <p className="text-sm text-muted-foreground">
          {reporting.resultsCompleteThrough
            ? `Results are complete through ${formatDay(reporting.resultsCompleteThrough)}. `
            : "No 48-hour outcomes are complete yet. "}
          {reporting.stillCollectingFollowers} follower
          {reporting.stillCollectingFollowers === 1 ? " is" : "s are"} still collecting 48-hour
          outcomes.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <ArmCard title="2-hour reminder" summary={metrics.arms.twoHour} />
        <ArmCard title="6-hour reminder" summary={metrics.arms.sixHour} />
        <ArmCard title="No reminder" summary={metrics.arms.noReminder} withheld />
      </div>

      <div className="rounded-lg border px-4 py-3 text-sm">
        <p className="font-medium">2-hour compared with 6-hour</p>
        {timingComparison.differencePercentagePoints === null ? (
          <p className="mt-1 text-muted-foreground">Not enough matured followers to compare.</p>
        ) : (
          <p className="mt-1 text-muted-foreground">
            <span className="tabular-nums">
              {signedPoints(timingComparison.differencePercentagePoints)} percentage points
            </span>
            {interval ? (
              <>
                {" "}·{" "}
                <span className="tabular-nums">
                  95% CI: {signedPoints(interval.low)} to {signedPoints(interval.high)} percentage
                  points
                </span>
              </>
            ) : null}
          </p>
        )}
      </div>

      <div role="status" className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        <p className="font-medium">
          {decisionMessage(metrics.decision.state, metrics.decision.conservativeDefault)}
        </p>
        {safety.map((detail) => (
          <p key={detail} className="mt-1 text-muted-foreground">
            {detail}
          </p>
        ))}
      </div>
    </section>
  );
}
