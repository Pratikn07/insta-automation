# Maison Recovery and Client-Operation Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Describe DM Recovery’s automatic public-comment behavior truthfully and replace the blanket client timeout with abortable reads plus mutation-specific unknown-outcome reconciliation.

**Architecture:** Recovery view models translate durable worker states into explicit public-action language. The API client is split into `apiRead` and `apiMutation`: reads abort their underlying fetch, while writes surface `outcome_unknown` after dispatch and rely on route-specific canonical state or stable operation IDs before allowing a retry.

**Tech Stack:** TypeScript, React 19, TanStack Query, Express, Zod, Prisma 5, PostgreSQL, Vitest, Testing Library, Supertest.

**Spec:** [Maison Editorial production-readiness design](../specs/2026-08-16-maison-editorial-production-readiness-design.md), especially §3 and “Recovery and transport contracts.”

## Global Constraints

- DM Recovery automatically posts a public reply to the original Instagram comment after policy and worker checks. It is not a manually released outbound DM.
- UI copy must name public visibility before an owner action can affect a reminder.
- Cancellation is allowed only where the backend can still prevent a future attempt. It cannot imply deletion of an already posted comment.
- `send_uncertain` means a public reply may exist; never add an automatic retry.
- A read deadline must abort the actual `fetch`, not merely reject a competing promise.
- A mutation is never retried automatically by the API client or React Query.
- Failure before dispatch is definite. A deadline, connection loss, or abort after dispatch is `outcome_unknown`.
- An unknown mutation keeps its original operation ID through reconciliation and any explicit retry.
- Do not add a generic external-side-effect idempotency table. Existing domain state machines remain authoritative for send/approve/campaign actions.
- Database-only creates use a client-generated UUID as the entity ID so canonical state can answer whether the create happened.
- No mutation UI may turn unknown outcome into “failed, try again” before canonical state proves the operation absent.

## Plan-Set Dependencies

- Complete the measurement-truth plan first so this plan migrates the final
  `Home.tsx` query functions and the `Home.test.tsx` API mock rather than a
  moving intermediate version.
- Complete Tasks 1–2 of the guide-delivery plan before Task 4 here; those tasks
  create `src/api/messages.routes.test.ts` and
  `src/api/resources.routes.test.ts`, which this plan extends.
- The interface/release-QA plan is the final plan in the set. Its release gate
  verifies the combined result of all three implementation plans.

---

## Planned File Structure

### Create

- `web/src/lib/requestDeadline.ts` — composed abort signals and abortable promise helper.
- `web/src/lib/requestDeadline.test.ts` — timer, caller abort, and cleanup tests.
- `web/src/lib/mutationOutcome.ts` — operation IDs, unknown-outcome type, and reconciliation result.
- `web/src/lib/mutationOutcome.test.ts` — stable operation ID and outcome classification tests.
- `docs/client-operation-contracts.md` — route-by-route read/mutation inventory and reconciliation rule.
- `src/api/createReplay.ts` — database-create replay helper keyed by client UUID.
- `src/api/createReplay.test.ts` — same-payload replay and conflict tests.
- `src/api/keywords.routes.test.ts` — keyword replay and idempotent backfill-recovery contracts.
- `src/api/insights.routes.test.ts` — manual experiment replay and baseline contracts.
- `src/services/experimentService.test.ts` — client-ID experiment creation and normalized replay fields.
- `web/src/pages/Insights.test.tsx` — retained experiment operation-ID behavior.
- `web/src/components/KeywordForm.test.tsx` — retained keyword/sequence create IDs.
- `web/src/pages/Keywords.test.tsx` — unknown patch/delete reconciliation.
- `web/src/pages/Assistant.test.tsx` — advisor client-message reconciliation.
- `web/src/components/MediaUpload.test.tsx` — unknown signed-upload PUT reconciliation.
- `web/src/components/conversations/DmThreadDrawer.test.tsx` — draft state-machine reconciliation.
- `web/src/lib/signedUpload.ts`, `signedUpload.test.ts` — deterministic upload
  path, abortable PUT, and public-object reconciliation.
- `src/api/upload.routes.test.ts` — deterministic signed-path contract.

### Modify

- `web/src/lib/api.ts`, `web/src/lib/api.test.ts` — split read/mutation clients and recovery methods.
- `src/api/resources.routes.test.ts` — extend the guide-delivery route contract
  with resource create replay coverage.
- `web/src/main.tsx` — explicit no-retry mutation default and safe query retry predicate.
- All frontend query call sites listed in Task 2 — pass TanStack Query’s signal to `apiRead`.
- All frontend mutation call sites listed in `docs/client-operation-contracts.md` — use `apiMutation` and their declared reconciliation rule.
- `web/src/pages/DmRecovery.tsx`, `web/src/pages/DmRecovery.test.tsx` — truthful introductory copy.
- `web/src/components/conversations/DmRecoveryList.tsx`, `DmRecoveryList.test.tsx` — Due label and public-action health language.
- `web/src/components/conversations/DmRecoveryDrawer.tsx`, `DmRecoveryDrawer.test.tsx` — public cancellation and unknown-outcome handling.
- `web/src/components/conversations/dmRecoveryViewModel.ts`, `dmRecoveryViewModel.test.ts` — exact state vocabulary.
- `src/api/resources.routes.ts` — client-ID resource creation.
- `src/api/keywords.routes.ts` — client-ID keyword creation with replay-safe,
  idempotent backfill recovery.
