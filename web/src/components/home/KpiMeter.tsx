import { cn } from "@/lib/utils";

// A single-fill horizontal meter, for a KPI figure whose meaning is "how far
// along" rather than "how it moved": progress toward the next follower
// milestone, and the answered share of the unlock DM.
//
// The track is --color-line (#CAC7BD, 1.55:1 on the ground) and not the funnel's
// own --color-funnel-track (#EBE8DF). That token is correct inside a card, but
// #EBE8DF against the #F7F5EF ground measures 1.12:1 — the same invisible
// hairline that made this whole band read as page background. A meter whose
// extent cannot be seen only shows a floating fill.
//
// The track is a container, not a data mark, so 1.55:1 is the right bar to hold
// it to; the fill is the mark and clears index.css's 3:1 floor with room —
// foreground at 16.38:1, funnel-mark at 8.41:1.

export interface KpiMeterProps {
  /** Filled share, clamped to 0–1. */
  fraction: number;
  /** Fill colour utility. Defaults to ink. */
  fillClassName?: string;
  /** Accessible description of what is filled. */
  title: string;
  /** Small caption under the meter, e.g. the target it runs toward. */
  caption?: string;
}

export function KpiMeter({
  fraction,
  fillClassName = "bg-foreground",
  title,
  caption,
}: KpiMeterProps) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;

  return (
    <div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-sm bg-line"
        role="img"
        aria-label={title}
      >
        {/* A zero-width fill would leave the track looking broken rather than
            empty, so a just-started meter still shows a hairline of itself. */}
        <div
          className={cn("h-full rounded-sm", fillClassName)}
          style={{ width: `${pct === 0 ? 0.75 : pct}%` }}
        />
      </div>
      {caption && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{caption}</p>
      )}
    </div>
  );
}
