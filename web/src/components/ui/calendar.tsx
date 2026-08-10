import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  WEEKDAY_INITIALS,
  buildMonthGrid,
  monthLabel,
  monthOf,
  shiftMonth,
} from "@/lib/calendarGrid";
import type { DayRange } from "@/lib/dateRange";
import { cn } from "@/lib/utils";

interface RangeCalendarProps {
  // Inclusive selectable bounds. Days outside are rendered disabled rather than
  // hidden, so the shape of the month stays readable.
  min: string;
  max: string;
  value: DayRange;
  onChange: (range: DayRange) => void;
}

/**
 * Two-click inclusive range calendar.
 *
 * Hand-rolled rather than pulling in react-day-picker: the panel is a bespoke
 * dark surface, so a library would need full restyling anyway, and every date
 * here is an abstract Pacific day key that must never pass through local-time
 * parsing. All grid math lives in calendarGrid.ts and is unit-tested; this
 * component only renders and tracks which click comes next.
 */
export function RangeCalendar({ min, max, value, onChange }: RangeCalendarProps) {
  const [month, setMonth] = React.useState(() => monthOf(value.to));
  // null = next click starts a new range; a day = next click completes it.
  const [anchor, setAnchor] = React.useState<string | null>(null);
  const [hovered, setHovered] = React.useState<string | null>(null);

  const grid = buildMonthGrid(month);
  const canGoBack = month > monthOf(min);
  const canGoForward = month < monthOf(max);

  // While picking the second endpoint, preview against the hovered day so the
  // band under the cursor is the range that would be committed.
  const preview: DayRange =
    anchor === null
      ? value
      : (() => {
          const other = hovered ?? anchor;
          return anchor <= other ? { from: anchor, to: other } : { from: other, to: anchor };
        })();

  function handleDayClick(day: string) {
    if (anchor === null) {
      setAnchor(day);
      return;
    }
    // Order the two clicks rather than requiring start-before-end.
    onChange(anchor <= day ? { from: anchor, to: day } : { from: day, to: anchor });
    setAnchor(null);
    setHovered(null);
  }

  return (
    <div className="w-64 select-none p-3" onMouseLeave={() => setHovered(null)}>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          disabled={!canGoBack}
          onClick={() => setMonth(shiftMonth(month, -1))}
          className="rounded-md p-1 text-muted-foreground transition hover:bg-white/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-xs font-semibold">{monthLabel(month)}</span>
        <button
          type="button"
          aria-label="Next month"
          disabled={!canGoForward}
          onClick={() => setMonth(shiftMonth(month, 1))}
          className="rounded-md p-1 text-muted-foreground transition hover:bg-white/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAY_INITIALS.map((initial, i) => (
          <div
            key={`${initial}-${i}`}
            aria-hidden
            className="pb-1 text-center text-[10px] font-medium text-muted-foreground"
          >
            {initial}
          </div>
        ))}

        {grid.weeks.flat().map((cell, i) => {
          if (!cell) return <div key={`pad-${i}`} />;
          const disabled = cell.day < min || cell.day > max;
          const inRange = cell.day >= preview.from && cell.day <= preview.to;
          const isEndpoint = cell.day === preview.from || cell.day === preview.to;

          return (
            <button
              key={cell.day}
              type="button"
              disabled={disabled}
              aria-label={cell.day}
              aria-pressed={isEndpoint}
              onClick={() => handleDayClick(cell.day)}
              onMouseEnter={() => setHovered(cell.day)}
              className={cn(
                "h-7 rounded-md text-[11px] tabular-nums transition",
                disabled && "pointer-events-none opacity-25",
                !inRange && !disabled && "text-foreground hover:bg-white/10",
                inRange && !isEndpoint && "bg-sky-400/15 text-sky-100",
                isEndpoint && "bg-sky-400 font-semibold text-slate-900",
              )}
            >
              {cell.dayOfMonth}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-center text-[10px] text-muted-foreground">
        {anchor === null ? "Click a start date" : "Click an end date"}
      </p>
    </div>
  );
}
