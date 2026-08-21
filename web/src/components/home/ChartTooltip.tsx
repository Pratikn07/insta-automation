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
  actionHint?: string;
  // Resolve a row key to its swatch/label. Defaults to the four regions, so
  // country mode supplies its own without this component knowing either scheme.
  colorOf?: (key: string) => string;
  labelOf?: (key: string) => string;
}

const regionColor = (key: string) =>
  REGION_COLORS[key as keyof typeof REGION_COLORS] ?? "rgb(148 163 184)";
const regionLabel = (key: string) =>
  REGION_LABELS[key as keyof typeof REGION_LABELS] ?? key;

const CURSOR_GAP = 12;
const CARD_WIDTH = 200;
const FLIP_ABOVE_BELOW_AT = 90;

export function ChartTooltip({
  model,
  x,
  y,
  containerWidth,
  actionHint,
  colorOf = regionColor,
  labelOf = regionLabel,
}: ChartTooltipProps) {
  // Flip near the right edge so the card never runs off the panel.
  const flipHorizontal = x + CURSOR_GAP + CARD_WIDTH > containerWidth;
  const flipVertical = y < FLIP_ABOVE_BELOW_AT;

  const position: React.CSSProperties = {
    ...(flipHorizontal
      ? { right: `${containerWidth - x + CURSOR_GAP}px` }
      : { left: `${x + CURSOR_GAP}px` }),
    ...(flipVertical ? { top: `${y + CURSOR_GAP}px` } : { bottom: "0px" }),
    width: `${CARD_WIDTH}px`,
    // Inline z-index, not just the Tailwind class: the svg is a later DOM
    // sibling, and a Tailwind z-20 alone let it paint OVER the card — verified
    // with elementFromPoint returning the <svg> at the card's own center.
    zIndex: 50,
  };

  return (
    <div
      aria-hidden="true"
      style={position}
      className="pointer-events-none absolute z-20 rounded-xl border border-line bg-popover p-3 shadow-lg"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-foreground">{model.heading}</span>
        {model.totalLabel && (
          <span className="text-xs font-medium tabular-nums text-funnel-mark">
            {model.totalLabel}
          </span>
        )}
      </div>

      {(model.rows.length > 0 || model.emptyLabel) && (
        <div className="mt-2 space-y-1 border-t border-t-line pt-2">
          {model.rows.map((row) => (
            <div key={row.key} className="flex items-center gap-2 text-[11px]">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: colorOf(row.key) }}
              />
              <span className="flex-1 truncate text-muted-foreground">{labelOf(row.key)}</span>
              <span className="font-medium tabular-nums text-foreground">{row.valueLabel}</span>
            </div>
          ))}
          {model.emptyLabel && (
            <div className="text-[11px] text-muted-foreground">{model.emptyLabel}</div>
          )}
        </div>
      )}

      {model.notes.length > 0 && (
        <div className="mt-2 space-y-0.5 border-t border-t-line pt-2">
          {model.notes.map((note) => (
            <p key={note} className="text-[10px] leading-snug text-caution">
              {note}
            </p>
          ))}
        </div>
      )}

      {actionHint && (
        <p className="mt-2 border-t border-t-line pt-2 text-[10px] font-medium text-funnel-mark">
          {actionHint}
        </p>
      )}
    </div>
  );
}
