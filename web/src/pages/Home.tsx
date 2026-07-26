import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowUpRight, CalendarDays, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import type { FollowerFlowResponse, GeoWindowPoint, LeaderboardRow, Stats } from "@/lib/types";
import { rankRepeatCandidates, summarizeAudienceGrowth } from "@/lib/homeDashboard";
import { summarizeFollowerFlow } from "@/lib/followerFlow";
import { AudienceGrowthPanel } from "@/components/home/AudienceGrowthPanel";
import { AutomationHealthStrip } from "@/components/activity/AutomationHealthStrip";
import { FollowerFlowPanel } from "@/components/home/FollowerFlowPanel";
import { FollowerYieldPanel } from "@/components/home/FollowerYieldPanel";
import { RepeatReelsPanel } from "@/components/home/RepeatReelsPanel";
import { Button } from "@/components/ui/button";

interface GeoWindowResponse {
  points: GeoWindowPoint[];
}

interface LeaderboardResponse {
  items: LeaderboardRow[];
}

const fadeUp = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

export function Home() {
  const flowQ = useQuery<FollowerFlowResponse>({
    queryKey: ["insights", "follower-daily-adds"],
    queryFn: () => api<FollowerFlowResponse>("/insights/follower-daily-adds"),
  });
  const geoQ = useQuery<GeoWindowResponse>({
    queryKey: ["insights", "geo-window-trend"],
    queryFn: () => api<GeoWindowResponse>("/insights/geo-window-trend"),
  });
  const leaderboardQ = useQuery<LeaderboardResponse>({
    queryKey: ["insights", "leaderboard"],
    queryFn: () => api<LeaderboardResponse>("/insights/leaderboard"),
  });
  const statsQ = useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: () => api<Stats>("/stats"),
  });

  const flowPoints = flowQ.data?.points ?? [];
  const flowStock = flowQ.data?.stock ?? null;
  const flowSummary = summarizeFollowerFlow(flowPoints);
  const points = geoQ.data?.points ?? [];
  const audience = summarizeAudienceGrowth(points);
  const repeatCandidates = rankRepeatCandidates(leaderboardQ.data?.items ?? []);

  // The follower feed refreshes daily; the reached/engaged feed can freeze for
  // days, so the header date must come from the follower stock, not `audience`.
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
      <div className="pointer-events-none absolute -right-24 top-24 -z-10 size-72 rounded-full bg-fuchsia-400/5 blur-3xl" />

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
            Know what is growing.<br className="hidden sm:block" /> Repeat what is working.
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Who you gained each day, where they are from, and the reels earning another version.
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

      <div className="grid items-stretch gap-5 xl:grid-cols-2">
        <motion.div {...fadeUp} transition={{ duration: 0.24, delay: 0.05 }}>
          <FollowerFlowPanel
            points={flowPoints}
            stock={flowStock}
            summary={flowSummary}
            isLoading={flowQ.isLoading}
            isError={flowQ.isError}
            onRetry={() => void flowQ.refetch()}
            now={new Date().toISOString()}
          />
        </motion.div>
        <motion.div {...fadeUp} transition={{ duration: 0.24, delay: 0.1 }}>
          <RepeatReelsPanel
            candidates={repeatCandidates}
            isLoading={leaderboardQ.isLoading}
            isError={leaderboardQ.isError}
            onRetry={() => void leaderboardQ.refetch()}
          />
        </motion.div>
      </div>

      <div className="grid items-stretch gap-5 xl:grid-cols-2">
        <motion.div {...fadeUp} transition={{ duration: 0.24, delay: 0.15 }}>
          <AudienceGrowthPanel
            points={points}
            summary={audience}
            isLoading={geoQ.isLoading}
            isError={geoQ.isError}
            onRetry={() => void geoQ.refetch()}
            asOf={audience?.capturedAt ?? null}
          />
        </motion.div>
        <motion.div {...fadeUp} transition={{ duration: 0.24, delay: 0.2 }} className="space-y-5">
          <AutomationHealthStrip stats={statsQ.data} isLoading={statsQ.isLoading} />
          <FollowerYieldPanel stats={statsQ.data} isLoading={statsQ.isLoading} />
        </motion.div>
      </div>
    </div>
  );
}
