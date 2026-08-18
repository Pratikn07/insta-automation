# Maison Remaining Build and QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete every remaining local code, documentation, and pre-production QA requirement for Maison Editorial, then stop at a truthful `READY FOR CONTROLLED ROLLOUT` or `NO-GO` decision without deploying, sending Meta messages, or removing the legacy guide sender.

**Architecture:** Finish the durable guide review surface first, then replace ambiguous browser transport behavior with abortable reads, explicit mutation outcomes, replay-safe creates, and route-owned reconciliation. Complete the paper-theme chart migration, run all database/browser/runtime/static gates from one commit, and publish one evidence-backed QA record. Production cohort activation and legacy retirement remain separate gated phases.

**Tech Stack:** TypeScript, React 19, TanStack Query, Vite, Vitest, Playwright, Express, Prisma, PostgreSQL, Supabase Auth/Storage, and the Meta Graph API boundary.

**Specs:**

- `docs/superpowers/specs/2026-08-09-guide-message-limits-and-resumable-delivery-design.md`
- `docs/superpowers/specs/2026-08-16-maison-editorial-production-readiness-design.md`
- `docs/superpowers/plans/2026-08-09-guide-message-limits-and-resumable-delivery.md`
- `docs/superpowers/plans/2026-08-16-maison-recovery-client-truth.md`
- `docs/superpowers/plans/2026-08-16-maison-interface-release-qa.md`

## Current verified baseline

- Branch: `design/maison-editorial` in the linked worktree `.worktrees/maison-editorial`.
- Baseline commit for this remaining plan: `25635fd`.
- Worktree state at plan creation: clean; branch is 22 commits ahead of the existing draft PR branch.
- Measurement truth: Tasks 1–4 complete.
- Durable guide delivery: Tasks 1–10 complete and independently reviewed.
- Recovery/client truth: Task 1 complete; Tasks 2–6 remain.
- Interface/release QA: Tasks 2–4 complete; Tasks 1 and 5 remain.
- Latest guide/backend evidence: 2,248 backend tests passed; Task 10 live-database matrix 76/76 passed with zero skips.
- Shared disposable PostgreSQL: `codex-maison-qa-postgres`, `127.0.0.1:55439`, database `insta_contract`. It must never be replaced by or pointed at production.
- `GuideDeliveryReviewCard.tsx` does not exist yet; interrupted Task 11 left no file changes.

## Global constraints

- Do not deploy, change production environment variables, add an Instagram recipient to a rollout allowlist, or send a Meta message during Tasks 1–12.
- Do not remove `sequenceSender` or the mutually exclusive legacy branch before the controlled path is formally declared stable and legacy removal is separately authorized.
- Do not connect a local server to the configured production database for visual QA; startup performs writes even with workers disabled.
- Every text and caption limit uses Unicode code points (`[...value].length`), not UTF-16 code units.
- A mutation whose request was dispatched but whose response is ambiguous is `unknown`; it is never automatically retried.
- No UI, DTO, event, or log may expose guide snapshots, media URLs, provider response bodies, access tokens, or private trace data.
- Database-backed contracts must execute against the named disposable loopback database with zero skips.
- Each task follows RED → GREEN → focused verification → broader regression → independent review → commit.
- Preserve unrelated user changes and keep each commit limited to the task's declared files.

## Remaining execution order

| Order | Deliverable | Depends on |
| --- | --- | --- |
| 1 | Conversations guide-delivery review UI | Guide Tasks 1–10 |
| 2 | Guide operations runbook and authority corrections | Task 1 |
| 3 | Abortable browser reads | Existing interface routes |
| 4 | Explicit mutation dispatch/outcome primitive | Task 3 |
| 5 | Replay-safe database creates | Task 4 and guide API contracts |
| 6 | Business-key reconciliation for AI/advisor/upload | Tasks 4–5 |
| 7 | Migrate all remaining frontend mutations | Tasks 4–6 |
| 8 | Recovery/client product record and slice verification | Tasks 3–7 |
| 9 | Paper-safe semantic chart palette | Existing Home chart |
| 10 | Integrated automated, database, audit, and static gates | Tasks 1–9 |
| 11 | Fixture-only visual QA and production-readiness report | Task 10 |
| 12 | Final branch audit and controlled-rollout handoff | Task 11 |

---

### Task 1: Add guide delivery review to Conversations

**Files:**

- Create: `web/src/components/conversations/GuideDeliveryReviewCard.tsx`
- Create: `web/src/components/conversations/GuideDeliveryReviewCard.test.tsx`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/components/conversations/DmThreadList.tsx`
- Modify: `web/src/components/conversations/DmThreadDrawer.tsx`
- Modify: `web/src/pages/Conversations.test.tsx`

**Interfaces:**

- Consumes: `GET /api/guide-deliveries/review`, `POST /:deliveryId/confirm`, `POST /:deliveryId/retry`, and `POST /:deliveryId/cancel` from guide Task 10.
- Produces: `GuideDeliveryReviewCard`, `GuideDeliveryReview`, `GuideDeliveryReviewUnit`, `deliveryReviewCount`, and explicit owner-resolution mutations consumed by Task 7's transport migration.

- [ ] **Step 1: Add the safe DTO types**

```ts
export interface GuideDeliveryReviewUnit {
  id: string;
  position: number;
  kind: "text" | "image" | "file";
  status: "pending" | "sending" | "sent" | "retryable" | "failed" | "uncertain" | "cancelled";
}

