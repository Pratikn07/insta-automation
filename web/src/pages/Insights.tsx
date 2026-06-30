import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { BarChart3, Film, ExternalLink, Sparkles, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import type { GeoStageSplit, LeaderboardRow, ReelInsightDetail } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";

type Tab = "leaderboard" | "recipe" | "experiments";

const TABS: { value: Tab; label: string; ready: boolean }[] = [
  { value: "leaderboard", label: "Leaderboard", ready: true },
  { value: "recipe", label: "Recipe", ready: false },
  { value: "experiments", label: "Experiments", ready: false },
];

export function Insights() {
  const [tab, setTab] = useState<Tab>("leaderboard");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Insights</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Which reels resonate with a US audience — and why. US-fit is a content
          proxy from video analysis, not measured per-reel geography.
        </p>
      </div>

      <GeoHeader />

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => t.ready && setTab(t.value)}
            disabled={!t.ready}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              tab === t.value
                ? "border-foreground/40 bg-accent/40 text-foreground"
                : "text-muted-foreground hover:bg-accent/20",
              !t.ready && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
          >
            {t.label}
            {!t.ready && <span className="ml-1.5 text-[10px]">soon</span>}
          </button>
        ))}
      </div>

      {tab === "leaderboard" && <Leaderboard />}
    </div>
  );
}

