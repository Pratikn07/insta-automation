# Chart Hover Tooltip Design

## Goal

Replace the daily-adds chart's native SVG `<title>` tooltips with a styled,
instant tooltip that shows each day's total and its per-region breakdown on
hover.

The chart already has `<title>` elements on every bar, so hovering technically
works today — but native tooltips take ~1s to appear, cannot be styled, and are
easy to miss entirely. This is a replacement, not a new capability.

## Scope decision: regions, not countries

The user's request mentioned seeing "the country". Per-country data was
investigated and **deliberately deferred**:

- The DB does hold per-country counts, and real per-day country deltas are
  derivable (verified 2026-07-26 — e.g. Jul 24: US +41, GB +8, IN +5, CA +5,
  AU +5, KE +2, ZA +1, PK +1).
- But `followerFlowService` collapses countries into four regions before the API
  responds, so the frontend receives no country data at all. Surfacing countries
  needs a backend change plus a Railway deploy.
- Decision: ship the regions-only tooltip first (frontend-only, no API change).
  Countries remain a viable follow-up on the same tooltip component.

## Data source

The tooltip reads the source `FollowerDailyAddsPoint`, NOT the rendered
`ChartBar`. This matters: `ChartSegment` carries only pixel geometry (`region`,
`y`, `height`) and no region value, so the numbers are unavailable from bars.
The point carries `us` / `southAsian` / `anglosphere` / `other` / `total` /
`unattributed` / `spanDays` / `provisional` / `basis` — everything the tooltip
needs.

No API change, no new endpoint, no DB access.

## Behavior

- Pointer moves anywhere over the chart → the nearest slot's bar highlights
  (brightness lift) and the tooltip appears **instantly** at the cursor,
  offset 12px so it never sits beneath the pointer.
- Hit detection maps cursor x → **slot index**, not bar rectangle. Thin bars and
  the gaps between them both register, so there are no dead zones.
- Near the right edge the card flips to the cursor's left; near the top it flips
  below. It never clips outside the chart container.
- Pointer leaving the chart hides the tooltip.
- Hovering a ghost/gap column shows that column's state text rather than nothing.

## Content

Normal measured day:

```
Jul 24                    +59 net
──────────────────────────────────
● US                          +41
● South Asia                   +6
● UK/CA/AU/NZ/IE              +13
● Rest of world                −1
```

- Region rows use the same colors and labels as the chart legend
  (`REGION_COLORS` / `REGION_LABELS`), so the tooltip and legend cannot disagree.
- Regions with a value of exactly 0 are omitted — a row of zeros is noise.
- If every region is 0 but the day IS measured, show a single "no net change"
  row rather than an empty card.
- Signed values use `formatSignedCount` (U+2212 minus), matching the rest of the UI.

Conditional notes, included only when they apply (these explain the
odd-looking bars; dropping them would make the tall combined bar read as a real
spike):

| Condition | Note |
|---|---|
| `spanDays > 1` | heading spans both dates (`Jul 20–21`) + "Meta did not refresh in between" |
| `provisional` | "still settling — Meta may revise" |
| `unattributed !== 0` | "+3 unplaced (top-country cutoff)" |
| `basis === "pending"` | "waiting for Meta to refresh" |
| `basis === "no_snapshot"` | "no snapshot captured" |
| `basis === "no_prior_day"` | "series start, nothing to diff against" |

## Structure

Three units, each independently testable:

1. **`tooltipModel(point)`** — new pure function in `web/src/lib/followerFlow.ts`.
   Takes a `FollowerDailyAddsPoint`, returns
   `{ heading, totalLabel, rows: Array<{ region, label, color, value }>, notes: string[] }`.
   Every content decision lives here and is unit-tested with no DOM.
   The existing `barTitle` logic in `DailyAddsChart.tsx` folds into this
   function rather than being duplicated.
2. **`ChartTooltip.tsx`** — presentational card. Takes the model plus cursor
   `{x, y}` and container dimensions; owns only positioning and edge flipping.
   No data logic.
3. **`DailyAddsChart.tsx`** — adds `hoveredIndex` state and pointer handlers,
   wires 1 into 2, and drops the per-bar `<title>` elements.

## Accessibility

Removing `<title>` from bars removes a screen-reader affordance, so:

- The chart keeps its `role="img"` and summary `aria-label` (unchanged).
- The tooltip is `aria-hidden` — it is a pointer affordance, and its content is
  already covered by the chart's aria-label summary.
- The mean-line `<title>` and the chart's own `<title>` stay.

## Testing

- `tooltipModel`: unit tests for normal day, multi-day span, provisional,
  each ghost basis, non-zero unattributed, all-zero-regions, and negative values.
- `ChartTooltip`: `renderToStaticMarkup` tests for rendered content and for
  edge-flip positioning (right edge, top edge).
- Pointer interaction is not unit-testable here (no jsdom in this project), so
  hover is verified in a real browser with Playwright as the final step — moving
  the actual cursor over actual bars and asserting the tooltip's content.
- Frontend suite and `npm run build` must stay green. Baseline: 8 files,
  86 tests.

## Deploy

Frontend only — Vercel CLI (`cd web && vercel --prod --yes`); the project is not
Git-connected. No Railway deploy needed.