export interface GuideDeliveryReview {
  id: string;
  status: "needs_review" | "failed";
  confirmedUnits: number;
  totalUnits: number;
  sendWindowExpiresAt: string;
  sendWindowOpen: boolean;
  failureCode: string | null;
  units: GuideDeliveryReviewUnit[];
}
```

Add `deliveryReviewCount: number` to `DmThreadRow` and `deliveryReviews: GuideDeliveryReview[]` to `DmThreadDetail`.

- [ ] **Step 2: Write the card's failing behavior and privacy tests**

Assert the heading, `2 of 4 messages confirmed`, one-based unit position/kind, `Already delivered`, `Retry unit`, and `Cancel delivery`. Assert rendered output does not contain fixture snapshots, media URLs, provider bodies, or tokens.

```ts
expect(screen.getByText("Delivery needs review")).toBeInTheDocument();
expect(screen.getByText("2 of 4 messages confirmed")).toBeInTheDocument();
expect(screen.queryByText("PRIVATE-SNAPSHOT")).not.toBeInTheDocument();
```

- [ ] **Step 3: Add failing action-state tests**

Verify retry opens `ConfirmDialog`, explains that Instagram may already have delivered the unit, and sends `{ acknowledgeDuplicateRisk: true }` only after confirmation. Verify retry is disabled after window close, cancel stays enabled, and `Already delivered` stays enabled after window close only when confirming that unit can complete locally.

- [ ] **Step 4: Run the focused RED test**

```bash
npm --prefix web test -- src/components/conversations/GuideDeliveryReviewCard.test.tsx
```

Expected: component-not-found failure.

- [ ] **Step 5: Implement the review card and exact closed-window copy**

```text
Instagram's messaging window has closed. A fresh inbound message is required before any remaining message can be sent.
```

Map stable API errors to inline owner guidance. Invalidate `dm-thread`, `dm-threads`, and conversation counts after confirmed actions.

- [ ] **Step 6: Integrate list badge and drawer ordering**

Render an amber `Delivery needs review` badge whenever `deliveryReviewCount > 0`, independently of draft status. Render all delivery-review cards above the draft card so uncertain automation is resolved before composing another reply.

- [ ] **Step 7: Verify Conversations integration and web regressions**

```bash
npm --prefix web test -- src/components/conversations/GuideDeliveryReviewCard.test.tsx src/pages/Conversations.test.tsx
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
```

Expected: all commands exit `0`; default Needs reply/lens behavior remains unchanged.

- [ ] **Step 8: Commit and review**

```bash
git add web/src/lib/types.ts web/src/components/conversations/GuideDeliveryReviewCard.tsx web/src/components/conversations/GuideDeliveryReviewCard.test.tsx web/src/components/conversations/DmThreadList.tsx web/src/components/conversations/DmThreadDrawer.tsx web/src/pages/Conversations.test.tsx
git commit -m "feat: review uncertain guide sends in conversations"
```

Independent review must approve copy truthfulness, closed-window actions, query invalidation, accessibility, and negative privacy before Task 2.

---

### Task 2: Write the guide operations runbook and align authority records

**Files:**

- Create: `docs/guide-delivery-operations.md`
- Modify: `docs/superpowers/specs/2026-08-09-guide-message-limits-and-resumable-delivery-design.md`
- Modify: `PRODUCT.md`

**Interfaces:**

- Consumes: completed guide Tasks 1–11.
- Produces: the exact deployment/rollback/owner-review procedure used only after Task 12 reaches `READY FOR CONTROLLED ROLLOUT`.

- [ ] **Step 1: Write the runbook before executing any production action**

Document the read-only content audit, author-only correction rule, migration-first deployment, safe disabled values, allowlist-only cohort procedure, text and image-plus-caption cases, definite rejection/resume case, ambiguous timeout/no-auto-retry case, all three owner actions, safe event fields, and rollback by stopping new application sends without deleting ledger rows.

- [ ] **Step 2: Record the safe initial configuration exactly**

```text
GUIDE_DELIVERY_ENABLED=false
GUIDE_DELIVERY_ROLLOUT_PERCENT=0
GUIDE_DELIVERY_COHORT_IG_USER_IDS=
```

State that `follow_recovery` remains a separate future trigger and that the worker is not active before controlled authorization.

- [ ] **Step 3: Correct stale code-unit and rollout claims**

Change authoring/API/preflight references to Unicode code points measured by `[...value].length`. Add durable states and disabled rollout status to `PRODUCT.md`; do not say the ledger owns production traffic.

- [ ] **Step 4: Run ownership, privacy, and event scans**

```bash
npm run check:guide-delivery-bypasses
rg -n 'guideDeliveryOwner|deliverGuideForTrigger|sendSequence' src/handlers/messageHandler.ts
rg -n 'logger\.(info|warn|error|debug)\([^\n]*(textSnapshot|mediaUrlSnapshot|body)' src/services/guideDelivery* src/api/guideDeliveries.routes.ts
rg -n 'eventLog\.create|logEvent' src/services/guideDelivery* src/api/guideDeliveries.routes.ts
```

Expected: the formal detector passes; the handler has one mutually exclusive ownership point; the unsafe-log search is empty; every event call contains only allowlisted aggregate fields.

- [ ] **Step 5: Commit the pre-production documentation**

```bash
git add docs/guide-delivery-operations.md docs/superpowers/specs/2026-08-09-guide-message-limits-and-resumable-delivery-design.md PRODUCT.md
git commit -m "docs: add guide delivery rollout runbook"
```

Do not execute the runbook's deploy or controlled-recipient sections in this task.

---

### Task 3: Replace cosmetic read timeouts with genuinely abortable reads

**Files:**

- Create: `web/src/lib/requestDeadline.ts`
- Create: `web/src/lib/requestDeadline.test.ts`
- Modify: `web/src/lib/api.ts`, `web/src/lib/api.test.ts`, `web/src/main.tsx`
- Modify: every TanStack query in Home, Activity, Assistant, Sequences, Keywords, Content, Sequence Editor, Conversations, Funnels, Historical Recovery, Insights, User Lineage, Keyword Form, AI Connection, People Directory, DM thread/recovery drawers, and Historical Candidate Drawer.
- Modify: their API module mocks so `apiRead` exists.

**Interfaces:**

- Produces: `withDeadline`, `awaitWithSignal`, `RequestTimeoutError`, and `apiRead<T>(path, { signal, timeoutMs? })`.
- Consumed by: every TanStack query and every recovery read method.

- [ ] **Step 1: Write deadline and listener-cleanup tests**

```ts
const deadline = withDeadline(undefined, 20_000);
await vi.advanceTimersByTimeAsync(20_000);
expect(deadline.signal.reason).toBeInstanceOf(RequestTimeoutError);
deadline.dispose();
```

Also prove caller abort reason propagation, already-aborted callers, timer disposal after success, and listener removal for a never-settling Supabase auth promise.

- [ ] **Step 2: Write a fetch-abort RED test**

Capture `init.signal`, advance fake timers, assert the underlying fetch signal is aborted, and distinguish `RequestTimeoutError` from caller `AbortError`.

- [ ] **Step 3: Run RED**

```bash
npm --prefix web test -- src/lib/requestDeadline.test.ts src/lib/api.test.ts
```

Expected: the module is absent and the current timeout does not abort fetch.

- [ ] **Step 4: Implement the deadline primitive**

```ts
export class RequestTimeoutError extends Error {
  readonly code = "read_timeout";
  constructor(readonly timeoutMs: number) {
    super(`The read exceeded its ${timeoutMs}ms deadline.`);
    this.name = "RequestTimeoutError";
  }
}
```

`awaitWithSignal` may race only dependency promises that cannot accept a signal. Fetch always receives the composed signal and is never hidden behind `Promise.race`.

- [ ] **Step 5: Implement `apiRead`**

Bound `getSession`, the single allowed refresh, and fetch with the same signal; dispose timers/listeners in `finally`; preserve caller cancellation identity; use one safe 401 refresh attempt.

- [ ] **Step 6: Migrate every query function**

```ts
queryFn: ({ signal }) => apiRead<Stats>("/stats", { signal })
```

For infinite queries, destructure `pageParam` and `signal`. Recovery list/count/metrics/verification/detail reads accept the optional signal.

- [ ] **Step 7: Make query retry explicit**

Retry once only for a network failure, `RequestTimeoutError`, or `ApiError.status >= 500`; never retry caller cancellation or 4xx. Keep `networkMode: "always"`.

- [ ] **Step 8: Verify migration completeness**

```bash
rg -n "queryFn:.*\bapi<|queryFn: \(\) => api<" web/src
rg -n "list:|counts:|metrics:|settingsVerifications:|detail:" web/src/lib/api.ts
npm --prefix web test -- src/lib/requestDeadline.test.ts src/lib/api.test.ts
npm --prefix web test -- src/pages/Home.test.tsx src/pages/Conversations.test.tsx src/pages/DmRecovery.test.tsx src/pages/HistoricalRecovery.test.tsx src/pages/SequenceEditor.test.tsx src/components/conversations/DmRecoveryList.test.tsx src/components/conversations/DmRecoveryDrawer.test.tsx src/components/historical/HistoricalCandidateDrawer.test.tsx
npm --prefix web run build
```

Expected: no generic read query remains; focused tests and build pass.

- [ ] **Step 9: Commit and review**

```bash
git add web/src/lib/requestDeadline.ts web/src/lib/requestDeadline.test.ts web/src/lib/api.ts web/src/lib/api.test.ts web/src/main.tsx web/src/pages/Home.tsx web/src/pages/Home.test.tsx web/src/pages/Activity.tsx web/src/pages/Assistant.tsx web/src/pages/Sequences.tsx web/src/pages/Keywords.tsx web/src/pages/Content.tsx web/src/pages/SequenceEditor.tsx web/src/pages/SequenceEditor.test.tsx web/src/pages/Conversations.tsx web/src/pages/Conversations.test.tsx web/src/pages/DmRecovery.test.tsx web/src/pages/Funnels.tsx web/src/pages/HistoricalRecovery.tsx web/src/pages/HistoricalRecovery.test.tsx web/src/pages/Insights.tsx web/src/components/UserLineage.tsx web/src/components/KeywordForm.tsx web/src/components/ai/AiConnectionCard.tsx web/src/components/conversations/PeopleDirectory.tsx web/src/components/conversations/DmThreadDrawer.tsx web/src/components/conversations/DmRecoveryList.tsx web/src/components/conversations/DmRecoveryList.test.tsx web/src/components/conversations/DmRecoveryDrawer.tsx web/src/components/conversations/DmRecoveryDrawer.test.tsx web/src/components/historical/HistoricalCandidateDrawer.tsx web/src/components/historical/HistoricalCandidateDrawer.test.tsx
git commit -m "fix: abort timed-out reads before retrying"
```

Review must reject fetch-level `Promise.race`, lost abort reasons, unremoved listeners, or a query that ignores TanStack's signal.

---

### Task 4: Model mutation dispatch and unknown outcomes explicitly

**Files:**

- Create: `web/src/lib/mutationOutcome.ts`
- Create: `web/src/lib/mutationOutcome.test.ts`
- Modify: `web/src/lib/api.ts`, `web/src/lib/api.test.ts`, `web/src/main.tsx`

**Interfaces:**

- Produces: `createOperationId`, `MutationNotDispatchedError`, `MutationOutcomeUnknownError`, `ReconciliationResult<T>`, and `apiMutation<T>`.
- Consumed by: Tasks 5–7.

- [ ] **Step 1: Write dispatch-phase RED tests**

Cover auth timeout before fetch as definite not-dispatched; timeout/abort/network rejection after fetch starts as unknown; any post-dispatch 5xx as unknown; definite 4xx as `ApiError`; and zero automatic second fetch.

```ts
export type ReconciliationResult<T> =
  | { status: "confirmed"; value: T }
  | { status: "absent" }
  | { status: "still_unknown" };
