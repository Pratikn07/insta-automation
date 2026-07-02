import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { BarChart3, Film, ExternalLink, Sparkles, RefreshCw, ListChecks, FlaskConical } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type {
  GeoStageSplit,
  LeaderboardRow,
  ReelInsightDetail,
  RecipeData,
  RecipeGroup,
  Experiment,
  UsReachTrendPoint,
  GeoWindowPoint,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";

type Tab = "leaderboard" | "recipe" | "experiments";

const TABS: { value: Tab; label: string; ready: boolean }[] = [
  { value: "leaderboard", label: "Leaderboard", ready: true },
  { value: "recipe", label: "Recipe", ready: true },
  { value: "experiments", label: "Experiments", ready: true },
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
      {tab === "recipe" && <Recipe />}
      {tab === "experiments" && <Experiments />}
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

// ── Recipe (Tab 2) ───────────────────────────────────────────────────────────
function Recipe() {
  const q = useQuery<RecipeData>({
    queryKey: ["insights", "recipe"],
    queryFn: () => api<RecipeData>("/insights/recipe"),
  });

  if (q.isError) {
    return (
      <EmptyState
        icon={<ListChecks className="size-5" />}
        title="Couldn't load the recipe"
        description="Try again shortly."
        action={
          <Button variant="outline" onClick={() => q.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  if (q.isLoading) return <Skeleton className="h-72 w-full rounded-lg" />;

  const data = q.data;
  if (!data || !data.ready || !data.top || !data.bottom) {
    return (
      <EmptyState
        icon={<ListChecks className="size-5" />}
        title="Not enough analyzed reels yet"
        description={`The recipe contrasts your top vs bottom US-fit reels. ${
          data?.scoredCount ?? 0
        } scored so far — it sharpens as more are analyzed.`}
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* Honesty banner: US-fit is a tone label, not a performance predictor. */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200/90">
        <span className="font-medium">US-fit describes who a reel is aimed at — not how far it travels.</span>{" "}
        Across your {data.scoredCount} scored reels, US-fit and reach are essentially uncorrelated
        {data.usFitReachCorr !== null ? ` (r = ${data.usFitReachCorr})` : ""}. The contrast below is
        about tone and style, not a reach or growth formula.
      </div>

      {/* The style takeaway, up top */}
      <div className="rounded-lg border bg-card/40 p-4">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          <ListChecks className="size-4 text-emerald-400" /> What makes a reel read as US-aimed
        </h3>
        {data.checklist.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No clear pattern yet — analyze more reels to surface the recipe.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {data.checklist.map((c, i) => (
              <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                <span className="mt-0.5 text-emerald-400">✓</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          Derived by contrasting your {data.top.reels.length} highest vs{" "}
          {data.bottom.reels.length} lowest US-fit reels ({data.scoredCount} analyzed). US-fit is a
          content-tone proxy from video analysis, not measured per-reel geography — and it does not
          predict reach. Use it to gauge how US-aimed a reel reads, not whether it will perform.
        </p>
      </div>

      {/* Side-by-side contrast */}
      <div className="grid gap-4 md:grid-cols-2">
        <RecipeColumn group={data.top} tone="us" />
        <RecipeColumn group={data.bottom} tone="india" />
      </div>
    </div>
  );
}

function RecipeColumn({ group, tone }: { group: RecipeGroup; tone: "us" | "india" }) {
  const accent = tone === "us" ? "text-emerald-400" : "text-muted-foreground";
  const refs = tone === "us" ? group.usRefs : group.indiaRefs;
  return (
    <div className="space-y-3 rounded-lg border bg-card/40 p-4">
      <div className="flex items-center justify-between">
        <h3 className={cn("text-sm font-medium", accent)}>{group.label}</h3>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
            scoreColor(group.avgUsFit),
          )}
        >
          avg US-fit {group.avgUsFit ?? "—"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Setting" value={group.avgSettingScore !== null ? `${group.avgSettingScore}` : "—"} />
        <Stat label="Cultural" value={group.avgCulturalScore !== null ? `${group.avgCulturalScore}` : "—"} />
        <Stat label="Median reach" value={fmt(group.medianReach)} />
      </div>

      <div className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {tone === "us" ? "US cultural cues" : "India cultural cues"}
        </div>
        {refs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {tone === "us"
              ? "No US-specific references — this is the tell of a generic reel."
              : "No India-specific references."}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {refs.map((r) => (
              <Chip key={r.text}>
                {r.text}
                {r.count > 1 && <span className="ml-1 opacity-60">×{r.count}</span>}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {/* A few thumbnails from this group */}
      <div className="flex gap-1.5 pt-1">
        {group.reels.slice(0, 4).map((r) =>
          r.thumbnailUrl ? (
            <img
              key={r.mediaId}
              src={r.thumbnailUrl}
              alt=""
              className="aspect-[9/16] w-12 shrink-0 rounded object-cover"
            />
          ) : (
            <div
              key={r.mediaId}
              className="flex aspect-[9/16] w-12 shrink-0 items-center justify-center rounded bg-accent text-muted-foreground"
            >
              <Film className="size-4" />
            </div>
          ),
        )}
      </div>
    </div>
  );
}

// ── Experiments (Tab 3) ──────────────────────────────────────────────────────
const STATUS_TONE: Record<Experiment["status"], string> = {
  running: "text-sky-400 bg-sky-400/10",
  confirmed: "text-emerald-400 bg-emerald-400/10",
  busted: "text-rose-400 bg-rose-400/10",
  inconclusive: "text-muted-foreground bg-muted/40",
};

function Experiments() {
  const qc = useQueryClient();
  const trendQ = useQuery<{ points: UsReachTrendPoint[] }>({
    queryKey: ["insights", "us-reach-trend"],
    queryFn: () => api<{ points: UsReachTrendPoint[] }>("/insights/us-reach-trend"),
  });
  const windowQ = useQuery<{ points: GeoWindowPoint[] }>({
    queryKey: ["insights", "geo-window-trend"],
    queryFn: () => api<{ points: GeoWindowPoint[] }>("/insights/geo-window-trend"),
  });
  const expsQ = useQuery<{ items: Experiment[] }>({
    queryKey: ["insights", "experiments"],
    queryFn: () => api<{ items: Experiment[] }>("/insights/experiments"),
  });

  const points = trendQ.data?.points ?? [];
  const windowPoints = windowQ.data?.points ?? [];
  const experiments = expsQ.data?.items ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["insights", "experiments"] });
    qc.invalidateQueries({ queryKey: ["insights", "us-reach-trend"] });
    qc.invalidateQueries({ queryKey: ["insights", "geo-window-trend"] });
  };

  return (
    <div className="space-y-5">
      {/* Recent-vs-baseline thermometer: are RECENT reels pulling US or not? */}
      <RecentAudiencePanel points={windowPoints} />

      {/* Reached-US% trend */}
      <div className="rounded-lg border bg-card/40 p-4">
        <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
          <BarChart3 className="size-4 text-muted-foreground" /> Reached-US% over time
        </h3>
        <UsReachChart points={points} />
        <p className="mt-2 text-[11px] text-muted-foreground">
          {points.length < 5
            ? `${points.length} snapshot${points.length === 1 ? "" : "s"} so far — the trend sharpens as data accrues (daily). `
            : ""}
          Account-wide reached-US% (90-day window). Correlational, not causal — run one change at a
          time for a clean read.
        </p>
      </div>

      <NewExperimentForm onCreated={invalidate} />

      {/* Experiment list */}
      {expsQ.isLoading ? (
        <Skeleton className="h-32 w-full rounded-lg" />
      ) : experiments.length === 0 ? (
        <EmptyState
          icon={<FlaskConical className="size-5" />}
          title="No experiments yet"
          description="Log a hypothesis above, post the reel(s) that test it, then watch whether reached-US% moves over the following weeks."
        />
      ) : (
        <div className="space-y-3">
          {experiments.map((e) => (
            <ExperimentCard key={e.id} exp={e} onChange={invalidate} />
          ))}
        </div>
      )}
    </div>
  );
}

// The "recent reels" thermometer. Compares the latest 14-day window (what your
// RECENT reels pulled) against the 90-day baseline. A 14d BELOW 90d means recent
// content skewed less US than your historical norm — the signal Pratik wants.
function RecentAudiencePanel({ points }: { points: GeoWindowPoint[] }) {
  const latest = points.length ? points[points.length - 1] : null;

  const Metric = ({
    label,
    us14,
    us90,
    in14,
  }: {
    label: string;
    us14: number | null;
    us90: number | null;
    in14: number | null;
  }) => {
    const delta = us14 !== null && us90 !== null ? Math.round((us14 - us90) * 10) / 10 : null;
    const tone =
      delta === null ? "text-muted-foreground" : delta >= 0 ? "text-emerald-400" : "text-rose-400";
    return (
      <div className="rounded-md border bg-background/40 p-3">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-semibold">{us14 ?? "—"}%</span>
          <span className="text-[11px] text-muted-foreground">US · last 14d</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          vs {us90 ?? "—"}% baseline (90d)
          {delta !== null && (
            <span className={cn("ml-1 font-medium", tone)}>
              {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)} pts
            </span>
          )}
        </div>
        {in14 !== null && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">India last 14d: {in14}%</div>
        )}
      </div>
    );
  };

  return (
    <div className="rounded-lg border bg-card/40 p-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <BarChart3 className="size-4 text-muted-foreground" /> Recent reels: who are they pulling?
      </h3>
      {!latest ? (
        <p className="py-3 text-xs text-muted-foreground">
          No windowed snapshot yet — this fills in on the next daily snapshot tick.
        </p>
      ) : (
        <>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Metric
              label="Engaged"
              us14={latest.engagedUs14}
              us90={latest.engagedUs90}
              in14={latest.engagedIn14}
            />
            <Metric
              label="Reached"
              us14={latest.reachedUs14}
              us90={latest.reachedUs90}
              in14={latest.reachedIn14}
            />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            14-day window ≈ your ~last two weeks of reels. When the 14d US% sits{" "}
            <span className="text-rose-400">below</span> the 90d baseline, recent content skewed less
            US than your norm. Account-level (Meta gives no per-reel geo) — attribute to whichever
            reel dominated the window's reach.
          </p>
        </>
      )}
    </div>
  );
}

// Tiny dependency-free SVG line chart (recharts couldn't be installed in this
// environment, and a single slow-moving line doesn't justify a 500KB dep).
function UsReachChart({ points }: { points: UsReachTrendPoint[] }) {
  const vals = points.map((p) => p.usPct).filter((v): v is number => v !== null);
  if (vals.length === 0) {
    return <div className="py-6 text-center text-xs text-muted-foreground">No snapshots yet.</div>;
  }
  if (points.length === 1) {
    return (
      <div className="py-4 text-center">
        <span className="text-2xl font-semibold">{vals[0]}%</span>
        <span className="ml-1 text-xs text-muted-foreground">US (single reading)</span>
      </div>
    );
  }
  const W = 600, H = 120, pad = 8;
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const xs = (i: number) => pad + (i / (points.length - 1)) * (W - 2 * pad);
  const ys = (v: number) => H - pad - ((v - min) / range) * (H - 2 * pad);
  const path = points
    .map((p, i) => (p.usPct === null ? null : `${i === 0 ? "M" : "L"}${xs(i)},${ys(p.usPct)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} className="text-emerald-400" />
      {points.map((p, i) =>
        p.usPct === null ? null : (
          <circle key={i} cx={xs(i)} cy={ys(p.usPct)} r={2.5} className="fill-emerald-400" />
        ),
      )}
    </svg>
  );
}

function NewExperimentForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [hypothesis, setHypothesis] = useState("");
  const [variable, setVariable] = useState("");

  const createM = useMutation({
    mutationFn: () =>
      api("/insights/experiments", {
        method: "POST",
        body: JSON.stringify({ hypothesis, variable, reelMediaIds: [] }),
      }),
    onSuccess: () => {
      toast.success("Experiment started — baseline US% captured.");
      setHypothesis("");
      setVariable("");
      setOpen(false);
      onCreated();
    },
    onError: () => toast.error("Couldn't create experiment."),
  });

  if (!open) {
    return (
      <Button variant="brand" size="sm" onClick={() => setOpen(true)}>
        <FlaskConical className="size-4" /> New experiment
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card/40 p-4">
      <div className="space-y-1.5">
        <Label htmlFor="hyp">Hypothesis</Label>
        <Textarea
          id="hyp"
          value={hypothesis}
          onChange={(e) => setHypothesis(e.target.value)}
          placeholder="e.g. Reels using trending US audio lift reached-US%"
          rows={2}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="var">What you're changing (the variable)</Label>
        <Input
          id="var"
          value={variable}
          onChange={(e) => setVariable(e.target.value)}
          placeholder="e.g. trending US audio"
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="brand"
          disabled={!hypothesis.trim() || !variable.trim() || createM.isPending}
          onClick={() => createM.mutate()}
        >
          {createM.isPending ? "Starting…" : "Start experiment"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Baseline reached-US% is captured now. Post the reel(s) testing this, then check back over the
        coming weeks.
      </p>
    </div>
  );
}

function ExperimentCard({ exp, onChange }: { exp: Experiment; onChange: () => void }) {
  const patchM = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/insights/experiments/${exp.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: onChange,
    onError: () => toast.error("Update failed."),
  });

  const baseline = exp.baselineUsPct;
  const current = exp.currentUsPct;
  const delta = baseline !== null && current !== null ? Math.round((current - baseline) * 10) / 10 : null;

  return (
    <div className="space-y-3 rounded-lg border bg-card/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{exp.hypothesis}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Changing: {exp.variable}</p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            STATUS_TONE[exp.status],
          )}
        >
          {exp.status}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Baseline US%" value={baseline !== null ? `${baseline}%` : "—"} />
        <Stat label="Current US%" value={current !== null ? `${current}%` : "—"} />
        <Stat
          label="Delta"
          value={delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta} pts`}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={patchM.isPending} onClick={() => patchM.mutate({ measure: true })}>
          <RefreshCw className="size-3.5" /> Measure now
        </Button>
        {exp.status === "running" && (
          <>
            <Button size="sm" variant="ghost" onClick={() => patchM.mutate({ status: "confirmed" })}>
              Mark confirmed
            </Button>
            <Button size="sm" variant="ghost" onClick={() => patchM.mutate({ status: "busted" })}>
              Mark busted
            </Button>
            <Button size="sm" variant="ghost" onClick={() => patchM.mutate({ status: "inconclusive" })}>
              Inconclusive
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
