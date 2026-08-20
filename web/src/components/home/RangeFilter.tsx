import * as React from "react";
import { CalendarDays } from "lucide-react";
import { RangeCalendar } from "@/components/ui/calendar";
import {
  RANGE_PRESETS,
  formatRangeLabel,
  resolvePreset,
  type DayRange,
  type RangePreset,
} from "@/lib/dateRange";
import { cn } from "@/lib/utils";

interface RangeFilterProps {
  coverage: DayRange;
  value: DayRange;
  // null once the user picks a custom range, so no preset reads as active.
  activePreset: RangePreset | null;
  onPresetSelect: (preset: RangePreset) => void;
  onRangeSelect: (range: DayRange) => void;
}

/**
 * Presets plus a custom range calendar.
 *
 * The popover is hand-rolled — there is no popover primitive in components/ui —
 * and follows drawer.tsx's dismissal contract: Escape closes, and a pointerdown
 * outside closes. Non-modal, because the chart behind it is exactly what the
 * user is choosing a range for and should stay visible while they choose.
 */
export function RangeFilter({
  coverage,
  value,
  activePreset,
  onPresetSelect,
  onRangeSelect,
}: RangeFilterProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // pointerdown, not click: a click that begins inside and ends outside (a
    // drag across the calendar) should not be read as a dismissal.
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative flex flex-wrap items-center gap-1">
      {RANGE_PRESETS.map(({ value: preset, label }) => {
        // A preset that would resolve to the same span as "All" is not a
        // separate choice — hide it rather than offer two buttons that agree.
        const resolved = resolvePreset(preset, coverage);
        if (!resolved) return null;
        const redundant =
          preset !== "all" &&
          resolved.from === coverage.from &&
          resolved.to === coverage.to;
        if (redundant) return null;

        return (
          <button
            key={preset}
            type="button"
            aria-pressed={activePreset === preset}
            onClick={() => onPresetSelect(preset)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition",
              activePreset === preset
                ? "bg-mark-soft text-funnel-mark"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}

      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition",
          activePreset === null
            ? "bg-mark-soft text-funnel-mark"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <CalendarDays className="size-3.5" />
        {activePreset === null ? formatRangeLabel(value) : "Custom"}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose a date range"
          className="absolute right-0 top-full z-30 mt-1.5 rounded-xl border border-border bg-popover shadow-xl"
        >
          <RangeCalendar
            min={coverage.from}
            max={coverage.to}
            value={value}
            onChange={(range) => {
              onRangeSelect(range);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