```

- [ ] **Step 2: Verify RED**

```bash
npm --prefix web test -- src/lib/mutationOutcome.test.ts src/lib/api.test.ts
```

Expected: new exports are absent and current errors do not distinguish dispatch phase.

- [ ] **Step 3: Implement `apiMutation`**

Accept non-GET methods, optional `operationId`, and a deadline. Set `dispatched = true` immediately before fetch. Once dispatched, map timeout, abort without a definite response, network failure, and 5xx to `MutationOutcomeUnknownError(path, operationId)`. Add `Idempotency-Key` only when an operation ID exists. Never serialize request bodies or headers into errors/logs.

- [ ] **Step 4: Disable framework mutation retry**

```ts
mutations: { networkMode: "always", retry: false }
```

No component may override this with a positive retry count.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix web test -- src/lib/mutationOutcome.test.ts src/lib/api.test.ts
npm --prefix web run build
git add web/src/lib/mutationOutcome.ts web/src/lib/mutationOutcome.test.ts web/src/lib/api.ts web/src/lib/api.test.ts web/src/main.tsx
git commit -m "fix: distinguish unknown mutation outcomes"
```

---

### Task 5: Make database-only creates replayable by client UUID

**Files:**

- Create: `src/api/createReplay.ts`, `src/api/createReplay.test.ts`
- Create/modify tests for resources, keywords, resource messages, and insights/manual experiments.
- Modify: `src/api/resources.routes.ts`, `src/api/keywords.routes.ts`, `src/api/messages.routes.ts`, `src/api/insights.routes.ts`, `src/services/experimentService.ts`
- Modify create callers/tests in Sequences, Sequence Editor, Insights, and Keyword Form.

