import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { feedFollowAttributionPath } from "@/lib/feedFollowAttribution";
import type {
  FeedFollowAttributionResponse,
  FollowerFlowResponse,
  GuideFollowResult,
  Stats,
} from "@/lib/types";
import { summarizeFollowerFlow, summarizeUsWeekOverWeek } from "@/lib/followerFlow";
import { composeTodaysRead } from "@/lib/todaysRead";
import { FollowerFlowPanel } from "@/components/home/FollowerFlowPanel";
import { FeedFollowAttributionDrawer } from "@/components/home/FeedFollowAttributionDrawer";
import { FollowerKpiRow } from "@/components/home/FollowerKpiRow";
import { cn } from "@/lib/utils";

const nf = new Intl.NumberFormat("en-US");

interface Attention {
  title: string;
  detail: string;
  tag: "Now" | "Today" | "Watch";
  to: string;
  action: string;
}

/**
 * What needs attention, derived — never authored.
 *
 * Every row below comes from a number the API already returns. There is no
 * placeholder list and no ranked advice the data cannot support: when nothing
 * qualifies the section says so, because an empty attention list is a real and
 * good state for this product, not a gap to fill with something plausible.
 *
 * Order is by what a person can actually lose: an ambiguous send is a follower
 * who may never have received their guide, an exhausted gate is one who
 * definitely did not, and the funnel leak is the largest standing loss.
 */
function deriveAttention(stats: Stats | undefined, funnel: GuideFollowResult | undefined): Attention[] {
  const items: Attention[] = [];

  if (stats?.gateQueueSendUncertain) {
    items.push({
      title: `Check ${nf.format(stats.gateQueueSendUncertain)} uncertain gate sends`,
      detail:
        "The DM may already have landed, so these are never retried automatically. Each one is a person who may never have received their gate.",
      tag: "Now",
      to: "/activity",
      action: "Open",
    });
  }

  if (stats?.gateQueueExhausted) {
    items.push({
      title: `${nf.format(stats.gateQueueExhausted)} gate deliveries gave up`,
      detail: "Retries ran out inside the 7-day window. These people asked and never got a reply.",
      tag: "Now",
      to: "/activity",
      action: "Review",
    });
  }

  if (funnel) {
    const { numerator, denominator } = funnel.headline.rate;
    const lost = denominator - numerator;
    if (lost > 0) {
      // "Inspect", not "Rewrite". The cohort proves WHERE people stopped; it
      // does not prove the copy stopped them. Prescribing a rewrite states a
      // cause the measurement cannot support, and this product's standing rule
      // is that every claim traces to evidence. Recommend a rewrite only once
      // message-level or experiment data supports it.
      items.push({
        title: `Inspect the ${funnel.headline.label.toLowerCase()} loss`,
        detail: `${nf.format(lost)} of ${nf.format(denominator)} conversations stop here — the largest measured loss in the journey. What causes it is not yet measured.`,
        tag: "Today",
        to: "/funnels",
        action: "Inspect",
      });
    }
  }

  if (stats?.conversationsAwaiting) {
    items.push({
      title: `${nf.format(stats.conversationsAwaiting)} conversations awaiting a reply`,
      detail: "Waiting on the follower's side. Worth a look if the number keeps climbing.",
      tag: "Watch",
      to: "/conversations",
      action: "Open",
    });
  }

  return items;
}

export function Home() {
  const [attributionDay, setAttributionDay] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const flowQ = useQuery<FollowerFlowResponse>({
    queryKey: ["insights", "follower-daily-adds"],
    queryFn: () => api<FollowerFlowResponse>("/insights/follower-daily-adds"),
  });
  const statsQ = useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: () => api<Stats>("/stats"),
  });
  // Default window (30 days) — no params, so this shares a cache key with the
  // Funnels page's default view rather than re-running the cohort scan.
  const funnelQ = useQuery<GuideFollowResult>({
    queryKey: ["funnels", "guide-follow", "default"],
    queryFn: () => api<GuideFollowResult>("/funnels/guide-follow"),
  });
  const attributionQ = useQuery<FeedFollowAttributionResponse>({
    queryKey: ["insights", "feed-follow-attribution", attributionDay],
    queryFn: ({ signal }) =>
      api<FeedFollowAttributionResponse>(feedFollowAttributionPath(attributionDay!), { signal }),
    enabled: attributionDay !== null,
  });

  const flowPoints = flowQ.data?.points ?? [];
  const flowStock = flowQ.data?.stock ?? null;
  const flowSummary = summarizeFollowerFlow(flowPoints);
  const weekOverWeek = summarizeUsWeekOverWeek(flowPoints);
  const read = composeTodaysRead(weekOverWeek, funnelQ.data);
  const attention = deriveAttention(statsQ.data, funnelQ.data);
  const best = attention[0] ?? null;

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
            {attention.length === 0
              ? "Nothing is waiting on you today."
              : `${attention.length} ${attention.length === 1 ? "decision deserves" : "decisions deserve"} your attention today.`}
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
          ) : flowQ.isError || funnelQ.isError ? (
            <p className="mt-2 max-w-[54ch] text-[13px] leading-relaxed">
              No read available — the API did not answer. This is a connection problem, not an
              empty account.{" "}
              <button
                type="button"
                onClick={() => void flowQ.refetch()}
                className="underline underline-offset-2 [@media(pointer:coarse)]:min-h-11"
              >
                Try again
              </button>
            </p>
          ) : (
            <p className="mt-2 max-w-[54ch] text-[13px] leading-relaxed">
              No read yet. Two days of follower geography are needed before this week can be
              compared with the last; the snapshot worker fills this in on its own.
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
        weekOverWeek={weekOverWeek}
        stock={flowStock}
        avgPerDay7={flowSummary?.avgPerDay7 ?? null}
        stats={statsQ.data}
        funnel={funnelQ.data}
        isFlowLoading={flowQ.isLoading}
        isStatsLoading={statsQ.isLoading}
        isFunnelLoading={funnelQ.isLoading}
      />

      <div className="grid gap-8 lg:grid-cols-[1.55fr_1fr]">
        <section>
          <div className="flex items-baseline justify-between gap-3 border-b border-foreground pb-1.5">
            <h3 className="text-[15px] font-medium">What needs attention</h3>
            <span className="label-caps">Ranked by what is lost</span>
          </div>
          {attention.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground">
              Nothing qualifies. No failed gates, no exhausted retries, nothing waiting.
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
