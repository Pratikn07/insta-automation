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
import { FollowerFlowPanel } from "@/components/home/FollowerFlowPanel";
import { FeedFollowAttributionDrawer } from "@/components/home/FeedFollowAttributionDrawer";
import { FollowerKpiRow } from "@/components/home/FollowerKpiRow";

/**
 * The growth record's opening page.
 *
 * Composition is Maison: a folio rule across the top, the headline at a fixed
 * measure, then the figures. There is no eyebrow above the headline and no
 * section numbering — both were in the first comp and both are ornament that
 * names nothing the reader needs.
 *
 * Motion lives in the shell's route transition, not here. A staggered entrance
 * on every block reads as a template announcing itself; the page should simply
 * be present when you arrive.
 */
export function Home() {
  const [attributionDay, setAttributionDay] = useState<string | null>(null);
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
      api<FeedFollowAttributionResponse>(
        feedFollowAttributionPath(attributionDay!),
        { signal },
      ),
    enabled: attributionDay !== null,
  });

  const flowPoints = flowQ.data?.points ?? [];
  const flowStock = flowQ.data?.stock ?? null;
  const flowSummary = summarizeFollowerFlow(flowPoints);
  const weekOverWeek = summarizeUsWeekOverWeek(flowPoints);

  // Two shapes, not one string with a prefix baked in: "Updated waiting for the
  // next snapshot" is what prefixing produced, and in tracked caps it ran off
  // the right edge of a phone.
  const updatedLabel = flowStock
    ? `Updated ${new Date(flowStock.capturedAt).toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: flowQ.data?.analyticsTimeZone ?? "America/Los_Angeles",
      })}`
    : "Awaiting first snapshot";

  return (
    // Tightened after seeing it at full size. The first build gave the headline
    // magazine scale and pushed the figures below a fold of air — which reads well
    // once and costs a third of the viewport every day after that. The world is
    // unchanged; only the density is. Editorial character lives in the typeface,
    // the hairlines and the single gold, not in the amount of empty paper.
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b pb-2.5">
        <span className="label-caps">Growth</span>
        <span className="label-caps">{updatedLabel}</span>
      </div>

      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          {/* A title, not a feature. It stops being informative on the second
              visit, so it may not keep the scale it had on the first. */}
          <h1 className="font-display text-[1.4rem] leading-[1.15] tracking-[-0.012em] sm:text-[1.75rem]">
            Who you gained. And <em className="italic text-gold">where</em> they came from.
          </h1>
          <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
            Your followers day by day, by region, in real counts.
          </p>
        </div>
        <Link
          to="/insights"
          className="label-caps shrink-0 border-b border-gold-text pb-1 text-gold-text transition-opacity hover:opacity-70"
        >
          Full insights
        </Link>
      </header>

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
