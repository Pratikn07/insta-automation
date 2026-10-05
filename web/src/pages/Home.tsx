import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiRead } from "@/lib/api";
import type { GuideFollowResult, Stats } from "@/lib/types";
import { deriveHomeAttentionState, type HomeAttentionState, type HomeSource, type SourceState } from "@/lib/homeAttention";
import { AutomationKpiRow } from "@/components/home/AutomationKpiRow";
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

export function Home() {
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
  const attentionState = deriveHomeAttentionState({
    stats: queryState(statsQ),
    funnel: queryState(funnelQ),
  });
  const attention = attentionState.status === "checking" ? [] : attentionState.items;
  const best = attention[0] ?? null;

  const failedSourceControls: Record<
    HomeSource,
    { label: string; retryLabel: string; retry: () => void }
  > = {
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Home</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {attentionHeader(attentionState)}
          </p>
        </div>
      </div>

      <section className="grid border border-line lg:grid-cols-[1.55fr_1fr]">
        <AutomationKpiRow
          funnel={funnelQ.data}
          isLoading={funnelQ.isPending}
          isError={funnelQ.isError}
          onRetry={() => void funnelQ.refetch()}
        />

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
