# Home Growth Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the operational home page with a visual dashboard that answers whether the US audience is growing and which reels should be repeated.

**Architecture:** Keep `Home.tsx` as the query/orchestration boundary. Put deterministic growth and ranking calculations in a tested `homeDashboard.ts` module, and split the two visual stories into focused presentational components. Reuse existing API endpoints and types; do not add backend or database scope.

**Tech Stack:** React 19, TypeScript, TanStack Query, Tailwind CSS 4, Lucide, Framer Motion, inline accessible SVG, Vitest.

## Global Constraints

- Audience growth is the primary story and uses 14-day versus 90-day aggregate Meta geography.
- Audience growth and reel performance receive equal visual weight in the main layout.
- Reel repeat ranking uses measured performance only; US-fit is context, not a ranking input.
- No backend endpoints, migrations, external API calls, or charting dependency.
- Existing automation health remains visible but secondary.

---

### Task 1: Dashboard calculation contract

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Create: `web/src/lib/homeDashboard.test.ts`
- Create: `web/src/lib/homeDashboard.ts`

**Interfaces:**
- Consumes: `GeoWindowPoint` and `LeaderboardRow` from `web/src/lib/types.ts`.
- Produces: `summarizeAudienceGrowth(points)`, `rankRepeatCandidates(reels)`, `AudienceGrowthSummary`, and `RepeatCandidate`.

- [ ] **Step 1: Install Vitest and add the test script**

Run: `npm install --save-dev vitest`

Add to `web/package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write failing calculation tests**

Create tests that assert:

```ts
expect(summarizeAudienceGrowth([point({ reachedUs14: 42, reachedUs90: 37 })])).toMatchObject({
  status: "growing",
  currentPct: 42,
  baselinePct: 37,
  deltaPoints: 5,
  source: "reached",
});

expect(summarizeAudienceGrowth([point({ reachedUs14: null, reachedUs90: null, engagedUs14: 31, engagedUs90: 34 })])).toMatchObject({
  status: "cooling",
  source: "engaged",
});

expect(rankRepeatCandidates([highReach, highUsFitButNoPerformance])[0]?.mediaId).toBe(highReach.mediaId);
```

- [ ] **Step 3: Run tests and verify RED**

Run: `npm test -- src/lib/homeDashboard.test.ts`

Expected: FAIL because `homeDashboard.ts` does not exist.

- [ ] **Step 4: Implement the minimal calculations**

Implement thresholded audience summaries and percentile-based repeat scoring with weights `0.5` reach, `0.3` inverse skip rate, and `0.2` completed guides. Return at most three candidates with the strongest metric as the explanation.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm test -- src/lib/homeDashboard.test.ts`

Expected: all dashboard calculation tests pass.

### Task 2: Visual audience-growth panel

**Files:**
- Create: `web/src/components/home/AudienceGrowthPanel.tsx`
- Create: `web/src/components/home/DashboardSparkline.tsx`

**Interfaces:**
- Consumes: `AudienceGrowthSummary`, `GeoWindowPoint[]`, loading/error flags, and retry callback.
- Produces: responsive audience panel and reusable accessible sparkline.

- [ ] **Step 1: Add a failing server-render test for key semantics**

Extend `homeDashboard.test.ts` with a markup-level assertion that the formatter produces “+5.0 percentage points” and status label “Growing.”

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/lib/homeDashboard.test.ts`

Expected: FAIL because the presentation formatter is missing.

- [ ] **Step 3: Implement the formatter and visual panel**

Build a panel containing the large headline percentage, status badge, delta, trend sparkline, and reached/engaged 14-day versus 90-day comparison bars. Include empty, loading, and retry states.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- src/lib/homeDashboard.test.ts`

Expected: all tests pass.

### Task 3: Visual repeat-reels panel

**Files:**
- Create: `web/src/components/home/RepeatReelsPanel.tsx`

**Interfaces:**
- Consumes: `RepeatCandidate[]`, loading/error flags, and retry callback.
- Produces: thumbnail-led ranked reel recommendations with measured metrics and Instagram links.

- [ ] **Step 1: Add failing reason-selection tests**

Add fixtures proving that high reach, low skip rate, and guide deliveries each generate the correct plain-language reason when they are the strongest normalized signal.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/lib/homeDashboard.test.ts`

Expected: FAIL for at least one unimplemented reason selection.

- [ ] **Step 3: Implement the reel panel**

Render three ranked cards with thumbnail fallback, caption, reach, skip rate, guides delivered, contextual US-fit badge, strongest-signal reason, and accessible external Instagram link. State that ranking uses performance while US-fit is context.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- src/lib/homeDashboard.test.ts`

Expected: all tests pass.

### Task 4: Home-page orchestration and secondary health strip

**Files:**
- Modify: `web/src/pages/Home.tsx`
- Modify: `web/src/lib/types.ts`

**Interfaces:**
- Consumes: `/insights/geo-window-trend`, `/insights/leaderboard`, and `/stats`.
- Produces: final visual home dashboard.

- [ ] **Step 1: Replace home queries and hierarchy**

Query the three existing endpoints independently, derive summaries with the tested helpers, and render the audience and repeat panels in an equal-width responsive grid.

- [ ] **Step 2: Add the secondary automation-health strip**

Show sequences completed today, people awaiting a reply, and gate retries queued in one compact row. Remove the recent-recipients list and raw error-payload disclosure from the home screen.

- [ ] **Step 3: Run focused tests**

Run: `npm test -- src/lib/homeDashboard.test.ts`

Expected: all tests pass.

- [ ] **Step 4: Run production verification**

Run: `npm run build`

Expected: TypeScript and Vite production build succeed.

Run: `npm run lint`

Expected: no new errors in home-dashboard files; document any unrelated pre-existing failures.

### Task 5: Final review

**Files:**
- Review: all files above

**Interfaces:**
- Consumes: completed dashboard.
- Produces: verified implementation handoff.

- [ ] **Step 1: Check responsive and empty/error states by inspection**

Confirm the two panels stack on small screens, charts contain accessible labels, external links use `rel="noreferrer"`, and no metric invents missing values.

- [ ] **Step 2: Run the full verification set**

Run: `npm test && npm run build && npm run lint`

Expected: tests and build pass; lint status is reported exactly.

- [ ] **Step 3: Review repository diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors and only planned files are changed.
