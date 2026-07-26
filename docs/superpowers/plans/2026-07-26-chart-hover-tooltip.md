# Chart Hover Tooltip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the daily-adds chart's slow, unstyled native SVG `<title>` tooltips with an instant styled tooltip showing each day's total and per-region breakdown on hover.

**Architecture:** Three units. A pure `tooltipModel(point)` in `followerFlow.ts` turns a data point into display-ready content (absorbing the existing `barTitle` logic). A presentational `ChartTooltip` renders that model as a positioned card and owns edge flipping. `DailyAddsChart` adds pointer handlers plus `hoveredIndex` state and drops the per-bar `<title>` elements. Frontend only — no API, DB, or backend change.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Vitest 4 with `renderToStaticMarkup`, Playwright (for the final real-browser hover check).

## Global Constraints

- All work in `web/`. Run commands from `/Users/pratik.nandoskar/Documents/working/mch/insta-automation/web`.
- Test command `npm test` (`vitest run`). Baseline, measured: **8 files, 86 tests** green at `c16e5bc`.
- Component tests use `renderToStaticMarkup` from `react-dom/server` and assert HTML substrings. Do NOT add jsdom or `@testing-library/react` — neither is installed, and pointer interaction is therefore NOT unit-testable. Verify hover in a real browser (Task 4).
- Pure functions in `web/src/lib/` must never call `Date.now()` or argless `new Date()`. `new Date("<iso>")` with an explicit argument is fine and already used by `tickLabel`.
- `tsconfig.app.json` sets `noUnusedLocals`/`noUnusedParameters`. A stray import or variable fails `npm run build`.
- Signed numbers use `formatSignedCount` from `@/lib/followerFlow` — it renders U+2212 minus (`−`), NOT an ASCII hyphen. Tests asserting negatives must use `−`.
- Region colors and labels come from the existing `REGION_COLORS` / `REGION_LABELS` exported by `DailyAddsChart.tsx`, so the tooltip and the panel legend can never disagree.
- `framer-motion` is already a dependency but the tooltip must NOT animate its position — a lerped card lags the cursor and reads as broken. Plain conditional render.
- Copy rule: keep the honest caveats. A combined 2-day bar must say Meta did not refresh; provisional bars must say they are still settling. Without them the tall bar reads as a real spike.
- Commit with explicit `git add` paths, never `-A`.

---

## Critical implementation constraint: coordinate spaces

The SVG uses `viewBox="0 0 720 220"` with `className="w-full"`, so **1 SVG unit ≠ 1 screen pixel** — the chart is typically rendered ~1100px wide, a ~1.5× scale. Two consequences the implementer must respect:

1. **Hit detection must convert.** Take `event.clientX`, subtract the container's `getBoundingClientRect().left`, then scale by `WIDTH / rect.width` to land in SVG units before comparing against slot boundaries. Comparing raw client pixels to SVG x-values silently selects the wrong bar (off by ~1.5× the further right you hover).
2. **Tooltip position is in screen pixels, not SVG units.** The tooltip is an HTML div positioned inside a `relative` wrapper, so it uses the *unscaled* offset (`clientX - rect.left`) directly. Do not scale that value.

Task 1's `slotFromOffset` handles (1) and is unit-tested; Task 2's component handles (2).

## File Structure

**Created:**
| Path | Responsibility |
|---|---|
| `web/src/lib/chartTooltip.ts` | Pure content + hit-testing math: `tooltipModel`, `slotFromOffset`. No DOM, no React. |
| `web/src/lib/chartTooltip.test.ts` | Unit tests for both functions. |
| `web/src/components/home/ChartTooltip.tsx` | Presentational card: renders a model at a position, flips at edges. No data logic. |
| `web/src/components/home/ChartTooltip.test.tsx` | Render + edge-flip tests. |

