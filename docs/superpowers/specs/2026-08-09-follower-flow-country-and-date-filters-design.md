# Follower Flow: Per-Country Drill-Down and Date Range Filters

## 1. Purpose

The Follower Flow panel on Home answers "where are your followers coming from?" with a stacked bar
chart of daily net adds across four fixed regions: `us`, `southAsian`, `anglosphere`, and `other`.
The chart covers a fixed trailing window and offers no controls.

This design adds two things:

1. **A date range filter** over the existing chart.
2. **A per-country breakdown mode**, so the four-region roll-up can be expanded into the actual
   countries underneath it.

This is a product and engineering design, not an implementation plan.

## 2. Context

### 2.1 The four-region roll-up hides real markets

`followerFlowCore.ts` collapses every follower snapshot into four regions before the data leaves the
server. The browser has never seen a country code.

Measured over the fourteen days ending 2026-08-09, net follower adds by country were:

| Country | Net adds (14d) | Days it entered the reported set |
| --- | --- | --- |
| US | +633 | 0 |
| IN | +226 | 0 |
| GB | +164 | 0 |
| AU | +125 | 0 |
| CA | +114 | 0 |
| **ZA** | **+81** | 0 |
| PK | +24 | 0 |
| IE | +21 | 0 |
| HK | +20 | 3 |
| MY | +19 | 0 |
| BR | +19 | 3 |
| DE | +16 | 0 |

Six countries account for roughly 92% of all movement, and the tail falls to single digits quickly.

South Africa is the finding that motivates this work. `ANGLOSPHERE` in `src/services/regionMap.ts`
is `GB, CA, AU, NZ, IE`. `ZA` is not a member, so the sixth-largest growth market on the account is
currently rendered as an anonymous slice of the grey "Rest of world" band.

### 2.2 Meta reports only its top 45 countries, and the membership churns

Every follower snapshot carries exactly 45 country codes. Membership at the tail is unstable:
comparing the 08:11 and 14:11 snapshots on 2026-08-09, `IL` was present in the first and absent
from the second.

Over fourteen days, `HK` and `BR` each entered the reported set on three separate days. On such a
day the country has no prior value to diff against. Treating the absence as zero would render a
country's entire cumulative follower count as a single day's gain — a fabricated spike, three times
in two weeks, for each of those countries.

Every country in the top six has a churn count of zero. The instability is confined to the tail.

### 2.3 Available history is 41 days, not 90

`LOOKBACK_DAYS` is 90 in `followerFlowService.ts`, but follower snapshots begin 2026-06-30. As of
2026-08-09 there are 41 distinct days of coverage with no gaps, from 147 snapshots. The date filter
must clamp to real coverage rather than offering 90 days of mostly empty range.

## 3. Scope

### In scope

- Date range filter (presets and custom range) over the Follower Flow chart.
- Per-country breakdown mode with automatic top-N selection, pinning, and muting.
- Per-country diffs plumbed from `geo_demographic_snapshot.counts` through the API.
- Generalising the trend badge so it remains honest under an arbitrary range.

### Out of scope

- Changing `regionMap.ts`. Region membership stays exactly as it is (see §7.1).
- Filtering any other panel. The KPI row, spike candidates, and Home header date continue to read
  the full window.
- Backfilling follower snapshots earlier than 2026-06-30.
- Country breakdowns for the `reached` and `engaged` snapshot stages.

## 4. Data Model and Server Behavior

### 4.1 Per-country diffs

`buildDailyPoints` in `followerFlowCore.ts` already selects one anchor snapshot per Pacific
analytics day and diffs consecutive anchors, carrying `spanDays`, `stale`, `provisional`, and
`basis` semantics. Per-country diffing is added as a parallel computation in that same pass, over
the same anchors, with identical day-bucketing and gap-absorption behavior. No new worker, no new
snapshot logic, and no change to how anchors are chosen.

### 4.2 The presence rule

`diffAnchors` **already implements this rule** for regions: it diffs on the key intersection only,
and countries entering or leaving Meta's reported set net into `unattributed` without touching a
region. The country path records the deltas that loop already computes rather than adding new churn
logic.

