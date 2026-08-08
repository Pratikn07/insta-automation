# Instagram Automation P2 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete QA-18, QA-19, and QA-20 by normalizing recovery copy, making historical and canonical recovery state operable from the API/dashboard, eliminating the web lint baseline, and adding browser-level regression coverage.

**Architecture:** Reuse the existing recovery campaign, candidate, intent, conversation, audit, and media-permalink records; no database migration is required. Add narrow route contracts and focused UI components, keep mutable operator actions idempotent, and use React Query snapshot pagination with a fixed `asOf` value. Keep the active P1 selector/schema work out of every P2 commit.

**Tech Stack:** TypeScript, Express, Zod, Prisma/PostgreSQL, React 19, TanStack React Query, Vitest, Testing Library, ESLint, Vite, and Playwright.

## Global Constraints

- Do not modify `prisma/schema.prisma`, `src/services/historicalRecoverySelector.ts`, `src/services/historicalRecoverySelectorContract.test.ts`, or the active P1 migrations.
- Do not add a Prisma migration; every P2 field and relation already exists.
- Normalize user-visible recovery keywords by trimming and applying JavaScript `toUpperCase()`.
- Take approval and review actors only from `req.adminEmail`; never trust a caller-supplied actor.
- Use verified stored media permalinks only; never build a post URL from `publicReplyId` or `commentId`.
- Default conversation operations to canonical owners plus unreconciled legacy records; expose aliases only in explicit raw-history mode.
- Add no ESLint rule suppression for the nine baseline errors.
- Do not run a live Meta mutation without controlled-account credentials.
- Preserve and avoid staging every unrelated dirty worktree file.

---

### Task 1: Shared recovery keyword normalization

**Files:**
- Create: `src/services/recoveryCopyCore.ts`
- Modify: `src/services/dmRecoveryPolicy.ts:39-51`
- Modify: `src/services/dmRecoveryPolicy.test.ts:10-29`
- Modify: `src/services/historicalRecoveryCopy.ts:34-55`
- Test: `src/services/historicalRecoveryCopy.test.ts:87-98`

**Interfaces:**
- Produces: `normalizeRecoveryKeyword(keyword: string): string`.
- Consumes: prospective `renderRecoveryCopy` and historical `recoveryCopyFor` both call the shared function.
- Compatibility: `historicalRecoveryCopy.ts` continues exporting `normalizeKeywordForCopy` as an alias so existing imports do not break.

- [ ] **Step 1: Add prospective mixed-case regression tests**

Add literal expectations that would fail if prospective copy merely trims the keyword:

```ts
it.each([
  ["no_confirmed_read", "  sleep ", "DM @tinysoho \"SLEEP\"."],
  ["settings_blocked", "Protein", "DM @tinysoho \"PROTEIN\"."],
] as const)("normalizes %s copy to an uppercase keyword", (trigger, keyword, expectedTail) => {
  expect(renderRecoveryCopy(trigger, keyword)).toContain(expectedTail);
});
```

- [ ] **Step 2: Run the copy tests and verify RED**

Run: `npm test -- src/services/dmRecoveryPolicy.test.ts src/services/historicalRecoveryCopy.test.ts`

Expected: the new prospective cases fail because the output contains `sleep` and `Protein`; historical normalization remains green.

- [ ] **Step 3: Add the shared helper and route both renderers through it**

Create:

```ts
export function normalizeRecoveryKeyword(keyword: string): string {
  const normalized = keyword.trim().toUpperCase();
  if (!normalized) {
    throw new Error("invalid recovery keyword: expected a non-empty snapshot");
  }
  return normalized;
}
```

Import it in both copy modules. In `historicalRecoveryCopy.ts`, retain compatibility with:

```ts
import { normalizeRecoveryKeyword } from "./recoveryCopyCore.js";
export { normalizeRecoveryKeyword as normalizeKeywordForCopy } from "./recoveryCopyCore.js";
```

Use `normalizeRecoveryKeyword(keywordSnapshot)` inside `renderRecoveryCopy` and `normalizeRecoveryKeyword(keyword)` inside `recoveryCopyFor`.

- [ ] **Step 4: Run focused and complete service tests**

Run: `npm test -- src/services/dmRecoveryPolicy.test.ts src/services/historicalRecoveryCopy.test.ts`

