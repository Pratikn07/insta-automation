# Maison Interface and Release QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the paper-theme migration, preserve navigation meaning across desktop/mobile/legacy URLs, restore route-correct browser coverage, and enforce one evidence-backed production release gate.

**Architecture:** Shared chart and route metadata replace dark-theme literals and duplicated navigation titles. Conversations lenses become URL state, the E2E harness mounts the new recovery destination at its real route, and a dated QA record collects complete verification without claiming inherited infrastructure risks are resolved.

**Tech Stack:** TypeScript, React 19, React Router 7, Tailwind CSS 4, SVG, Vitest, Testing Library, Playwright, Vite.

**Spec:** [Maison Editorial production-readiness design](../specs/2026-08-16-maison-editorial-production-readiness-design.md), §4, rollout, and the shared release gate.

## Global Constraints

- The background remains light paper. This plan does not reintroduce a dark application shell.
- Meaningful chart marks must reach at least 3:1 against both `#F7F5EF` ground and `#FFFEF9` raised paper after opacity is composited.
- Provisional and multi-day marks use shape/dash as well as color.
- Home stays above Measure / Publish / Audience / System.
- Route path, rail label, mobile title, and group membership have one source of truth.
- `/users` preserves the People destination as `/conversations?lens=people`.
- DM Recovery and Historical Recovery remain separate routes and are never peer tabs.
- Browser tests run in both desktop and 390×844 mobile projects.
- A test frozen clock must not freeze auth/application hydration.
- No deploy, production worker activation, or database write is performed by automated QA commands in this plan.
- Inherited Express and dependency findings are recorded as an accepted baseline with a linked hardening plan; they are not called fixed or clean.

## Plan-Set Dependencies

- Run this plan after measurement truth, guide delivery through its
  pre-production pause, and recovery/client truth are implemented.
- Task 5 first produces the combined `READY FOR CONTROLLED ROLLOUT` or `NO-GO`
  record without making production mutations.
- Only an explicit owner authorization may resume guide-delivery Task 12 for the
  allowlisted Meta check. Attach that evidence here afterward and update status
  to `CONTROLLED PATH STABLE` when justified.
- Legacy-sender removal remains the later guide-delivery Task 13 gate.

---

## Planned File Structure

### Create

- `web/src/lib/chartPalette.ts` — semantic region, country, mean, and provisional chart tokens.
- `web/src/lib/chartPalette.test.ts` — contrast and opacity-composition contracts.
- `web/src/lib/navigation.ts` — Home, grouped destinations, route labels, and title matcher.
- `web/src/lib/navigation.test.ts` — complete route/title/group coverage.
- `web/src/AppRoutes.tsx` — authenticated route tree separated from auth/browser setup.
- `web/src/AppRoutes.test.tsx` — legacy redirect and route-destination tests.
- `docs/qa/2026-08-16-maison-editorial-production-readiness-qa.md` — exact release-gate evidence.
- `docs/qa/artifacts/2026-08-16-maison-editorial/` — fixture-only desktop
  and mobile screenshots referenced by the QA record.

### Modify

- `DESIGN.md` — chart tokens, neutral Today’s Read, truthful moss rules.
- `PRODUCT.md` — current route inventory and People redirect.
- `web/src/index.css` — chart tokens and stale moss comments.
- `web/index.html` — neutral Today’s Read comment.
- `web/src/lib/followerCountry.ts`, `followerCountry.test.ts` — paper palette.
- `web/src/components/home/DailyAddsChart.tsx` — semantic fills and visible overlays.
- `web/src/components/home/HomePanels.test.tsx` — rendered SVG token assertions.
- `web/src/components/layout/Sidebar.tsx` — consume shared navigation metadata.
- `web/src/components/layout/AppShell.tsx`, `AppShell.test.tsx` — consume complete mobile titles.
- `web/src/App.tsx` — delegate authenticated route tree.
- `web/src/pages/Conversations.tsx`, `Conversations.test.tsx` — URL-addressable lenses.
- `web/e2e/main.tsx` — real route harness for DM Recovery.
- `web/e2e/recovery-reminders.spec.ts` — direct route journeys and updated semantics.
- `web/e2e/ai-workflows.spec.ts` — deterministic countdown clock.

---

### Task 1: Replace dark-surface chart literals with paper-theme semantic tokens

**Files:**

