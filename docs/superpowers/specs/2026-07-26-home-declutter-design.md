# Home Declutter Design

## Goal

Home tries to answer too many questions at once today (growth, reel picks,
operations) and repeats the same "is US growing?" question twice with two
different abstract percentage framings. This redesign narrows Home to one
job — **glanceable, concrete follower/audience numbers** — and moves
everything else to the page that already owns it.

Non-goals: no backend changes, no new API endpoints, no new database
columns. Every number Home needs already exists in `GET
/insights/follower-daily-adds` and `GET /stats`.

## Scope: what moves, what's cut, what's new

**Leaves Home:**
- Automation Health strip → moves to **Activity** page, unchanged.
- "Reels worth repeating" (top-3 ranked cards) → moves to **Insights**,
  added to the existing Leaderboard tab. Ranking logic (`rankRepeatCandidates`)
  is unchanged — it's the panel's location that moves, not its rules.
- "Is my US audience growing" (14d-vs-90d %, reached/engaged) panel →
  **deleted**. It duplicated the goal (US-growth signal) with an abstract
  percentage-point framing the user found hard to act on, and it already
  substantially overlapped the Experiments tab on Insights, which has its own
  14d-vs-90d reached/engaged comparison. No replacement is needed on Insights.

**Stays on Home, restructured:**
- Daily follower flow chart (region-stacked bars, 7-day mean line) — kept,
  trimmed of its own headline number/US-share tiles (now redundant with the
  new KPI row above it).

**New on Home (promoted from buried sub-elements, or newly computed):**
- **US followers this week vs last week** — answers "is my US audience
  growing" with real counts instead of percentage points.
- **Total followers milestone** — promoted from a footer sentence inside the
  old flow panel into its own tile.
- **Guide→follow yield** — kept, restyled from a wide stat-strip card into a
  KPI tile matching the other two.

## Layout

```
Header (unchanged: title, one-liner, "Updated <date>")

┌───────────────┬───────────────┬───────────────┐
│ US followers   │ Total          │ Guide→follow   │
│ this week      │ followers      │ yield          │
└───────────────┴───────────────┴───────────────┘

┌─────────────────────────────────────────────────┐
│ Daily net adds by region (chart + legend)        │
└─────────────────────────────────────────────────┘
```

- KPI row: 3 equal-width tiles. Side-by-side from tablet width up; stacks to
  a single column only below that (existing Tailwind breakpoints already
  used elsewhere in the app apply here — no new breakpoint).
- Chart panel: the existing `DailyAddsChart`, region legend, and the
  "Meta reports only its top countries…" disclaimer — unchanged content,
  just no longer sharing a card with a headline number.
- Each tile and the chart panel manage their own loading/empty/error state
  independently (existing pattern) — one stalled feed never blanks the rest
  of the page.

## KPI tile 1: US followers this week vs last week

New calculation, added to `web/src/lib/followerFlow.ts`.

- **This week** = sum of `us` region adds over the trailing window whose
  `spanDays` total reaches 7 (same coverage-based windowing `sumRegions`
  already uses — a multi-day-span point counts its full total toward the
  window it spans, consistent with how `ratePerDay`/`sumRegions` avoid
  double-counting absorbed gap days). Provisional points excluded, matching
  `summarizeFollowerFlow`.
- **Last week** = the same coverage-based sum over the 7 covered days
  immediately preceding the "this week" window.
