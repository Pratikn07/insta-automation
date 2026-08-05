# Feed Follow Attribution Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Home follower-chart day selectable and show a side drawer that explains which regular feed posts Meta credited with follows on that UTC day.

**Architecture:** Keep the deployed backend unchanged. Home owns the selected UTC day and lazily requests the existing one-day attribution endpoint; `DailyAddsChart` owns accessible day selection; a focused drawer renders the response; pure view-model helpers centralize accuracy-sensitive labels and explanations.

**Tech Stack:** React 19, TypeScript 6, TanStack Query, Framer Motion, Tailwind CSS, Lucide, Vitest, React DOM server rendering, existing Express/Prisma backend.

## Global Constraints

- Only carousels, images, and non-Reel feed videos are attributed.
- Reels and Stories must remain explicitly excluded.
- Feed-post attribution is gross follows; account follower change is net follows minus unfollows.
- `netResidualAfterFeed` is directional and must never be labeled as exact Reel attribution.
- Dates sent to the endpoint are inclusive UTC `YYYY-MM-DD` dates.
- No new backend schema, migration, collector, endpoint, navigation item, or frontend dependency.
- Preserve chart geometry, hover behavior, provisional styling, multi-day styling, and stale/ghost bars.

---

### Task 1: Frontend attribution types and accuracy copy

**Files:**
- Modify: `web/src/lib/types.ts`
- Create: `web/src/lib/feedFollowAttribution.ts`
- Create: `web/src/lib/feedFollowAttribution.test.ts`

**Interfaces:**
- Produces: `FeedFollowAttributionResponse`, `FeedFollowAttributionDay`, `FeedFollowAttributedPost`, `FeedFollowCollectionStatus`, and `FeedFollowComparisonReason`, mirroring the deployed API.
- Produces: `feedMediaLabel(mediaType)`, `feedComparisonExplanation(reason)`, and `feedCollectionCopy(day)`.

- [ ] **Step 1: Write failing tests for human-readable, accuracy-safe copy**

Create table-driven assertions requiring:

```ts
expect(feedMediaLabel("CAROUSEL_ALBUM")).toBe("Carousel");
expect(feedMediaLabel("IMAGE")).toBe("Image post");
expect(feedMediaLabel("VIDEO")).toBe("Feed video");
expect(feedMediaLabel(null)).toBe("Feed post");

expect(feedComparisonExplanation("account_provisional")).toContain("still settling");
expect(feedComparisonExplanation("feed_multi_day_delta")).toContain("multiple days");
expect(feedComparisonExplanation(null)).toBeNull();

expect(feedCollectionCopy(completeDay).label).toBe("Complete");
expect(feedCollectionCopy(partialDay).detail).toContain("1 unavailable");
expect(feedCollectionCopy(notStartedDay).detail).toContain("Tracking had not started");
```

Every test fixture must contain every `FeedFollowAttributionDay` field so API/type drift is caught.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web && npm test -- src/lib/feedFollowAttribution.test.ts
```

Expected: FAIL because the helper module and response types do not exist.

- [ ] **Step 3: Add exact API response types**

Append frontend mirrors to `web/src/lib/types.ts`:

```ts
export type FeedFollowCollectionStatus = "not_started" | "complete" | "partial" | "missing";

export type FeedFollowComparisonReason =
  | "feed_not_started"
  | "feed_tracking_partial_day"
  | "feed_collection_incomplete"
  | "feed_multi_day_delta"
  | "feed_counter_correction"
  | "account_missing"
  | "account_provisional"
  | "account_not_one_day";

export interface FeedFollowAttributedPost {
  mediaId: string;
  mediaType: string | null;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  postedAt: string | null;
  follows: number;
  delta: number;
  spanDays: number;
}