- Create: `web/src/lib/chartPalette.ts`
- Create: `web/src/lib/chartPalette.test.ts`
- Modify: `web/src/index.css`
- Modify: `web/src/lib/followerCountry.ts`
- Modify: `web/src/lib/followerCountry.test.ts`
- Modify: `web/src/components/home/DailyAddsChart.tsx`
- Modify: `web/src/components/home/HomePanels.test.tsx`
- Modify: `DESIGN.md`

**Interfaces:**

- Produces: `REGION_CHART_COLORS`, `COUNTRY_CHART_COLORS`, `CHART_OTHER`,
  `CHART_MEAN`, and `CHART_PROVISIONAL`.
- Consumed by: region and country modes of `DailyAddsChart`.

- [ ] **Step 1: Write contrast utilities inside the test**

In `chartPalette.test.ts`, implement test-only WCAG relative luminance and alpha
composition helpers:

```ts
function channel(value: number) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function contrast(foreground: string, background: string): number {
  const fg = luminance(hexRgb(foreground));
  const bg = luminance(hexRgb(background));
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}
```

The production module exports opaque hex values and
`CHART_SEMANTIC_MARK_OPACITY = 1`. The test composites every meaningful mark at
that exported opacity. Ancillary grid/hit-target opacity is outside this array;
bar segments, mean, and provisional outlines may not inherit a dimmed ancestor.

- [ ] **Step 2: Add failing palette and rendered-SVG assertions**

```ts
it.each([GROUND, RAISED])("gives every primary chart mark 3:1 on %s", (paper) => {
  for (const color of Object.values({ ...REGION_CHART_COLORS, ...COUNTRY_CHART_COLORS })) {
    expect(contrast(color, paper)).toBeGreaterThanOrEqual(3);
  }
  expect(contrast(CHART_MEAN, paper)).toBeGreaterThanOrEqual(3);
  expect(contrast(CHART_PROVISIONAL, paper)).toBeGreaterThanOrEqual(3);
  expect(CHART_SEMANTIC_MARK_OPACITY).toBe(1);
});
```

In `HomePanels.test.tsx`, render the chart and assert the mean polyline and
provisional outline do not contain `255 255 255`, `white`, or a white hex value.
Assert the provisional outline has `strokeDasharray`. Give semantic bar groups
a test ID/data attribute and assert neither they nor an ancestor applies group
opacity below 1.

- [ ] **Step 3: Run the tests and verify current colors fail**

```bash
npm --prefix web test -- src/lib/chartPalette.test.ts src/components/home/HomePanels.test.tsx
```

Expected: module absent; current region colors measure below 3:1 and the mean/
provisional strokes are white.

- [ ] **Step 4: Add the semantic palette**

Use these approved paper-safe values:

```ts
export const REGION_CHART_COLORS = {
  us: "#2C4A3B",
  southAsian: "#8C5A1F",
  anglosphere: "#2A4A6B",
  other: "#66665F",
} as const;

export const COUNTRY_CHART_COLORS = [
  "#2C4A3B", "#8C5A1F", "#2A4A6B", "#8C3A2B",
  "#5A4E7C", "#3F6B22", "#1E5F66", "#8C3B63",
] as const;
export const CHART_OTHER = "#66665F";
export const CHART_MEAN = "#171812";
export const CHART_PROVISIONAL = "#66665F";
export const CHART_SEMANTIC_MARK_OPACITY = 1;
```

Mirror these as named `--color-chart-*` values in `index.css` for devtools and
future CSS consumers. Add the same tokens to DESIGN frontmatter and chart rules.

- [ ] **Step 5: Migrate both chart modes**

Import region tokens into `DailyAddsChart` and country tokens into
`followerCountry`. Replace the white mean line with `CHART_MEAN`; replace the
white provisional/multi-day outline with `CHART_PROVISIONAL` and retain a visible
dash. Do not reduce a whole provisional group below an opacity that preserves
the 3:1 mark. For this palette, current 0.45/0.55/0.70 group opacity fails that
floor, so remove semantic group fading entirely. Show provisional state with
dash/outline and active selection with an additional outline/background hit
target rather than fading other data.

- [ ] **Step 6: Correct stale design comments**

