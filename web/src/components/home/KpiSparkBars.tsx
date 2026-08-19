import type { FollowerDailyAddsPoint } from "@/lib/types";
import { trailingUsSlots } from "@/lib/followerFlow";

// The trailing daily series behind a KPI figure, at figure scale rather than
// chart scale. Its job is to give the band something true to look at: the row
// used to be three numbers on bare paper, and the score cell in particular was
// an em-dash whenever the week was not comparable.
//
// It is NOT a decorative sparkline. Every bar is a measured daily net add — the
// same series the follower-flow chart below plots — and a day Meta never
// measured draws NOTHING. It keeps its slot so the timeline stays true, but a
// gap is a gap. Rendering it as a zero-height bar would state that nobody
// followed that day, which is the one thing the data does not say.
//
// Drawn in --color-chart-us, deliberately not moss: index.css reserves the
// accent for "the system is working" and spells the rule out on this very token
// — an accent that also means "United States" stops meaning "the system is
// working".

export interface KpiSparkBarsProps {
  points: FollowerDailyAddsPoint[];
  /** Trailing days to draw. */
  days?: number;
  /** Accessible summary. The bars themselves are decorative to a screen reader
   *  because the figure and its context line already carry the numbers. */
  title: string;
}

export function KpiSparkBars({ points, days = 14, title }: KpiSparkBarsProps) {
  const slots = trailingUsSlots(points, days);
  const measured = slots.filter((s): s is { value: number; provisional: boolean } =>
    s.value !== null,
  );
  // Nothing measured means nothing to draw. An empty axis with no bars would be
  // a chart claiming to show a series it does not have.
  if (measured.length === 0) return null;

  const values = measured.map((s) => s.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  // A viewBox stretched to the cell. Bars are fills with no strokes, so the
  // non-uniform scale cannot distort a stroke weight.
  const W = 100;
  const H = 30;
  const slotW = W / slots.length;
  const barW = Math.max(slotW * 0.62, 0.8);
  const zeroY = (max / span) * H;
  const hasNegative = min < 0;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-[30px] w-full"
      role="img"
      aria-label={title}
    >
      {/* The zero baseline, drawn only when a bar actually descends below it —
          otherwise it is a rule restating the bottom edge. */}
      {hasNegative && (
        <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="var(--color-line)" strokeWidth="0.5" />
      )}
      {slots.map((slot, i) => {
        if (slot.value === null) return null;
        const h = (Math.abs(slot.value) / span) * H;
        const y = slot.value >= 0 ? zeroY - h : zeroY;
        return (
          <rect
            key={i}
            x={i * slotW + (slotW - barW) / 2}
            y={y}
            width={barW}
            height={Math.max(h, 0.75)}
            fill={
              slot.provisional ? "var(--color-chart-provisional)" : "var(--color-chart-us)"
            }
          />
        );
      })}
    </svg>
  );
}