Expected: both files pass, including empty and whitespace-only input behavior.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/services/recoveryCopyCore.ts src/services/dmRecoveryPolicy.ts src/services/dmRecoveryPolicy.test.ts src/services/historicalRecoveryCopy.ts src/services/historicalRecoveryCopy.test.ts
git commit -m "fix: normalize recovery keywords consistently"
```

---

### Task 2: Historical campaign approval and stable candidate pagination

**Files:**
- Modify: `src/api/historicalRecovery.routes.ts:129-231`
- Modify: `src/api/historicalRecovery.routes.test.ts`

**Interfaces:**
- Produces: `GET /api/historical-recovery/candidates` response `{ counts, nextCursor, asOf, candidates }`.
- Candidate summaries include `campaignPhase`, `reviewedAt`, and `createdAt` for phase-aware rendering and review-state refreshes.
- Produces: `POST /api/historical-recovery/campaigns/:id/approve` with an empty body and authenticated `req.adminEmail` actor.
- Pagination invariant: every list and count predicate includes `createdAt <= effectiveAsOf`.

- [ ] **Step 1: Add route harness mocks without weakening the existing pure filter tests**

Mock `prisma.recoveryCandidate.findMany/count`, `getIgUsers`, and `approveCampaign`, then mount the real router under Express with JSON parsing and a test-only identity middleware:

```ts
function makeApp(adminEmail = "owner@example.com") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.adminEmail = adminEmail;
    next();
  });
  app.use("/api/historical-recovery", historicalRecoveryRouter);
  return app;
}
```

Keep literal tests for every `candidateViewWhere` branch.

- [ ] **Step 2: Add fixed-boundary and actor tests**

Cover these observable contracts:

```ts
it("returns and applies one fixed asOf boundary to rows and counts", async () => {
  const asOf = "2026-08-08T20:00:00.000Z";
  const res = await request(makeApp()).get(
    `/api/historical-recovery/candidates?asOf=${encodeURIComponent(asOf)}`,
  );
  expect(res.status).toBe(200);
  expect(res.body.asOf).toBe(asOf);
  expect(candidateFindMany.mock.calls[0]![0].where.createdAt).toEqual({
    lte: new Date(asOf),
  });
  expect(candidateCount.mock.calls.every(([args]) =>
    args.where.createdAt.lte.getTime() === Date.parse(asOf),
  )).toBe(true);
});