**Modified:**
| Path | Change |
|---|---|
| `web/src/components/home/DailyAddsChart.tsx` | Add `hoveredIndex` state + pointer handlers, render `ChartTooltip`, delete per-bar `<title>` and the now-unused `barTitle`/`unattributedNote` helpers, add hover highlight. |
| `web/src/components/home/HomePanels.test.tsx` | Assert the native per-bar `<title>` elements are gone and the chart's own `<title>`/aria-label remain. |

**Why a new `chartTooltip.ts` rather than appending to `followerFlow.ts`:** that file is already 470+ lines covering rate math, region sums, milestones, and chart geometry. Tooltip content and hit-testing are a distinct concern with distinct tests; a separate module keeps both files focused. The spec said "in `followerFlow.ts`" — this is a deliberate deviation for file size, and the only cost is one extra import.

**Task order:** Task 1 is pure logic with no consumers. Task 2 is the dumb component consuming Task 1's type. Task 3 wires them into the chart — the only task that changes rendered output. Task 4 verifies real hover in a browser, which nothing else can.

---

### Task 1: `tooltipModel` + `slotFromOffset` pure logic

**Files:**
- Create: `web/src/lib/chartTooltip.ts`
- Test: `web/src/lib/chartTooltip.test.ts`

**Interfaces:**
- Consumes: `FollowerDailyAddsPoint` from `./types`, `formatSignedCount` and `type ChartRegion` from `./followerFlow`.
- Produces:
  ```ts
  export interface TooltipRow {
    region: ChartRegion;
    value: number;
    valueLabel: string;   // "+41" / "−3", already signed
  }
  export interface TooltipModel {
    heading: string;        // "Jul 24" or "Jul 20–21"
    totalLabel: string | null;  // "+59 net"; null for ghost columns
    rows: TooltipRow[];     // zero-value regions omitted; empty for ghosts
    notes: string[];        // honest caveats, may be empty
    emptyLabel: string | null;  // "No net change" when measured but all-zero
  }
  export function tooltipModel(point: FollowerDailyAddsPoint): TooltipModel;
  export function slotFromOffset(
    offsetX: number, containerWidth: number, viewBoxWidth: number,
    gutterLeft: number, slotCount: number,
  ): number | null;
  ```
  Task 2 renders `TooltipModel`; Task 3 calls both.

**Note on region labels:** `tooltipModel` returns the `region` key, NOT a display label. The component maps keys → `REGION_LABELS`, which keeps the label table in one place (it is already exported from `DailyAddsChart.tsx` and used by `FollowerFlowPanel`'s legend).

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/chartTooltip.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint } from "./types";
import { slotFromOffset, tooltipModel } from "./chartTooltip";

function point(overrides: Partial<FollowerDailyAddsPoint> = {}): FollowerDailyAddsPoint {
  const us = overrides.us ?? 0;
  const southAsian = overrides.southAsian ?? 0;
  const anglosphere = overrides.anglosphere ?? 0;
  const other = overrides.other ?? 0;
  const total = overrides.total !== undefined ? overrides.total : us + southAsian + anglosphere + other;
  return {
    day: "2026-07-24",
    capturedAt: "2026-07-24T23:00:00.000Z",
    us, southAsian, anglosphere, other,
    total,
    unattributed: 0,
    reportedTotalDelta: total,
    spanDays: 1,
    stale: false,
    provisional: false,
    basis: "diff",
    ...overrides,
  };
}

