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

- **This week** = `sumRegions(points, 7).us` — the `us` region sum over the
  trailing 7 points, reusing the existing window helper verbatim so the tile
  and the chart legend below it are computed the same way.
- **Last week** = the same `sumRegions(_, 7).us` over the 7 points
  immediately preceding that window.
- **Provisional (still-settling) days are INCLUDED**, matching
  `summarizeFollowerFlow`, which uses `includeProvisional: true`. This is
  deliberate and load-bearing: commit `126d4ee` changed it *to* include
  them because excluding them made the headline rate disagree with the
  7-day region legend printed beside it, and bent the trend badge (dropping
  the 2 newest days removes ~29% of a 7-day window but only ~7% of a 28-day
  baseline). The tile discloses the count instead — "newest N still
  settling" — exactly as the panel does today.
- Headline: `+182` (this week's sum). Comparison line: `vs +140 last week`.
- Trend (accelerating / steady / slowing) reuses the existing ±15% band rule
  from `summarizeFollowerFlow` (`band = max(|lastWeek| * 0.15, 1)`), scoped
  to the `us` region sum instead of the total.
- **Insufficient history:** the prior window covers fewer than 7 days →
  show the this-week US sum alone, comparison line reads "not enough history
  yet for a week-over-week read" instead of a misleading `vs` number. Zero
  covered days in even the this-week window → tile shows `—` with
  "Needs two days of follower geography".

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
- `summarizeUsWeekOverWeek(points)` in `followerFlow.ts` + Vitest coverage
  (enough history / insufficient history / no-data case / provisional-day
  INCLUSION / trend band boundaries / negative week), mirroring the existing
  pure-function test style in `followerFlow.test.ts`.

**Changed:**
- `web/src/pages/Home.tsx` — drop the `geo-window-trend` and `leaderboard`
  queries (no longer consumed on this page); render `FollowerKpiRow` then
  the trimmed `FollowerFlowPanel`.
- `web/src/components/home/FollowerFlowPanel.tsx` — remove the headline
  number block, the "US share of new/all followers" tile pair, AND the
  stock/milestone row (`describeStockVsFlow`'s "4,355 followers counted · at
  this pace ~6 days to 5,000") — all three are now owned by the KPI row, and
  leaving them would reprint the same numbers twice on one screen. Keep: the
  title, trend badge, freshness pill, region legend, unattributed footnote,
  the chart, the Meta-lag disclaimer, and all empty/error states.
  `PanelShell`'s `min-h-[600px]` also drops (the trimmed panel is much
  shorter; a 600px floor would leave a large dead gap).
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
  (moved to `web/src/components/activity/AutomationHealthStrip.tsx`)
- `web/src/components/home/FollowerYieldPanel.tsx` — its entire content
  becomes KPI tile 3, so the standalone wide-strip panel has no remaining
  caller. (`summarizeFollowerYield` in `homeDashboard.ts` survives — the tile
  calls it.)
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