A country's delta is real only when the country appears in **both** the current and prior anchor.

- Present in both: delta is `current − prior`, attributed to that country.
- Absent from prior, present in current: delta is **unknown**. It is folded into the point's
  existing `unattributed` residual and contributes nothing to any country's bar.
- Present in prior, absent from current: likewise unknown, likewise folded into `unattributed`.

This preserves the invariant the region path already maintains: the sum of attributed buckets plus
`unattributed` reconciles to Meta's `reportedTotalDelta`. It is the specific mechanism that prevents
the `HK` and `BR` fabricated spikes described in §2.2.

### 4.3 API shape

`GET /api/insights/follower-daily-adds` gains a `byCountry` field on each point: a map of ISO country
code to net delta, containing only countries that satisfied the presence rule for that point.

Existing region fields (`us`, `southAsian`, `anglosphere`, `other`, `total`, `unattributed`,
`reportedTotalDelta`, `spanDays`, `basis`, `provisional`, `spike`) are unchanged. No consumer of the
current response needs to change.

**No new endpoint, and no server-side filtering.** Top-N ranking must recompute whenever the date
range changes; computing it server-side would make every filter interaction a network round trip.
Returning all countries once makes every filter change instant and local, and keeps a single source
of truth for the panel.

Payload cost: 41 days × 45 codes is roughly 1,800 integers (~40KB). At the full 90-day lookback it
approaches ~90KB. This is acceptable for a single panel on a single page.

## 5. Client Behavior

### 5.1 Control bar

A control bar renders above the chart, inside the existing panel shell.

**Date range.** Presets `7d`, `14d`, `30d`, `All`, plus a custom inclusive from–to range. Selection
is clamped to actual coverage (earliest snapshot day through today), so an empty range cannot be
selected. The default on load is `All`, which reproduces today's chart exactly — the panel currently
renders every point the service returns.

**Breakdown mode.** `Regions` or `Countries`. `Regions` is the default and reproduces today's chart
exactly.

**Country selection.** In `Countries` mode, the chart stacks the top 6 countries by absolute net
movement **over the selected date range**, with all remaining countries collapsed into a single
`Other (N countries)` band. The user may pin a country to force its inclusion regardless of rank, or
mute a country to fold it into `Other`.

Ranking is scoped to the selected range on purpose: narrowing to a specific week surfaces a country
that only mattered during that week.

**Selecting a country shows that country alone.** From the automatic view, clicking a country —
whether on a legend chip or in the dropdown — narrows the chart to it, with **no `Other` band**:
"select South Africa" has to mean South Africa, not South Africa beside a grey bar holding the other
46. Clicking further countries adds them alongside; clicking a selected one removes it; emptying the
selection returns to automatic rather than leaving an empty chart with no way back.

The earlier design had clicking *fold a country away*, which inverted the user's intent — with every
top mover already on screen, the only thing a click could do was remove, so "select" read as "hide".

Two surfaces drive this over **one shared `selected` state** so they cannot drift:

1. **Legend chips** — click to narrow to that country, or to drop it from a selection.
2. **A full dropdown** listing every reported country with its net adds over the range, for browsing
   the tail, plus a reset back to the automatic top movers.

Only a real selection carries a tick in the dropdown. In the automatic view every top mover is on
screen but none was *chosen*, and ticking them would make the next click read as "untick".

**The y-axis rescales to the selection.** South Africa is a sliver of the total, so on the full
stack's scale its daily shape is an unreadable strip; selected alone the axis drops from +600 to +15
and its actual trend becomes visible. The trade-off accepted: bar heights are no longer comparable
across different selections.

**Only the overall top 8 countries can hold their own band** (see §5.5). The dropdown lists the rest
with their real numbers but disables their toggle, rather than hiding them and implying Meta never
reported them.

### 5.5 Colour belongs to the country, never to its rank

The colour map is built **once from the full dataset**, not per range. A hue is a property of a
country: changing the date range may change which countries stack, but never repaints the ones that
survive. Assigning colours by index into the range-scoped top-6 would repaint every survivor the
moment a new country entered — the legend would need re-reading after every date change, and two
screenshots of the same country would disagree about its colour.