- `src/api/messages.routes.ts`, `messages.routes.test.ts` — client-ID step creation; the route test is created by the guide-delivery plan’s Task 1, which must run before this task.
- `src/api/insights.routes.ts` — client-ID manual experiment creation.
- `src/services/experimentService.ts` — persist the supplied experiment ID and
  compare replay fields without recapturing a baseline.
- `src/services/replyDraftService.ts`, `replyDraftService.test.ts` — make the
  first-draft operation idempotent for one thread/inbound business key.
- `codex-runtime/src/advisorService.ts`, `advisorService.test.ts` — bind
  `clientMessageId` to one advisor turn/result across retry and restart.
- `codex-runtime/src/app.ts`, `app.test.ts` — stable pending/conflict response
  contracts for replayed advisor keys.
- `src/services/codexRuntimeClient.ts`, `codexRuntimeClient.test.ts` and
  `src/api/ai.routes.ts`, `ai.routes.test.ts` — preserve those stable advisor
  outcomes through the main API boundary.
- `src/api/upload.routes.ts` — sign the deterministic path derived from a
  client UUID rather than minting a new object path on every retry.
- `web/src/pages/Sequences.tsx`, `SequenceEditor.tsx`, `Insights.tsx`, and `KeywordForm.tsx` — retain create operation IDs through reconciliation.
- `PRODUCT.md` — automatic public recovery and request semantics.

---

### Task 1: Correct DM Recovery vocabulary and state presentation

**Files:**

- Modify: `web/src/pages/DmRecovery.tsx`
- Modify: `web/src/pages/DmRecovery.test.tsx`
- Modify: `web/src/components/conversations/DmRecoveryList.tsx`
- Modify: `web/src/components/conversations/DmRecoveryList.test.tsx`
- Modify: `web/src/components/conversations/DmRecoveryDrawer.tsx`
- Modify: `web/src/components/conversations/DmRecoveryDrawer.test.tsx`
- Modify: `web/src/components/conversations/dmRecoveryViewModel.ts`
- Modify: `web/src/components/conversations/dmRecoveryViewModel.test.ts`

**Interfaces:**

- Consumes: existing `RecoveryStatus`, `eligibleAt`, `sentAt`, and worker health DTOs.
- Produces: one truthful `RecoveryStatusView` used by list and drawer.

- [ ] **Step 1: Replace the test that asserts false manual-release copy**

In `DmRecovery.test.tsx`, delete `states that nothing sends on its own` and add:

```ts
it("states that recovery may automatically post publicly", () => {
  renderPage();
  expect(screen.getByText(/automatically post one public reminder/i)).toBeInTheDocument();
  expect(screen.getByText(/original Instagram comment/i)).toBeInTheDocument();
  expect(screen.queryByText(/nothing here sends on its own/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/released/i)).not.toBeInTheDocument();
});
```

Expand the mock `recoveryApi` with `settingsVerifications`, activation, and
retirement functions so a rejected child query cannot be swallowed while the
page test still passes.

- [ ] **Step 2: Write exact view-model state tests**

Add this table to `dmRecoveryViewModel.test.ts`:

```ts
it.each([
  [row({ status: "waiting", eligibleAt: future }), "Scheduled"],
  [row({ status: "waiting", eligibleAt: past }), "Due"],
  [row({ status: "sending" }), "Sending"],
  [row({ status: "sent", sentAt: nowIso }), "Sent publicly"],
  [row({ status: "send_failed" }), "Failed"],
  [row({ status: "send_uncertain" }), "Outcome uncertain"],
  [row({ status: "control" }), "Control"],
  [row({ status: "suppressed" }), "Suppressed"],
])("maps durable state to %s", (reminder, label) => {
  expect(recoveryStatusView(reminder, now).label).toContain(label);
});
```

Assert every `sending`, `sent`, and `send_uncertain` row has `canCancel === false`.
Retain the existing backend-supported cancellation set for unsent retryable rows,
but copy must say it prevents a future attempt rather than undoing the past.

- [ ] **Step 3: Run the focused tests and verify the current copy fails**

```bash
npm --prefix web test -- src/pages/DmRecovery.test.tsx src/components/conversations/dmRecoveryViewModel.test.ts src/components/conversations/DmRecoveryDrawer.test.tsx src/components/conversations/DmRecoveryList.test.tsx
```

Expected: false “nothing sends” assertion is replaced, Ready/Sent labels differ,
and child API mocks are incomplete.

- [ ] **Step 4: Implement the approved wording**

Use this introduction exactly, except for typographic punctuation:

```text
If no read or engagement is confirmed after the waiting period, Tiny Soho may automatically post one public reminder on the original Instagram comment. You can cancel before the worker claims it.
```

Change only the user-facing view label from `Ready` to `Due`; keep the API query
value `ready` to avoid an unnecessary backend contract migration. Update the view
model labels and descriptions so every send-related state contains `public
reminder` or `public reply` at least once in its visible detail.

Change the cancellation confirmation to:

```text
This prevents a future public-comment attempt. It cannot remove a comment that Instagram already accepted.
```

- [ ] **Step 5: Remove false source comments and rerun tests**

Search and fix comments in `DmRecovery.tsx`, `DmRecoveryList.tsx`, and
`Conversations.tsx` that call recovery an outbound DM or manual release.

```bash
rg -n "outbound DM|released|nothing.*sends|send on its own" web/src PRODUCT.md
npm --prefix web test -- src/pages/DmRecovery.test.tsx src/components/conversations/dmRecoveryViewModel.test.ts src/components/conversations/DmRecoveryDrawer.test.tsx src/components/conversations/DmRecoveryList.test.tsx
```

Expected: search returns no false behavioral claim; tests pass.

- [ ] **Step 6: Commit recovery truth**