**Interfaces:**

- Consumes: `createOperationId` and `apiMutation` from Task 4.
- Produces: replay-safe canonical create behavior keyed by body UUID and matching `Idempotency-Key`.

- [ ] **Step 1: Write the pure replay classifier tests**

```ts
expect(classifyCreateReplay({
  existing: { id: "id-1", name: "Guide" },
  intended: { id: "id-1", name: "Guide" },
  keys: ["id", "name"],
})).toBe("replay");
```

Also assert a mismatched request-owned field is `conflict`.

- [ ] **Step 2: Write route RED contracts for every create family**

For the same valid UUID: first create returns `201`, exact replay returns `200` and the same canonical row, conflicting replay returns `409 { error: "idempotency_conflict" }`, and header/body ID mismatch returns `400 { error: "idempotency_key_mismatch" }` before Prisma.

- [ ] **Step 3: Add domain-side-effect assertions**

Keyword exact active replay re-enqueues idempotent backfill; conflict does not. Experiment replay does not recapture baseline. ResourceMessage compares request-owned resource/type/body/media fields but not server-owned order.

- [ ] **Step 4: Run RED**

```bash
npm test -- src/api/createReplay.test.ts src/api/resources.routes.test.ts src/api/keywords.routes.test.ts src/api/messages.routes.test.ts src/api/insights.routes.test.ts src/services/experimentService.test.ts
```

- [ ] **Step 5: Accept and persist required client UUIDs**

Add `id: z.string().uuid()` to each create schema. On primary-key `P2002`, load by ID and compare normalized request-owned fields. Preserve existing domain duplicate responses when a different ID conflicts with a business unique key.

- [ ] **Step 6: Retain the UUID across unknown UI outcomes**

Create the UUID when the owner begins the attempt, not inside `mutationFn`. Send it in both body and `Idempotency-Key`; refetch by ID after unknown outcome; reset only after confirmed success. Retry the same UUID only after a successful canonical read confirms absence after the original deadline.

- [ ] **Step 7: Verify backend and frontend contracts**

```bash
npm test -- src/api/createReplay.test.ts src/api/resources.routes.test.ts src/api/keywords.routes.test.ts src/api/messages.routes.test.ts src/api/insights.routes.test.ts src/services/experimentService.test.ts
npm --prefix web test -- src/pages/Sequences.test.tsx src/pages/SequenceEditor.test.tsx src/pages/Insights.test.tsx src/components/KeywordForm.test.tsx
npm run build
npm --prefix web run build
```

- [ ] **Step 8: Commit and review**

```bash
git add src/api/createReplay.ts src/api/createReplay.test.ts src/api/resources.routes.ts src/api/resources.routes.test.ts src/api/keywords.routes.ts src/api/keywords.routes.test.ts src/api/messages.routes.ts src/api/messages.routes.test.ts src/api/insights.routes.ts src/api/insights.routes.test.ts src/services/experimentService.ts src/services/experimentService.test.ts web/src/pages/Sequences.tsx web/src/pages/Sequences.test.tsx web/src/pages/SequenceEditor.tsx web/src/pages/SequenceEditor.test.tsx web/src/pages/Insights.tsx web/src/pages/Insights.test.tsx web/src/components/KeywordForm.tsx web/src/components/KeywordForm.test.tsx
git commit -m "fix: make console creates replay-safe"
```

Review must inspect request-owned comparison fields, mismatched ID rejection before writes, stable UI operation IDs, and side-effect replay rules.

---

### Task 6: Bind AI, advisor, and upload operations to durable business keys

**Files:**

- Modify: `src/services/replyDraftService.ts`, `src/services/codexRuntimeClient.ts`, `src/api/ai.routes.ts`, `src/api/upload.routes.ts`
- Modify: corresponding backend tests.
- Modify: `codex-runtime/src/advisorService.ts`, `codex-runtime/src/app.ts`, and tests.
- Create: `web/src/lib/signedUpload.ts`, `web/src/lib/signedUpload.test.ts`
- Create/modify: `web/src/pages/Assistant.test.tsx`, `web/src/components/MediaUpload.test.tsx`

**Interfaces:**