This bounds how many countries can be individually stacked. The palette holds 8 validated hues, and
cycling is not an option (two countries sharing a colour is worse than folding one away), so hues go
to the overall top 8 and everything below folds into `Other`. That cut-off is where the data stops
being trustworthy anyway: below it sits Meta's churning top-45 boundary.

Eight rather than six because six show at once — the spare two keep the assignment stable when the
range changes which six those are.

### 5.6 `Other` is a drawn series, not just a legend entry

`Other` is stacked as a real band, computed per point from that day's own `byCountry`. Without it the
bars would draw only the named countries while the legend printed an `Other` total, so a bar whose
tooltip claimed "+419 net" would render — and itemise — only part of it. Named countries plus
`Other` equal the day's total, and the tooltip reconciles to the figure in its own header.

### 5.2 What recomputes

The filtered point array feeds every derived value in the panel: the bars, the trailing 7-day mean
line, the legend totals, and the trend badge. There is one array and one derivation path, so the
legend and the chart cannot disagree on screen.

The legend header names the window it actually describes. Region sums at `All` remain the trailing 7
days (long-standing behaviour, kept byte-identical); country sums always cover the whole selected
range, because ranking and legend come from one range-scoped pass. Those two windows differ at
`All`, so the label follows the mode — otherwise the panel prints "+1448 US" under "(7 days)".

### 5.3 Trend badge under an arbitrary range

`summarizeFollowerFlow` currently computes the trend by comparing a fixed 7-day rate against a fixed
28-day rate. That comparison is meaningless once the user picks their own range.

The badge always answers one question: *is the most recent stretch faster than the baseline before
it?* That question is resolved differently depending on whether a range is explicitly selected.

- **Range `All` (the default, i.e. unfiltered).** The existing 7-day versus 28-day comparison is
  retained unchanged. This is what "the baseline before it" means when the user has not narrowed the
  window, and it keeps the default view byte-identical to today's chart.
- **An explicit range of length L.** The selected range is compared against the equal-length range
  immediately preceding it.

When the preceding range is not fully covered by measured data, **the badge is hidden entirely**
rather than rendered from a partial baseline. This follows the existing withholding pattern in
`summarizeUsWeekOverWeek`, which returns a null `lastWeek` rather than compare against an incomplete
prior window.

A consequence to accept: selecting a 30-day range when only 41 days exist leaves an 11-day
predecessor, so the badge disappears. Showing nothing is preferable to a number that reads as a real
decline.

### 5.4 Chart geometry

`chartGeometry` in `web/src/lib/followerFlow.ts` hardcodes `STACK_ORDER` as the four region keys. It
is generalised to accept the stack keys and their accessors as a parameter, so the same geometry
code serves both region and country stacking. Signed stacking (positives up, negatives down),
span-N bar widths, ghost bars, nice-number axis domains, and the shared y-domain between ticks and
bars all remain exactly as they are.

Country colours come from an 8-hue categorical palette, dark-surface steps, validated as a set
against the panel surface: lightness band, chroma floor, adjacent-pair CVD separation (worst ΔE 8.4),
normal-vision floor (worst ΔE 19.3), and 3:1 contrast all pass. `Other` takes the same neutral slate
region mode uses for "Rest of world" — a fold-up bucket must not read as one more country. Region
mode keeps its existing four hardcoded fills.

## 6. Structure

- `src/services/followerFlowCore.ts` — per-country diffing and the presence rule, beside the
  existing region diff. Pure; no DB access.
- `web/src/lib/followerCountry.ts` — new pure module for range-scoped ranking, the top-N cut, and
  pin/mute resolution. No dates sourced internally, no `Date.now()`, matching how `followerFlow.ts`
  is already constructed.
- `web/src/lib/followerFlow.ts` — generalised `chartGeometry`, generalised trend comparison.
- `web/src/components/home/FollowerFlowPanel.tsx` — owns filter state and renders the control bar.
- `web/src/components/home/DailyAddsChart.tsx` — stays a renderer; receives precomputed geometry and
  a stack key/color/label set.

Filter state lives in the panel, not in `Home.tsx`, which keeps the KPI row and header date reading
the unfiltered query result.