```bash
git add web/src/pages/DmRecovery.tsx web/src/pages/DmRecovery.test.tsx web/src/components/conversations/DmRecoveryList.tsx web/src/components/conversations/DmRecoveryList.test.tsx web/src/components/conversations/DmRecoveryDrawer.tsx web/src/components/conversations/DmRecoveryDrawer.test.tsx web/src/components/conversations/dmRecoveryViewModel.ts web/src/components/conversations/dmRecoveryViewModel.test.ts web/src/pages/Conversations.tsx
git commit -m "fix: describe automatic public recovery truthfully"
```

---

### Task 2: Introduce genuinely abortable read requests

**Files:**

- Create: `web/src/lib/requestDeadline.ts`
- Create: `web/src/lib/requestDeadline.test.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/api.test.ts`
- Modify: `web/src/main.tsx`
- Modify query call sites in:
  - `web/src/pages/Home.tsx`
  - `web/src/pages/Activity.tsx`
  - `web/src/pages/Assistant.tsx`
  - `web/src/pages/Sequences.tsx`
  - `web/src/pages/Keywords.tsx`
  - `web/src/pages/Content.tsx`
  - `web/src/pages/SequenceEditor.tsx`
  - `web/src/pages/Conversations.tsx`
  - `web/src/pages/Funnels.tsx`
  - `web/src/pages/HistoricalRecovery.tsx`
  - `web/src/pages/Insights.tsx`
  - `web/src/components/UserLineage.tsx`
  - `web/src/components/KeywordForm.tsx`
  - `web/src/components/ai/AiConnectionCard.tsx`
  - `web/src/components/conversations/PeopleDirectory.tsx`
  - `web/src/components/conversations/DmThreadDrawer.tsx`
  - `web/src/components/conversations/DmRecoveryList.tsx`
  - `web/src/components/conversations/DmRecoveryDrawer.tsx`
  - `web/src/components/historical/HistoricalCandidateDrawer.tsx`
- Modify API mocks in:
  - `web/src/pages/Home.test.tsx`
  - `web/src/pages/Conversations.test.tsx`
  - `web/src/pages/DmRecovery.test.tsx`
  - `web/src/pages/HistoricalRecovery.test.tsx`
  - `web/src/pages/SequenceEditor.test.tsx`
  - `web/src/components/conversations/DmRecoveryList.test.tsx`
  - `web/src/components/conversations/DmRecoveryDrawer.test.tsx`
  - `web/src/components/historical/HistoricalCandidateDrawer.test.tsx`

**Interfaces:**

- Produces: `apiRead<T>(path, { signal, timeoutMs? })` and `RequestTimeoutError`.
- Consumed by: every TanStack query and `recoveryApi` read method.

- [ ] **Step 1: Write abort-signal unit tests**

In `requestDeadline.test.ts`, use fake timers and assert:

```ts
it("aborts the composed signal at the deadline", async () => {
  const deadline = withDeadline(undefined, 20_000);
  expect(deadline.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.signal.reason).toBeInstanceOf(RequestTimeoutError);
  deadline.dispose();
});

it("propagates a caller abort and clears the timer", () => {
  const caller = new AbortController();
  const deadline = withDeadline(caller.signal, 20_000);
  caller.abort(new DOMException("query cancelled", "AbortError"));
  expect(deadline.signal.aborted).toBe(true);
  deadline.dispose();
});

it("starts aborted when the caller was already cancelled", () => {
  const caller = new AbortController();
  caller.abort(new DOMException("query cancelled", "AbortError"));
  const deadline = withDeadline(caller.signal, 20_000);
  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.signal.reason).toBe(caller.signal.reason);
  deadline.dispose();
});
```

Add an `awaitWithSignal` test showing a never-settling Supabase promise rejects
when the signal aborts and removes its event listener.

- [ ] **Step 2: Write API tests that inspect the fetch signal**

Mock `getSession` to resolve and `global.fetch` to capture `init.signal`:

```ts
it("aborts the underlying fetch when a read reaches its deadline", async () => {
  let seenSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_url, init) => {
    seenSignal = init?.signal;
    return new Promise((_resolve, reject) =>
      seenSignal?.addEventListener("abort", () => reject(seenSignal!.reason), { once: true }),
    );
  }));
  const request = apiRead("/funnels/guide-follow", { timeoutMs: 20_000 });
  await vi.advanceTimersByTimeAsync(20_000);
  await expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
  expect(seenSignal?.aborted).toBe(true);
});
```

Also prove a caller cancellation is not mislabeled as a timeout and a completed
read disposes the timer.

- [ ] **Step 3: Run the new tests and verify `Promise.race` fails the fetch-abort assertion**

```bash
npm --prefix web test -- src/lib/requestDeadline.test.ts src/lib/api.test.ts
```

Expected: `requestDeadline` is absent and the existing fetch signal remains
unaborted after timeout.

- [ ] **Step 4: Implement the deadline primitive**

Create:

```ts
export class RequestTimeoutError extends Error {
  readonly code = "read_timeout";
  constructor(readonly timeoutMs: number) {
    super(`The read exceeded its ${timeoutMs}ms deadline.`);
    this.name = "RequestTimeoutError";
  }
}

export function withDeadline(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forward = () => {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort(parent?.reason ?? new DOMException("Aborted", "AbortError"));
  };
  if (parent?.aborted) forward();
  else parent?.addEventListener("abort", forward, { once: true });
  timer = setTimeout(
    () => controller.abort(new RequestTimeoutError(timeoutMs)),
    timeoutMs,
  );
  if (controller.signal.aborted) clearTimeout(timer);
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", forward);
    },
  };
}
```

