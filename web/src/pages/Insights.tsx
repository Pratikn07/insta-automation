import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { BarChart3, Film, ExternalLink, Sparkles, RefreshCw, ListChecks, FlaskConical, Target } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, apiRead } from "@/lib/api";
import type {
  GeoStageSplit,
  LeaderboardRow,
  ReelInsightDetail,
  RecipeData,
  RecipeGroup,
  ReelOriginRow,
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
import { RepeatReelsCard } from "@/components/insights/RepeatReelsCard";
import {
  rankCaptureLeaders,
  formatCaptureRate,
  recommendNextTest,
  learnedPatterns,
  type LearnedPattern,
} from "@/lib/growthLab";
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
    queryFn: ({ signal }) => apiRead<{ stages: GeoStageSplit[] }>("/insights/geo", { signal }),
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
    queryFn: ({ signal }) => apiRead<{ items: LeaderboardRow[] }>("/insights/leaderboard", { signal }),
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
      <RepeatReelsCard rows={items} isLoading={q.isLoading} />

      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
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

// Three bands and an absence. Solid fills carrying paper-coloured text, measured:
// signal 8.96:1, caution 5.85:1, urgent 5.57:1.
//
// The unscored case is muted rather than a grey fill. funnel-unknown (#8f8a80)
// is the system's colour for absence of evidence, but text on it measures 3.15:1
// — below the floor — and a badge that says "no score yet" has to be readable to
// say it. Grey ground with grey text carries the same meaning and can be read.
//
// A low score gets urgent, which the system defines as attention rather than
// alarm: this reel needs rethinking, not that it failed.
function scoreColor(score: number | null): string {
  if (score === null) return "bg-muted text-muted-foreground";
  if (score >= 67) return "bg-signal text-primary-foreground";
  if (score >= 40) return "bg-caution text-primary-foreground";
  return "bg-urgent text-primary-foreground";
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
          {row.reach !== null && <span>{row.reach.toLocaleString()} reach</span>}
          {row.captureRatePct !== null && (
            <span className="text-funnel-mark" title="Share of reach that entered the DM funnel">
              {formatCaptureRate(row.captureRatePct)} capture
            </span>
          )}
          {row.conversion.completed > 0 && (
            <span className="text-funnel-mark">{row.conversion.completed} delivered</span>
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
    queryFn: ({ signal }) => apiRead<ReelInsightDetail>(`/insights/reels/${mediaId}`, { signal }),
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
          <Funnel n={d.conversion.completed} label="guides delivered" tone="text-funnel-mark" />
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
    queryFn: ({ signal }) => apiRead<RecipeData>("/insights/recipe", { signal }),
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
      <div className="rounded-lg border border-caution bg-caution-soft p-3 text-xs text-caution">
        <span className="font-medium">US-fit describes who a reel is aimed at — not how far it travels.</span>{" "}
        Across your {data.scoredCount} scored reels, US-fit and reach are essentially uncorrelated
        {data.usFitReachCorr !== null ? ` (r = ${data.usFitReachCorr})` : ""}. The contrast below is
        about tone and style, not a reach or growth formula.
      </div>

      {/* The style takeaway, up top */}
      <div className="rounded-lg border bg-card/40 p-4">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          <ListChecks className="size-4 text-signal" /> What makes a reel read as US-aimed
        </h3>
        {data.checklist.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No clear pattern yet — analyze more reels to surface the recipe.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {data.checklist.map((c, i) => (
              <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                <span className="mt-0.5 text-signal">✓</span>
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

      {/* Per-reel gate-audience origin (proxy + gate-crowd only). */}
      <GateAudiencePanel />
    </div>
  );
}

// Per-reel inferred origin of the people who COMMENTED A KEYWORD on each reel.
// Two loud caveats, because this is the most misread panel on the page:
//   1. Origin is guessed from name/username — a proxy, not real geography.
//   2. Only keyword-commenters are here; that behavior skews South Asian, and
//      silent (mostly US) followers leave no trace. NOT "which reel brings US".
function GateAudiencePanel() {
  const q = useQuery<{ items: ReelOriginRow[] }>({
    queryKey: ["insights", "reel-origin"],
    queryFn: ({ signal }) => apiRead<{ items: ReelOriginRow[] }>("/insights/reel-origin", { signal }),
  });
  const items = (q.data?.items ?? []).filter((r) => r.total > 0);

  return (
    <div className="rounded-lg border bg-card/40 p-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <ListChecks className="size-4 text-muted-foreground" /> Gate audience by reel (keyword-commenters)
      </h3>
      <div className="mb-3 rounded-md border border-caution bg-caution-soft p-2.5 text-[11px] text-caution">
        Origin is inferred from each person's name/username — a <span className="font-medium">proxy, not real geography</span>.
        And this counts only people who <span className="font-medium">commented a keyword</span> (a habit that skews South
        Asian); your silent followers — where most US followers are — aren't here. Read it as "who plays the keyword game
        on each reel," not "which reel brings Americans."
      </div>
      {q.isLoading ? (
        <Skeleton className="h-24 w-full rounded-md" />
      ) : items.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">
          No keyword-commenters mapped yet — run the origin backfill, then this fills in.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((r) => {
            const usPct = r.total ? Math.round((r.usWestern / r.total) * 100) : 0;
            const saPct = r.total ? Math.round((r.southAsian / r.total) * 100) : 0;
            return (
              <div key={r.mediaId} className="rounded-md border bg-background/40 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs">{r.caption ?? r.mediaId}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {r.total} commenters · {r.followers} followed
                  </span>
                </div>
                {/* US vs SA vs other. Country marks from the categorical series,
                    which is what that series is for — separated by hue, not by
                    lightness, so neither segment reads as the larger one.

                    It was green for US and amber for South Asian, which colours a
                    geography as good and a geography as a warning. The rule is
                    that colour may mark where you are, not grade a conclusion,
                    and an audience segment is not a verdict. The labels still say
                    which is which; only the valence is gone.

                    c1 skipped deliberately: its hex is the accent's, so a US
                    segment in c1 would have kept exactly the reading this change
                    removes. */}
                <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-muted">
                  <div className="bg-c3" style={{ width: `${usPct}%` }} title={`US/Western ${usPct}%`} />
                  <div className="bg-c2" style={{ width: `${saPct}%` }} title={`South Asian ${saPct}%`} />
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  <span className="text-c3">US/Western {r.usWestern}</span> ·{" "}
                  <span className="text-c2">S. Asian {r.southAsian}</span>
                  {r.other + r.unknown > 0 && <span> · other/unknown {r.other + r.unknown}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RecipeColumn({ group, tone }: { group: RecipeGroup; tone: "us" | "india" }) {
  // Emphasis, not category colour: US is the column this account is optimising
  // for, so it carries full weight and India recedes. Colouring the heading would
  // grade one audience against the other, which is the reading the bar above
  // just had removed.
  const accent = tone === "us" ? "text-foreground" : "text-muted-foreground";
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
  running: "text-funnel-mark bg-mark-soft",
  confirmed: "text-signal bg-signal-soft",
  busted: "text-urgent bg-urgent-soft",
  inconclusive: "text-muted-foreground bg-muted/40",
};

// Lead recommendation for the growth lab: the reels that convert the most reach
// into the DM funnel (capture rate = keyword comments ÷ reach). Per-reel and
// directly attributable, so honest to act on — unlike account-level geo.
function CaptureLeadersCard({ rows, isLoading }: { rows: LeaderboardRow[]; isLoading: boolean }) {
  const leaders = rankCaptureLeaders(rows);
  return (
    <div className="rounded-lg border bg-card/40 p-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <Target className="size-4 text-muted-foreground" /> What converts best
      </h3>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Share of each reel's reach that entered the DM funnel. The most directly-attributable
        per-reel signal — repeat the hooks that convert, not just the ones that go viral.
      </p>
      {isLoading ? (
        <Skeleton className="h-24 w-full rounded-md" />
      ) : leaders.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">
          Not enough reach yet to rank reels by capture — this fills in as reels accrue reach.
        </p>
      ) : (
        <ol className="space-y-2">
          {leaders.map((l) => (
            <li
              key={l.row.mediaId}
              className="flex items-center gap-3 rounded-md border bg-background/40 p-2.5"
            >
              {l.row.thumbnailUrl ? (
                <img
                  src={l.row.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  className="size-12 shrink-0 rounded object-cover"
                />
              ) : (
                <div className="flex size-12 shrink-0 items-center justify-center rounded bg-accent text-muted-foreground">
                  <Film className="size-4" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-xs">{l.row.caption?.trim() || "No caption"}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{l.reason}</p>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-semibold text-funnel-mark">
                  {formatCaptureRate(l.captureRatePct)}
                </div>
                <div className="text-[10px] text-muted-foreground">{l.completed} delivered</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// US-audience recommendation, kept separate from capture rate: which content
// feature to test next, from completed auto-experiments with usable attribution.
function NextTestCard({ experiments }: { experiments: Experiment[] }) {
  const rec = recommendNextTest(experiments);
  return (
    <div className="rounded-lg border bg-card/40 p-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="size-4 text-muted-foreground" /> Recommended next test
      </h3>
      <p className={cn("text-xs", rec.status === "recommended" ? "text-foreground" : "text-muted-foreground")}>
        {rec.headline}
      </p>
      <p className="mt-2 text-[11px] text-muted-foreground">
        From completed auto-experiments with usable reach-share attribution (high or medium
        confidence). A US-audience signal — separate from capture rate above.
      </p>
    </div>
  );
}

const PATTERN_BADGE: Record<LearnedPattern["label"], { text: string; cls: string }> = {
  repeat: { text: "Repeat", cls: "bg-signal-soft text-signal" },
  rethink: { text: "Rethink", cls: "bg-urgent-soft text-urgent" },
  collecting: { text: "Collecting", cls: "bg-muted text-muted-foreground" },
};

function LearnedPatterns({ experiments }: { experiments: Experiment[] }) {
  const patterns = learnedPatterns(experiments);
  if (patterns.length === 0) return null;
  return (
    <div className="rounded-lg border bg-card/40 p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        <ListChecks className="size-4 text-muted-foreground" /> Learned patterns
      </h3>
      <ul className="space-y-1.5">
        {patterns.map((p) => {
          const badge = PATTERN_BADGE[p.label];
          const shift = `${p.meanShift >= 0 ? "+" : "−"}${Math.abs(p.meanShift).toFixed(1)}`;
          return (
            <li
              key={`${p.dimension}:${p.feature}`}
              className="flex items-center justify-between gap-2 rounded-md border bg-background/40 p-2 text-xs"
            >
              <span className="min-w-0 truncate">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {p.dimension}
                </span>{" "}
                {p.feature}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-[10px] text-muted-foreground">
                  {p.positive}/{p.total} · {shift} pts
                </span>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", badge.cls)}>
                  {badge.text}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Experiments() {
  const qc = useQueryClient();
  const trendQ = useQuery<{ points: UsReachTrendPoint[] }>({
    queryKey: ["insights", "us-reach-trend"],
    queryFn: ({ signal }) => apiRead<{ points: UsReachTrendPoint[] }>("/insights/us-reach-trend", { signal }),
  });
  const windowQ = useQuery<{ points: GeoWindowPoint[] }>({
    queryKey: ["insights", "geo-window-trend"],
    queryFn: ({ signal }) => apiRead<{ points: GeoWindowPoint[] }>("/insights/geo-window-trend", { signal }),
  });
  const expsQ = useQuery<{ items: Experiment[] }>({
    queryKey: ["insights", "experiments"],
    queryFn: ({ signal }) => apiRead<{ items: Experiment[] }>("/insights/experiments", { signal }),
  });
  // Reuses the Leaderboard tab's cached query (same key) for the capture card.
  const leaderboardQ = useQuery<{ items: LeaderboardRow[] }>({
    queryKey: ["insights", "leaderboard"],
    queryFn: ({ signal }) => apiRead<{ items: LeaderboardRow[] }>("/insights/leaderboard", { signal }),
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
      {/* Lead recommendation: which reels turn views into the funnel. */}
      <CaptureLeadersCard rows={leaderboardQ.data?.items ?? []} isLoading={leaderboardQ.isLoading} />

      {/* US-audience recommendation + the evidence behind it. */}
      <NextTestCard experiments={experiments} />
      <LearnedPatterns experiments={experiments} />

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

function RecentAudienceMetric({
  label,
  us14,
  us90,
  in14,
}: {
  label: string;
  us14: number | null;
  us90: number | null;
  in14: number | null;
}) {
  const delta = us14 !== null && us90 !== null ? Math.round((us14 - us90) * 10) / 10 : null;
  // The one place on this page where colour grades a direction, and it is allowed
  // to: US share is the account's stated success metric, so up is unambiguously
  // the thing being aimed at. Elsewhere — the geography bar, the recipe columns —
  // there is no such agreed direction and colour stays out of it.
  //
  // A null delta is muted, not zero-coloured: no 90d baseline is an absence of
  // comparison, not a flat result.
  const tone =
    delta === null ? "text-muted-foreground" : delta >= 0 ? "text-signal" : "text-urgent";
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
}

// The "recent reels" thermometer. Compares the latest 14-day window (what your
// RECENT reels pulled) against the 90-day baseline. A 14d BELOW 90d means recent
// content skewed less US than your historical norm — the signal Pratik wants.
function RecentAudiencePanel({ points }: { points: GeoWindowPoint[] }) {
  const latest = points.length ? points[points.length - 1] : null;

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
            <RecentAudienceMetric
              label="Engaged"
              us14={latest.engagedUs14}
              us90={latest.engagedUs90}
              in14={latest.engagedIn14}
            />
            <RecentAudienceMetric
              label="Reached"
              us14={latest.reachedUs14}
              us90={latest.reachedUs90}
              in14={latest.reachedIn14}
            />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            14-day window ≈ your ~last two weeks of reels. When the 14d US% sits{" "}
            <span className="text-urgent">below</span> the 90d baseline, recent content skewed less
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
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} className="text-funnel-mark" />
      {points.map((p, i) =>
        p.usPct === null ? null : (
          <circle key={i} cx={xs(i)} cy={ys(p.usPct)} r={2.5} className="fill-funnel-mark" />
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

  const isAuto = exp.origin === "auto";
  const baseline = exp.baselineUsPct;
  const current = exp.currentUsPct;
  const delta = baseline !== null && current !== null ? Math.round((current - baseline) * 10) / 10 : null;

  // Auto-experiments track the responsive 14d ENGAGED-US% before→after.
  const eBase = exp.baselineEngagedUsPct;
  const eMeas = exp.measuredEngagedUsPct;
  const eDelta = eBase !== null && eMeas !== null ? Math.round((eMeas - eBase) * 10) / 10 : null;
  const sharePct = exp.windowReachShare !== null ? Math.round(exp.windowReachShare * 100) : null;

  return (
    <div className="space-y-3 rounded-lg border bg-card/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {isAuto && (
              <span className="shrink-0 rounded bg-mark-soft px-1.5 py-0.5 text-[10px] font-medium text-funnel-mark">
                AUTO
              </span>
            )}
            <p className="truncate text-sm font-medium">{exp.hypothesis}</p>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isAuto && exp.usFitScore !== null ? `US-fit ${exp.usFitScore}` : `Changing: ${exp.variable}`}
            {isAuto && exp.culturalCues.length > 0 && ` · ${exp.culturalCues.slice(0, 3).join(", ")}`}
          </p>
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

      {/* Auto-experiments lead with the 14d engaged signal; manual with 90d reached. */}
      {isAuto ? (
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Engaged US% at post" value={eBase !== null ? `${eBase}%` : "—"} />
          <Stat label="Engaged US% now" value={eMeas !== null ? `${eMeas}%` : "measuring…"} />
          <Stat label="Shift" value={eDelta === null ? "—" : `${eDelta > 0 ? "+" : ""}${eDelta} pts`} />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Baseline US%" value={baseline !== null ? `${baseline}%` : "—"} />
          <Stat label="Current US%" value={current !== null ? `${current}%` : "—"} />
          <Stat label="Delta" value={delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta} pts`} />
        </div>
      )}

      {/* Auto suggestion + attribution confidence — a SUGGESTION, you still decide. */}
      {isAuto && exp.suggestedVerdict && (
        <div
          className={cn(
            "rounded-md border p-2.5 text-[11px]",
            exp.attributionConfidence === "high"
              ? "border-signal bg-signal-soft text-signal"
              : "border-caution bg-caution-soft text-caution",
          )}
        >
          {exp.attributionConfidence === "high" ? (
            <>
              <span className="font-medium">Suggested: {exp.suggestedVerdict}.</span> This reel drove{" "}
              {sharePct}% of its 14-day window's reach, so the US% shift is fairly attributable to it.
            </>
          ) : (
            <>
              <span className="font-medium">Inconclusive — overlapping reels.</span> This reel was only{" "}
              {sharePct ?? "—"}% of its window's reach, so the account-level US% move can't be pinned to it.
              Correlational only.
            </>
          )}
        </div>
      )}

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
