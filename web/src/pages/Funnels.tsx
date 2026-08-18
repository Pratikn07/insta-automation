import { useQuery } from "@tanstack/react-query";
import { Filter, RefreshCw } from "lucide-react";
import { useState } from "react";
import { apiRead } from "@/lib/api";
import type { DropOffSummary, GuideFollowResult } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { Caveat } from "@/components/funnels/Caveat";
import { GuardedNumber } from "@/components/funnels/GuardedNumber";
import { FunnelStages } from "@/components/funnels/FunnelStages";
import { EvidenceBar } from "@/components/funnels/EvidenceBar";
import { DropOffTable } from "@/components/funnels/DropOffTable";

// Where the guide funnel loses people.
//
// Separate from Insights on purpose: that page is scoped to reels ("which reels
// resonate with a US audience"), while a funnel's axis is the conversation
// lifecycle. Same reason the API mounts /funnels rather than adding a tab.
//
// Every percentage here is computed server-side by summarizeGuideFollow, the
// same function the CLI uses. If this page and `npm run funnel` ever disagree,
// the bug is in the rendering, not the arithmetic.

const WINDOW_PRESETS = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
] as const;

/** Cohort bounds as YYYY-MM-DD, which is what the API expects. */
function windowFor(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { from: day(from), to: day(to) };
}