`awaitWithSignal` races only dependency promises that cannot accept a signal;
`fetch` itself always receives the signal and is not wrapped in `Promise.race`.

- [ ] **Step 5: Implement `apiRead` and remove blanket `api()` timeout**

`apiRead` must:

1. compose the caller signal and deadline;
2. bound both `supabase.auth.getSession()` and the one allowed
   `supabase.auth.refreshSession()` with `awaitWithSignal`;
3. pass the same signal to `fetch` and the one safe 401 refresh attempt;
4. dispose listeners/timers in `finally`;
5. preserve `AbortError` for caller cancellation and `RequestTimeoutError` for deadline.

Do not export the old `withTimeout` or use `Promise.race` around fetch.

- [ ] **Step 6: Migrate every query function**

Use TanStack’s query signal:

```ts
queryFn: ({ signal }) => apiRead<Stats>("/stats", { signal })
```

For infinite queries destructure both `pageParam` and `signal`. Change
`recoveryApi.list/counts/metrics/settingsVerifications/detail` to accept an
optional signal and call `apiRead`. Do not change mutation methods yet.

Update every listed test mock at the same time. A mock for `@/lib/api` or
`../lib/api` must export `apiRead` and route it to the existing read spy; keep
`api` only where an as-yet-unmigrated mutation still imports it. This prevents
the production migration from passing while component tests fail because their
module factory exposes the old API shape.

- [ ] **Step 7: Make query retry explicit**

In `main.tsx`, replace `retry: 1` with a predicate that retries once only for a
network failure, `RequestTimeoutError`, or `ApiError.status >= 500`; never retry
4xx or caller cancellation. Keep `networkMode: "always"`.

- [ ] **Step 8: Verify read migration completeness**

```bash
rg -n "queryFn:.*\bapi<|queryFn: \(\) => api<" web/src
rg -n "list:|counts:|metrics:|settingsVerifications:|detail:" web/src/lib/api.ts
npm --prefix web test -- src/lib/requestDeadline.test.ts src/lib/api.test.ts
npm --prefix web test -- src/pages/Home.test.tsx src/pages/Conversations.test.tsx src/pages/DmRecovery.test.tsx src/pages/HistoricalRecovery.test.tsx src/pages/SequenceEditor.test.tsx src/components/conversations/DmRecoveryList.test.tsx src/components/conversations/DmRecoveryDrawer.test.tsx src/components/historical/HistoricalCandidateDrawer.test.tsx
npm --prefix web run build
```

Expected: the first search returns no generic API query. Inspect the second
search and confirm every recovery read delegates to `apiRead`; tests/build pass.

- [ ] **Step 9: Commit abortable reads**

```bash
git add web/src/lib/requestDeadline.ts web/src/lib/requestDeadline.test.ts web/src/lib/api.ts web/src/lib/api.test.ts web/src/main.tsx web/src/pages/Home.tsx web/src/pages/Home.test.tsx web/src/pages/Activity.tsx web/src/pages/Assistant.tsx web/src/pages/Sequences.tsx web/src/pages/Keywords.tsx web/src/pages/Content.tsx web/src/pages/SequenceEditor.tsx web/src/pages/SequenceEditor.test.tsx web/src/pages/Conversations.tsx web/src/pages/Conversations.test.tsx web/src/pages/DmRecovery.test.tsx web/src/pages/Funnels.tsx web/src/pages/HistoricalRecovery.tsx web/src/pages/HistoricalRecovery.test.tsx web/src/pages/Insights.tsx web/src/components/UserLineage.tsx web/src/components/KeywordForm.tsx web/src/components/ai/AiConnectionCard.tsx web/src/components/conversations/PeopleDirectory.tsx web/src/components/conversations/DmThreadDrawer.tsx web/src/components/conversations/DmRecoveryList.tsx web/src/components/conversations/DmRecoveryList.test.tsx web/src/components/conversations/DmRecoveryDrawer.tsx web/src/components/conversations/DmRecoveryDrawer.test.tsx web/src/components/historical/HistoricalCandidateDrawer.tsx web/src/components/historical/HistoricalCandidateDrawer.test.tsx
git commit -m "fix: abort timed-out reads before retrying"
```

---

### Task 3: Model mutation dispatch and unknown outcome explicitly

**Files:**

- Create: `web/src/lib/mutationOutcome.ts`
- Create: `web/src/lib/mutationOutcome.test.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/api.test.ts`
- Modify: `web/src/main.tsx`

**Interfaces:**

- Produces: `createOperationId()`, `MutationOutcomeUnknownError`,
  `apiMutation<T>()`, and `ReconciliationResult`.
- Consumed by: Tasks 4 and 5.

- [ ] **Step 1: Write outcome-classification tests**

```ts
it("creates a stable UUID suitable for an entity id", () => {
  expect(createOperationId()).toMatch(/^[0-9a-f-]{36}$/i);
});

it("carries path and operation id without request data", () => {
  const error = new MutationOutcomeUnknownError("/resources", "operation-1");
  expect(error).toMatchObject({ code: "mutation_outcome_unknown", path: "/resources", operationId: "operation-1" });
  expect(JSON.stringify(error)).not.toContain("PRIVATE-BODY");
});
```

In `api.test.ts`, distinguish two phases:

- auth deadline before `fetch` → `MutationNotDispatchedError`, fetch count zero;
- deadline after `fetch` starts → fetch signal aborted and
  `MutationOutcomeUnknownError`, fetch count one;
- network rejection or any HTTP 5xx after `fetch` starts →
  `MutationOutcomeUnknownError` because the server may have committed before
  the response failed;