it("attributes approval to the authenticated administrator", async () => {
  approveCampaign.mockResolvedValue({ ok: true, state: "running" });
  await request(makeApp("admin@example.com"))
    .post("/api/historical-recovery/campaigns/11111111-1111-4111-8111-111111111111/approve")
    .send({ approvedBy: "forged@example.com" })
    .expect(200);
  expect(approveCampaign).toHaveBeenCalledWith(
    "11111111-1111-4111-8111-111111111111",
    "admin@example.com",
  );
});
```

Also assert invalid `asOf` returns 400, a first page returns a parseable server boundary, cursor pages use `skip: 1`, `nextCursor` points to the last included row, and serialized summaries carry `campaignPhase`, `reviewedAt`, and `createdAt`.

- [ ] **Step 3: Run historical route tests and verify RED**

Run: `npm test -- src/api/historicalRecovery.routes.test.ts`

Expected: `asOf` is absent/not applied and approval still passes the forged body actor.

- [ ] **Step 4: Implement the fixed boundary and authenticated approval**

Inside the list handler:

```ts
const effectiveAsOf = parsed.data.asOf ? new Date(parsed.data.asOf) : new Date();
const base: Prisma.RecoveryCandidateWhereInput = {
  ...(campaignId ? { campaignId } : {}),
  createdAt: { lte: effectiveAsOf },
};
```

Use `base` for both the page and every count, return `asOf: effectiveAsOf.toISOString()`, and serialize `campaignPhase`, `reviewedAt`, and `createdAt` with the existing candidate fields.

Replace the approval body schema with authenticated context:

```ts
historicalRecoveryRouter.post("/campaigns/:id/approve", async (req, res) => {
  if (!req.adminEmail) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const result = await approveCampaign(req.params.id, req.adminEmail);
  if (!result.ok) {
    res.status(409).json({ error: result.reason });
    return;
  }
  res.json(result);
});
```

- [ ] **Step 5: Run route tests and commit Task 2**

Run: `npm test -- src/api/historicalRecovery.routes.test.ts`

Expected: all existing view tests and new route contracts pass.

```bash
git add src/api/historicalRecovery.routes.ts src/api/historicalRecovery.routes.test.ts
git commit -m "fix: stabilize historical campaign operations"
```

---

### Task 3: Historical candidate detail and idempotent review

**Files:**
- Create: `src/services/historicalRecoveryCandidateDetail.ts`
- Create: `src/services/historicalRecoveryCandidateDetail.test.ts`
- Modify: `src/api/historicalRecovery.routes.ts`
- Modify: `src/api/historicalRecovery.routes.test.ts`

**Interfaces:**
- Produces: `historicalCandidateDetail(candidateId: string): Promise<HistoricalCandidateDetail | null>`.
- Produces: `GET /api/historical-recovery/candidates/:id`.
- Produces: `POST /api/historical-recovery/candidates/:id/mark-reviewed`, returning 204 for first and repeated review.
- Audit payload key: `candidateId`, used by both the writer and candidate-detail event query.

- [ ] **Step 1: Write failing permalink-resolution and safe-detail tests**

Use complete fixtures for the candidate, campaign, intent, canonical owner, aliases, triggers, and keyword. Assert these literal outcomes:

```ts
expect(detail?.mediaPermalink).toBe("https://www.instagram.com/reel/verified-source/");
expect(detail?.intent.canonicalConversation.id).toBe(CANONICAL_CONVERSATION_ID);
expect(detail?.intent.aliasConversations.map((row) => row.id)).toEqual([ALIAS_ID]);
expect(detail?.intent.triggers.map((row) => row.commentId)).toEqual(["comment-1"]);
expect(detail?.auditEvents[0].kind).toBe("historical_recovery_reviewed");
expect(JSON.stringify(detail)).not.toMatch(/access_token|providerRaw|secret/i);
```

Add separate cases proving Reel permalink wins, Feed permalink is the fallback, Keyword permalink is the final fallback, and all-missing returns `null` rather than a fabricated URL.

- [ ] **Step 2: Run detail tests and verify RED**

Run: `npm test -- src/services/historicalRecoveryCandidateDetail.test.ts`

Expected: the module cannot be imported because it does not exist.

- [ ] **Step 3: Implement the focused detail service**

Query one candidate with a curated `select` containing campaign, keyword, intent, triggers, canonical conversation, and aliases. In parallel query:

```ts
const [reel, feed, auditEvents] = await Promise.all([
  row.mediaId
    ? prisma.reelMeta.findUnique({ where: { mediaId: row.mediaId }, select: { permalink: true } })
    : null,
  row.mediaId
    ? prisma.feedPostMeta.findUnique({ where: { mediaId: row.mediaId }, select: { permalink: true } })
    : null,
  prisma.eventLog.findMany({
    where: { payload: { path: ["candidateId"], equals: candidateId } },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { id: true, kind: true, payload: true, createdAt: true },
  }),
]);
const mediaPermalink = reel?.permalink ?? feed?.permalink ?? row.keyword.mediaPermalink ?? null;
```

Serialize dates to ISO strings and return curated fields only.

- [ ] **Step 4: Write failing route tests for detail and review behavior**

Test 404/detail pass-through, then the review state machine:

```ts
it("records one review and one authenticated audit event", async () => {
  candidateFindUnique.mockResolvedValue({ outcome: "send_uncertain", reviewedAt: null });
  candidateUpdateMany.mockResolvedValue({ count: 1 });
  await request(makeApp("reviewer@example.com"))
    .post(`/api/historical-recovery/candidates/${CANDIDATE_ID}/mark-reviewed`)
    .expect(204);
  expect(candidateUpdateMany.mock.calls[0]![0].where).toMatchObject({
    id: CANDIDATE_ID,
    outcome: { in: ["send_failed", "send_uncertain"] },
    reviewedAt: null,
  });
  expect(logEvent).toHaveBeenCalledWith("historical_recovery_reviewed", {
    candidateId: CANDIDATE_ID,
    actor: "reviewer@example.com",
    action: "mark_reviewed",
    previousOutcome: "send_uncertain",
    newOutcome: "send_uncertain",
  });
});
```

Assert an already-reviewed row returns 204 without update/audit, a concurrent winner returns 204 after reread, non-attention outcome returns 409, and missing identity returns 401.

- [ ] **Step 5: Run route tests and verify RED**

Run: `npm test -- src/api/historicalRecovery.routes.test.ts`

Expected: both new routes return 404 because they are not registered.

- [ ] **Step 6: Implement detail and compare-and-set review routes**

Register the detail route before any conflicting parameter route. For review, read `{ outcome, reviewedAt }`, return 204 immediately when reviewed, then update with:

```ts
where: {
  id: req.params.id,
  outcome: { in: ["send_failed", "send_uncertain"] },
  reviewedAt: null,
}
```

If `updateMany` loses a race, reread `reviewedAt`; return 204 when set and 409 otherwise. Emit the event only after this request wins the write.

- [ ] **Step 7: Run focused tests and commit Task 3**

Run: `npm test -- src/services/historicalRecoveryCandidateDetail.test.ts src/api/historicalRecovery.routes.test.ts`

```bash
git add src/services/historicalRecoveryCandidateDetail.ts src/services/historicalRecoveryCandidateDetail.test.ts src/api/historicalRecovery.routes.ts src/api/historicalRecovery.routes.test.ts
git commit -m "feat: expose historical recovery evidence"
```

---

### Task 4: Canonical and raw conversation API modes

**Files:**
- Modify: `src/api/conversations.routes.ts:66-194`
- Modify: `src/api/conversations.routes.test.ts`

**Interfaces:**
- Produces: query parameter `mode=canonical|raw`, default `canonical`, for list and counts.
- Produces: `conversationScopeWhere(mode: ConversationMode): Prisma.ConversationWhereInput`.
- Produces per row: `historyRole`, `canonicalOwner`, `aliasCount`, and `reconciliationReason`.

- [ ] **Step 1: Expand the test Prisma surface and add failing scope tests**

Mock `conversation.groupBy/count` in addition to existing methods. Add pure expectations:

```ts
expect(conversationScopeWhere("canonical")).toEqual({
  OR: [{ ownedIntents: { some: {} } }, { canonicalIntentId: null }],
});
expect(conversationScopeWhere("raw")).toEqual({});
```

Add list tests proving default requests use the canonical predicate, `mode=raw` removes it, and aliases serialize as:

```ts
{
  historyRole: "alias",
  canonicalOwner: { id: CANONICAL_ID },
  aliasCount: 0,
  reconciliationReason: "duplicate_inside_window",
}
```

Add count tests proving canonical/raw use the same predicate as their corresponding list and the retrying sub-count intersects that predicate.

- [ ] **Step 2: Run conversation route tests and verify RED**

Run: `npm test -- src/api/conversations.routes.test.ts`

Expected: the default list has no canonical predicate, `mode` is ignored, and ownership metadata is absent.

- [ ] **Step 3: Implement one scope helper and use it everywhere**

Add:

```ts
export type ConversationMode = "canonical" | "raw";

