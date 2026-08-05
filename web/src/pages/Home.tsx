import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowUpRight, CalendarDays, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { feedFollowAttributionPath } from "@/lib/feedFollowAttribution";
import type { FeedFollowAttributionResponse, FollowerFlowResponse, Stats } from "@/lib/types";
import { summarizeFollowerFlow, summarizeUsWeekOverWeek } from "@/lib/followerFlow";
import { FollowerFlowPanel } from "@/components/home/FollowerFlowPanel";
import { FeedFollowAttributionDrawer } from "@/components/home/FeedFollowAttributionDrawer";
import { FollowerKpiRow } from "@/components/home/FollowerKpiRow";
import { Button } from "@/components/ui/button";

const fadeUp = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

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

  const updatedLabel = flowStock
    ? new Date(flowStock.capturedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Waiting for the next snapshot";

  return (
    <div className="relative space-y-6 pb-6">
      <div className="pointer-events-none absolute -left-32 -top-32 -z-10 size-80 rounded-full bg-emerald-400/5 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 top-24 -z-10 size-72 rounded-full bg-sky-400/5 blur-3xl" />

      <motion.header
        {...fadeUp}
        transition={{ duration: 0.24 }}
        className="flex flex-col gap-5 rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.055] to-transparent p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6"
      >
        <div className="max-w-2xl">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-violet-300">
            <Sparkles className="size-4" /> Growth snapshot
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">
            Who you gained.<br className="hidden sm:block" /> And where they came from.
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Your followers day by day, by region — in real counts.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/10 px-3 py-2 text-xs text-muted-foreground">
            <CalendarDays className="size-3.5" /> Updated {updatedLabel}
          </div>
          <Button asChild variant="outline" size="sm" className="rounded-full bg-black/10">
            <Link to="/insights">Full insights <ArrowUpRight className="size-3.5" /></Link>
          </Button>
        </div>
      </motion.header>

      <motion.div {...fadeUp} transition={{ duration: 0.24, delay: 0.05 }}>
        <FollowerKpiRow
          weekOverWeek={weekOverWeek}
          stock={flowStock}
          avgPerDay7={flowSummary?.avgPerDay7 ?? null}
          stats={statsQ.data}
          isFlowLoading={flowQ.isLoading}
          isStatsLoading={statsQ.isLoading}
        />
      </motion.div>

      <motion.div {...fadeUp} transition={{ duration: 0.24, delay: 0.1 }}>
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
      </motion.div>

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
