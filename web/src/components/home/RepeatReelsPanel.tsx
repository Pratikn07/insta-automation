import { ArrowUpRight, Eye, Film, RefreshCw, Repeat2, Sparkles } from "lucide-react";
import type { RepeatCandidate } from "@/lib/homeDashboard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyPanel, PanelShell } from "./PanelShell";

interface RepeatReelsPanelProps {
  candidates: RepeatCandidate[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function RepeatReelsPanel({ candidates, isLoading, isError, onRetry }: RepeatReelsPanelProps) {
  if (isLoading) return <Skeleton className="min-h-[600px] rounded-2xl" />;

  if (isError) {
    return (
      <PanelShell>
        <EmptyPanel
          title="Reel performance couldn't load"
          body="Your audience signal is still available. Retry this panel to restore repeat recommendations."
          action={<Button variant="outline" size="sm" onClick={onRetry}><RefreshCw className="size-3.5" /> Retry</Button>}
          Icon={Repeat2}
          accentClassName="bg-fuchsia-400/10 text-fuchsia-300"
        />
      </PanelShell>
    );
  }

  if (candidates.length === 0) {
    return (
      <PanelShell>
        <EmptyPanel
          title="Waiting for reel performance"
          body="Once snapshots include reach, skip rate, or guide deliveries, your clearest repeat candidates will appear here."
          Icon={Repeat2}
          accentClassName="bg-fuchsia-400/10 text-fuchsia-300"
        />
      </PanelShell>
    );
  }

  return (
    <PanelShell className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-fuchsia-400/15 via-violet-400/5 to-transparent" />
      <div className="relative">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-fuchsia-300">
              <Repeat2 className="size-4" /> Reel performance
            </div>
            <h2 className="text-xl font-semibold tracking-tight">Which reels should I repeat?</h2>
          </div>
          <span className="rounded-full border border-fuchsia-300/20 bg-fuchsia-300/10 px-2.5 py-1 text-xs font-semibold text-fuchsia-200">
            Top {candidates.length}
          </span>
        </div>

        <div className="space-y-3">
          {candidates.map((candidate) => (
            <article key={candidate.mediaId} className="group rounded-2xl border border-white/10 bg-black/15 p-3 transition-colors hover:bg-white/[0.04]">
              <div className="flex gap-3">
                <div className="relative h-28 w-20 shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-fuchsia-400/20 to-violet-500/20">
                  {candidate.thumbnailUrl ? (
                    <img src={candidate.thumbnailUrl} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-fuchsia-200"><Film className="size-7" /></div>
                  )}
                  <span className="absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/75 text-xs font-bold text-white">
                    {candidate.rank}
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 text-sm font-medium leading-snug">
                      {candidate.caption?.trim() || "Untitled reel"}
                    </p>
                    {candidate.permalink && (
                      <a
                        href={candidate.permalink}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Open reel on Instagram"
                        className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ArrowUpRight className="size-4" />
                      </a>
                    )}
                  </div>

                  <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-fuchsia-100/80">
                    <Sparkles className="mt-0.5 size-3.5 shrink-0" /> {candidate.reason}
                  </p>

                  <div className="mt-3 grid grid-cols-3 gap-1.5">
                    <Metric label="Reach" value={candidate.reach === null ? "—" : compactNumber.format(candidate.reach)} />
                    <Metric label="Retention" value={candidate.skipRate === null ? "—" : `${Math.round(candidate.skipRate * 100)}% skip`} />
                    <Metric label="Delivered" value={`${compactNumber.format(candidate.conversion.completed)} guides`} />
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5" aria-label={`Repeat score ${candidate.score} out of 100`}>
                      <div className="h-full rounded-full bg-gradient-to-r from-fuchsia-400 to-violet-400" style={{ width: `${candidate.score}%` }} />
                    </div>
                    {candidate.usFitScore !== null && (
                      <span className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-muted-foreground">
                        US fit {candidate.usFitScore}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.025] p-3 text-[11px] leading-relaxed text-muted-foreground">
          <Eye className="mt-0.5 size-3.5 shrink-0" />
          <p>Ranked from reach, retention, and guide deliveries. US-fit is context, not part of the ranking.</p>
        </div>
      </div>
    </PanelShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.035] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xs font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