export function conversationScopeWhere(mode: ConversationMode): Prisma.ConversationWhereInput {
  return mode === "raw"
    ? {}
    : { OR: [{ ownedIntents: { some: {} } }, { canonicalIntentId: null }] };
}
```

Parse `mode` in list and counts. Combine state and scope with `AND` so neither predicate overwrites the other. Extend list `include` with bounded `canonicalIntent.canonicalConversation` and `ownedIntents` ownership data. Derive:

```ts
const historyRole = c.ownedIntents.length > 0
  ? "canonical"
  : c.canonicalIntentId
    ? "alias"
    : "unreconciled";
```

For counts, add the same `where` to `groupBy` and the retrying `conversation.count`.

- [ ] **Step 4: Run focused tests and commit Task 4**

Run: `npm test -- src/api/conversations.routes.test.ts`

```bash
git add src/api/conversations.routes.ts src/api/conversations.routes.test.ts
git commit -m "feat: default conversations to canonical history"
```

---

### Task 5: Historical recovery dashboard controls and evidence drawer

**Files:**
- Create: `web/src/components/historical/HistoricalCandidateDrawer.tsx`
- Create: `web/src/components/historical/HistoricalCandidateDrawer.test.tsx`
- Create: `web/src/components/historical/HistoricalStageForm.tsx`
- Create: `web/src/pages/HistoricalRecovery.test.tsx`
- Modify: `web/src/components/historical/historicalRecoveryViewModel.ts`
- Modify: `web/src/components/historical/historicalRecoveryViewModel.test.ts`
- Modify: `web/src/pages/HistoricalRecovery.tsx`

**Interfaces:**
- Produces: `campaignPhaseView(phase)` with evidence-safe title and description.
- Consumes list contract `{ candidates, counts, nextCursor, asOf }` via `useInfiniteQuery`.
- Consumes detail and review routes from Task 3.
- Consumes existing staging route with `{ batchSize, hourlyCap, dailyCap }`.

- [ ] **Step 1: Add failing phase-language tests**

Add literal semantic assertions:

```ts
expect(campaignPhaseView("confirmed_failure").description).toMatch(/could not be delivered/i);
expect(campaignPhaseView("unknown_read_pilot").description).toMatch(/no read confirmation/i);
expect(campaignPhaseView("unknown_read_pilot").description).not.toMatch(/never received|failed/i);
```

Run: `npm --prefix web test -- src/components/historical/historicalRecoveryViewModel.test.ts`

Expected: `campaignPhaseView` is not exported.

- [ ] **Step 2: Implement phase-safe copy and complete row types**

Add `dailyCap`, `selectionVersion`, and timestamps required by the page to `CampaignRow`; add `reviewedAt`, `campaignPhase`, and `createdAt` to `CandidateRow`. Implement `campaignPhaseView` with two exhaustive branches and an evidence-neutral fallback.

- [ ] **Step 3: Write failing page integration tests**

Mount the real page with QueryClient and a mocked HTTP boundary. Cover:

1. selecting “Confirmed delivery failures” requests its campaign ID instead of always using the first campaign;
2. approval sends `{ method: "POST", body: "{}" }` and never includes `approvedBy`;
3. staging sends numeric `batchSize`, `hourlyCap`, and `dailyCap`;
4. **Load more** sends both the first page's cursor and exact `asOf`;
5. the unknown-read campaign never renders “never received”; and
6. clicking a row opens the candidate drawer.

Use literal fixtures with two campaigns and two pages; assert the behavior rendered by the real child components.

- [ ] **Step 4: Run page tests and verify RED**

Run: `npm --prefix web test -- src/pages/HistoricalRecovery.test.tsx`

Expected: campaign selection, staging, load-more, and detail controls are absent; approval contains `approvedBy: "owner"`.

- [ ] **Step 5: Implement stable selection and infinite pagination**

Track `selectedCampaignId`, derive an active campaign that falls back only when the current ID disappears, and replace the candidate `useQuery` with:

```ts
const candidates = useInfiniteQuery({
  queryKey: ["historical-candidates", active?.id, tab],
  initialPageParam: undefined as { cursor: string; asOf: string } | undefined,
  queryFn: ({ pageParam }) => {
    const params = new URLSearchParams({ view: tab, campaignId: active!.id });
    if (pageParam) {
      params.set("cursor", pageParam.cursor);
      params.set("asOf", pageParam.asOf);
    }
    return api<HistoricalCandidateListResponse>(
      `/historical-recovery/candidates?${params.toString()}`,
    );
  },
  getNextPageParam: (last) => last.nextCursor
    ? { cursor: last.nextCursor, asOf: last.asOf }
    : undefined,
  enabled: Boolean(active),
});
```

Flatten pages and deduplicate by candidate ID before rendering. Add accessible campaign selection and **Load more** controls. Approval sends `{}`.

- [ ] **Step 6: Implement the staging form**

Render the form only when `campaignActions(active.state).canAdvanceStage` is true. Initialize three number inputs from the selected campaign, submit numeric values to `/campaigns/:id/stage`, disable while pending, close on success, and invalidate campaign data.

- [ ] **Step 7: Write failing candidate drawer tests**

Test a stored permalink renders with `target="_blank"`, `null` renders no Instagram link, canonical/alias/trigger/audit evidence is visible, and `send_uncertain` review invalidates detail and list queries before retiring the button.

Run: `npm --prefix web test -- src/components/historical/HistoricalCandidateDrawer.test.tsx`

Expected: module missing.

- [ ] **Step 8: Implement the candidate drawer and connect it to rows**

Use the existing `Drawer` and real query/mutation boundaries. Show candidate phase/outcome, source comment identifiers/timestamps, canonical intent and owner, alias summaries, triggers, audit events, and a source link only for `mediaPermalink`. After a successful review, invalidate `historical-candidate`, `historical-candidates`, and `historical-campaigns` keys.

- [ ] **Step 9: Run focused web tests and commit Task 5**

Run: `npm --prefix web test -- src/components/historical/historicalRecoveryViewModel.test.ts src/components/historical/HistoricalCandidateDrawer.test.tsx src/pages/HistoricalRecovery.test.tsx`

```bash
git add web/src/components/historical web/src/pages/HistoricalRecovery.tsx web/src/pages/HistoricalRecovery.test.tsx
git commit -m "feat: complete historical recovery controls"
```

---

### Task 6: Canonical conversation dashboard mode

**Files:**
- Modify: `web/src/lib/types.ts:80-102`
- Modify: `web/src/pages/Conversations.tsx:88-355`
- Modify: `web/src/pages/Conversations.test.tsx`

**Interfaces:**
- Consumes Task 4 `mode=canonical|raw` list/count contracts.
- Produces: journey-list toggle “Canonical” / “Raw history”.
- Produces: visible role labels “Canonical”, “Alias”, and “Unreconciled”, with alias owner text.

- [ ] **Step 1: Add failing canonical/raw UI tests**

Extend the real page test to select a journey lens and assert:

```ts
expect(api).toHaveBeenCalledWith(expect.stringContaining("/conversations?mode=canonical"));
await user.click(screen.getByRole("button", { name: "Raw history" }));
expect(api).toHaveBeenCalledWith(expect.stringContaining("mode=raw"));
expect(api).toHaveBeenCalledWith("/conversations/counts?mode=raw");
expect(await screen.findByText("Alias")).toBeInTheDocument();
expect(screen.getByText(/Canonical owner/)).toBeInTheDocument();
```

Also assert switching mode resets the cursor traversal by checking the raw request has no prior cursor.

- [ ] **Step 2: Run the page test and verify RED**

Run: `npm --prefix web test -- src/pages/Conversations.test.tsx`

Expected: requests omit mode and there is no raw-history control or ownership label.

- [ ] **Step 3: Add the response types and wire mode into query identity**

Add:

```ts
export type ConversationHistoryRole = "canonical" | "alias" | "unreconciled";