export interface FeedFollowAttributionDay {
  day: string;
  collectionStatus: FeedFollowCollectionStatus;
  eligiblePosts: number;
  successfulPosts: number;
  unavailablePosts: number;
  failedPosts: number;
  missingPosts: number;
  attributedFeedFollows: number | null;
  posts: FeedFollowAttributedPost[];
  hasCounterCorrection: boolean;
  hasMultiDayDelta: boolean;
  accountNetAdds: number | null;
  accountBasis: DailyAddsBasis | null;
  accountProvisional: boolean;
  netResidualAfterFeed: number | null;
  comparisonReason: FeedFollowComparisonReason | null;
}
```

Add the complete response envelope:

```ts
export interface FeedFollowAttributionResponse {
  range: { from: string; to: string };
  tracking: {
    startedAt: string | null;
    lastAttemptAt: string | null;
    lastCompletedAt: string | null;
    lastStatus: string | null;
    eligibleCount: number;
    writtenCount: number;
    unavailableCount: number;
    failedCount: number;
    lastError: string | null;
    trackedPosts: number;
    latestSnapshotDay: string | null;
  };
  days: FeedFollowAttributionDay[];
  summary: {
    comparableDays: number;
    attributedFeedFollows: number;
    accountNetAdds: number;
    netResidualAfterFeed: number;
  };
  caveats: string[];
}
```

- [ ] **Step 4: Implement the pure view-model helpers**

Create `web/src/lib/feedFollowAttribution.ts`. Map every comparison reason to plain language. `feedCollectionCopy` must use the day's failed/unavailable/missing counts and never call the residual a Reel count. Return:

```ts
export interface FeedCollectionCopy {
  label: string;
  detail: string;
  tone: "good" | "caution" | "muted";
}
```

- [ ] **Step 5: Run the focused test and verify GREEN**

```bash
cd web && npm test -- src/lib/feedFollowAttribution.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the completed unit**

```bash
git add web/src/lib/types.ts web/src/lib/feedFollowAttribution.ts web/src/lib/feedFollowAttribution.test.ts
git commit -m "feat(web): model feed follow attribution"
```

---

### Task 2: Attribution drawer states and post list

**Files:**
- Create: `web/src/components/home/FeedFollowAttributionDrawer.tsx`
- Create: `web/src/components/home/FeedFollowAttributionDrawer.test.tsx`
- Reuse: `web/src/components/ui/drawer.tsx`
- Reuse: `web/src/components/ui/button.tsx`
- Reuse: `web/src/components/ui/skeleton.tsx`

**Interfaces:**
- Consumes: Task 1 response types and helpers.
- Produces:

```ts
export interface FeedFollowAttributionDrawerProps {
  day: string | null;
  data: FeedFollowAttributionResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onClose: () => void;
}
```

- [ ] **Step 1: Write failing server-rendered component tests**

Cover six states: loading, request error, before tracking, complete zero, partial collection, and complete with contributors. For a contributing carousel assert the markup includes `+7`, `Carousel`, `12 lifetime`, caption text, and safe external-link attributes. Assert the drawer says `Reels and Stories are not included` and `directional`, and never claims a Reel caused the remainder.

- [ ] **Step 2: Run the drawer test and verify RED**