- no automatic second fetch after unknown outcome;
- a contractually definite HTTP 4xx remains `ApiError`, not unknown.

- [ ] **Step 2: Run the tests and verify the current generic client cannot distinguish phases**

```bash
npm --prefix web test -- src/lib/mutationOutcome.test.ts src/lib/api.test.ts
```

Expected: new exports are absent and current timeout always produces one generic
`TimeoutError`.

- [ ] **Step 3: Implement mutation types**

```ts
export type ReconciliationResult<T> =
  | { status: "confirmed"; value: T }
  | { status: "absent" }
  | { status: "still_unknown" };

export class MutationOutcomeUnknownError extends Error {
  readonly code = "mutation_outcome_unknown";
  constructor(readonly path: string, readonly operationId: string | null) {
    super("The request was sent, but its result is not confirmed yet.");
  }
}
```

`apiMutation` accepts only non-GET methods, an optional `operationId`, and a
deadline. The auth phase uses a separate deadline before `dispatched = true`.
Once fetch starts, any timeout/abort/network rejection without a response and
any HTTP 5xx becomes unknown. Generic transport code cannot prove whether a
server-side write preceded a 5xx. Stable 4xx domain/validation responses remain
definite. Include `Idempotency-Key` only when `operationId` is provided; never
log body or headers.

- [ ] **Step 4: Prevent framework-level mutation retry**

Set:

```ts
mutations: { networkMode: "always", retry: false }
```

No component may override mutation retry to a positive value.

- [ ] **Step 5: Run the focused API tests and build**

```bash
npm --prefix web test -- src/lib/mutationOutcome.test.ts src/lib/api.test.ts
npm --prefix web run build
```

Expected: PASS.

- [ ] **Step 6: Commit the mutation transport primitive**

```bash
git add web/src/lib/mutationOutcome.ts web/src/lib/mutationOutcome.test.ts web/src/lib/api.ts web/src/lib/api.test.ts web/src/main.tsx
git commit -m "fix: distinguish unknown mutation outcomes"
```

---

### Task 4: Make database-only creates replayable by client UUID

**Files:**

- Create: `src/api/createReplay.ts`
- Create: `src/api/createReplay.test.ts`
- Modify: `src/api/resources.routes.test.ts` (created by guide-delivery Task 2)
- Create: `src/api/keywords.routes.test.ts`
- Modify: `src/api/messages.routes.test.ts` (created by guide-delivery Task 1)
- Create: `src/api/insights.routes.test.ts`
- Modify: `src/services/experimentService.ts`
- Create: `src/services/experimentService.test.ts`
- Modify:
  - `src/api/resources.routes.ts`
  - `src/api/keywords.routes.ts`
  - `src/api/messages.routes.ts`
  - `src/api/insights.routes.ts`
  - `web/src/pages/Sequences.tsx`
  - `web/src/pages/SequenceEditor.tsx`
  - `web/src/pages/Insights.tsx`
  - `web/src/components/KeywordForm.tsx`

**Interfaces:**

- Consumes: `operationId` from Task 3.
- Produces: replay-safe Resource, Keyword, ResourceMessage, and manual Experiment creates.

- [ ] **Step 1: Write the generic comparison helper test**

The helper compares an existing canonical row with normalized intended fields;
it does not execute Prisma or external work:

```ts
expect(classifyCreateReplay({ existing: { id: "id-1", name: "Guide" }, intended: { id: "id-1", name: "Guide" }, keys: ["id", "name"] }))
  .toBe("replay");
expect(classifyCreateReplay({ existing: { id: "id-1", name: "Other" }, intended: { id: "id-1", name: "Guide" }, keys: ["id", "name"] }))
  .toBe("conflict");
```

- [ ] **Step 2: Add route tests for first create, same replay, and conflicting replay**

For every route, send a required `id` UUID:

```ts
const operationId = "11111111-1111-4111-8111-111111111111";
const first = await post({ id: operationId, ...payload });
const replay = await post({ id: operationId, ...payload });
const conflict = await post({ id: operationId, ...differentPayload });
expect(first.status).toBe(201);
expect(replay.status).toBe(200);
expect(replay.body.id).toBe(operationId);
expect(conflict.status).toBe(409);
expect(conflict.body).toEqual({ error: "idempotency_conflict" });
```

Also send a mismatched `Idempotency-Key` header and body `id`; expect
`400 { error: "idempotency_key_mismatch" }` before Prisma is called.

For Keyword, assert exact active replay re-enqueues the already-idempotent
`backfillKeyword` so a crash after row commit but before the fire-and-forget call
can heal; conflicting replay must not enqueue it. For Experiment, assert replay
does not recapture the baseline. For ResourceMessage, compare only the
request-owned resource/type/body/media fields—not `order`, which the server
allocates and later reorder operations may legitimately change.

- [ ] **Step 3: Run route tests and verify create schemas reject or ignore client IDs**

```bash
npm test -- src/api/createReplay.test.ts src/api/resources.routes.test.ts src/api/keywords.routes.test.ts src/api/messages.routes.test.ts src/api/insights.routes.test.ts src/services/experimentService.test.ts
```

Expected: helper absent and route replay does not return the canonical row.

- [ ] **Step 4: Accept and persist client UUIDs**

Add `id: z.string().uuid()` to the four create schemas and pass it into Prisma’s
`data`. On a primary-key `P2002`, load by `id`, compare only normalized fields
owned by that request, and return:

- `200` with the canonical row for an exact replay;
- `409 { error: "idempotency_conflict" }` for a mismatched payload;
- the existing domain-specific duplicate response when a different ID conflicts
  with a business unique key.