function formatCohortRange(window: { from: string; to: string }): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${fmt(window.from)} – ${fmt(window.to)}`;
}

export function Funnels() {
  const [days, setDays] = useState<number>(30);
  const range = windowFor(days);
  const query = `?from=${range.from}&to=${range.to}`;

  const funnelQ = useQuery<GuideFollowResult>({
    queryKey: ["funnels", "guide-follow", range.from, range.to],
    queryFn: ({ signal }) => apiRead<GuideFollowResult>(`/funnels/guide-follow${query}`, { signal }),
  });

  const dropOffQ = useQuery<DropOffSummary>({
    queryKey: ["funnels", "guide-follow", "no-reply", range.from, range.to],
    queryFn: ({ signal }) => apiRead<DropOffSummary>(`/funnels/guide-follow/drop-off/no-reply${query}`, { signal }),
  });

  return (
    <div className="space-y-8">
      <header>
        <p className="label-caps">Funnels · Guide → follow</p>
        <h2 className="mt-2 max-w-[24ch] text-2xl font-medium leading-tight tracking-tight text-balance">
          Where the guide funnel loses people.
        </h2>

        {/* Cohort semantics, stated. Never "last 30 days": these are the SAME
            conversations tracked forward, not events counted inside a window,
            and reading it the other way is how the old yield tile misled. */}
        <p className="mt-4 max-w-[62ch] text-sm text-muted-foreground">
          {funnelQ.data ? (
            <>
              <span className="font-medium text-foreground">
                {funnelQ.data.cohortSize.toLocaleString()} conversations
              </span>{" "}
              that entered between{" "}
              <span className="font-medium text-foreground">
                {formatCohortRange(funnelQ.data.window)}
              </span>
              , followed forward however long they took — not events counted inside the
              window.
            </>
          ) : (
            "Conversations that entered in the window, followed forward however long they took."
          )}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {WINDOW_PRESETS.map((p) => (
            <button
              key={p.days}
              type="button"
              onClick={() => setDays(p.days)}
              className={
                "rounded-sm border px-3 py-1.5 text-xs transition-colors [@media(pointer:coarse)]:min-h-11 " +
                (days === p.days
                  ? "border-line bg-muted font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted")
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {funnelQ.isError ? (
        <EmptyState
          icon={<Filter className="size-5" />}
          title="Couldn't load the funnel"
          description="The cohort query scans the event log over the window; a wide range can time out."
          action={
            <Button variant="outline" onClick={() => funnelQ.refetch()}>
              <RefreshCw className="size-4" /> Retry
            </Button>
          }
        />
      ) : funnelQ.isLoading || !funnelQ.data ? (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-lg" />
          <Skeleton className="h-72 w-full rounded-lg" />
        </div>
      ) : (
        <FunnelBody data={funnelQ.data} dropOff={dropOffQ.data} isDropOffLoading={dropOffQ.isLoading} />
      )}
    </div>
  );
}

function FunnelBody({
  data,
  dropOff,
  isDropOffLoading,
}: {
  data: GuideFollowResult;
  dropOff: DropOffSummary | undefined;
  isDropOffLoading: boolean;
}) {
  const d21 = data.stages.find((s) => s.key === "followingD21");
  const measuredD21 = data.retention.denominator;
  const eligible = data.stages.find((s) => s.key === "followingMeasured")?.count ?? 0;

  return (
    <>
      {/* Headline + KPIs */}
      <section className="grid gap-8 border-b pb-9 md:grid-cols-[1.15fr_1fr] md:gap-14">
        <div>
          <p className="label-caps">{data.headline.label}</p>
          <GuardedNumber
            className="mt-3"
            rate={data.headline.rate}
            unit="answered the unlock DM"
            size="hero"
          />
          <p className="mt-3 max-w-[46ch] text-sm text-muted-foreground">
            {data.headline.rationale}
          </p>
        </div>

        <dl className="flex flex-col">
          <Kpi label="Follow gate conversion" rate={data.followGateConversion} />
          <KpiCount label="Stuck at the follow wall" value={data.stuckAtWall} sub="asked, never followed" />
          <KpiCount
            label="Never saw the wall"
            value={data.expressLane}
            sub="already following — served immediately"
          />
          {data.byEntryPath.map((p) => (
            <Kpi key={p.entryPath} label={`${p.entryPath} entry → guide`} rate={p.deliveryRate} />
          ))}
        </dl>
      </section>

      {/* Stages */}
      <section className="pt-2">
        <SectionHead
          eyebrow="The stages"
          title="Six steps, one branch"
          blurb="Bars are drawn against the full cohort, so lengths are comparable down the list. Stages marked joinable are reached without passing the step above, so no step conversion is shown — a tapering funnel chart would have implied a sequence that does not exist."
        />
        <FunnelStages
          stages={data.stages}
          cohortSize={data.cohortSize}
          renderLoss={(stage, lost) =>
            stage.key === "replied" ? (
              <p className="mt-2.5 text-[12.5px] text-muted-foreground">
                <span className="font-medium text-foreground">
                  {lost.toLocaleString()} lost here
                </span>{" "}
                —{" "}
                <a
                  href="#drop-off"
                  className="border-b border-current text-funnel-mark hover:opacity-80"
                >
                  see who they are
                </a>
              </p>
            ) : (
              <p className="mt-2.5 text-[12.5px] text-muted-foreground">
                {lost.toLocaleString()} lost here
              </p>
            )
          }
          notes={{
            guideDelivered: (
              <p className="mt-2.5 max-w-[64ch] text-[12.5px] text-muted-foreground">
                {data.expressLane.toLocaleString()} of these never saw the gate — already
                following, so they were served immediately. Only{" "}
                {data.followGateConversion.numerator.toLocaleString()} came from someone who
                had to follow first.
              </p>
            ),
            // Load-bearing, not decoration: without it a reader sees a hairline
            // bar reading "5" and concludes retention collapsed.
            followingD21:
              d21 && measuredD21 < eligible ? (
                <Caveat className="mt-3">
                  <b className="font-medium">This is not {d21.ofPrevPct}% retention.</b> The
                  follow-through worker has re-measured {measuredD21.toLocaleString()} of{" "}
                  {eligible.toLocaleString()} eligible conversations, and{" "}
                  {data.retention.numerator.toLocaleString()} of those are still following.
                  Read the bar as coverage, not churn.
                </Caveat>
              ) : null,
          }}
        />
      </section>

      {/* Drop-off */}
      <section id="drop-off" className="pt-8">
        {isDropOffLoading || !dropOff ? (
          <Skeleton className="h-64 w-full rounded-lg" />
        ) : (
          <>
            <SectionHead
              eyebrow={`Biggest leak · ${dropOff.label.toLowerCase()}`}
              title={`${dropOff.total.toLocaleString()} people, and what we know about why`}
              blurb={`${dropOff.byState.expired.toLocaleString()} of these conversations have expired; ${dropOff.byState.stillOpen.toLocaleString()} are still open. The question is whether they ignored the message or never saw it — opposite problems with opposite fixes.`}
            />

            <EvidenceBar evidence={dropOff.readEvidence} />

            <Caveat className="mt-5">
              <b className="font-medium">
                The grey block is an absence of evidence, not a finding.
              </b>{" "}
              Those {dropOff.readEvidence.noReadData.toLocaleString()} conversations were never
              tracked for read receipts, so nothing can be concluded about them. Among the{" "}
              {dropOff.readEvidence.confirmedSeenOfTracked.denominator.toLocaleString()} we can
              judge, {dropOff.readEvidence.trackedNeverConfirmed.toLocaleString()} were never
              confirmed read. That points at deliverability rather than at the wording of the DM.
            </Caveat>

            <h3 className="mt-9 text-[15px] font-medium">Who to act on</h3>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">
              Newest first, capped at {dropOff.rows.length.toLocaleString()} rows.
            </p>
            <DropOffTable rows={dropOff.rows} />

            <p className="mt-3 max-w-[68ch] text-xs text-muted-foreground">
              Across the whole bucket: {dropOff.recovery.reminderSent.toLocaleString()} reminders
              sent, {dropOff.recovery.reminderSuppressed.toLocaleString()} suppressed, and{" "}
              {dropOff.recovery.inControlArm.toLocaleString()} in a control arm — a holdout
              already running against this problem, which makes the reminder's lift measurable
              rather than assumed.
            </p>
          </>
        )}
      </section>
    </>
  );
}

function SectionHead({
  eyebrow,
  title,
  blurb,
}: {
  eyebrow: string;
  title: string;
  blurb: string;
}) {
  return (
    <div className="mb-6">
      <p className="label-caps">{eyebrow}</p>
      <h3 className="mt-1.5 text-[15px] font-medium tracking-tight">{title}</h3>
      <p className="mt-1.5 max-w-[64ch] text-sm text-muted-foreground">{blurb}</p>
    </div>
  );
}

function Kpi({ label, rate }: { label: string; rate: GuideFollowResult["retention"] }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-3 first:border-t">
      <dt className="text-[13px] capitalize text-muted-foreground">{label}</dt>
      <dd className="text-right">
        <GuardedNumber rate={rate} size="inline" />
      </dd>
    </div>
  );
}

function KpiCount({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-3 first:border-t">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="text-right">
        <div className="text-base font-medium tabular-nums tracking-[-0.01em]">
          {value.toLocaleString()}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
      </dd>
    </div>
  );
}
