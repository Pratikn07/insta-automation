# Dashboard Analytics Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Native execution is the default; no subagents are needed for this bounded UI change.

**Goal:** Remove duplicated Instagram audience and content-performance reporting from the dashboard while preserving automation operations and their evidence.

**Architecture:** Change the React presentation layer and its request dependencies. Home will depend on system stats and the guide-follow funnel, with no follower-data dependency. Insights will retain unique AI analysis, automation conversion counts and content-experiment results, while removing general audience/performance panels. Backend APIs, collectors and stored data remain intact.

**Tech Stack:** React, TypeScript, TanStack Query, React Router, Vitest/Testing Library and Playwright.

**Spec:** The user's Oct 4 request and preceding source audit, made concrete in the scope and acceptance ledger below. This document is a proposal; creating it does not authorize implementation, publishing or collector retirement.

**Source baseline:** Local `main`, commit `4b7280d`, inspected Oct 4, 2026. Recheck the checkout and relevant source before execution. Production state and the external monitoring tool's feature coverage have not been verified.

## Scope

### Remove in this change

| Surface | Exact removal |
|---|---|
| Home | US follower weekly KPI, total-follower KPI, milestone meter and follower sparklines |
| Home | Growth-based Today's read, its growth qualification/evidence toggle, follower snapshot freshness label |
| Home | Follower-flow chart, date/country controls, country/region breakdown, churn totals, spikes and feed-follow attribution drawer |
| Insights header | Account-wide reached/engaged/follower geography summary |
| Insights leaderboard | Reach and capture-rate badges; repeat-reel recommendation panel based on reach/skip rate |
| Reel detail | Entire How it performed section: reach, views, skip rate, likes, saves and shares |
| Insights Recipe | Median reach statistics and numerical US-fit/reach correlation; retain the qualitative warning that US-fit does not predict reach |
| Insights content Experiments tab | General recent-versus-baseline audience panel, Reached-US% trend chart and capture-leader panel |

### Preserve in this change

- Home: Best next move, What needs attention, System pulse and the funnel reply-rate KPI.
- All existing failure, uncertain-send, unattached-keyword and awaiting-reply attention items, in their current priority order.
- Funnels: reply rate, gate conversion, delivery, drop-offs, retention and guide-access/cover health.
- Insights: US-fit/content-profile analysis, re-analysis, the content-style Recipe, inferred origin of keyword commenters, per-reel keyword/gate/guide counts, content-experiment creation/results, next-test recommendations and learned patterns.
- A content experiment's own baseline/current/delta and attribution qualifications remain: these are experiment results, an explicit exception to removal of general geography reporting.
- The separate `/experiments` automation-experiment page, Switches, Assistant, Activity, Content, Keywords, Guides, Conversations and both recovery areas.
- All API routes, response types, tables, historical rows, migrations, timers, token refresh, collectors and Gemini settings.
- `/insights` remains a working destination. Its sidebar link, bookmarks and Assistant links remain valid; no route redirect or runtime-contract change is needed.

### Deferred, separate decision

Retiring the entire Insights page, AI analysis, content experiments or their collectors requires a separate scope decision. Removing the UI here will reduce its queries, but will not stop background Meta/Gemini work or reduce stored history. Do not claim those savings.

The shared snapshot worker also refreshes reel metadata; feed collection refreshes feed-post metadata. Historical recovery reads those tables for source-post links. Do not disable either worker wholesale or delete those tables during this change.

## Global Constraints

- Before the first code edit, invoke `$unlazy` and create an execution acceptance ledger from the gates below.
- Preserve existing user changes, including untracked `graphify-out` artifacts. No broad staging or cleanup.
- Use a `codex/` branch. Reuse a suitable checkout; isolate only if current work requires it.
- No backend behavior, API contract, database, schema, environment-variable, collector or recovery-policy changes.
- Preserve query cancellation, retry behavior, unknown/error states and minimum-sample rules on retained surfaces.
- Keep existing visual tokens, responsive behavior and accessibility; do not redesign navigation or unrelated pages.
- Product copy describes automation evidence. Do not invent a replacement growth narrative or show a false Updated timestamp.
- No automatic deployment or external communication is included in this planning request.