- Consumes: Task 4's operation IDs and unknown-outcome classes.
- Produces: same-inbound draft coalescing, advisor `clientMessageId` replay, deterministic upload object paths, and signed-upload reconciliation.

- [ ] **Step 1: Write duplicate-draft RED tests**

While holding the thread lock, a repeated initial draft request for the same authoritative latest inbound must return the active draft rather than supersede it. Regenerate remains a separate explicit transition keyed by the prior draft ID.

- [ ] **Step 2: Write advisor idempotency RED tests**

Same `clientMessageId` plus exact question returns the completed result, an active turn returns `advisor_outcome_pending`, a failed/cancelled/invalid-output turn returns a definite terminal failure, and same ID plus different text returns `idempotency_conflict`. History read failure is `still_unknown`, never absence. Cover in-process concurrency and restart/history replay.

- [ ] **Step 3: Preserve stable advisor codes through every layer**

Map `advisor_outcome_pending` and `idempotency_conflict` through runtime HTTP, main runtime client, and `/api/ai/advisor/messages` without converting them to generic 502 responses. Bodies expose only the stable code.

- [ ] **Step 4: Write deterministic upload RED tests**

Require a client UUID at `/upload/sign`, derive `kind/<uuid>.<validated-ext>`, return the same path on re-sign, and reject mismatched header/body IDs. For unknown PUT, HEAD the public URL and compare size/type; a confirmed 404 after the original deadline permits re-sign/retry of the same path.

- [ ] **Step 5: Implement the business-key and signed-upload contracts**

`signedUpload.ts` uses an abortable PUT deadline. It never creates a new UUID/path after unknown outcome, and it never interprets a failed HEAD/read as absence.

- [ ] **Step 6: Verify all three domains**

```bash
npm test -- src/services/replyDraftService.test.ts src/api/upload.routes.test.ts src/services/codexRuntimeClient.test.ts src/api/ai.routes.test.ts
npm --prefix codex-runtime test -- src/advisorService.test.ts src/app.test.ts
npm --prefix web test -- src/pages/Assistant.test.tsx src/components/MediaUpload.test.tsx src/lib/signedUpload.test.ts
npm run build
npm --prefix codex-runtime run build
npm --prefix web run build
```

- [ ] **Step 7: Commit and review**

```bash
git add src/services/replyDraftService.ts src/services/replyDraftService.test.ts src/services/codexRuntimeClient.ts src/services/codexRuntimeClient.test.ts src/api/ai.routes.ts src/api/ai.routes.test.ts src/api/upload.routes.ts src/api/upload.routes.test.ts codex-runtime/src/advisorService.ts codex-runtime/src/advisorService.test.ts codex-runtime/src/app.ts codex-runtime/src/app.test.ts web/src/lib/signedUpload.ts web/src/lib/signedUpload.test.ts web/src/pages/Assistant.test.tsx web/src/components/MediaUpload.test.tsx
git commit -m "fix: bind external console actions to durable keys"
```

Review must reject a second draft, runtime turn, or storage object path after an ambiguous first request.

---

### Task 7: Migrate every remaining mutation to route-owned reconciliation

**Files:**

- Create: `docs/client-operation-contracts.md`
- Modify mutation call sites/tests in Keywords, Sequences, Sequence Editor, Historical Recovery, Insights, Assistant, Keyword Form, Media Upload, AI Connection, DM Thread Drawer, DM Recovery list/drawer, and Historical Candidate Drawer.
- Modify: `web/src/lib/api.ts`

**Interfaces:**

- Consumes: `apiMutation`, unknown outcomes, replay-safe creates, AI/advisor/upload business keys, and Task 1 guide review actions.
- Produces: no production use of generic `api()` and one explicit canonical reconciliation rule per mutation route.

**Required operation contracts:**

| Family | Routes | Primary callers | Canonical result after unknown outcome |
| --- | --- | --- | --- |
| Entity create | resources, keywords, messages, manual experiments | Sequences, Sequence Editor, Keyword Form, Insights | Refetch by client UUID; retry the same UUID only after confirmed absence beyond the original deadline. |
| Entity patch/delete/reorder | resources, keywords, messages, experiments | Keywords, Sequences, Sequence Editor, Insights | Refetch canonical entity/list and compare intended fields; never automatically retry. |
| Recovery actions | cancel, mark-reviewed, verification activate/retire | DM Recovery list/drawer | Refetch recovery detail and registry; the server state transition is authoritative. |
| Historical campaign actions | start, pause, resume, stop, stage, rollout pause, review | Historical Recovery and candidate drawer | Refetch campaign/candidate; sealed state and stable IDs prove the result. |
| AI draft actions | create, regenerate, dismiss, approve, retry-send, patch | DM Thread Drawer | Initial create uses thread/latest-inbound business key; later actions refetch the draft state machine; never blindly resend approved text. |
| Advisor message | `/ai/advisor/messages` | Assistant | Refetch history by `clientMessageId`; keep composer locked while the key is pending. |
| AI connection | connect/disconnect | AI Connection Card | Refetch connection status; never start a second login while unknown. |
| Upload sign/PUT | `/upload/sign`, signed storage URL | Media Upload | UUID owns one object path; reconcile PUT with HEAD size/type, then re-sign the same path only after confirmed absence. |
| Analysis enqueue | `/insights/reels/:mediaId/analyze` | Insights | Refetch reel/job state; media ID is the business key and repeated pending state is not a second job. |
| Guide owner review | confirm, retry, cancel | Guide Delivery Review Card | Refetch guide review/thread; retry requires the original operation and literal duplicate-risk acknowledgement. |

- [ ] **Step 1: Inventory every mutation before changing callers**

Create one row per route with source component, operation family, business key, canonical read, fields that prove success, minimum reconciliation deadline, and whether a same-key explicit retry is allowed. Do not use “same as another route.”

- [ ] **Step 2: Write high-risk unknown-outcome RED tests**