Update `followerCountry.ts` to say the palette is validated against both paper
surfaces. In `DESIGN.md`, remove the contradiction that Today’s Read sits on
moss-soft and the instruction to keep moss for “working and nothing else.” The
Neutral Finding Rule remains authoritative; moss is an accent for focus and
affirmative actions, not a finding surface or data series.

- [ ] **Step 7: Verify palette and visual component tests**

```bash
npm --prefix web test -- src/lib/chartPalette.test.ts src/lib/followerCountry.test.ts src/components/home/HomePanels.test.tsx
npm --prefix web run build
```

Expected: all pass.

- [ ] **Step 8: Commit the chart slice**

```bash
git add DESIGN.md web/src/index.css web/src/lib/chartPalette.ts web/src/lib/chartPalette.test.ts web/src/lib/followerCountry.ts web/src/lib/followerCountry.test.ts web/src/components/home/DailyAddsChart.tsx web/src/components/home/HomePanels.test.tsx
git commit -m "fix: move follower charts onto the paper palette"
```

---

### Task 2: Centralize navigation metadata and complete mobile titles

**Files:**

- Create: `web/src/lib/navigation.ts`
- Create: `web/src/lib/navigation.test.ts`
- Modify: `web/src/components/layout/Sidebar.tsx`
- Modify: `web/src/components/layout/AppShell.tsx`
- Modify: `web/src/components/layout/AppShell.test.tsx`

**Interfaces:**

- Produces: `HOME_DESTINATION`, `NAV_GROUPS`, `NAV_DESTINATIONS`, and
  `titleForPath(pathname)`.
- Consumed by: Sidebar, AppShell, route tests, and documentation checks.

- [ ] **Step 1: Write the complete route contract**

```ts
const EXPECTED = [
  ["/", "Home", null],
  ["/insights", "Insights", "Measure"],
  ["/funnels", "Funnels", "Measure"],
  ["/content", "Content", "Publish"],
  ["/keywords", "Keywords", "Publish"],
  ["/sequences", "Sequences", "Publish"],
  ["/conversations", "Conversations", "Audience"],
  ["/dm-recovery", "DM recovery", "Audience"],
  ["/historical-recovery", "Historical recovery", "Audience"],
  ["/activity", "Activity", "System"],
  ["/assistant", "Assistant", "System"],
] as const;

it("contains every approved destination once", () => {
  expect(NAV_DESTINATIONS.map(({ path, label, group }) => [path, label, group])).toEqual(EXPECTED);
});

it.each(EXPECTED)("gives %s the mobile title %s", (path, title) => {
  expect(titleForPath(path)).toBe(title);
});

it("matches sequence editor detail routes", () => {
  expect(titleForPath("/sequences/11111111-1111-4111-8111-111111111111")).toBe("Sequence editor");
});
```

Assert unknown paths return `Tiny Soho` and the two recovery routes are adjacent
but distinct.

- [ ] **Step 2: Run the test and verify the module is absent**

```bash
npm --prefix web test -- src/lib/navigation.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement metadata without JSX**

```ts
export interface NavDestination {
  path: string;
  label: string;
  mobileTitle: string;
  group: "Measure" | "Publish" | "Audience" | "System" | null;
}
```

Define Home separately above groups, export grouped and flattened arrays, and
implement the dynamic sequence matcher. Do not include legacy aliases (`/users`,
`/reels`) as destinations.

- [ ] **Step 4: Make Sidebar and AppShell consume the shared metadata**

Delete Sidebar’s local `HOME`/`groups` arrays and AppShell’s local `titles`
record. Preserve existing visual order and exact labels. Keep the safety comments
about recovery grouping in PRODUCT/DESIGN, not as duplicated data definitions.

- [ ] **Step 5: Extend AppShell tests**

Keep `mobileNavigationOpen` tests and add `titleForPath` assertions for Insights,
Funnels, Historical Recovery, Activity, and Assistant—the five routes currently
falling back to Tiny Soho.

- [ ] **Step 6: Run focused tests, lint, and build**

```bash
npm --prefix web test -- src/lib/navigation.test.ts src/components/layout/AppShell.test.tsx
npm --prefix web run lint
npm --prefix web run build
```

Expected: all pass.

- [ ] **Step 7: Commit shared navigation metadata**

```bash
git add web/src/lib/navigation.ts web/src/lib/navigation.test.ts web/src/components/layout/Sidebar.tsx web/src/components/layout/AppShell.tsx web/src/components/layout/AppShell.test.tsx
git commit -m "fix: share rail and mobile route metadata"
```

---

### Task 3: Preserve People meaning in URLs and legacy redirects

**Files:**

- Create: `web/src/AppRoutes.tsx`
- Create: `web/src/AppRoutes.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/pages/Conversations.tsx`
- Modify: `web/src/pages/Conversations.test.tsx`

**Interfaces:**

- Produces: authenticated `AppRoutes`, URL `lens` contract, and semantic
  `/users` redirect.
- Consumed by: production App and Task 4’s route harness.

- [ ] **Step 1: Write Conversations URL tests**

Change the test renderer to accept an initial entry and a location probe:

```tsx
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}
```

Add:

```ts
it("opens People directly from the lens URL", async () => {
  renderPage("/conversations?lens=people");
  expect(await screen.findByPlaceholderText("Search by @username or name…")).toBeInTheDocument();
});