## Acceptance Ledger

| Gate | Required evidence |
|---|---|
| G1: Home no longer reports audience growth | No growth tiles, chart, attribution drawer or growth commentary; Home makes neither follower-daily-adds nor feed-follow-attribution requests |
| G2: Home operational readiness works independently | Ready only after stats and funnel succeed; errors/loading remain honest; verified alerts persist when the other source fails |
| G3: Reply-rate evidence survives | Same API-derived label/counts/rate, minimum-sample suppression and coherent loading/error/zero behavior |
| G4: Insights duplicate reporting removed | All removal rows above absent in every tab and drawer; removed geo/trend endpoints are not requested |
| G5: Unique Insights features survive | AI detail, gate/guide counts, Recipe, commenter-origin panel and content-experiment create/retry/update/results work |
| G6: Other workflows preserved | Funnels and operational pages/routes still work; no backend, database, runtime or collector diff |
| G7: Release is reviewable and reversible | Changed-file allowlist reviewed; focused tests/build and desktop/mobile fixture checks pass; rollback is a UI-only revert |

## Review Focus

1. Stats or funnel missing/failed: no all-clear claim, retained verified alerts visible, retry targets only the failed source. Task 1 tests this.
2. Tiny or zero reply denominators: counts-only below threshold, no fabricated percentage or meter; missing funnel remains unavailable. Task 1 tests this.
3. Stale/failed follower service: no Home request, dependency, timestamp or blank growth placeholder. Task 1 tests this.
4. Previously populated performance/geo data: removed panels must stay absent despite full payloads; AI and automation evidence remain visible. Task 2 tests this.
5. Content-experiment uncertain create outcome and navigation on mobile: retry reuses operation ID; tabs/drawers remain accessible without layout overflow. Tasks 2 and 3 test this.

## File Map

| File | Planned responsibility |
|---|---|
| `web/src/pages/Home.tsx` | Remove follower reads/rendering; retain operational queries, actions, pulse and reply KPI |
| `web/src/lib/homeAttention.ts` | Remove flow from required-source contract; preserve item derivation/order |
| `web/src/components/home/AutomationKpiRow.tsx` (new) | Present only the existing funnel reply KPI without follower props |
| `web/src/pages/Insights.tsx` | Remove duplicate reporting/rendering/queries; preserve unique features and `/insights` |
| `web/src/pages/Home.test.tsx`, `web/src/lib/homeAttention.test.ts` | Pin new readiness contract and removed requests |
| `web/src/components/home/AutomationKpiRow.test.tsx` (new) | Pin retained reply KPI and sample/error behavior |
| `web/src/pages/Insights.test.tsx` | Pin removal across tabs/drawer and retained operations |
| `web/e2e/visual-qa.spec.ts` | Replace obsolete Home chart requirement; save new screenshots outside historical artifact folders |
| `web/e2e/dashboard-analytics-removal.spec.ts` (new) | Focused desktop/mobile fixture checks for removal and retained navigation |
| `web/e2e/main.tsx` (conditional) | Only add synthetic fixtures needed for these checks; do not rewrite unrelated scenarios |
| `PRODUCT.md` | Update only current Home/reporting expectations that conflict with this approved removal; preserve historical decisions and other product roles |

Keep unused follower components/utilities and their tests initially; deleting them does not improve the requested UI outcome. Remove unused imports and local helper functions in changed files when they are solely for removed panels. Do not prune shared helpers, types or endpoints based on this change.

## Task 1: Make Home an operational dashboard

