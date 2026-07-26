import type { TooltipModel } from "@/lib/chartTooltip";
import { REGION_COLORS, REGION_LABELS } from "./DailyAddsChart";

// Dumb positioned card. Every string arrives pre-formatted from tooltipModel;
// this component owns only placement. No animation on position — a lerped card
// lags the cursor and reads as broken.

export interface ChartTooltipProps {
  model: TooltipModel;
  // Cursor offset within the chart container, in SCREEN pixels (unscaled).
  x: number;
  y: number;
  containerWidth: number;
}

const CURSOR_GAP = 12;
const CARD_WIDTH = 200;
const FLIP_ABOVE_BELOW_AT = 90;

export function ChartTooltip({ model, x, y, containerWidth }: ChartTooltipProps) {
  // Flip near the right edge so the card never runs off the panel.
  const flipHorizontal = x + CURSOR_GAP + CARD_WIDTH > containerWidth;
  const flipVertical = y < FLIP_ABOVE_BELOW_AT;

  const position: React.CSSProperties = {
    ...(flipHorizontal
      ? { right: `${containerWidth - x + CURSOR_GAP}px` }
      : { left: `${x + CURSOR_GAP}px` }),
    ...(flipVertical ? { top: `${y + CURSOR_GAP}px` } : { bottom: "0px" }),
    width: `${CARD_WIDTH}px`,
  };

  return (
    <div
      aria-hidden="true"
      style={position}
      className="pointer-events-none absolute z-20 rounded-xl border border-white/15 bg-neutral-950/95 p-3 shadow-xl shadow-black/40 backdrop-blur"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold text-white">{model.heading}</span>
        {model.totalLabel && (
          <span className="text-xs font-semibold tabular-nums text-sky-300">
            {model.totalLabel}
          </span>
        )}
      </div>

      {(model.rows.length > 0 || model.emptyLabel) && (
        <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
          {model.rows.map((row) => (
            <div key={row.region} className="flex items-center gap-2 text-[11px]">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: REGION_COLORS[row.region] }}
              />
              <span className="flex-1 truncate text-muted-foreground">
                {REGION_LABELS[row.region]}
              </span>
              <span className="font-semibold tabular-nums text-foreground">{row.valueLabel}</span>
            </div>
          ))}
          {model.emptyLabel && (
            <div className="text-[11px] text-muted-foreground">{model.emptyLabel}</div>
          )}
        </div>
      )}

      {model.notes.length > 0 && (
        <div className="mt-2 space-y-0.5 border-t border-white/10 pt-2">
          {model.notes.map((note) => (
            <p key={note} className="text-[10px] leading-snug text-amber-200/80">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