If an `Idempotency-Key` header is present, require it to equal body `id`.
Do not repeat a non-idempotent after-create effect on replay. The Keyword
backfill is the explicit exception: it is documented and tested as idempotent,
so an exact active replay re-enqueues it to close the commit-before-dispatch
crash gap.

Change `createExperiment` to accept and persist `id`. Its replay comparison
normalizes `postedAt` to an ISO instant and compares hypothesis, variable,
reel IDs, and postedAt only. Baseline, status, timestamps, and measured fields
are server-owned and must not create a false conflict.

- [ ] **Step 5: Retain operation IDs in create UIs**

Create the UUID when an owner begins the create attempt, not inside `mutationFn`.
Keep it in a ref/state through unknown outcome and explicit retry. Include it as
both body `id` and `Idempotency-Key`:

```ts
const operationIdRef = useRef(createOperationId());
apiMutation<Resource>("/resources", {
  method: "POST",
  operationId: operationIdRef.current,
  body: JSON.stringify({ id: operationIdRef.current, name, description }),
});
```

After confirmed success, reset the operation ID for the next new entity. After
unknown outcome, refetch the relevant collection and match `id`; if present,
treat it as success. If absent only after the original request's server deadline
has elapsed and a successful canonical read completes, offer retry with the same
ID. A fixed count of fast refetches is not proof while the first request may
still be executing.

- [ ] **Step 6: Run focused backend/frontend tests**

```bash
npm test -- src/api/createReplay.test.ts src/api/resources.routes.test.ts src/api/keywords.routes.test.ts src/api/messages.routes.test.ts src/api/insights.routes.test.ts src/services/experimentService.test.ts
npm --prefix web test -- src/pages/SequenceEditor.test.tsx src/pages/Insights.test.tsx src/components/KeywordForm.test.tsx
npm run build
npm --prefix web run build
```

Create `web/src/pages/Insights.test.tsx` and
`web/src/components/KeywordForm.test.tsx` with first-create,
unknown-then-confirmed, and same-ID retry cases. Extend
`web/src/pages/SequenceEditor.test.tsx` and the guide plan’s
`web/src/pages/Sequences.test.tsx` with the same contracts for step and resource
creation.

- [ ] **Step 7: Commit replay-safe creates**

```bash
git add src/api/createReplay.ts src/api/createReplay.test.ts src/api/resources.routes.ts src/api/resources.routes.test.ts src/api/keywords.routes.ts src/api/keywords.routes.test.ts src/api/messages.routes.ts src/api/messages.routes.test.ts src/api/insights.routes.ts src/api/insights.routes.test.ts src/services/experimentService.ts src/services/experimentService.test.ts web/src/pages/Sequences.tsx web/src/pages/Sequences.test.tsx web/src/pages/SequenceEditor.tsx web/src/pages/SequenceEditor.test.tsx web/src/pages/Insights.tsx web/src/pages/Insights.test.tsx web/src/components/KeywordForm.tsx web/src/components/KeywordForm.test.tsx
git commit -m "fix: make console creates replay-safe"
```

---

### Task 5: Migrate state transitions and external actions to canonical reconciliation

**Files:**

- Modify: `web/src/lib/api.ts`
- Modify mutation call sites in:
  - `web/src/pages/Keywords.tsx`
  - `web/src/pages/Sequences.tsx`
  - `web/src/pages/SequenceEditor.tsx`
  - `web/src/pages/HistoricalRecovery.tsx`
  - `web/src/pages/Insights.tsx`
  - `web/src/pages/Assistant.tsx`
  - `web/src/components/KeywordForm.tsx`
  - `web/src/components/MediaUpload.tsx`
  - `web/src/components/ai/AiConnectionCard.tsx`
  - `web/src/components/conversations/DmThreadDrawer.tsx`
  - `web/src/components/conversations/DmRecoveryList.tsx`
  - `web/src/components/conversations/DmRecoveryDrawer.tsx`
  - `web/src/components/historical/HistoricalCandidateDrawer.tsx`
- Modify corresponding existing component/page tests.
- Create missing operation tests:
  - `web/src/pages/Assistant.test.tsx`
  - `web/src/components/MediaUpload.test.tsx`
  - `web/src/components/conversations/DmThreadDrawer.test.tsx`
- Modify backend business-key contracts:
  - `src/services/replyDraftService.ts`
  - `src/services/replyDraftService.test.ts`
  - `codex-runtime/src/advisorService.ts`
  - `codex-runtime/src/advisorService.test.ts`
  - `codex-runtime/src/app.ts`
  - `codex-runtime/src/app.test.ts`
  - `src/services/codexRuntimeClient.ts`
  - `src/services/codexRuntimeClient.test.ts`
  - `src/api/ai.routes.ts`
  - `src/api/ai.routes.test.ts`
  - `src/api/upload.routes.ts`
  - `src/api/upload.routes.test.ts`
- Create: `web/src/lib/signedUpload.ts`
- Create: `web/src/lib/signedUpload.test.ts`

**Interfaces:**

- Consumes: `apiMutation`, unknown outcome, and operation IDs.
- Produces: no remaining generic `api()` mutation and a tested reconciliation rule per route.

- [ ] **Step 1: Create the route inventory before changing call sites**

Write `docs/client-operation-contracts.md` with one row per frontend mutation:

