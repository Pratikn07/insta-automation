import * as React from "react";
import { Command } from "cmdk";
import { Check, ChevronDown, Search } from "lucide-react";
import { formatSignedCount } from "@/lib/followerFlow";
import { countryLabel, type CountryRank } from "@/lib/followerCountry";
import { cn } from "@/lib/utils";

interface CountryPickerProps {
  ranked: CountryRank[];
  colors: Map<string, string>;
  shown: readonly string[];
  // null while the chart is picking the top movers automatically.
  selected: readonly string[] | null;
  onToggle: (code: string) => void;
  onReset: () => void;
}

/**
 * The full list of reported countries, for browsing the tail and picking what
 * the chart shows.
 *
 * Shares its `selected` state with the legend chips rather than holding its own
 * — two surfaces over one state can't drift out of sync.
 *
 * Countries with no stable colour are listed with their numbers but cannot be
 * stacked: past the palette there is no hue left that isn't already another
 * country's. Showing the value while disabling the toggle is the honest version
 * of that limit — hiding them would imply Meta never reported them.
 */
export function CountryPicker({
  ranked,
  colors,
  shown,
  selected,
  onToggle,
  onReset,
}: CountryPickerProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
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

  const shownSet = new Set(shown);
  const isExplicit = selected !== null && selected.length > 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition",
          isExplicit
            ? "border-sky-400/30 bg-sky-400/10 text-sky-200"
            : "border-white/10 text-muted-foreground hover:bg-white/5 hover:text-foreground",
        )}
      >
        {isExplicit
          ? `${selected!.length} selected`
          : `All countries (${ranked.length})`}
        <ChevronDown className={cn("size-3.5 transition", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="All reported countries"
          className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-xl border border-white/10 bg-[#0d1117] shadow-xl shadow-black/50"
        >
          <Command className="max-h-80 overflow-hidden">
            <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <Command.Input
                placeholder="Search countries…"
                className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-4 text-center text-xs text-muted-foreground">
                No country matches.
              </Command.Empty>
              {ranked.map((entry) => {
                const color = colors.get(entry.code);
                const isShown = shownSet.has(entry.code);
                const stackable = color !== undefined;

                return (
                  <Command.Item
                    key={entry.code}
                    value={`${entry.code} ${countryLabel(entry.code)}`}
                    // From the automatic view, the first click SELECTS — the
                    // chart narrows to that country alone. Clicking again from
                    // an explicit selection adds or removes. "Select South
                    // Africa" must not mean "remove South Africa", which is what
                    // a plain toggle did when everything already showed.
                    onSelect={() => {
                      if (stackable) onToggle(entry.code);
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                      stackable
                        ? "cursor-pointer data-[selected=true]:bg-white/10"
                        : "cursor-not-allowed opacity-50",
                    )}
                  >
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color ?? "rgb(148 163 184)" }}
                    />
                    <span className="flex-1 truncate">{countryLabel(entry.code)}</span>
                    <span className="shrink-0 font-semibold tabular-nums text-muted-foreground">
                      {formatSignedCount(entry.net)}
                    </span>
                    {/* Only a real selection gets a tick. In the automatic view
                        every top mover is on screen, but none of them was
                        chosen — ticking them would make the next click read as
                        "untick", which is the confusion this replaced. */}
                    <Check
                      className={cn(
                        "size-3 shrink-0",
                        isExplicit && isShown ? "text-sky-300" : "invisible",
                      )}
                    />
                    <span className="sr-only">
                      {isExplicit && isShown ? "selected" : "not selected"}
                    </span>
                  </Command.Item>
                );
              })}
            </Command.List>
          </Command>
          <div className="border-t border-white/10 px-3 py-2">
            {isExplicit ? (
              <button
                type="button"
                onClick={onReset}
                className="w-full rounded-md py-1 text-[11px] font-medium text-sky-300 transition hover:bg-white/5"
              >
                Show top movers again
              </button>
            ) : (
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Pick countries to chart them on their own. Those below the top {colors.size} fold
                into Other — Meta's reported set churns at its cutoff, so their daily moves are
                mostly reporting noise.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