Cover AI Approve & Send, Historical campaign start/approve, DM Recovery cancel, sequence reorder, keyword/resource delete, advisor question, initial AI draft, signed upload PUT, and guide owner-review actions. Each rejected `MutationOutcomeUnknownError` is followed by controlled canonical query results; assert mutation call count remains one.

- [ ] **Step 3: Migrate recovery actions**

Keep reads on `apiRead`; move actions to `apiMutation`. Unknown results invalidate the complete recovery tree, show `Still confirming with Instagram state`, and disable the action. Unchanged state alone is not absence while the first request may still be executing.

- [ ] **Step 4: Migrate patch/delete/reorder and campaign actions**

Refetch the smallest canonical entity/list that proves the intended state. Never rollback to stale local order after unknown outcome. Never retry external sends/campaign actions only because HTTP timed out.

- [ ] **Step 5: Migrate guide review and remaining AI/upload callers**

Preserve Task 1's exact duplicate-risk acknowledgement. Lock the UI while the operation key is unresolved. Clear pending state only when canonical state confirms success, definite failure, or documented absence after deadline.

- [ ] **Step 6: Remove the legacy generic API export**

```bash
rg -n "\bapi<|\bapi\(" web/src --glob '!lib/api.ts' --glob '!*.test.*'
```

Expected: empty. Then remove `api` from `web/src/lib/api.ts`; every call is visibly `apiRead` or `apiMutation`.

- [ ] **Step 7: Run complete client/runtime regression**

```bash
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
npm test -- src/services/replyDraftService.test.ts src/api/upload.routes.test.ts src/services/codexRuntimeClient.test.ts src/api/ai.routes.test.ts
npm --prefix codex-runtime test
npm --prefix codex-runtime run build
```

- [ ] **Step 8: Commit and review**

```bash
git add docs/client-operation-contracts.md web/src/lib/api.ts web/src/pages/Keywords.tsx web/src/pages/Keywords.test.tsx web/src/pages/Sequences.tsx web/src/pages/Sequences.test.tsx web/src/pages/SequenceEditor.tsx web/src/pages/SequenceEditor.test.tsx web/src/pages/HistoricalRecovery.tsx web/src/pages/HistoricalRecovery.test.tsx web/src/pages/Insights.tsx web/src/pages/Insights.test.tsx web/src/pages/Assistant.tsx web/src/pages/Assistant.test.tsx web/src/components/KeywordForm.tsx web/src/components/KeywordForm.test.tsx web/src/components/MediaUpload.tsx web/src/components/MediaUpload.test.tsx web/src/components/ai/AiConnectionCard.tsx web/src/components/ai/AiConnectionCard.test.tsx web/src/components/conversations/DmThreadDrawer.tsx web/src/components/conversations/DmThreadDrawer.test.tsx web/src/components/conversations/DmRecoveryList.tsx web/src/components/conversations/DmRecoveryList.test.tsx web/src/components/conversations/DmRecoveryDrawer.tsx web/src/components/conversations/DmRecoveryDrawer.test.tsx web/src/components/historical/HistoricalCandidateDrawer.tsx web/src/components/historical/HistoricalCandidateDrawer.test.tsx
git commit -m "fix: reconcile unknown console mutations safely"
```

Independent review compares every scanned mutation to the inventory and rejects generic invalidation without route-specific proof.

---

### Task 8: Align the recovery/client product record and verify the complete slice

**Files:**

- Modify: `PRODUCT.md`
- Modify: `docs/client-operation-contracts.md`
- If necessary, create: `codex-runtime/vitest.config.ts` so `npm --prefix codex-runtime test` works directly.

**Interfaces:**

- Consumes: Tasks 3–7.
- Produces: complete transport/recovery evidence for the combined release report.

- [ ] **Step 1: Correct the product record**

State that DM Recovery automates public comments, Scheduled/Due are automation states rather than approval queues, `send_uncertain` has no automatic retry, reads are abortable, mutations can be unknown, and Historical Recovery retains its separate safety boundary.

- [ ] **Step 2: Compare the real mutation scan to the inventory**

```bash
rg -n "apiMutation|method: \"(POST|PATCH|PUT|DELETE)\"" web/src --glob '*.ts' --glob '*.tsx'
```

Every result must have an explicit row in `docs/client-operation-contracts.md`.

- [ ] **Step 3: Run retry, copy, and timeout scans**

```bash
rg -n "retry:\s*[1-9]|retry\(.*apiMutation|mutationFn:.*apiRead" web/src
rg -n "outbound DM|released|nothing.*sends|send on its own" web/src PRODUCT.md
rg -n "Promise\.race" web/src/lib/api.ts web/src/lib/requestDeadline.ts
```

Expected: no unsafe mutation retry, false recovery copy, or fetch-level race remains.

- [ ] **Step 4: Run the whole slice**

```bash
npm test
npm run build
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
npm --prefix codex-runtime test
npm --prefix codex-runtime run build
git diff --check
```

- [ ] **Step 5: Commit and review**

```bash
git add PRODUCT.md docs/client-operation-contracts.md
if test -f codex-runtime/vitest.config.ts; then git add codex-runtime/vitest.config.ts; fi
git commit -m "docs: record recovery and client operation contracts"
```

Stage only a runtime config file if it was actually required. Review must confirm the direct package command succeeds and no undocumented alternate command is needed.

---

### Task 9: Move follower charts to paper-safe semantic tokens

**Files:**

- Create: `web/src/lib/chartPalette.ts`, `web/src/lib/chartPalette.test.ts`
- Modify: `web/src/index.css`, `web/src/lib/followerCountry.ts`, `web/src/lib/followerCountry.test.ts`, `web/src/components/home/DailyAddsChart.tsx`, `web/src/components/home/HomePanels.test.tsx`, `DESIGN.md`

**Interfaces:**

