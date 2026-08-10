import { useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Clock, Info, RefreshCw, TrendingUp } from "lucide-react";
import type { FollowerDailyAddsPoint, FollowerStock } from "@/lib/types";
import {
  formatSignedCount,
  summarizeFollowerFlowForRange,
  type FollowerFlowSummary,
} from "@/lib/followerFlow";
import {
  OTHER_COLOR,
  OTHER_KEY,
  buildCountryStack,
  colorMapFor,
  countryLabel,
  rankCountries,
  resolveCountryStack,
} from "@/lib/followerCountry";
import {
  coverageOf,
  filterPointsToRange,
  formatRangeSpan,
  precedingRange,
  rangeLengthDays,
  resolvePreset,
  type DayRange,
  type RangePreset,
} from "@/lib/dateRange";
import { describeFreshness } from "@/lib/homeDashboard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DailyAddsChart, REGION_COLORS, REGION_LABELS } from "./DailyAddsChart";
import { EmptyPanel, PanelShell } from "./PanelShell";
import { CountryPicker } from "./CountryPicker";
import { RangeFilter } from "./RangeFilter";
import { SpikeCandidates } from "./SpikeCandidates";

type BreakdownMode = "regions" | "countries";

interface FollowerFlowPanelProps {
  points: FollowerDailyAddsPoint[];
  stock: FollowerStock | null;
  summary: FollowerFlowSummary | null;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  selectedDay?: string | null;
  onDaySelect?: (day: string) => void;
  // ISO "now" for the staleness pill (injected, never Date.now(), so the panel
  // stays deterministic under renderToStaticMarkup like the rest of Home).
  now?: string;
}

// The follower feed snapshots 4×/day, so anything past ~2 days old means the
// worker has stalled — and this panel drives the headline rate AND the Home
// header date, so a silent freeze here is worse than on the reached/engaged card.
const FOLLOWER_STALE_AFTER_DAYS = 2;

const trendStyles = {
  accelerating: {
    label: "Accelerating",
    Icon: ArrowUpRight,
    badge: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
    glow: "from-emerald-400/20 via-emerald-400/5 to-transparent",
  },
  steady: {
    label: "Holding steady",
    Icon: ArrowRight,
    badge: "border-amber-300/25 bg-amber-300/10 text-amber-200",
    glow: "from-amber-300/15 via-amber-300/5 to-transparent",
  },
  slowing: {
    label: "Slowing",
    Icon: ArrowDownRight,
    badge: "border-rose-400/25 bg-rose-400/10 text-rose-300",
    glow: "from-rose-400/15 via-rose-400/5 to-transparent",
  },
} as const;