it("writes lens changes to the URL", async () => {
  renderPage("/conversations");
  await userEvent.click(screen.getByRole("button", { name: "People" }));
  expect(screen.getByTestId("location")).toHaveTextContent("/conversations?lens=people");
});

it("falls back safely for an unknown lens", () => {
  renderPage("/conversations?lens=unknown");
  expect(screen.getByRole("button", { name: "Needs reply" })).toHaveAttribute("aria-pressed", "true");
});
```

Add `aria-pressed` to lens buttons as part of implementation.

- [ ] **Step 2: Write a route-level legacy redirect test**

Mock page modules except Conversations, render `AppRoutes` in
`MemoryRouter initialEntries={["/users"]}`, and assert the location becomes
`/conversations?lens=people`. Add a `/reels` → `/content` preservation test.

- [ ] **Step 3: Run tests and verify `/users` currently loses the lens**

```bash
npm --prefix web test -- src/pages/Conversations.test.tsx src/AppRoutes.test.tsx
```

Expected: route module absent and current redirect ends at bare `/conversations`.

- [ ] **Step 4: Move authenticated routes into `AppRoutes`**

`AppRoutes.tsx` owns the existing `<Routes>` tree under `AppShell`. Change only
the legacy route:

```tsx
<Route path="users" element={<Navigate to="/conversations?lens=people" replace />} />
```

`App.tsx` retains auth, loader, BrowserRouter, and logged-out Login routing; it
renders `<AppRoutes />` for an authenticated session.

- [ ] **Step 5: Make Conversations lens URL-driven**

Use `useSearchParams`. Validate against:

```ts
const LENSES = new Set<Lens>(["needs_reply", "dms", "people", "journeys"]);
```

Default to `needs_reply`. Lens buttons set `lens` while preserving unrelated
search parameters; journey filter buttons set `lens=journeys` while preserving
their existing local filter behavior. Remove the independent lens `useState`,
so Back/Forward and copied URLs restore the visible lens.

- [ ] **Step 6: Run route and page tests**

```bash
npm --prefix web test -- src/pages/Conversations.test.tsx src/AppRoutes.test.tsx src/lib/navigation.test.ts
npm --prefix web run build
```

Expected: all pass.

- [ ] **Step 7: Commit semantic routing**

```bash
git add web/src/App.tsx web/src/AppRoutes.tsx web/src/AppRoutes.test.tsx web/src/pages/Conversations.tsx web/src/pages/Conversations.test.tsx
git commit -m "fix: preserve people as a conversations destination"
```

---

### Task 4: Rewire Playwright to the DM Recovery route and stabilize clocks

**Files:**

- Modify: `web/e2e/main.tsx`
- Modify: `web/e2e/recovery-reminders.spec.ts`
- Modify: `web/e2e/ai-workflows.spec.ts`

**Interfaces:**

- Consumes: `DmRecovery`, Conversations URL contract, and truthful recovery copy.
- Produces: deterministic desktop/mobile browser evidence.

- [ ] **Step 1: Make the recovery harness fail at the old Conversations assumption**

Replace `openRecovery` with:

```ts
async function openRecovery(page: Page, scenario: string) {
  await page.goto(`/e2e/index.html?scenario=${scenario}`);
  await expect(page.getByRole("heading", { name: "DM recovery" })).toBeVisible();
}
```

Delete the browser test that navigates from recovery back through legacy
Conversations lenses; route isolation replaces that obsolete behavior. Add a
test that the page contains automatic/public/original-comment copy and no manual
release claim.

- [ ] **Step 2: Run recovery E2E and verify the current harness fails**

```bash
npm --prefix web run test:e2e -- recovery-reminders.spec.ts --project=desktop
```

Expected: recovery scenarios still mount Conversations, so the DM Recovery
heading is absent.

- [ ] **Step 3: Mount recovery scenarios at the real route**

In `e2e/main.tsx`, import `DmRecovery` and React Router `Routes`/`Route`. Reuse
the harness's single outer `MemoryRouter`—do not nest a second router. Compute
its `initialEntries` before render (`/dm-recovery` for recovery scenarios), and
have the recovery branch render a real `/dm-recovery` route. Do not render
Conversations and do not recreate the removed pill.

Keep HTTP boundary stubs and stateful cancellation/review fixtures unchanged.
Update Ready selectors to Due where the user-facing label changed; keep API
query `view=ready` assertions where applicable.

- [ ] **Step 4: Remove the hydration-sensitive pause**

Change the scheduled countdown journey to install its final initial time before
navigation:

```ts
await page.clock.install({ time: new Date("2026-08-05T21:59:30.000Z") });
await page.goto("/e2e/index.html?scenario=follow-up-scheduled");
await expect(page.getByText("Follow-up scheduled")).toBeVisible();
await expect(page.getByText("Ready in 30s")).toBeVisible();
await page.clock.fastForward(30_000);
await expect(page.getByText("Ready now")).toBeVisible();
```

Do not call `pauseAt` after navigation; it can freeze hydration/auth work at a
message boundary.

- [ ] **Step 5: Run focused journeys in both projects repeatedly**

```bash
npm --prefix web run test:e2e -- recovery-reminders.spec.ts ai-workflows.spec.ts --project=desktop
npm --prefix web run test:e2e -- recovery-reminders.spec.ts ai-workflows.spec.ts --project=mobile
for run in 1 2 3; do npm --prefix web run test:e2e -- ai-workflows.spec.ts --grep "scheduled countdown"; done
```

Expected: all runs pass; no “Loading conversation…” stall.

- [ ] **Step 6: Run complete Playwright**

```bash
npm --prefix web run test:e2e
```

Expected: zero failures in desktop and mobile.

- [ ] **Step 7: Commit browser migration**

```bash
git add web/e2e/main.tsx web/e2e/recovery-reminders.spec.ts web/e2e/ai-workflows.spec.ts
git commit -m "test: move recovery journeys to their real route"
```

---

### Task 5: Align records and produce the production-readiness QA report

**Files:**

- Create: `docs/qa/2026-08-16-maison-editorial-production-readiness-qa.md`
- Modify: `PRODUCT.md`
- Modify: `DESIGN.md`
- Modify: `web/index.html`
- Modify: `web/src/index.css`

- [ ] **Step 1: Correct route and design authority**

In `PRODUCT.md`:

- replace the stale “12 routes” inventory with eleven total destinations: Home
  plus ten grouped routes;
- remove `/users` as a destination and record its People redirect;
- add `/dm-recovery` and automatic public-comment behavior;
- preserve Measure / Publish / Audience / System and Home above groups.

In `DESIGN.md`, `web/index.html`, and `index.css`:

- make the Neutral Finding Rule and neutral Today’s Read surface consistent;
- remove moss-soft Today’s Read references;
- describe the new chart tokens and 3:1 mark floor;
- retain moss for focus/affirmative action, not as a data series.

- [ ] **Step 2: Create the QA report structure before running commands**

The report contains:

```markdown
# Maison Editorial Production Readiness QA — 2026-08-16