// ── Geo header: the "is the audience actually US?" North Star ────────────────
function GeoHeader() {
  const geoQ = useQuery<{ stages: GeoStageSplit[] }>({
    queryKey: ["insights", "geo"],
    queryFn: () => api<{ stages: GeoStageSplit[] }>("/insights/geo"),
  });

  const stages = geoQ.data?.stages ?? [];
  const hasData = stages.some((s) => s.usPct !== null);

  return (
    <div className="rounded-lg border bg-card/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <BarChart3 className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Audience geography (account-wide)</h3>
      </div>
      {!hasData ? (
        <p className="text-xs text-muted-foreground">
          No demographic snapshot yet — it populates after the first snapshot run.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {stages.map((s) => (
            <div key={s.stage} className="rounded-md border bg-background/40 p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {s.stage === "reached" ? "Reached" : s.stage === "engaged" ? "Engaged" : "Followers"}
              </div>
              {s.usPct !== null ? (
                <>
                  <div className="mt-1 flex items-baseline gap-1">
                    <span className="text-lg font-semibold">{s.usPct}%</span>
                    <span className="text-xs text-muted-foreground">US</span>
                  </div>
                  <div className="text-xs text-muted-foreground">India {s.inPct ?? 0}%</div>
                </>
              ) : (
                <div className="mt-1 text-xs text-muted-foreground">—</div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">
        Reach leads, followers lag. Comment-engagers skew Indian and are not a
        reliable per-reel geo signal.
      </p>
    </div>
  );
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
function Leaderboard() {
  const q = useQuery<{ items: LeaderboardRow[] }>({
    queryKey: ["insights", "leaderboard"],
    queryFn: () => api<{ items: LeaderboardRow[] }>("/insights/leaderboard"),
  });
  const [selected, setSelected] = useState<string | null>(null);

  if (q.isError) {
    return (
      <EmptyState
        icon={<BarChart3 className="size-5" />}
        title="Couldn't load insights"
        description="Try again shortly."
        action={
          <Button variant="outline" onClick={() => q.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  if (q.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[9/16] rounded-lg" />
        ))}
      </div>
    );
  }
  const items = q.data?.items ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Film className="size-5" />}
        title="No reels analyzed yet"
        description="Reels appear here once the snapshot worker has pulled them. US-fit scores fill in as Gemini analyzes each video."
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((row, i) => (
          <motion.button
            key={row.mediaId}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: i * 0.03 }}
            onClick={() => setSelected(row.mediaId)}
            className="group text-left"
          >
            <ReelCard row={row} />
          </motion.button>
        ))}
      </div>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="Reel insight"
        description="Why this reel fits (or doesn't fit) a US audience."
      >
        {selected && <ReelDetailDrawer mediaId={selected} />}
      </Drawer>
    </>
  );
}

function scoreColor(score: number | null): string {
  if (score === null) return "bg-black/55 text-white/80";
  if (score >= 67) return "bg-emerald-500/90 text-white";
  if (score >= 40) return "bg-amber-500/90 text-white";
  return "bg-rose-500/90 text-white";
}

function ReelCard({ row }: { row: LeaderboardRow }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card/40 transition-colors group-hover:border-foreground/30">
      <div className="relative aspect-[9/16] bg-accent">
        {row.thumbnailUrl ? (
          <img
            src={row.thumbnailUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Film className="size-6" />
          </div>
        )}
        {/* US-fit score badge + confidence dot */}
        <div className="absolute right-2 top-2 flex items-center gap-1">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold backdrop-blur",
              scoreColor(row.usFitScore),
            )}
            title={
              row.confidence === "high"
                ? "High confidence (video analyzed)"
                : "Low confidence (caption-only or unanalyzed)"
            }
          >
            {row.usFitScore !== null ? `US ${row.usFitScore}` : "—"}
            <span
              className={cn(
                "size-1.5 rounded-full",
                row.confidence === "high" ? "bg-white" : "bg-white/40",
              )}
            />
          </span>
        </div>
        {row.videoUnavailable && (
          <div className="absolute bottom-2 left-2">
            <span className="rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-white/80 backdrop-blur">
              video unavailable
            </span>
          </div>
        )}
      </div>
      <div className="space-y-1 px-2.5 py-2">
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {row.caption?.trim() || "No caption"}
        </p>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {row.reach !== null && <span>{row.reach.toLocaleString()} reach</span>}
          {row.conversion.completed > 0 && (
            <span className="text-emerald-400">{row.conversion.completed} delivered</span>
          )}
        </div>
      </div>
    </div>
  );
}

function ReelDetailDrawer({ mediaId }: { mediaId: string }) {
  const qc = useQueryClient();
  const detailQ = useQuery<ReelInsightDetail>({
    queryKey: ["insights", "reel", mediaId],
    queryFn: () => api<ReelInsightDetail>(`/insights/reels/${mediaId}`),
  });

  const analyzeM = useMutation({
    mutationFn: () => api(`/insights/reels/${mediaId}/analyze`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["insights", "leaderboard"] });
      qc.invalidateQueries({ queryKey: ["insights", "reel", mediaId] });
    },
  });

  if (detailQ.isLoading) return <Skeleton className="h-64 w-full rounded-lg" />;
  const d = detailQ.data;
  if (!d) return <p className="text-sm text-muted-foreground">Not found.</p>;

  const p = d.contentProfile;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex gap-3 rounded-lg border bg-card/40 p-3">
        <div className="aspect-[9/16] w-20 shrink-0 overflow-hidden rounded bg-accent">
          {d.thumbnailUrl ? (
            <img src={d.thumbnailUrl} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-muted-foreground">
              <Film className="size-5" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                scoreColor(d.usFitScore),
              )}
            >
              {d.usFitScore !== null ? `US-fit ${d.usFitScore}` : "Not scored"}
            </span>
            <span className="text-[11px] text-muted-foreground">{d.confidence ?? ""}</span>
          </div>
          <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
            {d.caption?.trim() || "No caption"}
          </p>
          {d.permalink && (
            <a
              href={d.permalink}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3" /> View on Instagram
            </a>
          )}
        </div>
      </div>

      {/* Why it fits (Gemini content profile) */}
      <Section title="Why it fits a US audience" icon={<Sparkles className="size-3.5" />}>
        {!p ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {d.videoUnavailable
                ? "Video unavailable (likely licensed/trending audio) — not yet analyzed."
                : "Not analyzed yet."}
            </p>
            <Button size="sm" variant="outline" onClick={() => analyzeM.mutate()} disabled={analyzeM.isPending}>
              <RefreshCw className="size-3.5" />
              {analyzeM.isPending ? "Queued…" : "Analyze now"}
            </Button>
          </div>
        ) : (
          <div className="space-y-2 text-xs">
            <p className="text-muted-foreground">{p.usCulturalFitRationale}</p>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Accent" value={`${p.accentScore}`} sub={p.speakerAccent} />
              <Stat label="Setting" value={`${p.settingScore}`} sub={p.visualSetting} />
              <Stat label="Cultural" value={`${p.culturalScore}`} sub={`${p.culturalReferences.length} refs`} />
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Chip>hook: {p.hookArchetype}</Chip>
              <Chip>audio: {p.audioVibe}</Chip>
              <Chip>lang: {p.onScreenLang}</Chip>
            </div>
            <Button size="sm" variant="ghost" onClick={() => analyzeM.mutate()} disabled={analyzeM.isPending}>
              <RefreshCw className="size-3.5" /> Re-analyze
            </Button>
          </div>
        )}
      </Section>

      {/* How it performed (Meta metrics — NOT fused into the score) */}
      <Section title="How it performed">
        {!d.latestPerf ? (
          <p className="text-xs text-muted-foreground">No performance snapshot yet.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 text-xs">
            <Stat label="Reach" value={fmt(d.latestPerf.reach)} />
            <Stat label="Views" value={fmt(d.latestPerf.views)} />
            <Stat
              label="Skip rate"
              value={d.latestPerf.skipRate !== null ? `${(d.latestPerf.skipRate * 100).toFixed(0)}%` : "—"}
            />
            <Stat label="Likes" value={fmt(d.latestPerf.likes)} />
            <Stat label="Saves" value={fmt(d.latestPerf.saved)} />
            <Stat label="Shares" value={fmt(d.latestPerf.shares)} />
          </div>
        )}
      </Section>

      {/* What it converted (your DB — the moat) */}
      <Section title="What it converted">
        <div className="flex items-center gap-2 text-xs">
          <Funnel n={d.conversion.keywordComments} label="keyword comments" />
          <span className="text-muted-foreground">→</span>
          <Funnel n={d.conversion.gateDelivered} label="gate delivered" />
          <span className="text-muted-foreground">→</span>
          <Funnel n={d.conversion.completed} label="guides delivered" tone="text-emerald-400" />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        {icon} {title}
      </h3>
      {children}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border bg-background/40 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
      {sub && <div className="line-clamp-1 text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border bg-background/40 px-2 py-0.5 text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}

function Funnel({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className={cn("text-base font-semibold tabular-nums", tone)}>{n}</span>
      <span className="text-[9px] text-muted-foreground">{label}</span>
    </div>
  );
}

function fmt(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}