| Operation family | Routes | Contract after unknown outcome |
| --- | --- | --- |
| Entity create | resources, keywords, messages, manual experiments | Refetch collection/detail by client UUID; retry same UUID only after confirmed absence. |
| Entity patch/delete/reorder | resources, keywords, messages, experiments | Refetch canonical entity/list; compare intended state; no automatic retry. |
| Recovery actions | cancel, mark-reviewed, verification activate/retire | Refetch recovery detail/registry; state transition is canonical. |
| Historical campaign actions | start/pause/resume/stop/stage/pause rollout/review | Refetch campaign/candidate; sealed state and IDs are canonical. |
| AI draft actions | create/regenerate/dismiss/approve/retry-send/patch | Initial create returns the active draft for the same thread/latest-inbound business key; later actions refetch the draft state machine; never blindly resend approved text. |
| Advisor message | `/ai/advisor/messages` | Runtime binds one exact question/result to `clientMessageId`; refetch history and keep the composer locked while that key is pending. |
| AI connection | connect/disconnect | Refetch connection status; do not start a second login while unknown. |
| Upload signing and object PUT | `/upload/sign`, signed storage URL | Client UUID deterministically owns one object path; reconcile an unknown PUT with HEAD metadata, then re-sign/retry the same path only after confirmed absence. |
| Analysis enqueue | `/insights/reels/:mediaId/analyze` | Refetch reel/job state; media ID upsert is the business key and repeated pending state is not a second job. |

List the exact source component beside every route. No mutation may be marked
“safe retry” merely because its HTTP method is PATCH or DELETE.

- [ ] **Step 2: Write unknown-outcome UI tests for the highest-risk actions**

At minimum cover:

- AI Approve & Send: unknown locks the button, refetches thread, and never calls
  approve twice;
- Historical campaign start/approve: unknown refetches campaign and does not
  repeat;
- DM Recovery cancel: unknown refetches detail/list and shows “Still confirming”;
- Sequence reorder: unknown refetches server order rather than rolling back to a
  possibly stale local order;
- keyword/resource delete: unknown keeps the row disabled until refetch resolves.
- Advisor question: unknown retains `clientMessageId`, finds a matching history
  turn, and never starts a second runtime turn for that key;
- Initial AI draft: unknown finds/returns the active draft for the same latest
  inbound rather than superseding it;
- Signed upload PUT: unknown HEAD-confirmed size/type completes successfully;
  confirmed absence re-signs and retries the same UUID-derived object path.

Use a rejected `MutationOutcomeUnknownError` followed by controlled canonical
query results. Assert `mutationFn` call count remains one.

- [ ] **Step 3: Run focused tests and verify current error handlers offer unsafe retry or rollback**

```bash
npm --prefix web test -- src/components/conversations/DmThreadDrawer.test.tsx src/components/conversations/DmRecoveryDrawer.test.tsx src/pages/HistoricalRecovery.test.tsx src/pages/SequenceEditor.test.tsx src/pages/Keywords.test.tsx src/pages/Sequences.test.tsx
npm test -- src/services/replyDraftService.test.ts src/api/upload.routes.test.ts src/services/codexRuntimeClient.test.ts src/api/ai.routes.test.ts
npm --prefix codex-runtime test -- src/advisorService.test.ts src/app.test.ts
```

Expected: current handlers treat unknown transport errors as ordinary failure.

- [ ] **Step 4: Bind the non-idempotent operations to real business keys**

Before migrating their UI callers:

- In `queueReplyDraft`, while holding the thread lock, return the existing
  active draft when it already belongs to the same authoritative latest inbound.
  Do not supersede it. Regenerate remains a separate explicit transition keyed
  by the prior draft ID.
- In the advisor runtime, coalesce concurrent asks with the same
  `clientMessageId`. Before `turn/start`, read history through a strict helper
  that does not turn read failure into `[]`: return the completed result for the
  same ID and exact question, return `advisor_outcome_pending` for a user turn
  whose turn is still running, expose a definite terminal failure when the
  stored turn ended failed/cancelled or with invalid output, and return
  `idempotency_conflict` if the same ID is reused with different text. A
  history-read failure is `still_unknown`, never absence. Test restart/history
  replay as well as in-process concurrency.
- Map `advisor_outcome_pending` and `idempotency_conflict` through the runtime
  HTTP app, main runtime client, and `/api/ai/advisor/messages` without reducing
  either to a generic 502. Response bodies contain only the stable code.
- Change `/upload/sign` to require a client UUID and derive
  `kind/<uuid>.<validated-ext>`. Re-signing the same UUID returns a new token for
  the same object path. Reject a mismatched `Idempotency-Key`/body ID.
- Implement `signedUpload.ts`: PUT with an abortable deadline; on unknown
  outcome, HEAD the public URL with `apiRead`-equivalent abort semantics and
  compare content length/type. Only a confirmed 404 after the original server
  deadline permits re-signing and retrying the same path.

Run:

```bash
npm test -- src/services/replyDraftService.test.ts src/api/upload.routes.test.ts src/services/codexRuntimeClient.test.ts src/api/ai.routes.test.ts
npm --prefix codex-runtime test -- src/advisorService.test.ts src/app.test.ts
npm --prefix web test -- src/pages/Assistant.test.tsx src/components/MediaUpload.test.tsx src/lib/signedUpload.test.ts
```

Expected: PASS with no duplicate draft, runtime turn, or storage object path.

- [ ] **Step 5: Migrate recovery API methods**

Keep read methods on `apiRead`. Move action methods to `apiMutation`, accepting an
operation ID where a domain entity does not already provide one. On unknown
outcome, invalidate the whole `recovery-reminders` tree, show “Still confirming
with Instagram state,” and disable the action. A subsequent canonical state ends
the pending UI. An unchanged state alone does not prove absence while the first
request may still be running. Offer a retry only when the documented recovery
transition is replay-safe and its reconciliation deadline has elapsed.

- [ ] **Step 6: Migrate every remaining mutation according to the inventory**