## Commit Under Test
## Environment and Safety Controls
## Measurement Truth
## Guide Delivery Integrity
## Recovery and Client Operations
## Interface and Navigation
## Automated Verification
## Controlled Rollout Evidence
## Inherited Risk Baseline
## Final Status
```

Every section records command, timestamp, exit code, counts, and a link to the
implementing commit/test. Do not prefill PASS.

- [ ] **Step 3: Run static consistency scans**

```bash
rg -n "moss tint|moss-soft.*read|outbound DM|nothing.*sends|/users.*destination|Console surfaces \(12 routes\)" PRODUCT.md DESIGN.md web/index.html web/src
rg -n "rgb\(255 255 255|white|#fff" web/src/components/home/DailyAddsChart.tsx
git diff --check
```

Expected: no stale claim or white semantic chart stroke remains.

- [ ] **Step 4: Run the complete automated matrix from a clean process**

```bash
npm test
npm run build
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
npm --prefix web run test:e2e
npm --prefix codex-runtime test
npm --prefix codex-runtime run build
```

Record exact pass/fail/skip counts. A partial suite cannot be summarized as “all
tests pass.”

- [ ] **Step 5: Run database contracts from the guide-delivery plan**

With `MIGRATION_TEST_DATABASE_URL` pointing only to disposable PostgreSQL:

```bash
npm test -- src/services/guideDeliveryMigrationContract.test.ts src/services/guideDeliveryRepositoryContract.test.ts
```

Expected: both execute rather than skip and pass. Never point this variable at
the production Supabase database.

- [ ] **Step 6: Run the active-guide audit as a separate read-only gate**

```bash
npm run audit:guide-message-lengths
```

Record exit code and ID/length-only output. Exit `1` is a blocker requiring
author correction; QA does not modify guide prose.

- [ ] **Step 7: Record—not conceal—the inherited baseline**

```bash
npm audit --omit=dev
npm --prefix web audit --omit=dev
npm --prefix codex-runtime audit --omit=dev
npm ls express
```

Record advisories and Express version with a link to the separate hardening
plan. This release adds no new advisory relative to its base commit. An inherited
advisory may be accepted only by an explicit release decision; do not change the
QA wording to “clean.”

- [ ] **Step 8: Perform manual visual QA without production mutations**

Using deterministic fixture data, capture desktop and mobile screenshots for
Home, the follower chart, Conversations People, DM Recovery, Historical
Recovery, Sequence Editor, Insights, and Funnels. Do not boot a local backend
against the production database for this step: `WORKERS_ENABLED=false` does not
make startup read-only because stale-draft reconciliation and token seeding can
still write. If production GET responses must be inspected, use an already
running deployed API in a separate read-only diagnostic session and do not
connect the interactive console to it. Verify:

- chart marks/mean/provisional outline are visible on paper;
- no dark shell returns;
- mobile title matches destination;
- no loading/error surface reads as empty or clear;
- DM Recovery names the automatic public action;
- focus, touch targets, and reduced motion remain usable.

Save fixture-only screenshots under
`docs/qa/artifacts/2026-08-16-maison-editorial/{desktop,mobile}/` with route-based
filenames, and link each file from the QA report. Do not place production user
content in these artifacts.

Do not cancel, approve, edit, create, or send through the production-backed
console during visual QA.

- [ ] **Step 9: Apply the staged status rule**

Use exactly one status:

- `NO-GO` when an automated/database/audit/visual gate fails;
- `READY FOR CONTROLLED ROLLOUT` when every pre-production gate passes but the
  owner has not yet authorized or completed the allowlisted real-Meta check;
- `CONTROLLED PATH STABLE` only after the guide plan's authorized cohort evidence
  is attached and has no unexplained duplicate, completion mismatch, or
  unresolved uncertain outcome.

Do not add `LEGACY REMOVAL AUTHORIZED`; that separate phrase requires the named
owner decision defined by guide-delivery Task 13.

- [ ] **Step 10: Commit records and QA evidence**

```bash
git add PRODUCT.md DESIGN.md web/index.html web/src/index.css docs/qa/2026-08-16-maison-editorial-production-readiness-qa.md docs/qa/artifacts/2026-08-16-maison-editorial
git commit -m "docs: record maison production readiness evidence"
```

---

## Plan Verification

- [ ] Every meaningful SVG chart mark reaches 3:1 on both paper surfaces.
- [ ] Sidebar and mobile header consume the same destination metadata.
- [ ] `/users` resolves to `/conversations?lens=people`.
- [ ] Conversations lens state survives reload, copy/paste, Back, and Forward.
- [ ] Recovery Playwright journeys mount `DmRecovery` and pass desktop/mobile.
- [ ] Scheduled countdown passes three repeated runs without `pauseAt` after navigation.
- [ ] Product, design, HTML comments, CSS tokens, and code agree.
- [ ] Complete backend, frontend, lint, build, database-contract, and Playwright evidence is recorded.
- [ ] Inherited advisories/Express risk are documented, not misreported as fixed.
- [ ] No production mutation occurs during QA.
