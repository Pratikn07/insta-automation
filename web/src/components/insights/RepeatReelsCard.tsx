import { ArrowUpRight, Film, Repeat2, Sparkles } from "lucide-react";
import type { LeaderboardRow } from "@/lib/types";
import { rankRepeatCandidates } from "@/lib/homeDashboard";
import { Skeleton } from "@/components/ui/skeleton";

// Moved off Home (which is now follower-stats only). Takes raw leaderboard rows
// and ranks them itself, matching CaptureLeadersCard's shape so the Insights
// page reads uniformly.
const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function RepeatReelsCard({
  rows,
  isLoading,
}: {
  rows: LeaderboardRow[];
  isLoading: boolean;
}) {
  const candidates = rankRepeatCandidates(rows);

  return (
    <div className="rounded-lg border bg-card/40 p-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <Repeat2 className="size-4 text-muted-foreground" /> Which reels should I repeat?
      </h3>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Ranked from reach, retention, and guide deliveries. US-fit is context, not part of the
        ranking.
      </p>

      {isLoading ? (
        <Skeleton className="h-32 w-full rounded-md" />
      ) : candidates.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">
          Not enough measured performance yet — reels appear here once snapshots include reach,
          skip rate, or guide deliveries.
        </p>
      ) : (
        <ol className="space-y-2">
          {candidates.map((c) => (
            <li key={c.mediaId} className="flex gap-3 rounded-md border bg-background/40 p-2.5">
              <div className="relative aspect-[9/16] w-12 shrink-0 overflow-hidden rounded bg-accent">
                {c.thumbnailUrl ? (
                  <img src={c.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center text-muted-foreground">
                    <Film className="size-4" />
                  </div>
                )}
                <span className="absolute left-1 top-1 flex size-4 items-center justify-center rounded-full bg-black/75 text-[9px] font-bold text-white">
                  {c.rank}
                </span>
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-2 text-xs">{c.caption?.trim() || "Untitled reel"}</p>
                  {c.permalink && (
                    <a
                      href={c.permalink}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open reel on Instagram"
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ArrowUpRight className="size-3.5" />
                    </a>
                  )}
                </div>
                <p className="mt-1 flex items-start gap-1 text-[11px] text-muted-foreground">
                  <Sparkles className="mt-0.5 size-3 shrink-0" /> {c.reason}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-muted-foreground">
                  <span>{c.reach === null ? "—" : compactNumber.format(c.reach)} reach</span>
                  <span>
                    {c.skipRate === null ? "—" : `${Math.round(c.skipRate * 100)}% skip`}
                  </span>
                  <span className="text-emerald-400">
                    {compactNumber.format(c.conversion.completed)} guides
                  </span>
                  {c.usFitScore !== null && <span>US fit {c.usFitScore}</span>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