- Produces: `REGION_CHART_COLORS`, `COUNTRY_CHART_COLORS`, `CHART_OTHER`, `CHART_MEAN`, `CHART_PROVISIONAL`, and `CHART_SEMANTIC_MARK_OPACITY`.
- Consumed by: region/country Home chart modes and final visual QA.

- [ ] **Step 1: Write WCAG contrast and rendered-SVG RED tests**

Every semantic mark must reach 3:1 contrast on both paper surfaces. Assert mean/provisional strokes contain no white value, provisional state uses a dash, and no semantic mark or ancestor has opacity below 1.

- [ ] **Step 2: Run RED**

```bash
npm --prefix web test -- src/lib/chartPalette.test.ts src/components/home/HomePanels.test.tsx
```

- [ ] **Step 3: Add the approved opaque palette**

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

Mirror named tokens in CSS and `DESIGN.md`.

- [ ] **Step 4: Migrate chart modes without group fading**

Use dash/outline for provisional data and outline/background hit target for selection. Do not fade semantic series to distinguish state.

- [ ] **Step 5: Reconcile design authority**

Neutral Finding remains authoritative. Moss is for focus and affirmative actions, not Today’s Read surface or data series.

- [ ] **Step 6: Verify and commit**

```bash
npm --prefix web test -- src/lib/chartPalette.test.ts src/lib/followerCountry.test.ts src/components/home/HomePanels.test.tsx
npm --prefix web run build
git add DESIGN.md web/src/index.css web/src/lib/chartPalette.ts web/src/lib/chartPalette.test.ts web/src/lib/followerCountry.ts web/src/lib/followerCountry.test.ts web/src/components/home/DailyAddsChart.tsx web/src/components/home/HomePanels.test.tsx
git commit -m "fix: move follower charts onto the paper palette"
```

---

### Task 10: Run the integrated pre-production release gate

**Files:**

- No feature files by default.
- Modify only a failing task's owned files if a gate reveals a real regression; rerun that task's review before continuing.

**Interfaces:**

- Consumes: Tasks 1–9 and all previously completed measurement/guide/interface work.
- Produces: timestamped command evidence for Task 11's QA report.

- [ ] **Step 1: Confirm clean scope and database target**

```bash
git status --short
docker ps --filter name=codex-maison-qa-postgres --format '{{.Names}} {{.Status}} {{.Ports}}'
```

Expected: clean tracked worktree and exactly the healthy loopback QA container at `127.0.0.1:55439`.

- [ ] **Step 2: Validate Prisma and run database contracts with no skips**

```bash
npx prisma format
npx prisma validate
npx prisma generate
DATABASE_URL='postgresql://postgres:codex_qa_only@127.0.0.1:55439/insta_contract' MIGRATION_TEST_DATABASE_URL='postgresql://postgres:codex_qa_only@127.0.0.1:55439/insta_contract' MIGRATION_TEST_DATABASE_DISPOSABLE=true npm test -- src/services/guideDeliveryMigrationContract.test.ts src/services/guideDeliveryRepositoryContract.test.ts
```

Expected: all contracts execute, zero skips.

- [ ] **Step 3: Run the full backend serially against the disposable database**

```bash
DATABASE_URL='postgresql://postgres:codex_qa_only@127.0.0.1:55439/insta_contract' MIGRATION_TEST_DATABASE_URL='postgresql://postgres:codex_qa_only@127.0.0.1:55439/insta_contract' MIGRATION_TEST_DATABASE_DISPOSABLE=true npm test -- --maxWorkers=1
npm run build
```

Record exact file/test/pass/fail/skip counts. A contended or interrupted run is discarded and repeated; it is not combined with partial reruns.

- [ ] **Step 4: Run web, E2E, and runtime matrices**

```bash
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
npm --prefix web run test:e2e
npm --prefix codex-runtime test
npm --prefix codex-runtime run build
```

- [ ] **Step 5: Run ownership, privacy, operation, and design scans**

```bash
npm run check:guide-delivery-bypasses
rg -n "\bapi<|\bapi\(" web/src --glob '!lib/api.ts' --glob '!*.test.*'
rg -n "retry:\s*[1-9]|mutationFn:.*apiRead|Promise\.race" web/src
rg -n "moss tint|moss-soft.*read|outbound DM|nothing.*sends|/users.*destination|Console surfaces \(12 routes\)" PRODUCT.md DESIGN.md web/index.html web/src
rg -n "rgb\(255 255 255|white|#fff" web/src/components/home/DailyAddsChart.tsx
git diff --check
```

Expected: only explicitly reviewed benign matches; no ownership bypass, generic production API call, unsafe mutation retry, stale copy, or white semantic chart stroke.

- [ ] **Step 6: Run the read-only active-guide audit**

```bash
npm run audit:guide-message-lengths
```

Record ID/length-only output and exit code. Exit `1` is `NO-GO` and requires the author to supply replacement prose; no SQL update or automatic split is permitted.

- [ ] **Step 7: Record inherited dependency risk without changing the verdict language**

```bash
npm audit --omit=dev
npm --prefix web audit --omit=dev
npm --prefix codex-runtime audit --omit=dev
npm ls express
```

Record advisories and Express version. Do not call an inherited advisory “clean”; link it to its separate hardening decision.

---

### Task 11: Perform fixture-only visual QA and write the combined report

**Files:**

- Create: `docs/qa/2026-08-16-maison-editorial-production-readiness-qa.md`
- Create: `docs/qa/artifacts/2026-08-16-maison-editorial/desktop/*.png`
- Create: `docs/qa/artifacts/2026-08-16-maison-editorial/mobile/*.png`
- Modify: `PRODUCT.md`, `DESIGN.md`, `web/index.html`, `web/src/index.css`

**Interfaces:**