describe("tooltipModel", () => {
  it("lists the day, total, and each non-zero region", () => {
    const m = tooltipModel(point({ us: 41, southAsian: 6, anglosphere: 13, other: -1 }));
    expect(m.heading).toBe("Jul 24");
    expect(m.totalLabel).toBe("+59 net");
    expect(m.rows.map((r) => r.region)).toEqual(["us", "southAsian", "anglosphere", "other"]);
    expect(m.rows.map((r) => r.valueLabel)).toEqual(["+41", "+6", "+13", "−1"]);
    expect(m.notes).toEqual([]);
    expect(m.emptyLabel).toBeNull();
  });

  it("omits zero-value regions rather than printing a row of zeros", () => {
    const m = tooltipModel(point({ us: 20, southAsian: 0, anglosphere: 4, other: 0 }));
    expect(m.rows.map((r) => r.region)).toEqual(["us", "anglosphere"]);
  });

  it("says so when a measured day nets to nothing across every region", () => {
    const m = tooltipModel(point({ us: 0, southAsian: 0, anglosphere: 0, other: 0, total: 0 }));
    expect(m.rows).toEqual([]);
    expect(m.emptyLabel).toBe("No net change");
    expect(m.totalLabel).toBe("0 net");
  });

  it("spans the date range and explains a combined multi-day bar", () => {
    const m = tooltipModel(point({ day: "2026-07-21", us: 96, spanDays: 2, basis: "multi_day_span" }));
    expect(m.heading).toBe("Jul 20–21");
    expect(m.notes).toContain("Meta did not refresh in between");
  });

  it("discloses a still-settling day", () => {
    const m = tooltipModel(point({ us: 30, provisional: true }));
    expect(m.notes).toContain("Still settling — Meta may revise");
  });

  it("reports unplaced rank-churn when non-zero", () => {
    const m = tooltipModel(point({ us: 30, unattributed: 3 }));
    expect(m.notes).toContain("+3 unplaced (top-country cutoff)");
  });

  it("omits the unplaced note when it is zero", () => {
    expect(tooltipModel(point({ us: 30, unattributed: 0 })).notes).toEqual([]);
  });

  it("explains each kind of gap column instead of showing empty rows", () => {
    const gap = (basis: FollowerDailyAddsPoint["basis"], note: string) => {
      const m = tooltipModel(
        point({ basis, total: null, spanDays: null, us: null, southAsian: null, anglosphere: null, other: null }),
      );
      expect(m.totalLabel).toBeNull();
      expect(m.rows).toEqual([]);
      expect(m.notes).toContain(note);
    };
    gap("pending", "Waiting for Meta to refresh");
    gap("no_snapshot", "No snapshot captured");
    gap("no_prior_day", "Series start — nothing to diff against");
    gap("stale", "Absorbed into the next bar");
  });
});