```bash
cd web && npm test -- src/components/home/FeedFollowAttributionDrawer.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the drawer shell and state boundary**

Use the existing `Drawer` with `open={day !== null}` and `widthClass="w-full max-w-xl"`. Keep the date in loading and error titles. Read `data.days[0]` defensively; an absent day is unavailable, never zero.

- [ ] **Step 4: Implement summary cards and collection status**

Render:

- `Account net change`: signed count or `Unavailable`.
- `Attributed to feed posts`: signed count or `Unavailable`.
- `Directional remainder`: signed count only when non-null; otherwise the comparison explanation.

Show `feedCollectionCopy` directly below the summaries.

- [ ] **Step 5: Implement contributor rows and honest empty states**

Map `day.posts` in API order. Each row gets a square thumbnail/fallback, caption fallback, media label, UTC publication date, daily signed delta, lifetime follows, and safe Instagram link. A complete empty day gets a definitive zero message; incomplete and pre-tracking days preserve uncertainty.

- [ ] **Step 6: Run the drawer test and verify GREEN**

```bash
cd web && npm test -- src/components/home/FeedFollowAttributionDrawer.test.tsx
```

Expected: PASS without warnings.

- [ ] **Step 7: Commit the completed unit**

```bash
git add web/src/components/home/FeedFollowAttributionDrawer.tsx web/src/components/home/FeedFollowAttributionDrawer.test.tsx
git commit -m "feat(web): show feed attribution drawer"
```

---

### Task 3: Select chart days and load one-day attribution

**Files:**
- Modify: `web/src/components/home/DailyAddsChart.tsx`
- Modify: `web/src/components/home/ChartTooltip.tsx`
- Modify: `web/src/components/home/ChartTooltip.test.tsx`
- Modify: `web/src/components/home/FollowerFlowPanel.tsx`
- Modify: `web/src/components/home/HomePanels.test.tsx`
- Modify: `web/src/pages/Home.tsx`

**Interfaces:**
- Extend `DailyAddsChartProps` and `FollowerFlowPanelProps` with `selectedDay?: string | null` and `onDaySelect?: (day: string) => void`.
- Extend `ChartTooltipProps` with `actionHint?: string`.
- Home consumes `FeedFollowAttributionDrawer`.

- [ ] **Step 1: Write failing chart-markup and tooltip tests**

In `HomePanels.test.tsx`, render with `onDaySelect` and `selectedDay="2026-07-21"`. Assert each chart day has `role="button"`, a date-specific label containing `View feed-post attribution`, `tabindex="0"`, and selected `aria-pressed="true"`.

In `ChartTooltip.test.tsx`, pass `actionHint="Click to see contributing feed posts"` and assert it renders without changing existing content.

- [ ] **Step 2: Run focused chart tests and verify RED**

```bash
cd web && npm test -- src/components/home/HomePanels.test.tsx src/components/home/ChartTooltip.test.tsx
```

Expected: FAIL because selection props, SVG controls, and action hint are absent.

- [ ] **Step 3: Add selection behavior without changing geometry**

Wrap normal and ghost day visuals in selectable SVG `<g>` elements. When `onDaySelect` exists, add button role, `tabIndex={0}`, date-specific label, `aria-pressed`, pointer cursor, click activation, and Enter/Space activation with `preventDefault()`. Leave non-interactive markup unchanged when no callback exists.

Selected-day emphasis must reuse the existing opacity logic; do not change dimensions or values.

- [ ] **Step 4: Add tooltip hint and pass selection through the panel**

Render `actionHint` as a subtle final line. `DailyAddsChart` supplies the exact prompt only when interactive. `FollowerFlowPanel` accepts and forwards selection props.

- [ ] **Step 5: Wire Home state, query, and drawer**

In `Home.tsx`:

```ts
const [attributionDay, setAttributionDay] = useState<string | null>(null);
const attributionQ = useQuery<FeedFollowAttributionResponse>({
  queryKey: ["insights", "feed-follow-attribution", attributionDay],
  queryFn: () =>
    api<FeedFollowAttributionResponse>(
      `/insights/feed-follow-attribution?from=${attributionDay}&to=${attributionDay}`,
    ),
  enabled: attributionDay !== null,
});
```

Pass selection to `FollowerFlowPanel`. Render the drawer with query state, retry, close, and selected day. Closing resets only `attributionDay`, allowing React Query caching.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
cd web && npm test -- src/components/home/HomePanels.test.tsx src/components/home/ChartTooltip.test.tsx src/components/home/FeedFollowAttributionDrawer.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the completed integration**

```bash
git add web/src/components/home/DailyAddsChart.tsx web/src/components/home/ChartTooltip.tsx web/src/components/home/ChartTooltip.test.tsx web/src/components/home/FollowerFlowPanel.tsx web/src/components/home/HomePanels.test.tsx web/src/pages/Home.tsx
git commit -m "feat(web): open attribution from follower chart"
```

---

### Task 4: Full verification and authenticated smoke test

**Files:**
- Verify only; fix failures in their owning files with a new failing regression test first.

**Interfaces:**
- Validates the complete frontend/backend release boundary without adding scope.

- [ ] **Step 1: Run the complete automated verification set**

```bash
cd web && npm test && npm run lint && npm run build
cd .. && npm test && npm run build && npx prisma validate && git diff --check
```

Expected: all tests pass, ESLint exits 0, both builds exit 0, Prisma validates, and the diff check is clean.

- [ ] **Step 2: Start the local frontend against the configured API**

Run Vite on an available localhost port. Use the existing signed-in browser session; never copy tokens into source or logs.

- [ ] **Step 3: Smoke-test the complete interaction**

Verify hover accuracy; pre-tracking and tracked days; identical `from`/`to` request dates; summary and post rows matching the response; new-tab Instagram links; Escape close; Enter/Space activation; and mobile-width behavior without horizontal overflow.

- [ ] **Step 4: Inspect the final branch**

```bash
git status --short --branch
git log --oneline --decorate -6
```

The worktree must be clean. Commit any verification fix only after its regression test fails then passes.

- [ ] **Step 5: Request code review before integration**

Review against `docs/superpowers/specs/2026-08-04-feed-follow-attribution-drawer-design.md`, resolve critical/important findings with TDD, and rerun Step 1 before offering merge, push, or deployment choices.