export function FollowerFlowPanel({
  points,
  stock,
  summary,
  isLoading,
  isError,
  onRetry,
  selectedDay,
  onDaySelect,
  now,
}: FollowerFlowPanelProps) {
  // Filter state lives here, not in Home: the KPI row, the header date, and the
  // spike panel must keep reading the FULL window. A date filter that silently
  // moved the headline follower rate would make the dashboard's top-line numbers
  // depend on a control most people will forget they set.
  //
  // Hooks run unconditionally, above the loading/error returns below.
  const [preset, setPreset] = useState<RangePreset>("all");
  const [customRange, setCustomRange] = useState<DayRange | null>(null);
  const [mode, setMode] = useState<BreakdownMode>("regions");
  const [pinned, setPinned] = useState<string[]>([]);
  const [muted, setMuted] = useState<string[]>([]);

  const toggle = (list: string[], code: string) =>
    list.includes(code) ? list.filter((c) => c !== code) : [...list, code];

  if (isLoading) {
    return <Skeleton className="h-96 rounded-2xl" />;
  }

  if (isError) {
    return (
      <PanelShell tall>
        <EmptyPanel
          title="Follower flow couldn't load"
          body="The rest of your dashboard is still available. Retry this panel when you're ready."
          action={<Button variant="outline" size="sm" onClick={onRetry}><RefreshCw className="size-3.5" /> Retry</Button>}
          Icon={TrendingUp}
          accentClassName="bg-sky-400/10 text-sky-300"
        />
      </PanelShell>
    );
  }

  if (!summary || !stock) {
    return (
      <PanelShell tall>
        <EmptyPanel
          title="Waiting for follower snapshots"
          body="Daily adds need two days of follower geography. The snapshot worker fills this in automatically."
          Icon={TrendingUp}
          accentClassName="bg-sky-400/10 text-sky-300"
        />
      </PanelShell>
    );
  }

  const coverage = coverageOf(points);
  // "All" reuses Home's already-computed summary verbatim rather than
  // recomputing an equivalent one, so the default view is provably identical to
  // what shipped before the filters existed.
  // A custom range always wins over the preset — picking dates from the calendar
  // is the more specific act, and `preset` stays "all" until a preset is clicked.
  const isAll = (preset === "all" && !customRange) || !coverage;
  const range: DayRange | null = coverage
    ? (customRange ?? (preset === "all" ? coverage : resolvePreset(preset, coverage)))
    : null;

  const rangePoints = isAll || !range ? points : filterPointsToRange(points, range);
  const rangeSummary = (() => {
    if (isAll || !range) return summary;
    const prior = precedingRange(range);
    return summarizeFollowerFlowForRange(
      rangePoints,
      filterPointsToRange(points, prior),
      rangeLengthDays(range),
    );
  })();

  const freshness = now
    ? describeFreshness(stock.capturedAt, now, FOLLOWER_STALE_AFTER_DAYS)
    : null;

  // Country mode needs a server that returns byCountry. An older deployment
  // simply omits it — offer region mode only rather than an empty chart.
  const hasCountryData = points.some((p) => p.byCountry);
  // Built from ALL points, never the filtered slice: a hue belongs to a country,
  // so changing the range can change which countries stack but never repaints
  // the ones that survive.
  const countryColors = colorMapFor(points);
  const rankedInRange = rankCountries(rangePoints);
  const countryStack = resolveCountryStack(rankedInRange, countryColors, { pinned, muted });
  const inCountryMode = mode === "countries" && hasCountryData;

  const filterBar = coverage && range && (
    <RangeFilter
      coverage={coverage}
      value={range}
      activePreset={customRange ? null : preset}
      onPresetSelect={(next) => {
        setPreset(next);
        setCustomRange(null);
      }}
      onRangeSelect={setCustomRange}
    />
  );

  // A range narrow enough to hold fewer than two measured days has nothing
  // honest to summarise. Keep the filter bar mounted so the user can widen it —
  // replacing the whole panel would strand them with no way back.
  if (!rangeSummary) {
    return (
      <PanelShell tall>
        <div className="mb-4 flex justify-end">{filterBar}</div>
        <EmptyPanel
          title="Not enough measured days in this range"
          body="Pick a wider range — daily adds need at least two days Meta actually refreshed."
          Icon={TrendingUp}
          accentClassName="bg-sky-400/10 text-sky-300"
        />
      </PanelShell>
    );
  }

  const style = trendStyles[rangeSummary.trend];
  const TrendIcon = style.Icon;
  const regionLegend = [
    { key: "us" as const, sum: rangeSummary.windowSums.us },
    { key: "southAsian" as const, sum: rangeSummary.windowSums.southAsian },
    { key: "anglosphere" as const, sum: rangeSummary.windowSums.anglosphere },
    { key: "other" as const, sum: rangeSummary.windowSums.other },
  ];
  // The label must describe the numbers printed directly beneath it.
  //
  // Region sums at "All" are the trailing 7 days (long-standing behaviour, kept
  // byte-identical). Country sums are always the whole selected range, because
  // ranking and legend come from the same range-scoped pass. At "All" those two
  // windows differ, so the label follows the mode — otherwise the panel prints
  // "+1448 US (7 days)" over a 43-day figure.
  const windowLabel =
    !range || (isAll && !inCountryMode) ? "7 days" : formatRangeSpan(range);
  // Same window as the country legend, for the same reason.
  const unattributed = inCountryMode
    ? rangePoints.reduce((sum, p) => sum + (p.unattributed ?? 0), 0)
    : rangeSummary.windowSums.unattributed;

  return (
    <PanelShell className="relative overflow-hidden">
      <div className={cn("pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b", style.glow)} />
      <div className="relative space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-sky-300">
              <TrendingUp className="size-4" /> Follower flow
            </div>
            <h2 className="text-xl font-semibold tracking-tight">Where are your followers coming from?</h2>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {/* Hidden, not greyed, when there is no equal-length predecessor to
                compare against: a badge reading "Holding steady" from a partial
                baseline is a claim we cannot support. */}
            {rangeSummary.trendComparable && (
              <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", style.badge)}>
                <TrendIcon className="size-3.5" /> {style.label}
              </span>
            )}
            {freshness?.isStale && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-[11px] font-medium text-amber-200">
                <Clock className="size-3" /> Snapshots {freshness.label}
              </span>
            )}
          </div>
        </div>

        {filterBar && <div className="flex justify-end">{filterBar}</div>}

        <div className="rounded-xl border border-white/10 bg-black/15 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              Where your new followers come from ({windowLabel})
            </div>
            {hasCountryData && (
              <div className="flex items-center gap-1">
                <div className="flex rounded-md border border-white/10 p-0.5">
                  {(["regions", "countries"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={mode === m}
                      onClick={() => setMode(m)}
                      className={cn(
                        "rounded px-2 py-0.5 text-[11px] font-medium capitalize transition",
                        mode === m
                          ? "bg-white/10 text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                {inCountryMode && (
                  <CountryPicker
                    ranked={rankedInRange}
                    colors={countryColors}
                    shown={countryStack.keys}
                    pinned={pinned}
                    muted={muted}
                    onTogglePin={(code) => setPinned((p) => toggle(p, code))}
                    onToggleMute={(code) => setMuted((m) => toggle(m, code))}
                  />
                )}
              </div>
            )}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {inCountryMode
              ? countryStack.keys.map((code) => {
                  const entry = rankedInRange.find((r) => r.code === code);
                  return (
                    <button
                      key={code}
                      type="button"
                      // Chips are the second surface over the same pinned/muted
                      // state the dropdown writes, so the two cannot disagree.
                      onClick={() => setMuted((m) => toggle(m, code))}
                      title={`Hide ${countryLabel(code)}`}
                      className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-foreground transition hover:bg-white/10"
                    >
                      <span
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: countryColors.get(code) }}
                      />
                      <span className="font-semibold tabular-nums">
                        {formatSignedCount(entry?.net ?? 0)}
                      </span>
                      <span className="text-muted-foreground">{countryLabel(code)}</span>
                    </button>
                  );
                })
              : regionLegend.map(({ key, sum }) => (
                  <span key={key} className="inline-flex items-center gap-1.5 text-xs text-foreground">
                    <span className="size-2.5 rounded-full" style={{ backgroundColor: REGION_COLORS[key] }} />
                    <span className="font-semibold tabular-nums">{formatSignedCount(sum)}</span>
                    <span className="text-muted-foreground">{REGION_LABELS[key]}</span>
                  </span>
                ))}

            {inCountryMode && countryStack.hasOther && (
              <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: OTHER_COLOR }} />
                <span className="font-semibold tabular-nums">
                  {formatSignedCount(countryStack.otherNet)}
                </span>
                <span className="text-muted-foreground">
                  Other ({countryStack.otherCount} countries)
                </span>
              </span>
            )}
          </div>
          {unattributed !== 0 && (
            <p className="mt-2 border-t border-white/5 pt-2 text-[11px] leading-relaxed text-muted-foreground">
              {formatSignedCount(unattributed)} more Meta counted but couldn't place —
              countries crossing its top-{stock.countriesReported} reporting cutoff.
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-foreground">
              Daily net adds by {inCountryMode ? "country" : "region"}
            </span>
            <span className="text-muted-foreground">Line = 7-day average</span>
          </div>
          <DailyAddsChart
            points={rangePoints}
            selectedDay={selectedDay}
            onDaySelect={onDaySelect}
            {...(inCountryMode
              ? {
                  stack: buildCountryStack(countryStack.keys, countryStack.hasOther),
                  colorOf: (key: string) => countryColors.get(key) ?? OTHER_COLOR,
                  labelOf: (key: string) =>
                    key === OTHER_KEY
                      ? `Other (${countryStack.otherCount} countries)`
                      : countryLabel(key),
                  seriesNoun: "country",
                }
              : {})}
          />
        </div>

        {/* Deliberately the UNFILTERED points: spikes are "what happened on this
            account", not "what happened inside the window you're looking at",
            and hiding a spike because of a date filter buries the lead. */}
        <SpikeCandidates points={points} />

        <div className="flex gap-3 rounded-xl border border-violet-400/15 bg-violet-400/5 p-3.5 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0 text-violet-300" />
          <p>
            Net adds (follows minus unfollows) diffed from Meta's follower geography, bucketed by Pacific day.
            Meta reports only its top countries and lags about two days — the dashed newest bars can still shift,
            and days Meta skips are absorbed into the next bar.
          </p>
        </div>
      </div>
    </PanelShell>
  );
}