**Interfaces:** `HomeSources` becomes `{ stats: SourceState<Stats>; funnel: SourceState<GuideFollowResult> }`; `HomeSource` becomes `"stats" | "funnel"`. New `AutomationKpiRow` consumes `{ funnel: GuideFollowResult | undefined; isLoading: boolean; isError: boolean; onRetry: () => void }`. All API response contracts remain unchanged.

- [x] Update existing Home and homeAttention tests first. Remove follower-only fixtures/assertions from Home tests, replace the three-source readiness cases with two-source cases, and keep all operational attention-order tests.
- [x] Add these assertions to the existing suites, using `clearStats`, `clearFunnel`, `success`, `failed` and `renderHome` fixtures already defined there:

```tsx
// homeAttention.test.ts: clear requires exactly the two operational sources.
expect(deriveHomeAttentionState({
  stats: success(clearStats()), funnel: success(clearFunnel()),
})).toEqual({ status: "ready_clear", items: [] });

const state = deriveHomeAttentionState({
  stats: success({ ...clearStats(), gateQueueExhausted: 3 }),
  funnel: failed(),
});
expect(state.status).toBe("incomplete");
expect(state.items.some(item => item.kind === "failed_gates")).toBe(true);

// Home.test.tsx: successful operational reads require no follower request.
renderHome({
  stats: Promise.resolve(clearStats()),
  funnel: Promise.resolve(clearFunnel()),
});
expect(await screen.findByText(/Nothing is waiting on you today/)).toBeInTheDocument();
expect(api.mock.calls.some(([path]) =>
  String(path).startsWith("/insights/follower-daily-adds") ||
  String(path).startsWith("/insights/feed-follow-attribution")
)).toBe(false);
expect(screen.queryByText("Total followers")).not.toBeInTheDocument();
expect(screen.queryByText("US followers this week")).not.toBeInTheDocument();
```

- [x] Run from `web`: `npm test -- src/pages/Home.test.tsx src/lib/homeAttention.test.ts`; confirm new expectations fail on existing behavior.
- [x] Remove `flow` from `HomeSource`, `HomeSources`, readiness entries and failed-source controls. Leave `deriveAttentionItems` and its priority order unchanged.

```ts
export type HomeSource = "stats" | "funnel";
export interface HomeSources {
  stats: SourceState<Stats>;
  funnel: SourceState<GuideFollowResult>;
}
// In deriveHomeAttentionState:
const entries = [
  ["stats", sources.stats],
  ["funnel", sources.funnel],
] as const;
```

- [x] Extract only the reply-rate calculation/rendering from `FollowerKpiRow` into `AutomationKpiRow`. Reuse `KpiTile` and `KpiMeter`; preserve API headline label, counts and minimum-sample gate. If loading, show the existing skeleton; if failed, show unavailable with retry and no meter; otherwise use the existing KPI formatting. Gate its meter on `headline.rate.pct !== null`, never on counts alone.
- [x] Add component tests with the existing full `GuideFollowResult` fixture shape. Copy the retained reply-only cases from `FollowerKpiRow.test.tsx`; test `{ numerator: 2, denominator: 4, pct: null, belowMinSample: true }`, measured zero, loading and error. Assert the counts-only case shows `2 of 4` and no percentage/meter.
- [x] Remove Home's flow and attribution queries/state, follower components, summary/comparison helpers, growth evidence toggle and follower update label. Place `AutomationKpiRow` and the existing Best next move panel in the current bordered band. Keep What needs attention and System pulse intact. Pass readiness only the two retained queries:

```tsx
const attentionState = deriveHomeAttentionState({
  stats: queryState(statsQ),
  funnel: queryState(funnelQ),
});
<AutomationKpiRow
  funnel={funnelQ.data}
  isLoading={funnelQ.isPending}
  isError={funnelQ.isError}
  onRetry={() => void funnelQ.refetch()}
/>
```

- [x] Keep the funnel query key `['funnels', 'guide-follow', 'default']` and `/stats` query key unchanged so Home/Funnels cache sharing survives.
- [x] Run from `web`: `npm test -- src/pages/Home.test.tsx src/lib/homeAttention.test.ts src/components/home/AutomationKpiRow.test.tsx`. G1–G3 must pass before proceeding.