export interface ConversationCanonicalOwner {
  id: string;
}
```

Extend `Conversation` with `historyRole`, `canonicalOwner`, `aliasCount`, and `reconciliationReason`. Add `historyMode` state defaulting to `canonical`; include it in both query keys and both API URLs. React Query will start a fresh infinite query when the mode changes.

- [ ] **Step 4: Render the raw-history control and ownership badges**

Show the mode switch only alongside the automation-journey lens. Label canonical owners with alias counts, label aliases with their canonical owner ID, and label null ownership “Unreconciled”. Preserve all existing recovery and delivery badges.

- [ ] **Step 5: Run focused tests and commit Task 6**

Run: `npm --prefix web test -- src/pages/Conversations.test.tsx`

```bash
git add web/src/lib/types.ts web/src/pages/Conversations.tsx web/src/pages/Conversations.test.tsx
git commit -m "feat: expose canonical conversation history"
```

---

### Task 7: Remove the nine web lint failures without rule suppression

**Files:**
- Modify: `web/src/components/ai/AiConnectionCard.tsx`
- Modify: `web/src/components/layout/AppShell.tsx`
- Create: `web/src/components/layout/AppShell.test.tsx`
- Create: `web/src/components/ui/buttonVariants.ts`
- Modify: `web/src/components/ui/button.tsx`
- Modify: `web/src/pages/Insights.tsx`
- Create: `web/src/pages/SequenceEditor.test.tsx`
- Modify: `web/src/pages/SequenceEditor.tsx`

**Interfaces:**
- Produces: `mobileNavigationOpen(openedForPath: string | null, currentPath: string): boolean`.
- Sequence editor owns local drafts explicitly; server refetches cannot overwrite active edits.
- No exported non-component remains in `button.tsx`; no component is declared during another component's render.

- [ ] **Step 1: Reproduce the lint failures and preserve the output**

Run: `npm --prefix web run lint`

Expected: nine errors in `AiConnectionCard`, `AppShell`, `button.tsx`, `Insights`, and `SequenceEditor` matching the QA baseline.

- [ ] **Step 2: Add the AppShell route-close regression test and verify RED**

Test the desired state transition without animation timing:

```ts
expect(mobileNavigationOpen("/conversations", "/conversations")).toBe(true);
expect(mobileNavigationOpen("/conversations", "/keywords")).toBe(false);
expect(mobileNavigationOpen(null, "/conversations")).toBe(false);
```

Run: `npm --prefix web test -- src/components/layout/AppShell.test.tsx`

Expected: helper is missing.

- [ ] **Step 3: Derive AppShell and AI state instead of mirroring it in effects**

In AppShell, store `openedForPath` and derive `mobileOpen` through the tested helper; the menu action stores `loc.pathname`, while close stores `null`.

In `AiConnectionCard`, remove the effect and use:

```ts
const effectiveLogin = statusQ.data?.connected ? null : login;
```

Pass `effectiveLogin` to `connectionView` and stop polling when the query data is connected. The existing `connectionView` stale-code test protects the displayed behavior.

- [ ] **Step 4: Separate the button variant export and lift Metric to module scope**

Move the existing `cva` declaration unchanged to `buttonVariants.ts`, import it in `button.tsx`, and export only the React component from `button.tsx`. Move `Metric` from inside its parent in `Insights.tsx` to module scope with the same explicit prop type.

- [ ] **Step 5: Add SequenceEditor ownership tests and verify RED**

Mock only the HTTP boundary. Test that a typed resource name survives a query invalidation/refetch until blur, and that a typed step body survives a message refetch until blur. The server's second response must contain different text so an effect-driven reset fails visibly.

Run: `npm --prefix web test -- src/pages/SequenceEditor.test.tsx`

Expected: the current effects replace both in-progress values with the refetched server values.

- [ ] **Step 6: Refactor SequenceEditor around keyed local owners**

Move ready data into a `SequenceEditorForm` keyed by resource ID. Initialize resource fields and message items once in that component. Update `items` directly from add/delete/reorder/patch mutation results. Make `SortableStep` controlled by `step.body` and `step.mediaUrl`; call `onChange` on every input/upload change and persist on blur/upload. Remove all four state-mirroring effects and the now-unnecessary `useMemo`.

On reorder failure, restore the snapshot returned from `onMutate`; do not read a later query result into local state.

- [ ] **Step 7: Run focused behavior tests and lint**

Run: `npm --prefix web test -- src/components/ai/AiConnectionCard.test.tsx src/components/layout/AppShell.test.tsx src/pages/SequenceEditor.test.tsx`

Run: `npm --prefix web run lint`

Expected: tests pass; lint exits zero with no warnings or suppressions added.

- [ ] **Step 8: Commit Task 7**

```bash
git add web/src/components/ai/AiConnectionCard.tsx web/src/components/layout/AppShell.tsx web/src/components/layout/AppShell.test.tsx web/src/components/ui/button.tsx web/src/components/ui/buttonVariants.ts web/src/pages/Insights.tsx web/src/pages/SequenceEditor.tsx web/src/pages/SequenceEditor.test.tsx
git commit -m "fix: restore the web lint baseline"
```

---

### Task 8: Historical and canonical browser regression coverage

**Files:**
- Modify: `web/e2e/main.tsx`
- Create: `web/e2e/historical-recovery.spec.ts`

**Interfaces:**
- Adds deterministic scenarios `historical-dashboard` and `canonical-conversations` to the existing real-component harness.
- Captures approval/staging requests and pagination query parameters at the HTTP boundary.

- [ ] **Step 1: Write the failing browser journeys**

Mount the real `HistoricalRecovery` and `Conversations` pages. Add Playwright tests that:

1. select the second campaign and display its phase-safe copy;
2. approve it and verify the rendered approver is `owner@example.com` after refetch;
3. advance caps and verify the rendered caps change;
4. load a second candidate page and verify the second row appears without duplicating the first;
5. open candidate detail, verify canonical owner/alias/trigger/audit evidence and exact stored permalink;
6. mark an uncertain candidate reviewed and verify the action disappears after refetch; and
7. switch conversations from canonical to raw history and verify an alias appears with its owner.

- [ ] **Step 2: Run the new Playwright file and verify RED**

Run: `npm --prefix web run test:e2e -- historical-recovery.spec.ts`

Expected: the harness reports `Unknown scenario` or unhandled historical endpoints.

- [ ] **Step 3: Extend the deterministic HTTP harness**

Add complete response fixtures matching the production list/detail/campaign/conversation contracts. Maintain mutable sets/maps for approval, caps, and review. On candidate pagination, require the second request's `asOf` to equal `2026-08-08T20:00:00.000Z`; return 400 from the harness if it differs. Mount real pages based on the new scenario names.

- [ ] **Step 4: Run browser coverage and commit Task 8**

Run: `npm --prefix web run test:e2e -- historical-recovery.spec.ts`

Expected: all new journeys pass against real components and the stubbed HTTP boundary.

```bash
git add web/e2e/main.tsx web/e2e/historical-recovery.spec.ts
git commit -m "test: cover historical recovery operations"
```

---

### Task 9: Complete verification and update the QA record

**Files:**
- Modify: `docs/qa/2026-08-07-instagram-automation-features-1-4-deep-qa.md`

**Interfaces:**
- Produces: one evidence-backed status for QA-18, QA-19, and QA-20.
- Produces: exact blocked commands/runbook when database or Meta credentials remain absent.

- [ ] **Step 1: Run the full local verification matrix**

Run each command separately and record exit status and test count:

```bash
npm test
npm run build
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
npm --prefix web run test:e2e
```

If a command fails, follow `superpowers:systematic-debugging`: preserve the full error, reproduce with the narrowest command, trace the failing data path, add a failing regression test when behavior is wrong, then apply one root-cause fix.

- [ ] **Step 2: Check database-contract availability**

Check only whether `MIGRATION_TEST_DATABASE_URL` is set; do not print its value. When it is set, run:

```bash
npm test -- src/services/recoveryCampaignDatabaseContract.test.ts src/services/historicalRecoveryClaimContract.test.ts src/services/historicalRecoveryLifecycleContract.test.ts src/services/historicalRecoveryHealthContract.test.ts src/services/historicalRecoverySelectorContract.test.ts
```

When it is unset, record: “Blocked: `MIGRATION_TEST_DATABASE_URL` is required and must point to a disposable PostgreSQL database on which migrations may be applied and test rows destroyed.”

- [ ] **Step 3: Check controlled Meta availability without exposing secrets**

Check only presence of the required controlled-account token, Instagram account ID, and test media/comment identifiers. If absent, add this runbook to the QA record:

1. configure a sandbox/test Instagram professional account and a test post;
2. comment a mixed-case configured keyword from a controlled user;
3. force the verified settings-rejection path and capture the categorized provider response;
4. verify the snapshotted public recovery copy contains the uppercase keyword;
5. approve a one-person historical confirmed-failure campaign;
6. confirm exactly one public comment is created and its stored permalink opens the original post;
7. mark the candidate reviewed, replay the request, and confirm one review audit event;
8. remove the controlled test comment and revoke/rotate temporary credentials.

- [ ] **Step 4: Update the P2 findings with implementation and evidence**

For each of QA-18, QA-19, and QA-20, add:

- final status (`Fixed` or `Partially verified — external credential blocker`);
- changed implementation surfaces;
- named regression test files;
- fresh command results; and
- remaining database/Meta blocker text without secret values.

Do not rewrite P0/P1 verdicts as fixed by inference; only report their separately landed evidence already present in the repository.

- [ ] **Step 5: Run documentation and diff safety checks**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors and no P1-owned file staged or modified by the P2 branch.

- [ ] **Step 6: Commit the QA evidence**

```bash
git add docs/qa/2026-08-07-instagram-automation-features-1-4-deep-qa.md
git commit -m "docs: record P2 remediation verification"
```

---

## Final Review Gate

Before claiming completion, use `superpowers:verification-before-completion`. Re-run the full local verification commands from Task 9 against the final commit, inspect `git diff`/`git status` for unrelated files, and report credential-gated checks as blocked unless they actually ran with disposable/controlled credentials.