- Headline: `+182` (this week's sum). Comparison line: `vs +140 last week`.
- Trend (accelerating / steady / slowing) reuses the existing ±15%-of-prior
  -week band rule already in `summarizeFollowerFlow`, scoped to the `us`
  region sum instead of the total.
- **Insufficient history:** last week's window can't reach a full 7 covered
  days → show the this-week US sum alone, comparison line reads "not enough
  history yet for a week-over-week read" instead of a misleading `vs`
  number. Zero covered days in even the this-week window (today's existing
  `summarizeFollowerFlow` null case) → tile shows the panel's existing
  "waiting for snapshots" treatment.

## KPI tile 2: Total followers milestone

No new calculation — reuses `describeStockVsFlow(stock, avgPerDay7)`
verbatim from `followerFlow.ts`.

- Headline: `stock.totalCounted` (e.g. `4,355`).
- Comparison line: the existing `sentence` field (e.g. "At this pace, about
  6 days to 5,000."), or nothing if `daysToNextMilestone` is null.

## KPI tile 3: Guide→follow yield

No new calculation — reuses `summarizeFollowerYield(stats.followConversion)`
verbatim from `homeDashboard.ts`.

- Headline: `yieldPct` (e.g. `22.3%`), or `—` in the `empty` state.
- Comparison line: `${converted}/${rechecked} converted`, falling back to
  the existing `headline` copy ("Measuring N…", "No non-follower
  deliveries…") when `state === "empty"`.

## Component changes

**New:**
- `web/src/components/home/KpiTile.tsx` — shared tile shell: icon, big
  number, one-line comparison/context, loading skeleton, "—" empty state.
- `web/src/components/home/FollowerKpiRow.tsx` — lays out the 3 tiles,
  owns no data fetching itself (receives summaries as props like the
  existing panels do).
- `summarizeUsWeekOverWeek(points, opts)` in `followerFlow.ts` + Vitest
  coverage (enough history / insufficient history / zero-week edge case /
  provisional-day exclusion, mirroring the existing test style in
  `followerFlow.test.ts`).

**Changed:**
- `web/src/pages/Home.tsx` — drop the `geo-window-trend` and `leaderboard`
  queries (no longer consumed on this page); render `FollowerKpiRow` then
  the trimmed `FollowerFlowPanel`.
- `web/src/components/home/FollowerFlowPanel.tsx` — remove the headline
  number block and the "US share of new/all followers" tiles (now owned by
  the KPI row); keep the chart, region legend, stock-vs-flow disclaimer
  line, freshness pill, and empty/error states.
- `web/src/pages/Insights.tsx` — add a repeat-candidates section to the
  Leaderboard tab, reusing `rankRepeatCandidates` and rendering the same
  card markup `RepeatReelsPanel` used (moved, not rewritten).
- `web/src/pages/Activity.tsx` — render `AutomationHealthStrip` (moved
  as-is) above the event feed.

**Deleted:**
- `web/src/components/home/AudienceGrowthPanel.tsx`
- `web/src/components/home/DashboardSparkline.tsx` (only consumer was the
  deleted panel)
- `web/src/components/home/RepeatReelsPanel.tsx` as a standalone Home
  component (superseded by its relocated version in Insights)
- `web/src/components/home/AutomationHealthStrip.tsx` as a Home component
  (superseded by its relocated version in Activity)
- `summarizeAudienceGrowth` and `formatAudienceDelta` from
  `web/src/lib/homeDashboard.ts` (only consumer was the deleted panel)
- Corresponding `describe` blocks in `HomePanels.test.tsx` and
  `homeDashboard.test.ts` for everything above; new/moved tests added
  alongside the relocated components.

**Unchanged:**
- `DailyAddsChart.tsx`, `PanelShell.tsx`, `followerFlow.ts`'s existing
  exports, `rankRepeatCandidates` itself, `summarizeFollowerYield` itself.

## Testing

- New Vitest coverage for `summarizeUsWeekOverWeek` in
  `followerFlow.test.ts`, following the existing pure-function testing
  style (explicit `now`/inputs, no `Date.now()`).
- `HomePanels.test.tsx` updated: remove assertions for deleted components,
  add `KpiTile`/`FollowerKpiRow` render assertions, update
  `FollowerFlowPanel` assertions for the trimmed markup.
- Existing Insights/Activity test coverage (if any) extended to cover the
  relocated sections; no existing test files found for `Insights.tsx` or
  `Activity.tsx` today, so this is new coverage, not a modification.
- `npm run build` and `npm run lint` (in `web/`) run after implementation,
  same as prior Home changes.