Use operation-specific query keys and comparisons. Do not create one
`onUnknown => invalidate everything` helper. The route’s component owns the
canonical fields that prove its outcome.

For external sends and campaign actions, never offer retry solely because the
HTTP request timed out. For ordinary patch/delete, refetch before deciding
whether the intended state is present or absent.

- [ ] **Step 7: Remove the legacy generic `api` export**

After migration:

```bash
rg -n "\bapi<|\bapi\(" web/src --glob '!lib/api.ts' --glob '!*.test.*'
```

Expected: no result. Every call is visibly `apiRead` or `apiMutation`.

- [ ] **Step 8: Run the full frontend, runtime, and affected backend suites**

```bash
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
npm test -- src/services/replyDraftService.test.ts src/api/upload.routes.test.ts src/services/codexRuntimeClient.test.ts src/api/ai.routes.test.ts
npm --prefix codex-runtime test
npm --prefix codex-runtime run build
```

Expected: all exit 0.

- [ ] **Step 9: Commit mutation reconciliation**

```bash
git add docs/client-operation-contracts.md web/src/lib/api.ts web/src/lib/signedUpload.ts web/src/lib/signedUpload.test.ts web/src/pages/Keywords.tsx web/src/pages/Keywords.test.tsx web/src/pages/Sequences.tsx web/src/pages/Sequences.test.tsx web/src/pages/SequenceEditor.tsx web/src/pages/SequenceEditor.test.tsx web/src/pages/HistoricalRecovery.tsx web/src/pages/HistoricalRecovery.test.tsx web/src/pages/Insights.tsx web/src/pages/Insights.test.tsx web/src/pages/Assistant.tsx web/src/pages/Assistant.test.tsx web/src/components/KeywordForm.tsx web/src/components/KeywordForm.test.tsx web/src/components/MediaUpload.tsx web/src/components/MediaUpload.test.tsx web/src/components/ai/AiConnectionCard.tsx web/src/components/ai/AiConnectionCard.test.tsx web/src/components/conversations/DmThreadDrawer.tsx web/src/components/conversations/DmThreadDrawer.test.tsx web/src/components/conversations/DmRecoveryList.tsx web/src/components/conversations/DmRecoveryList.test.tsx web/src/components/conversations/DmRecoveryDrawer.tsx web/src/components/conversations/DmRecoveryDrawer.test.tsx web/src/components/historical/HistoricalCandidateDrawer.tsx web/src/components/historical/HistoricalCandidateDrawer.test.tsx src/services/replyDraftService.ts src/services/replyDraftService.test.ts src/api/upload.routes.ts src/api/upload.routes.test.ts src/services/codexRuntimeClient.ts src/services/codexRuntimeClient.test.ts src/api/ai.routes.ts src/api/ai.routes.test.ts codex-runtime/src/advisorService.ts codex-runtime/src/advisorService.test.ts codex-runtime/src/app.ts codex-runtime/src/app.test.ts
git commit -m "fix: reconcile unknown console mutations safely"
```

---

### Task 6: Align product records and verify transport/recovery contracts

**Files:**

- Modify: `PRODUCT.md`
- Modify: `docs/client-operation-contracts.md`

- [ ] **Step 1: Update the product record**

In `PRODUCT.md`:

- replace every statement that DM Recovery releases outbound DMs with automatic
  public-comment language;
- state that Scheduled/Due are automation states, not approval queues;
- record `send_uncertain` as no-auto-retry;
- document abortable reads and unknown mutation outcomes;
- keep Historical Recovery’s separate safety boundary.

- [ ] **Step 2: Verify every frontend operation is inventoried**

Generate the source list:

```bash
rg -n "apiMutation|method: \"(POST|PATCH|PUT|DELETE)\"" web/src --glob '*.ts' --glob '*.tsx'
```

Compare every result with `docs/client-operation-contracts.md`. Add missing rows
with exact canonical reconciliation; do not add “same as above.”

- [ ] **Step 3: Run privacy and automatic-retry scans**

```bash
rg -n "retry:\s*[1-9]|retry\(.*apiMutation|mutationFn:.*apiRead" web/src
rg -n "outbound DM|released|nothing.*sends|send on its own" web/src PRODUCT.md
rg -n "Promise\.race" web/src/lib/api.ts web/src/lib/requestDeadline.ts
```

Expected: no unsafe mutation retry, false recovery copy, or fetch-level
`Promise.race` remains.

- [ ] **Step 4: Run complete verification**

```bash
npm test
npm run build
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
git diff --check
npm --prefix codex-runtime test
npm --prefix codex-runtime run build
```

Expected: all exit 0.

- [ ] **Step 5: Commit records and verification corrections**

```bash
git add PRODUCT.md docs/client-operation-contracts.md
git commit -m "docs: record recovery and client operation contracts"
```

---

## Plan Verification

- [ ] DM Recovery always names the action as an automatic public comment.
- [ ] `send_uncertain` has no send/retry action.
- [ ] A read timeout aborts the captured fetch signal before React Query retries.
- [ ] A pre-dispatch mutation failure and post-dispatch unknown outcome are distinct types.
- [ ] React Query mutation retry is explicitly false.
- [ ] Database-only creates replay by the same client UUID and reject conflicting reuse.
- [ ] Every mutation route appears in `docs/client-operation-contracts.md` with a canonical reconciliation rule.
- [ ] No UI offers immediate retry after `MutationOutcomeUnknownError`.
- [ ] Initial draft, advisor turn, and storage upload retries reuse tested
  business keys instead of duplicating work.
- [ ] Full backend/frontend tests, builds, and lint pass.
