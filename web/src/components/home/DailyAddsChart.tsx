import type { FollowerDailyAddsPoint } from "@/lib/types";
import { chartGeometry, formatSignedCount, type ChartRegion } from "@/lib/followerFlow";
import { cn } from "@/lib/utils";

interface DailyAddsChartProps {
  points: FollowerDailyAddsPoint[];
  className?: string;
}

// Region fills, hardcoded like DashboardSparkline's colors. No <defs> at all —
// the sparkline's global gradient id can't collide with what doesn't exist.
const REGION_COLORS: Record<ChartRegion, string> = {
  us: "rgb(52 211 153)", // emerald-400
  southAsian: "rgb(167 139 250)", // violet-400
  anglosphere: "rgb(56 189 248)", // sky-400
  other: "rgb(148 163 184)", // slate-400
};

const REGION_LABELS: Record<ChartRegion, string> = {
  us: "US",
  southAsian: "South Asia",
  anglosphere: "UK/CA/AU/NZ/IE",
  other: "Rest of world",
};

const WIDTH = 720;
const HEIGHT = 220;

function tickLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

function unattributedNote(unattributed: number | null): string {
  if (!unattributed) return "";
  return ` ${formatSignedCount(unattributed)} unplaced (top-country cutoff).`;
}

function barTitle(
  bar: { day: string; slots: number; basis: string; total: number | null; unattributed: number | null },
  segments: string,
): string {
  const label = tickLabel(bar.day);
  if (bar.basis === "pending") return `${label} — waiting for Meta to refresh`;
  if (bar.basis === "no_snapshot") return `${label} — no snapshot captured`;
  if (bar.basis === "no_prior_day") return `${label} — series start, nothing to diff against`;
  const extra = unattributedNote(bar.unattributed);
  if (bar.slots > 1) {
    const from = tickLabel(shiftDay(bar.day, -(bar.slots - 1)));
    return `${from}–${label} combined (${formatSignedCount(bar.total ?? 0)}) — Meta did not refresh in between. ${segments}${extra}`;
  }
  return `${label}: ${formatSignedCount(bar.total ?? 0)} net. ${segments}${extra}`;
}

function shiftDay(day: string, byDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + byDays * 86_400_000).toISOString().slice(0, 10);
}

export function DailyAddsChart({ points, className }: DailyAddsChartProps) {
  const measured = points.filter((p) => p.total !== null);

  if (measured.length < 2) {
    return (
      <div
        role="img"
        aria-label="Daily follower adds: not enough history yet"
        className={cn(
          "flex h-56 items-center justify-center rounded-xl border border-dashed text-xs text-muted-foreground",
          className,
        )}
      >
        Daily adds appear after two measured days
      </div>
    );
  }

  const geo = chartGeometry(points, WIDTH, HEIGHT);
  const first = points[0]!.day;
  const last = points[points.length - 1]!.day;
  const mid = points[Math.floor(points.length / 2)]!.day;
  // Rank by per-day rate, not raw total, so a 2-day catch-up bar can't be named
  // "best" over a genuinely bigger single day — matches summarizeFollowerFlow.
  const best = measured.reduce((a, b) =>
    (b.total ?? 0) / (b.spanDays ?? 1) > (a.total ?? 0) / (a.spanDays ?? 1) ? b : a,
  );
  const staleCount = points.filter((p) => p.stale).length;

  const ariaLabel =
    `Daily net follower adds, ${tickLabel(first)} to ${tickLabel(last)}: ` +
    `best ${formatSignedCount(best.total ?? 0)} on ${tickLabel(best.day)}` +
    (staleCount > 0 ? `, ${staleCount} day${staleCount === 1 ? "" : "s"} without a Meta refresh` : "");

  return (
    <div className={className}>
      {/* No preserveAspectRatio="none" here (unlike DashboardSparkline): a
          stretched line still reads as a trend, but stretched bar widths read
          as false data. Fixed aspect, scaled by width. */}
      <svg role="img" aria-label={ariaLabel} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full">
        <title>Daily net follower adds by region</title>

        <line
          x1={8}
          y1={geo.zeroY}
          x2={WIDTH - 8}
          y2={geo.zeroY}
          stroke="currentColor"
          strokeOpacity="0.15"
          vectorEffect="non-scaling-stroke"
        />

        {geo.bars.map((bar) => {
          if (bar.ghost) {
            return (
              <rect
                key={bar.day}
                x={bar.x}
                y={8}
                width={bar.width}
                height={HEIGHT - 16}
                rx={4}
                fill="currentColor"
                fillOpacity="0.06"
              >
                <title>{barTitle(bar, "")}</title>
              </rect>
            );
          }

          const segmentText = bar.segments
            .map((s) => REGION_LABELS[s.region])
            .join(", ");
          return (
            <g key={bar.day} opacity={bar.provisional ? 0.45 : 1}>
              {bar.segments.map((seg) => (
                <rect
                  key={seg.region}
                  x={bar.x}
                  y={seg.y}
                  width={bar.width}
                  height={Math.max(seg.height, 0.5)}
                  fill={REGION_COLORS[seg.region]}
                />
              ))}
              {(bar.slots > 1 || bar.provisional) && bar.segments.length > 0 && (
                <rect
                  x={bar.x}
                  y={Math.min(...bar.segments.map((s) => s.y))}
                  width={bar.width}
                  height={
                    Math.max(...bar.segments.map((s) => s.y + s.height)) -
                    Math.min(...bar.segments.map((s) => s.y))
                  }
                  fill="none"
                  stroke="rgb(255 255 255 / 0.5)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <title>{barTitle(bar, segmentText)}</title>
            </g>
          );
        })}

        {geo.meanLine.length >= 2 && (
          <polyline
            points={geo.meanLine.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="rgb(255 255 255 / 0.55)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          >
            <title>7-day rolling average per day</title>
          </polyline>
        )}
      </svg>

      <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
        <span>{tickLabel(first)}</span>
        <span>{tickLabel(mid)}</span>
        <span>{tickLabel(last)}</span>
      </div>
    </div>
  );
}

export { REGION_COLORS, REGION_LABELS };