- Consumes: exact command evidence from Task 10 and deterministic Playwright fixture state.
- Produces: one pre-production verdict: `NO-GO` or `READY FOR CONTROLLED ROLLOUT`.

- [ ] **Step 1: Create the empty evidence structure without prefilling PASS**

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

- [ ] **Step 2: Align route and design authority**

Record eleven destinations: Home above Measure / Publish / Audience / System; remove `/users` as a destination and record the People redirect; add `/dm-recovery` and its automatic public-comment behavior. Keep Today’s Read neutral and chart tokens at the 3:1 floor.

- [ ] **Step 3: Capture deterministic desktop/mobile artifacts**

Capture Home, follower chart, Conversations People, DM Recovery, Historical Recovery, Sequence Editor, Insights, and Funnels. Use fixtures only. Never boot the local backend against production and never place real user content in artifacts.

- [ ] **Step 4: Perform the manual checklist**

Verify chart marks/mean/provisional outline on paper, no dark shell, correct mobile titles, truthful loading/error/empty states, automatic public-action wording, visible guide review, keyboard focus, touch targets, and reduced motion.

- [ ] **Step 5: Populate every evidence row**

For each Task 10 command, record timestamp, commit, command, exit code, exact counts, skips, and implementing test/commit. Link every screenshot. Partial suites remain visibly partial.

- [ ] **Step 6: Apply the staged verdict rule**

- `NO-GO`: any automated, database, active-guide audit, static, or visual gate fails.
- `READY FOR CONTROLLED ROLLOUT`: every pre-production gate passes, but no real Meta cohort has been authorized/run.
- Never use `CONTROLLED PATH STABLE` without the later authorized cohort evidence.
- Never use `LEGACY REMOVAL AUTHORIZED` without a separate named-owner decision.

- [ ] **Step 7: Commit the report and artifacts**

```bash
git add PRODUCT.md DESIGN.md web/index.html web/src/index.css docs/qa/2026-08-16-maison-editorial-production-readiness-qa.md docs/qa/artifacts/2026-08-16-maison-editorial
git commit -m "docs: record maison production readiness evidence"
```

---

### Task 12: Audit final scope and hand off at the production authorization gate

**Files:**

- No code changes expected.
- Existing draft PR: update only after the local verdict is recorded; do not merge.

**Interfaces:**

- Consumes: Task 11's committed QA verdict.
- Produces: a reviewable branch and an explicit list of deferred production actions.

- [ ] **Step 1: Inspect final branch scope**

```bash
git status --short
git log --oneline --decorate -30
git diff origin/main...HEAD --stat
git diff --check origin/main...HEAD
```

Expected: clean worktree and only planned feature, test, migration, documentation, and fixture files.

- [ ] **Step 2: Confirm production flags remain inactive in code/docs evidence**

Verify the runbook still requires disabled/0%/empty allowlist and the QA report contains no controlled Meta evidence.

- [ ] **Step 3: Stop the exact disposable QA container after all evidence is captured**

```bash
docker stop codex-maison-qa-postgres
```

Do not stop or remove any other container. Because this container was created with `--rm`, stopping it removes only that disposable QA instance.

- [ ] **Step 4: Update the existing draft PR without merging**

Push `design/maison-editorial`, update draft PR #15 with the QA verdict, exact test counts, database/audit evidence, and the production authorization pause. Do not mark it ready for merge if the QA verdict is `NO-GO`.

- [ ] **Step 5: Stop at the truthful terminal state**

If every gate passed, report `READY FOR CONTROLLED ROLLOUT`. Otherwise report `NO-GO` with the exact failed gate and keep production disabled.

---

## Deferred production-only phase: controlled Meta cohort

This phase is not part of the remaining local build. It starts only after explicit owner authorization and a `READY FOR CONTROLLED ROLLOUT` report.

- [ ] Apply the additive migration first.
- [ ] Deploy with guide delivery disabled, rollout 0, and an empty allowlist.
- [ ] Verify disabled worker and legacy behavior.
- [ ] Add only the authorized Instagram user ID, retain percentage 0, then enable the ledger.
- [ ] Verify a non-allowlisted probe remains legacy without receiving a test message.
- [ ] Run controlled two-text, image-plus-caption rejection/resume, ambiguous-timeout, and `Already delivered` cases.
- [ ] Record only delivery/unit IDs and statuses; never record private guide text or provider tokens.
- [ ] Use `CONTROLLED PATH STABLE` only when there is no unexplained duplicate, completion mismatch, or unresolved uncertain outcome.

## Deferred post-stability phase: remove the legacy sender

This phase remains Guide Task 13 and is not authorized by completing the local build.

- [ ] Obtain a separate named-owner `LEGACY REMOVAL AUTHORIZED` decision after controlled stability.
- [ ] Remove the legacy ownership branch and `sequenceSender` only then.
- [ ] Remove temporary rollout flags only after all traffic is durably owned.
- [ ] Rerun the full database/web/runtime/E2E/privacy/bypass matrix.
- [ ] Deploy and monitor with a rollback path that preserves ledger rows and uncertain states.

## Self-review checklist

- [x] Every remaining requirement from guide Tasks 11–12, recovery Tasks 2–6, and interface Tasks 1 and 5 maps to a task above.
- [x] Guide Task 13 is explicitly deferred rather than falsely counted as unfinished local code.
- [x] All code tasks include RED, GREEN, focused verification, broad verification, review, and commit boundaries.
- [x] All cross-task names are consistent: `apiRead`, `apiMutation`, `MutationOutcomeUnknownError`, `createOperationId`, `GuideDeliveryReview`, and `clientMessageId`.
- [x] No task authorizes a production database write, Meta send, rollout flag change, merge, or legacy removal.
- [x] Final status wording is limited to `NO-GO`, `READY FOR CONTROLLED ROLLOUT`, `CONTROLLED PATH STABLE`, and `LEGACY REMOVAL AUTHORIZED` at their proper gates.
