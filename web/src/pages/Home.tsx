import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiRead } from "@/lib/api";
import { feedFollowAttributionPath } from "@/lib/feedFollowAttribution";
import type {
  FeedFollowAttributionResponse,
  FollowerFlowResponse,
  GuideFollowResult,
  Stats,
} from "@/lib/types";
import { compareSettledUsWeeks, summarizeFollowerFlow } from "@/lib/followerFlow";
import { composeTodaysRead } from "@/lib/todaysRead";
import {
  deriveHomeAttentionState,
  type HomeAttentionState,
  type HomeSource,
  type SourceState,
} from "@/lib/homeAttention";
import { FollowerFlowPanel } from "@/components/home/FollowerFlowPanel";
import { FeedFollowAttributionDrawer } from "@/components/home/FeedFollowAttributionDrawer";
import { FollowerKpiRow } from "@/components/home/FollowerKpiRow";
import { cn } from "@/lib/utils";

const nf = new Intl.NumberFormat("en-US");

function queryState<T>(query: {
  isError: boolean;
  isPending: boolean;
  data?: T;
}): SourceState<T> {
  if (query.isError) return { status: "error" };
  if (query.isPending || query.data === undefined) return { status: "loading" };
  return { status: "success", data: query.data };
}

function attentionHeader(state: HomeAttentionState): string {
  switch (state.status) {
    case "checking":
      return "Checking what needs attention…";
    case "ready_with_attention":
      return `${state.items.length} ${state.items.length === 1 ? "decision deserves" : "decisions deserve"} your attention today.`;
    case "ready_clear":
      return "Nothing is waiting on you today.";
    case "incomplete":
      return "The check is incomplete.";
  }
}

function comparisonUnavailableCopy(
  comparison: ReturnType<typeof compareSettledUsWeeks>,
): string {
  if (comparison.status === "ready") return "";
  switch (comparison.reason) {
    case "not_enough_history":
      return "Waiting for two complete settled weeks of follower measurements.";
    case "missing_day":
      return "A daily follower measurement is missing, so no week-to-week claim is available.";
    case "provisional_day":
      return "Newest measurements are still settling, so the comparison is withheld.";
    case "multi_day_span":
      return "A catch-up span prevents a week-to-week comparison.";
    case "duplicate_day":
      return "Duplicate daily measurements prevent a trustworthy comparison.";
  }
}

