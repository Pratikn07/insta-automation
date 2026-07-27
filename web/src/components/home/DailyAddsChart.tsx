import { useRef, useState } from "react";
import type { FollowerDailyAddsPoint } from "@/lib/types";
import { chartGeometry, formatSignedCount, type ChartRegion } from "@/lib/followerFlow";
import { hitTestDay, shownSpikeDays, tooltipModel } from "@/lib/chartTooltip";
import { cn } from "@/lib/utils";
import { ChartTooltip } from "./ChartTooltip";

interface DailyAddsChartProps {
  points: FollowerDailyAddsPoint[];
  className?: string;
}

// Region fills, hardcoded rather than themed. No <defs> at all — nothing here
// declares a global gradient id, so nothing can collide with one.
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
// Room for the y-axis labels; chartGeometry shifts the plot right by this much.
const GUTTER_LEFT = 34;
const X_TICK_COUNT = 6;

function tickLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

export function DailyAddsChart({ points, className }: DailyAddsChartProps) {
  // Hooks must run unconditionally, so they sit above the early return below.
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Keyed by day, not index: chartGeometry draws no bar for stale days and gives
  // span bars two slots, so an index does not identify a hoverable bar.
  // Width is captured here rather than read from the ref at render time —
  // reading layout during render is unreliable and would not re-run on resize.
  const [hover, setHover] = useState<{
    day: string;
    x: number;
    y: number;
    containerWidth: number;
  } | null>(null);

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

  const geo = chartGeometry(points, WIDTH, HEIGHT, GUTTER_LEFT);
  const first = points[0]!.day;
  const last = points[points.length - 1]!.day;

  // ~6 evenly spaced date labels instead of 3, so a bar can be located in time.
  const stride = Math.max(1, Math.ceil(points.length / X_TICK_COUNT));
  const xTicks = points.filter((_, i) => i % stride === 0).map((p) => p.day);
  if (xTicks[xTicks.length - 1] !== last) xTicks.push(last);
  // Rank by per-day rate, not raw total, so a 2-day catch-up bar can't be named
  // "best" over a genuinely bigger single day — matches summarizeFollowerFlow.
  const best = measured.reduce((a, b) =>
    (b.total ?? 0) / (b.spanDays ?? 1) > (a.total ?? 0) / (a.spanDays ?? 1) ? b : a,
  );
  const staleCount = points.filter((p) => p.stale).length;
  const hoveredDay = hover?.day ?? null;
  const hoveredPoint = hoveredDay ? points.find((p) => p.day === hoveredDay) ?? null : null;
  // Same list SpikeCandidates renders, so the tooltip only points "below" when
  // there is a card down there to point at.
  const panelSpikeDays = shownSpikeDays(points);

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const offsetX = event.clientX - rect.left;
    const day = hitTestDay(offsetX, rect.width, WIDTH, geo.bars);
    if (day === null) {
      setHover(null);
      return;
    }
    setHover({ day, x: offsetX, y: event.clientY - rect.top, containerWidth: rect.width });
  }

  const ariaLabel =
    `Daily net follower adds, ${tickLabel(first)} to ${tickLabel(last)}: ` +
    `best ${formatSignedCount(best.total ?? 0)} on ${tickLabel(best.day)}` +
    (staleCount > 0 ? `, ${staleCount} day${staleCount === 1 ? "" : "s"} without a Meta refresh` : "");

  return (
    <div
      ref={containerRef}
      className={cn("relative", className)}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHover(null)}
    >
      {/* Deliberately no preserveAspectRatio="none": a stretched line still
          reads as a trend, but stretched bar widths read as false data.
          Fixed aspect, scaled by width. */}
      <svg role="img" aria-label={ariaLabel} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full">
        <title>Daily net follower adds by region</title>

        {/* Gridlines first so they sit behind the bars. Zero keeps a stronger
            stroke — signed bars are read against it. */}
        {geo.ticks.map((tick) => (
          <g key={`tick-${tick.value}`}>
            <line
              x1={geo.gutterLeft + 8}
              y1={tick.y}
              x2={WIDTH - 8}
              y2={tick.y}
              stroke="currentColor"
              strokeOpacity={tick.value === 0 ? 0.28 : 0.08}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={geo.gutterLeft}
              y={tick.y + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="currentColor"
              fillOpacity="0.45"
            >
              {formatSignedCount(tick.value)}
            </text>
          </g>
        ))}

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
                fillOpacity={hoveredDay === bar.day ? 0.12 : 0.06}
              />
            );
          }

          return (
            <g
              key={bar.day}
              opacity={
                bar.provisional
                  ? hoveredDay === bar.day
                    ? 0.7
                    : 0.45
                  : hoveredDay && hoveredDay !== bar.day
                    ? 0.55
                    : 1
              }
            >
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

      {/* Left padding matches the svg gutter so the first date sits under the
          first bar, not under the y-axis labels. */}
      <div
        className="mt-1.5 flex justify-between text-[10px] text-muted-foreground"
        style={{ paddingLeft: `${(GUTTER_LEFT / WIDTH) * 100}%` }}
      >
        {xTicks.map((day) => (
          <span key={day}>{tickLabel(day)}</span>
        ))}
      </div>

      {hover && hoveredPoint && (
        <ChartTooltip
          model={tooltipModel(hoveredPoint, panelSpikeDays)}
          x={hover.x}
          y={hover.y}
          containerWidth={hover.containerWidth}
        />
      )}
    </div>
  );
}

export { REGION_COLORS, REGION_LABELS };