## Task 2: Remove duplicated Insights reporting

**Interfaces:** `/insights` and all its existing API contracts stay available. Leaderboard rows keep their complete backend shape; the UI ignores removed performance fields. Content-experiment create/update identity and invalidation of `['insights', 'experiments']` remain unchanged.

- [x] Extend `Insights.test.tsx` with full synthetic leaderboard/detail/Recipe payloads. Use populated metrics, not empty envelopes, to prove rendering removal. Test all three tabs and a selected reel drawer. Keep existing experiment operation-ID and uncertain-outcome retry tests.
- [x] Add a route-call assertion using the suite's existing `api` spy after visiting every tab:

```tsx
const removedReads = [
  "/insights/geo", "/insights/us-reach-trend", "/insights/geo-window-trend",
];
renderPage();
const user = userEvent.setup();
await user.click(screen.getByRole("button", { name: "Recipe" }));
await user.click(screen.getByRole("button", { name: "Experiments" }));
expect(api.mock.calls.some(([path]) => removedReads.includes(String(path)))).toBe(false);
expect(screen.queryByText("Audience geography (account-wide)")).not.toBeInTheDocument();
expect(screen.queryByText("Reached-US% over time")).not.toBeInTheDocument();
expect(screen.queryByText("Which reels should I repeat?")).not.toBeInTheDocument();
```

- [x] Run from `web`: `npm test -- src/pages/Insights.test.tsx`; confirm removal expectations fail before implementation.
- [x] Remove `<GeoHeader />`, `<RepeatReelsCard />`, raw reach/capture badges and the entire How it performed detail section. Keep US-fit badges, analysis confidence, re-analysis and What it converted.
- [x] In Recipe remove `Median reach` and the `usFitReachCorr` numerical claim. Keep the existing qualitative copy `US-fit describes who a reel is aimed at — not how far it travels.` and the content-tone qualification, plus style scores and commenter-origin panel.
- [x] In the content Experiments tab remove `trendQ`, `windowQ`, its capture-only `leaderboardQ`, CaptureLeadersCard, RecentAudiencePanel and UsReachChart. Remove invalidations of the two unused trend keys; preserve experiment invalidation and all mutation operation IDs. Keep NextTestCard, LearnedPatterns, NewExperimentForm and ExperimentCard.
- [x] Remove imports/local functions now solely serving those removed panels. Keep `fmt`, `Stat`, shared analysis helpers and complete response types where retained UI needs them. Do not change `growthLab`, server calculations or collector behavior.
- [x] Add retained-feature assertions: selected reel still shows What it converted, keyword comments and guides delivered; Recipe still shows content-style checklist; experiment creation retries reuse the same UUID; experiment updates still target `/insights/experiments/:id`. Retain creation as synthetic tests only—do not create a real experiment during live verification.
- [x] Run from `web`: `npm test -- src/pages/Insights.test.tsx`. G4–G5 must pass.

## Task 3: Integrate, verify and prepare a reversible release

**Interfaces:** Existing production routes and backend contracts are unchanged. Browser verification uses the existing synthetic `/e2e/index.html` harness.

- [x] Update only conflicting Home/reporting expectations in `PRODUCT.md` after scope is approved. Do not rewrite historical strategy or redefine the purpose of other pages.
- [x] Replace the `home and its follower chart` browser case with an operational Home case. Stop requiring the first SVG to be a follower chart. Assert Home, What needs attention and System pulse are present, follower headings are absent and the reply evidence is visible.
- [x] Store new screenshots under `docs/qa/artifacts/2026-10-04-dashboard-analytics-removal/desktop` and `/mobile`; preserve historical screenshots. Update only the affected Home capture target rather than repointing the entire existing visual suite.
- [x] Add `dashboard-analytics-removal.spec.ts` using the existing `home` fixture scenario. Verify no horizontal overflow, Home removal, and navigation into Insights/Funnels. If those routes need fuller fixture payloads, add them narrowly to `web/e2e/main.tsx`.

