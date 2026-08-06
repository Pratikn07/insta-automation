import { ArrowUpRight, Film, Zap } from "lucide-react";
import type { FollowerDailyAddsPoint, SpikeInfo } from "@/lib/types";
import { formatSignedCount } from "@/lib/followerFlow";
import { shownSpikeDays } from "@/lib/chartTooltip";

// Which reels were gaining reach when a follower spike happened.
//
// Deliberately called CANDIDATES, not drivers. Meta publishes no per-reel
// follower attribution, so all we can honestly show is which reels grew their
// reach during the window and let the reader judge. On real data the leading reel
// changes if the window shifts by a day, which is exactly why three are listed
// instead of one.

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

// This is an abstract Pacific day key; UTC formatting prevents browser date shifting.
function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

// A 2%-share reel is not a candidate for anything; it is the rest of the catalog
// ticking over. Only list reels with a real slice of the window.
const MIN_SHARE_PCT = 5;

export function SpikeCandidates({ points }: { points: FollowerDailyAddsPoint[] }) {
  // shownSpikeDays owns the cap and the ordering; the tooltip reads the same list
  // so it never says "candidates below" about a day this section left out.
  const shown = shownSpikeDays(points);
  const spikeDays = shown
    .map((day) => points.find((p) => p.day === day))
    .filter((p): p is FollowerDailyAddsPoint & { spike: SpikeInfo } => Boolean(p?.spike));

  if (spikeDays.length === 0) return null;

  return (
    <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-foreground">
        <Zap className="size-3.5 text-amber-300" /> Candidates behind your biggest days
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Reels that gained the most reach while each spike happened. Meta gives no
        per-reel follower data, so treat these as candidates to compare — not proof.
      </p>

      <div className="space-y-3">
        {spikeDays.map((point) => (
          <div key={point.day} className="rounded-xl border border-white/10 bg-black/20 p-3">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="text-xs font-semibold text-white">
                {dayLabel(point.day)}{" "}
                <span className="font-normal text-muted-foreground">
                  {formatSignedCount(point.spike.net)} followers
                </span>
              </span>
              <span className="shrink-0 rounded-full border border-amber-300/25 bg-amber-300/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
                {point.spike.multiple}× usual
              </span>
            </div>

            {point.spike.confidence === "low" && (
              <p className="mb-2 text-[10px] leading-snug text-amber-200/80">
                Several reels overlapped — no single one stands out.
              </p>
            )}

            <ol className="space-y-1.5">
              {point.spike.candidates
                .filter((c) => c.sharePct >= MIN_SHARE_PCT)
                .map((c) => (
                <li key={c.mediaId} className="flex items-center gap-2.5">
                  <div className="relative aspect-[9/16] w-8 shrink-0 overflow-hidden rounded bg-accent">
                    {c.thumbnailUrl ? (
                      <img
                        src={c.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center text-muted-foreground">
                        <Film className="size-3" />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 text-[11px] text-foreground">
                      {c.caption?.trim() || "Untitled reel"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      +{compactNumber.format(c.reachGained)} reach that window
                    </p>
                  </div>

                  <span className="shrink-0 text-[11px] font-semibold tabular-nums text-sky-300">
                    {c.sharePct}%
                  </span>

                  {c.permalink && (
                    <a
                      href={c.permalink}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open reel on Instagram"
                      className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ArrowUpRight className="size-3" />
                    </a>
                  )}
                  </li>
                ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}