describe("slotFromOffset", () => {
  // Chart is 720 viewBox units wide with a 34-unit gutter, rendered at 1080px
  // (1.5× scale), 20 slots. Plot spans SVG x 42..712, so each slot is 33.5 units.
  const args = { containerWidth: 1080, viewBoxWidth: 720, gutterLeft: 34, slotCount: 20 };
  const slot = (offsetX: number) =>
    slotFromOffset(offsetX, args.containerWidth, args.viewBoxWidth, args.gutterLeft, args.slotCount);

  it("converts screen pixels to svg units before picking a slot", () => {
    // 1.5× scale: screen 63px -> svg 42 = the very start of slot 0.
    expect(slot(63)).toBe(0);
    // Middle of the plot lands mid-series, not at the end.
    expect(slot(1080 / 2)).toBe(9);
  });

  it("returns the last slot at the right edge and never overflows", () => {
    expect(slot(1079)).toBe(19);
    expect(slot(5000)).toBe(19);
  });

  it("returns null left of the plot area so the y-axis labels are not hoverable", () => {
    expect(slot(0)).toBeNull();
    expect(slot(10)).toBeNull();
  });

  it("clamps a negative offset to null rather than a negative index", () => {
    expect(slot(-40)).toBeNull();
  });

  it("degrades safely when the container has not been measured yet", () => {
    expect(slotFromOffset(50, 0, 720, 34, 20)).toBeNull();
    expect(slotFromOffset(50, 1080, 720, 34, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- chartTooltip`
Expected: FAIL — `Failed to resolve import "./chartTooltip"`.

- [ ] **Step 3: Implement**

Create `web/src/lib/chartTooltip.ts`:

```ts
import type { FollowerDailyAddsPoint } from "./types";
import { formatSignedCount, type ChartRegion } from "./followerFlow";

// Content + hit-testing math for the chart's hover tooltip. Kept out of
// followerFlow.ts (already 470+ lines of rate/geometry math) so both files stay
// focused. Pure: no DOM, no React, no Date.now().

export interface TooltipRow {
  region: ChartRegion;
  value: number;
  valueLabel: string;
}

export interface TooltipModel {
  heading: string;
  totalLabel: string | null;
  rows: TooltipRow[];
  notes: string[];
  emptyLabel: string | null;
}

// Same order the bars stack in, so the tooltip reads top-to-bottom like the bar.
const REGION_ORDER: ChartRegion[] = ["us", "southAsian", "anglosphere", "other"];

const GAP_NOTES: Partial<Record<FollowerDailyAddsPoint["basis"], string>> = {
  pending: "Waiting for Meta to refresh",
  no_snapshot: "No snapshot captured",
  no_prior_day: "Series start — nothing to diff against",
  stale: "Absorbed into the next bar",
};

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

function shiftDay(day: string, byDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + byDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Display-ready content for one hovered point.
 *
 * Zero-value regions are dropped (a column of zeros is noise), but a measured
 * day where everything nets to zero gets an explicit "No net change" rather than
 * an empty card. The notes carry the caveats that explain odd-looking bars —
 * without them a 2-day combined bar reads as a real spike.
 */
export function tooltipModel(point: FollowerDailyAddsPoint): TooltipModel {
  const heading =
    point.spanDays !== null && point.spanDays > 1
      ? `${dayLabel(shiftDay(point.day, -(point.spanDays - 1)))}–${dayLabel(point.day)}`
      : dayLabel(point.day);

  const gapNote = GAP_NOTES[point.basis];
  if (gapNote || point.total === null) {
    return {
      heading,
      totalLabel: null,
      rows: [],
      notes: [gapNote ?? "No measurement for this day"],
      emptyLabel: null,
    };
  }

  const rows: TooltipRow[] = [];
  for (const region of REGION_ORDER) {
    const value = point[region];
    if (value === null || value === 0) continue;
    rows.push({ region, value, valueLabel: formatSignedCount(value) });
  }

  const notes: string[] = [];
  if (point.spanDays !== null && point.spanDays > 1) {
    notes.push("Meta did not refresh in between");
  }
  if (point.provisional) notes.push("Still settling — Meta may revise");
  if (point.unattributed) {
    notes.push(`${formatSignedCount(point.unattributed)} unplaced (top-country cutoff)`);
  }

  return {
    heading,
    totalLabel: `${formatSignedCount(point.total)} net`,
    rows,
    notes,
    emptyLabel: rows.length === 0 ? "No net change" : null,
  };
}

/**
 * Which slot the cursor is over, or null when it is outside the plot.
 *
 * The svg is a fixed viewBox scaled by css width, so screen pixels must be
 * converted to viewBox units before comparing against slot boundaries —
 * skipping that conversion picks a bar further and further off as you move
 * right. INSET (8) matches chartGeometry's own inset.
 */
const INSET = 8;

export function slotFromOffset(
  offsetX: number,
  containerWidth: number,
  viewBoxWidth: number,
  gutterLeft: number,
  slotCount: number,
): number | null {
  if (containerWidth <= 0 || slotCount <= 0) return null;

  const svgX = (offsetX / containerWidth) * viewBoxWidth;
  const plotLeft = INSET + gutterLeft;
  const plotRight = viewBoxWidth - INSET;
  if (svgX < plotLeft) return null;

  const slotWidth = (plotRight - plotLeft) / slotCount;
  if (slotWidth <= 0) return null;

  const index = Math.floor((svgX - plotLeft) / slotWidth);
  return Math.max(0, Math.min(index, slotCount - 1));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- chartTooltip`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/chartTooltip.ts src/lib/chartTooltip.test.ts
git commit -m "feat(web): tooltip content model and slot hit-testing

Pure logic for the chart hover tooltip, in its own module rather than
appended to followerFlow.ts (already 470+ lines). slotFromOffset converts
screen pixels to viewBox units first — the svg is a fixed viewBox scaled
by css width, so comparing raw client x to svg coordinates picks a bar
progressively further off toward the right edge."
```

---

### Task 2: `ChartTooltip` presentational card

**Files:**
- Create: `web/src/components/home/ChartTooltip.tsx`
- Test: `web/src/components/home/ChartTooltip.test.tsx`

**Interfaces:**
- Consumes: `TooltipModel` from `@/lib/chartTooltip`; `REGION_COLORS`, `REGION_LABELS` from `./DailyAddsChart`.
- Produces:
  ```ts
  export interface ChartTooltipProps {
    model: TooltipModel;
    x: number;              // cursor offset within the container, SCREEN px
    y: number;
    containerWidth: number; // screen px, for right-edge flipping
  }
  export function ChartTooltip(props: ChartTooltipProps): React.JSX.Element;
  ```

**Positioning:** absolutely positioned inside the chart's `relative` wrapper. `x`/`y` are unscaled screen offsets — do NOT convert these to viewBox units. Offset 12px from the cursor; when `x` is within 200px of the right edge, render to the cursor's left instead; when `y` is under 90px, render below instead of above. `pointer-events-none` so the card never eats its own hover. `aria-hidden` because it is a pointer affordance and the chart's `aria-label` already summarizes the series.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/home/ChartTooltip.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TooltipModel } from "@/lib/chartTooltip";
import { ChartTooltip } from "./ChartTooltip";

const model: TooltipModel = {
  heading: "Jul 24",
  totalLabel: "+59 net",
  rows: [
    { region: "us", value: 41, valueLabel: "+41" },
    { region: "anglosphere", value: 13, valueLabel: "+13" },
    { region: "other", value: -1, valueLabel: "−1" },
  ],
  notes: [],
  emptyLabel: null,
};

describe("ChartTooltip", () => {
  it("renders the heading, total, and a labelled row per region", () => {
    const html = renderToStaticMarkup(
      <ChartTooltip model={model} x={300} y={120} containerWidth={1080} />,
    );
    expect(html).toContain("Jul 24");
    expect(html).toContain("+59 net");
    expect(html).toContain("US");
    expect(html).toContain("+41");
    expect(html).toContain("UK/CA/AU/NZ/IE");
    expect(html).toContain("Rest of world");
    expect(html).toContain("−1");
  });

  it("renders the honest caveats when present", () => {
    const html = renderToStaticMarkup(
      <ChartTooltip
        model={{
          ...model,
          notes: ["Meta did not refresh in between", "+3 unplaced (top-country cutoff)"],
        }}
        x={300}
        y={120}
        containerWidth={1080}
      />,
    );
    expect(html).toContain("Meta did not refresh in between");
    expect(html).toContain("+3 unplaced (top-country cutoff)");
  });

  it("shows the empty label instead of rows for a zero-net day", () => {
    const html = renderToStaticMarkup(
      <ChartTooltip
        model={{ ...model, rows: [], emptyLabel: "No net change" }}
        x={300}
        y={120}
        containerWidth={1080}
      />,
    );
    expect(html).toContain("No net change");
  });

  it("omits the total row for a gap column", () => {
    const html = renderToStaticMarkup(
      <ChartTooltip
        model={{
          heading: "Jul 20",
          totalLabel: null,
          rows: [],
          notes: ["No snapshot captured"],
          emptyLabel: null,
        }}
        x={300}
        y={120}
        containerWidth={1080}
      />,
    );
    expect(html).toContain("No snapshot captured");
    expect(html).not.toContain("net<");
  });

  it("flips to the cursor's left near the right edge", () => {
    const near = renderToStaticMarkup(
      <ChartTooltip model={model} x={1040} y={120} containerWidth={1080} />,
    );
    const far = renderToStaticMarkup(
      <ChartTooltip model={model} x={200} y={120} containerWidth={1080} />,
    );
    // Flipped cards anchor by right edge; normal cards anchor by left.
    expect(near).toContain("right:");
    expect(far).toContain("left:");
  });

  it("never intercepts its own hover and is hidden from assistive tech", () => {
    const html = renderToStaticMarkup(
      <ChartTooltip model={model} x={300} y={120} containerWidth={1080} />,
    );
    expect(html).toContain("pointer-events-none");
    expect(html).toContain('aria-hidden="true"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- ChartTooltip`
Expected: FAIL — `Failed to resolve import "./ChartTooltip"`.

- [ ] **Step 3: Implement**

Create `web/src/components/home/ChartTooltip.tsx`:

```tsx
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
    ...(flipVertical ? { top: `${y + CURSOR_GAP}px` } : { bottom: `0px` }),
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
              <span className="font-semibold tabular-nums text-foreground">
                {row.valueLabel}
              </span>
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- ChartTooltip`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/home/ChartTooltip.tsx src/components/home/ChartTooltip.test.tsx
git commit -m "feat(web): ChartTooltip presentational card

Takes a pre-formatted model plus a cursor position; owns only placement
and edge flipping. Reuses REGION_COLORS/REGION_LABELS so the tooltip and
the panel legend can never disagree. pointer-events-none so it cannot eat
its own hover."
```

---

### Task 3: Wire hover into the chart

**Files:**
- Modify: `web/src/components/home/DailyAddsChart.tsx`
- Modify: `web/src/components/home/HomePanels.test.tsx`

**Interfaces:**
- Consumes: `tooltipModel`, `slotFromOffset` (Task 1); `ChartTooltip` (Task 2).
- Produces: no new exports. `REGION_COLORS` / `REGION_LABELS` keep their existing exports — `ChartTooltip` imports them from here.

**What is deleted:** the per-bar `<title>` elements, plus the now-unused `barTitle` and `unattributedNote` helpers (their logic moved into `tooltipModel`). `noUnusedLocals` will fail the build if either is left behind. The chart's own `<title>`, the mean-line `<title>`, and the `role="img"`/`aria-label` all STAY.

- [ ] **Step 1: Write the failing test**

In `web/src/components/home/HomePanels.test.tsx`, add inside the existing `describe("FollowerFlowPanel", ...)` block:

```ts
  it("drops the slow native per-bar tooltips but keeps the chart's own labels", () => {
    const points = [
      flowPoint("2026-07-20", { us: 40, southAsian: 5, anglosphere: 10, other: 5 }),
      flowPoint("2026-07-21", { us: 120, southAsian: 15, anglosphere: 30, other: 10 }),
      flowPoint("2026-07-22", { us: 80, southAsian: 10, anglosphere: 20, other: 8 }),
    ];
    const summary = summarizeFollowerFlow(points)!;
    const html = renderToStaticMarkup(
      <FollowerFlowPanel
        points={points}
        stock={flowStock}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );

    // The old native tooltips said "net." per bar — those are gone.
    expect(html).not.toContain("net.");
    // Exactly two <title>s survive: the chart's own, and the mean line's.
    expect((html.match(/<title>/g) ?? []).length).toBe(2);
    expect(html).toContain("<title>Daily net follower adds by region</title>");
    expect(html).toContain("7-day rolling average per day");
    // The accessible summary is untouched.
    expect(html).toContain('role="img"');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- HomePanels`
Expected: FAIL — the per-bar `<title>` elements still render, so the `<title>` count is 5 (3 bars + 2) and `"net."` is still present.

- [ ] **Step 3: Implement**

In `web/src/components/home/DailyAddsChart.tsx`:

**(a)** Replace the import block at the top:

```tsx
import { useRef, useState } from "react";
import type { FollowerDailyAddsPoint } from "@/lib/types";
import { chartGeometry, formatSignedCount, type ChartRegion } from "@/lib/followerFlow";
import { slotFromOffset, tooltipModel } from "@/lib/chartTooltip";
import { cn } from "@/lib/utils";
import { ChartTooltip } from "./ChartTooltip";
```

**(b)** Delete `barTitle` (lines 45-59) and `unattributedNote` (lines 40-43) entirely. Keep `tickLabel` and `shiftDay` — `tickLabel` is still used by the axis and aria-label. If `shiftDay` becomes unused after deleting `barTitle`, delete it too; `noUnusedLocals` will tell you.

**(c)** Inside the component, after the `measured.length < 2` early return and before `const geo = ...`, add hover state:

```tsx
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const offsetX = event.clientX - rect.left;
    const index = slotFromOffset(offsetX, rect.width, WIDTH, GUTTER_LEFT, points.length);
    if (index === null) {
      setHover(null);
      return;
    }
    setHover({ index, x: offsetX, y: event.clientY - rect.top });
  }
```

**(d)** Wrap the returned markup so the tooltip has a positioned ancestor and the container receives pointer events. Change the outer element from `<div className={className}>` to:

```tsx
    <div
      ref={containerRef}
      className={cn("relative", className)}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHover(null)}
    >
```

**(e)** Highlight the hovered bar. The bars are keyed by day and drawn from `geo.bars`, but `hover.index` indexes `points` — map through the day so the two agree:

```tsx
  const hoveredDay = hover ? points[hover.index]?.day ?? null : null;
```

Declare that right after the `hover` state. Then in the measured-bar branch, change the `<g>` opacity so the hovered bar brightens and its neighbours dim slightly:

```tsx
            <g
              key={bar.day}
              opacity={
                bar.provisional
                  ? hoveredDay === bar.day ? 0.7 : 0.45
                  : hoveredDay && hoveredDay !== bar.day ? 0.55 : 1
              }
            >
```

And remove the `<title>{barTitle(bar, segmentText)}</title>` line plus the now-unused `const segmentText = ...` above it. For the ghost branch, remove its `<title>{barTitle(bar, "")}</title>` and give the `<rect>` a self-closing tag.

**(f)** Render the tooltip as the last child inside the wrapper, after the date-label row:

```tsx
      {hover && points[hover.index] && containerRef.current && (
        <ChartTooltip
          model={tooltipModel(points[hover.index]!)}
          x={hover.x}
          y={hover.y}
          containerWidth={containerRef.current.getBoundingClientRect().width}
        />
      )}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- HomePanels`
Expected: PASS.

Run: `npm test`
Expected: 10 files, 105 tests (86 baseline + 13 Task 1 + 6 Task 2). If your count differs, reconcile before committing.

Run: `npm run build`
Expected: exit 0. Any "declared but never read" error means a helper from (b) was left behind — delete it.

- [ ] **Step 5: Commit**

```bash
git add src/components/home/DailyAddsChart.tsx src/components/home/HomePanels.test.tsx
git commit -m "feat(web): instant styled tooltip on the daily-adds chart

Replaces the native per-bar <title> tooltips, which took ~1s to appear
and could not be styled. Hovering now shows the day's total and its
region breakdown immediately, with the hovered bar highlighted.

The chart's own <title> and aria-label summary stay, so the accessible
description is unchanged; the card itself is aria-hidden as a pointer
affordance."
```

---

### Task 4: Verify hover in a real browser

**Files:** none (verification only)

Pointer interaction cannot be unit-tested here — there is no jsdom, and `renderToStaticMarkup` produces static HTML with no events. This task is the only proof the feature works.

**Note on the environment:** the app throws at boot without `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`, which live in Vercel and are absent locally. So verify via a throwaway harness page that renders the real `DailyAddsChart` with realistic data — the same approach used for the Home declutter. Delete the harness files afterward; they must never be committed.

- [ ] **Step 1: Create the throwaway harness**

Create `web/harness.html`:

```html
<!doctype html>
<html lang="en" class="dark">
  <head><meta charset="UTF-8" /><title>Chart hover harness</title></head>
  <body><div id="root"></div><script type="module" src="/src/harness.tsx"></script></body>
</html>
```

Create `web/src/harness.tsx`:

```tsx
// THROWAWAY hover harness. Not committed.
import { createRoot } from "react-dom/client";
import type { FollowerDailyAddsPoint } from "@/lib/types";
import { DailyAddsChart } from "@/components/home/DailyAddsChart";
import "./index.css";

function d(n: number, us: number, sa: number, an: number, ot: number, extra: Partial<FollowerDailyAddsPoint> = {}): FollowerDailyAddsPoint {
  const total = us + sa + an + ot;
  const day = `2026-07-${String(n).padStart(2, "0")}`;
  return { day, capturedAt: `${day}T23:00:00.000Z`, us, southAsian: sa, anglosphere: an,
    other: ot, total, unattributed: 0, reportedTotalDelta: total, spanDays: 1,
    stale: false, provisional: false, basis: "diff", ...extra };
}

const points: FollowerDailyAddsPoint[] = [
  d(14, 38, 5, 13, 5), d(15, 29, 4, 10, 4), d(16, 33, 6, 12, 5),
  d(17, 41, 8, 14, 6, { unattributed: 3 }), d(18, 36, 5, 12, 5), d(19, 30, 4, 11, 4),
  { ...d(20, 0, 0, 0, 0), us: null, southAsian: null, anglosphere: null, other: null,
    total: null, spanDays: null, reportedTotalDelta: null, unattributed: null,
    stale: true, basis: "stale" },
  d(21, 96, 14, 34, 12, { spanDays: 2, basis: "multi_day_span" }),
  d(22, 52, 8, 18, 7), d(23, 61, 9, 21, 8), d(24, 41, 6, 13, -1),
  d(25, 47, 6, 16, 6, { provisional: true }), d(26, 39, 5, 14, 5, { provisional: true }),
];

createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-background p-10">
    <div className="mx-auto max-w-[1100px] rounded-2xl border border-white/10 bg-card/85 p-6">
      <DailyAddsChart points={points} />
    </div>
  </div>,
);
```

- [ ] **Step 2: Start the dev server**

Run: `npm run dev`
Expected: Vite serves on `http://localhost:5173`. Load `http://localhost:5173/harness.html`.

- [ ] **Step 3: Drive real hover with Playwright**

Move the mouse to the middle of the chart and read the tooltip. Verify:
- A styled dark card appears **immediately** (no ~1s delay) and tracks the cursor.
- It shows a date heading, a `+N net` total, and colored region rows with numbers.
- Hovering the wide Jul 20–21 bar shows the range heading and "Meta did not refresh in between".
- Hovering either dashed newest bar (Jul 25/26) shows "Still settling — Meta may revise".
- Hovering Jul 17 shows "+3 unplaced (top-country cutoff)".
- Hovering the far-right bar keeps the card fully inside the panel (it flips left).
- Hovering over the y-axis labels on the far left shows NO tooltip.
- Moving off the chart hides the card.
- The hovered bar is visibly brighter than its neighbours.

- [ ] **Step 4: Delete the harness and confirm the tree is clean**

```bash
rm -f harness.html src/harness.tsx
git status --short   # must be empty
```

- [ ] **Step 5: Report findings**

Report what you saw, including anything that looked wrong. If a fix is needed, make it, re-run `npm test` and `npm run build`, and commit separately.

---

### Task 5: Deploy

**Files:** none

Frontend only. The Vercel project is NOT Git-connected — pushing to `main` deploys nothing.

- [ ] **Step 1: Final verification**

```bash
npm test        # from web/, expect 10 files / 105 tests
npm run build   # exit 0
```

- [ ] **Step 2: Merge to main and re-verify**

```bash
cd /Users/pratik.nandoskar/Documents/working/mch/insta-automation
git checkout main && git merge <feature-branch>
cd web && npm test && npm run build
```
Both must pass on the merged result before deploying.

- [ ] **Step 3: Deploy**

```bash
cd web && vercel --prod --yes
```

- [ ] **Step 4: Verify in production**

Confirm the deployment reaches `READY` with `target: production` and that `tinysoho-admin.vercel.app` is in its alias list. Then load the live site and hover a bar on Home to confirm the tooltip appears.

---

## Rollback

`vercel rollback`, or redeploy the previous deployment id. Nothing outside `web/` changed and no schema moved, so there is nothing else to unwind.