```ts
await page.goto("/e2e/index.html?scenario=home");
await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
await expect(page.getByText("System pulse", { exact: true })).toBeVisible();
await expect(page.getByText("Total followers", { exact: true })).toHaveCount(0);
await expect(page.getByText("US followers this week", { exact: true })).toHaveCount(0);
expect(await page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth
)).toBe(true);
```

- [x] Run from `web`: `npm test -- src/pages/Home.test.tsx src/lib/homeAttention.test.ts src/components/home/AutomationKpiRow.test.tsx src/pages/Insights.test.tsx src/pages/Funnels.test.tsx src/lib/navigation.test.ts`.
- [x] Run from `web`: `npm run build`. Resolve type/build failures without broad refactoring.
- [x] Run from `web`: `npm run test:e2e -- dashboard-analytics-removal.spec.ts`; then `npm run test:e2e -- visual-qa.spec.ts --grep 'home|unattached'`. The configuration already covers desktop and mobile. Use a free `E2E_PORT` when another checkout's dev server is running.
- [x] Inspect resulting desktop/mobile screenshots and retained tabs/drawer/error states. No overlapping actions, unexplained gaps, growth placeholders or horizontal scrolling.
- [x] Review `git diff --name-only`, `git diff --check` and the complete scoped diff. Anything outside the File Map requires a concrete reason and scope review. In particular verify no `src/`, `prisma/`, `shared/`, `codex-runtime/`, lockfile, env or deployment-config changes.
- [x] Read-only smoke checks: retained navigation, Funnels, Activity/token health, Content setup screens and recovery source-post links. Do not send DMs, change switches, create experiments, refresh collectors or trigger paid analysis just to verify this UI change.
- [x] Reconcile G1–G7 against current evidence. Record local/preview status separately from deployed/externally verified status.
- [x] If implementation is subsequently authorized, produce a reviewable branch/PR containing only these UI/test/docs changes. Deployment remains a later explicit action; follow the repository release instructions when authorized.

## Rollout and Rollback

Implement Tasks 1 and 2 as separately reviewable diffs on one branch; ship after Task 3 passes. A local or preview pass is not production verification. After an authorized deployment, verify the actual deployed revision, signed-in Home and every Insights tab, request behavior and retained operational pages.

Rollback trigger: missing operational alerts, misleading all-clear state, broken reply KPI, lost experiment identity, broken navigation or recovery context. Revert only the scoped UI/test/docs commit(s) and redeploy through the normal release path. Because this change contains no migrations or collector changes, rollback needs no database restore, backfill or worker configuration change.

## Plan Review Record

- Each removal is mapped to Task 1 or Task 2 and a gate.
- Operational preservation, populated-data removal, source failures, small samples, retry identity and responsive behavior have explicit checks.
- No mass deletion, collector retirement or entire Insights-route retirement is bundled into this plan.
- Suggested execution: native, sequential implementation. Home and Insights are small enough to review directly, and a single execution context avoids extra coordination.
- Status: implemented on `codex/dashboard-analytics-removal-ui` in the attached managed worktree. The user subsequently authorized a scoped PR, merge to main and production deployment; release verification is recorded separately.
- Verification: frontend suite 75 files/968 tests passed; build passed; 8 desktop/mobile fixture journeys passed; all 8 execution gates met in `GATES.md`.
- Independent review: no Critical/Important source findings. A screenshot captured mid-animation was corrected with a settled drawer geometry check and the regenerated image was inspected.
- Execution adjustment: current-checkout reuse was replaced with a managed worktree after unrelated concurrent funnel edits appeared. Only task-owned dashboard files were transferred; unrelated edits and the other task's ledger were preserved.
- Production smoke checks remain a release-time action. Only local source and synthetic fixture evidence is claimed here.