## 7. Decisions and Rationale

### 7.1 `regionMap.ts` is not modified

Moving `ZA` into `ANGLOSPHERE` would appear to fix the specific finding in §2.1, but it silently
rewrites every historical region number in the panel and in any saved reading of it. Country mode is
the correct way to see South Africa. Region definitions stay stable.

### 7.2 Filters are panel-scoped

The KPI row, spike candidates, and the Home header date continue to derive from the full window. A
date filter that silently changed the headline follower rate would make the dashboard's top-line
numbers depend on an easily-forgotten control.

### 7.3 Automatic top-N over explicit multi-select

An explicit 45-country picker gives total control but requires the user to rediscover the same six
countries on every visit, and permits selecting twenty countries into an unreadable stack. The data
has a short head and a long dead tail; automatic ranking with pin/mute overrides matches that shape
while keeping the tail honestly represented rather than expanded into meaningless single-digit
bands.

## 8. Error Handling and Edge Cases

- **Range with no measured points.** The chart renders the existing empty state; the legend and
  badge are suppressed rather than showing zeros.
- **Country mode with no `byCountry` data.** If a deployed server predates this change, the field is
  absent; the mode toggle is disabled with an explanatory label rather than rendering an empty chart.
- **Fewer than 6 countries qualify.** The stack renders however many qualify. `Other` is omitted when
  it would be empty.
- **All countries muted.** The chart shows only the `Other` band; the mode is never left with an
  empty stack.
- **Ghost and stale days** behave exactly as today in both modes: stale days draw nothing because
  their adds live in the spanning bar, and `no_snapshot`/`no_prior_day`/`pending` days draw ghost
  columns representing unknown rather than zero.

## 9. Testing

- **Presence rule.** Fixtures reproducing `HK` and `BR` entering the reported set mid-window, with
  assertions that no country bar is drawn for the entry day and that the value lands in
  `unattributed` instead.
- **Reconciliation.** For every point, the sum of `byCountry` values plus `unattributed` equals
  `reportedTotalDelta`, matching the invariant already asserted for regions.
- **Span absorption.** A multi-day-span point carries country deltas covering the full span, and
  per-day rates divide by `spanDays`.
- **Ranking.** Top-N is computed from the selected range only; pinning forces inclusion below the
  cut; muting folds a country into `Other`; `Other` accounts for exactly the countries not shown.
- **Trend generalisation.** The badge matches today's output for the default window, and is withheld
  when the preceding range is not fully covered.
- **Geometry.** Existing `chartGeometry` assertions continue to pass unchanged under the
  parameterised stack keys, verifying the region path did not regress.
- **Rendering.** `renderToStaticMarkup` substring checks for the control bar and country legend,
  following the existing panel test pattern.

## 10. Acceptance Criteria

1. The Follower Flow chart offers `7d`, `14d`, `30d`, `All`, and a custom range, clamped to real
   snapshot coverage.
2. Changing the date range updates the bars, mean line, legend totals, and legend header without a
   network request.
3. A `Countries` breakdown mode stacks the top 6 countries over the selected range plus an `Other
   (N countries)` band, with pin and mute controls.
4. South Africa is visible as its own band in country mode over a range where it ranks.
5. No country bar is drawn for a day on which that country entered or left Meta's reported set; the
   value appears in `unattributed`.
6. Region mode output is byte-identical to today's chart for the default range.
7. The trend badge retains its 7d-versus-28d meaning at range `All`, uses range-versus-preceding-
   range for an explicit range, and is hidden on any explicit range whose equal-length predecessor
   is not fully covered.
8. The KPI row, spike candidates, and Home header date are unaffected by the filters.
9. Changing the range or the breakdown issues **no network request** — the page fetches once.
10. A country keeps the same colour when a filter changes which countries are stacked.
11. In country mode, the named bands plus `Other` equal each day's total, and the tooltip rows
    reconcile to the net figure in its own header.
12. The legend header names the window its numbers actually cover, in both modes.
13. Clicking a country from the automatic view charts **only** that country, with no `Other` band,
    and the y-axis rescales to it.
14. Further clicks add countries rather than replacing; emptying the selection restores the
    automatic top movers.