export function Home() {
  const [attributionDay, setAttributionDay] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const flowQ = useQuery<FollowerFlowResponse>({
    queryKey: ["insights", "follower-daily-adds"],
    queryFn: ({ signal }) => apiRead<FollowerFlowResponse>("/insights/follower-daily-adds", { signal }),
  });
  const statsQ = useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: ({ signal }) => apiRead<Stats>("/stats", { signal }),
  });
  // Default window (30 days) — no params, so this shares a cache key with the
  // Funnels page's default view rather than re-running the cohort scan.
  const funnelQ = useQuery<GuideFollowResult>({
    queryKey: ["funnels", "guide-follow", "default"],
    queryFn: ({ signal }) => apiRead<GuideFollowResult>("/funnels/guide-follow", { signal }),
  });
  const attributionQ = useQuery<FeedFollowAttributionResponse>({
    queryKey: ["insights", "feed-follow-attribution", attributionDay],
    queryFn: ({ signal }) =>
      apiRead<FeedFollowAttributionResponse>(feedFollowAttributionPath(attributionDay!), {
        signal,
      }),
    enabled: attributionDay !== null,
  });

  const flowPoints = flowQ.data?.points ?? [];
  const flowStock = flowQ.data?.stock ?? null;
  const flowSummary = summarizeFollowerFlow(flowPoints);
  const weekComparison = compareSettledUsWeeks(flowPoints);
  const read = composeTodaysRead(weekComparison, funnelQ.data);
  const attentionState = deriveHomeAttentionState({
    flow: queryState(flowQ),
    stats: queryState(statsQ),
    funnel: queryState(funnelQ),
  });
  const attention = attentionState.status === "checking" ? [] : attentionState.items;
  const best = attention[0] ?? null;

  const failedSourceControls: Record<
    HomeSource,
    { label: string; retryLabel: string; retry: () => void }
  > = {
    flow: {
      label: "Follower flow",
      retryLabel: "Retry follower flow",
      retry: () => void flowQ.refetch(),
    },
    stats: {
      label: "System stats",
      retryLabel: "Retry system stats",
      retry: () => void statsQ.refetch(),
    },
    funnel: {
      label: "Funnel evidence",
      retryLabel: "Retry funnel evidence",
      retry: () => void funnelQ.refetch(),
    },
  };

  // Three states, not two. A failed request previously rendered "Awaiting first
  // snapshot" — the same words the product uses for a genuinely empty account —
  // so an outage read as a quiet, expected condition. It cost real debugging
  // time against a database holding 48 unbroken days of geography.
  const updatedLabel = flowQ.isError
    ? "Could not reach the API"
    : flowStock
      ? `Updated ${new Date(flowStock.capturedAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          timeZone: flowQ.data?.analyticsTimeZone ?? "America/Los_Angeles",
        })}`
      : flowQ.isLoading
        ? "Loading"
        : "Awaiting first snapshot";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Home</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {attentionHeader(attentionState)}
          </p>
        </div>
        <span className="label-caps">{updatedLabel}</span>
      </div>

      {/* The read and the single best move, as one bordered band. Two panels
          divided by a rule rather than two floating cards. */}
      <section className="grid border border-line lg:grid-cols-[1.55fr_1fr]">
        {/* Neutral ground, deliberately. This panel held the moss tint until the
            review pointed out that "growth is 40% slower" would then be
            delivered on a success colour. A finding may be bad news, so the
            surface it sits on must not editorialise. */}
        <div className="bg-muted p-5 sm:p-6">
          <span className="label-caps">Today&rsquo;s read</span>
          {read ? (
            <>
              <h2 className="mt-2 text-lg font-medium leading-snug tracking-tight sm:text-xl">
                {read.headline}
              </h2>
              <p className="label-caps mt-1.5">{read.headlineWindow}</p>
              {read.because && (
                <>
                  <p className="mt-3 max-w-[58ch] text-[13px] leading-relaxed">{read.because}</p>
                  {read.becauseWindow && (
                    <p className="label-caps mt-1.5">{read.becauseWindow}</p>
                  )}
                </>
              )}
              <p className="label-caps mt-3.5">{read.qualification}</p>
              <button
                type="button"
                onClick={() => setEvidenceOpen((o) => !o)}
                aria-expanded={evidenceOpen}
                className="label-caps mt-3 border-b border-current pb-0.5 text-signal transition-opacity hover:opacity-70 [@media(pointer:coarse)]:min-h-11"
              >
                {evidenceOpen ? "Hide the evidence" : "Show the evidence"}
              </button>
            </>
          ) : flowQ.isError ? (
            <p className="mt-2 max-w-[54ch] text-[13px] leading-relaxed">
              No follower read is available — the API did not answer. This is a connection
              problem, not an empty account.{" "}
              <button
                type="button"
                onClick={() => void flowQ.refetch()}
                className="underline underline-offset-2 [@media(pointer:coarse)]:min-h-11"
              >
                Try again
              </button>
            </p>
          ) : flowQ.isPending ? (
            <p className="mt-2 max-w-[54ch] text-[13px] leading-relaxed">
              Waiting for follower measurements.
            </p>
          ) : (
            <p className="mt-2 max-w-[54ch] text-[13px] leading-relaxed">
              {comparisonUnavailableCopy(weekComparison)}
            </p>
          )}
        </div>

        <div className="flex flex-col border-line p-5 sm:p-6 lg:border-l">
          <span className="label-caps">Best next move</span>
          {best ? (
            <>
              <p className="mt-2 flex-1 text-[13px] leading-relaxed">{best.detail}</p>
              <Link
                to={best.to}
                className="mt-4 inline-flex min-h-9 items-center justify-center rounded-sm bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 [@media(pointer:coarse)]:min-h-11"
              >
                {best.title}
              </Link>
            </>
          ) : attentionState.status === "checking" ? (
            <p className="mt-2 flex-1 text-[13px] leading-relaxed text-muted-foreground">
              Waiting for the required evidence.
            </p>
          ) : attentionState.status === "incomplete" ? (
            <p className="mt-2 flex-1 text-[13px] leading-relaxed text-muted-foreground">
              Some evidence could not be checked.
            </p>
          ) : (
            <p className="mt-2 flex-1 text-[13px] leading-relaxed text-muted-foreground">
              Nothing is failing and nothing is queued. The automation is running without you.
            </p>
          )}
        </div>
      </section>

      {evidenceOpen && (
        <section className="border-t border-foreground pt-3">
          <span className="label-caps">Evidence</span>
          <div className="mt-2 max-w-[74ch] space-y-3 text-[13px] leading-relaxed text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">What this rests on.</span>{" "}
              Conversations are counted by the day they entered, not the day an event fired, so
              someone who replies a week later still counts in the week they arrived. The
              comparison uses complete days only.
            </p>
            <p>
              <span className="font-medium text-foreground">Why losses are quoted as counts.</span>{" "}
              A rate below the funnel&rsquo;s minimum sample is withheld everywhere in this
              product, including in the sentence above. Fifteen per cent over thirty-two people
              and over three thousand are different claims, and only one of them is a number.
            </p>
          </div>
        </section>
      )}

      <FollowerKpiRow
        weekComparison={weekComparison}
        stock={flowStock}
        avgPerDay7={flowSummary?.avgPerDay7 ?? null}
        stats={statsQ.data}
        funnel={funnelQ.data}
        isFlowLoading={flowQ.isLoading}
        isStatsLoading={statsQ.isLoading}
        isFunnelLoading={funnelQ.isLoading}
      />

      <FollowerFlowPanel
        points={flowPoints}
        stock={flowStock}
        summary={flowSummary}
        isLoading={flowQ.isLoading}
        isError={flowQ.isError}
        onRetry={() => void flowQ.refetch()}
        selectedDay={attributionDay}
        onDaySelect={setAttributionDay}
        now={new Date().toISOString()}
      />

      <div className="grid gap-8 lg:grid-cols-[1.55fr_1fr]">
        <section>
          <div className="flex items-baseline justify-between gap-3 border-b border-foreground pb-1.5">
            <h3 className="text-[15px] font-medium">What needs attention</h3>
            <span className="label-caps">Ranked by what is lost</span>
          </div>
          {attentionState.status === "incomplete" && (
            <div className="mt-3 border border-line bg-muted p-3 text-[12.5px] leading-relaxed">
              <p>
                Could not check:{" "}
                {attentionState.failedSources
                  .map((source) => failedSourceControls[source].label)
                  .join(", ")}
                . Verified items from the available sources remain below.
              </p>
              <div className="mt-2 flex flex-wrap gap-3">
                {attentionState.failedSources.map((source) => {
                  const control = failedSourceControls[source];
                  return (
                    <button
                      key={source}
                      type="button"
                      onClick={control.retry}
                      className="border-b border-current text-signal"
                    >
                      {control.retryLabel}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {attentionState.status === "checking" ? (
            <p className="mt-3 text-[13px] text-muted-foreground">
              Checking the required evidence before calling anything clear.
            </p>
          ) : attention.length === 0 && attentionState.status === "ready_clear" ? (
            <p className="mt-3 text-[13px] text-muted-foreground">
              Nothing qualifies. No failed gates, no exhausted retries, nothing waiting.
            </p>
          ) : attention.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground">
              No verified attention item is available from the sources that answered.
            </p>
          ) : (
            attention.map((a, i) => (
              <Link
                key={a.title}
                to={a.to}
                className="grid grid-cols-[26px_1fr_auto] items-start gap-3 border-b py-3 transition-[padding] duration-200 hover:pl-1.5 active:opacity-60 [@media(pointer:coarse)]:min-h-11"
              >
                <span className="pt-0.5 text-xs text-muted-foreground">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>
                  <span className="block text-[13.5px] font-medium">{a.title}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                    {a.detail}
                  </span>
                </span>
                <span className="text-right">
                  <span
                    className={cn(
                      "label-caps block",
                      a.tag === "Now" ? "text-urgent" : "text-muted-foreground",
                    )}
                  >
                    {a.tag}
                  </span>
                  <span className="mt-1.5 inline-block rounded-sm border border-line bg-card px-2.5 py-1 text-xs">
                    {a.action}
                  </span>
                </span>
              </Link>
            ))
          )}
        </section>

        <section>
          <div className="border-b border-foreground pb-1.5">
            <h3 className="text-[15px] font-medium">System pulse</h3>
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground">
            The parts that keep running after you leave.
          </p>
          <PulseRow
            name="Keywords"
            stats={statsQ.data}
            detail={(s) => `${s.activeKeywords} active of ${s.totalKeywords}`}
          />
          <PulseRow
            name="Guides sent today"
            stats={statsQ.data}
            detail={(s) => `${nf.format(s.dmsSentToday)} delivered`}
          />
          <PulseRow
            name="Gate queue"
            stats={statsQ.data}
            detail={(s) => `${nf.format(s.gateQueuePending)} pending`}
            warn={(s) => s.gateQueueExhausted > 0}
            chip={(s) =>
              s.gateQueueExhausted > 0 ? `${nf.format(s.gateQueueExhausted)} gave up` : undefined
            }
          />
          <PulseRow
            name="Completed today"
            stats={statsQ.data}
            detail={(s) => `${nf.format(s.completedToday)} journeys`}
          />
        </section>
      </div>

      <FeedFollowAttributionDrawer
        day={attributionDay}
        data={attributionQ.data}
        isLoading={attributionQ.isLoading}
        isError={attributionQ.isError}
        onRetry={() => void attributionQ.refetch()}
        onClose={() => setAttributionDay(null)}
      />
    </div>
  );
}

/**
 * One line of the system pulse.
 *
 * Takes the stats object rather than pre-formatted strings so that "we have no
 * reading" and "the reading is fine" cannot collapse into the same output. The
 * first build of this row rendered a green "Healthy" chip beside an em-dash
 * whenever the stats request failed — announcing the machine was well while
 * knowing nothing about it, which is the one thing this product must never do.
 * Unknown is its own state here, exactly as it is in the funnel.
 */
function PulseRow({
  name,
  stats,
  detail,
  chip,
  warn,
}: {
  name: string;
  stats: Stats | undefined;
  detail: (s: Stats) => string;
  chip?: (s: Stats) => string | undefined;
  warn?: (s: Stats) => boolean;
}) {
  const known = stats !== undefined;
  const isWarn = known && warn ? warn(stats) : false;

  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-2.5">
      <span>
        <span className="block text-[13px] font-medium">{name}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {known ? detail(stats) : "No reading"}
        </span>
      </span>
      <span
        className={cn(
          "shrink-0 rounded-sm px-2 py-0.5 text-xs",
          !known
            ? "bg-muted text-muted-foreground"
            : isWarn
              ? "bg-destructive/10 text-destructive"
              : "bg-signal-soft text-signal",
        )}
      >
        {!known ? "Unknown" : ((chip && chip(stats)) ?? (isWarn ? "Check" : "Healthy"))}
      </span>
    </div>
  );
}
