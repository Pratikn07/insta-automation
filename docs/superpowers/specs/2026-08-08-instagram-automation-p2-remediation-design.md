# Instagram Automation P2 Remediation Design

**Date:** 2026-08-08  
**Status:** Draft for written review  
**Source:** `docs/qa/2026-08-07-instagram-automation-features-1-4-deep-qa.md`  
**Scope:** QA-18, QA-19, and QA-20

## Goal

Complete every locally actionable P2 item from the Features 1–4 deep-QA report while preserving the behavior and files currently being changed by the separate P1 effort. The work will make recovery copy consistent, make historical-recovery and conversation state operable and auditable from the dashboard, restore a clean lint baseline, and add browser-level regression coverage.

Verification that requires a migration-test database or live Meta credentials will not be simulated. Those checks will be documented with exact commands and prerequisites and recorded as externally blocked until the required credentials are available.

## Non-goals

- Rewriting the dashboard or changing its visual design system.
- Changing recovery eligibility, delivery, claim, lifecycle, or historical-selection policy owned by the active P1 work.
- Adding a new database migration. The required fields and relationships already exist in the current schema.
- Sending comments or DMs to real Instagram accounts without an explicitly configured controlled Meta test account.
- Hiding historical data. Canonical views become the default, while an explicit raw-history mode remains available.

## Current State and Rebaseline

The original QA report found inconsistent keyword casing in both prospective and historical recovery copy. Subsequent P1 changes now uppercase the historical copy path, but the prospective `renderRecoveryCopy` path still only trims the supplied keyword. QA-18 therefore remains open for the prospective path and for consolidating the two paths behind one normalization rule.

The historical-recovery API already supports campaign staging, and the schema already contains candidate review timestamps, canonical intent/conversation relationships, trigger records, event logs, and media permalink sources. QA-19 can be completed by exposing and using these existing capabilities rather than introducing new persistence.

The web lint baseline currently contains nine errors. QA-20 also lacks historical-recovery browser coverage and cannot run credential-gated database or live Meta checks in the current environment.

## Design

### 1. Shared Recovery-Copy Normalization

Introduce one side-effect-free helper for user-visible recovery keywords. It will:

1. trim leading and trailing whitespace;
2. convert the keyword to uppercase using JavaScript's standard `toUpperCase()` behavior; and
3. return the normalized value without changing matching, storage, or eligibility behavior.

Both prospective and historical recovery-copy renderers will use the helper. Existing wording stays unchanged apart from consistent keyword casing. Unit tests will start with failing mixed-case and surrounding-whitespace examples for both copy paths, then cover the shared helper directly.

### 2. Historical-Recovery API

#### Campaign approval identity

`POST /api/historical-recovery/campaigns/:campaignId/approve` will no longer accept or trust an `approvedBy` request-body value. The authenticated administrator identity from `req.adminEmail` will be required and passed into the campaign approval service. A missing authenticated identity will use the existing authentication error path. The dashboard will send an empty request body.

#### Stable candidate pagination

`GET /api/historical-recovery/candidates` will accept the existing campaign, view, limit, and cursor parameters plus an optional ISO-8601 `asOf` parameter.

- On the first page, the server generates an `asOf` timestamp if the client did not supply one.
- Every query in the traversal is bounded to candidates with `createdAt <= asOf`.
- Ordering remains deterministic using the existing comment-time ordering plus the unique candidate ID tie-breaker.
- The response always returns the effective `asOf`, the page of candidates, counts for the selected scope, and `nextCursor` when another page exists.
- The client sends the same `asOf` with every subsequent cursor request and deduplicates by candidate ID before rendering.

This freezes the set of candidate records created by the snapshot time and prevents duplicates caused by newly inserted candidates. A candidate's mutable delivery outcome can still change while the operator is viewing the snapshot; the UI will show the latest returned outcome and refetch after operator actions.

The response contract will be:

```ts
type HistoricalCandidateListResponse = {
  candidates: HistoricalCandidateSummary[];
  counts: Record<HistoricalCandidateView, number>;
  nextCursor: string | null;
  asOf: string;
};
```

#### Candidate detail

Add `GET /api/historical-recovery/candidates/:candidateId`. It returns an operator-safe snapshot containing:

- the candidate's source comment, phase, outcome, attempts, timestamps, and review state;
- campaign identity and status;
- the selected canonical intent and its keyword;
- trigger evidence used to connect the candidate to that intent;
- canonical conversation ownership plus alias-conversation summaries and reconciliation reason;
- audit events whose structured payload identifies this candidate; and
- a resolved source-media permalink.

Media links will be resolved from stored permalink-bearing records (`ReelMeta`, `FeedPostMeta`, or the associated keyword media permalink). The API will return `null` when no verified permalink exists. It will never fabricate an Instagram post URL from a Graph API reply/comment ID. Provider tokens, raw credentials, and raw provider error bodies are excluded.

#### Mark reviewed

Add `POST /api/historical-recovery/candidates/:candidateId/mark-reviewed` for attention-required outcomes (`send_failed` and `send_uncertain`). The operation is idempotent:

- the first call writes `reviewedAt` and an audit event with the authenticated administrator as actor;
- subsequent calls leave the original review timestamp intact and succeed without creating duplicate review events;
- ineligible outcomes return the existing validation-style error response; and
- a missing candidate returns the existing not-found response.

The successful response will be `204 No Content`, matching the prospective recovery-reminder action.

#### Existing staging endpoint

The existing campaign staging endpoint remains the source of truth. No duplicate endpoint will be added. The UI will submit `batchSize`, `hourlyCap`, and `dailyCap`, and server-side validation remains authoritative.

### 3. Historical-Recovery Dashboard

The page will be decomposed into focused, testable components while retaining the current styling:

- a campaign selector that preserves the selected campaign while refreshed data still contains it and otherwise falls back to the first available campaign;
- phase-aware headings and explanations that distinguish candidates who never received the original reply from candidates whose intended journey was interrupted later;
- an approval action that uses authenticated server identity;
- a staging form prefilled from the active campaign and wired to the existing staging endpoint;
- infinite candidate pagination with a visible **Load more** action and the first page's fixed `asOf` value;
- a candidate-detail drawer showing source evidence, canonical intent, aliases, triggers, audit history, and a source-media link only when a verified permalink exists; and
- a **Mark reviewed** action for eligible attention-required candidates, followed by candidate-list/detail invalidation.

All mutations will disable their initiating controls while pending, display the existing error treatment on failure, and refresh only the affected campaign/candidate queries on success.

### 4. Canonical Conversation View

The conversations endpoint and dashboard will support two explicit modes:

- `canonical` (default): conversations that own at least one journey intent, plus unreconciled legacy conversations with no canonical intent; aliases are excluded from the top-level list;
- `raw`: every conversation record, including aliases, for historical investigation.

The list and count queries will use the same mode predicate so totals match visible data. Each returned item will identify whether it is canonical, an alias, or unreconciled and will include the canonical owner summary, alias count, and reconciliation reason when available.

The dashboard will add a raw-history toggle, label alias and unreconciled rows, and link alias rows back to their canonical owner where possible. Switching modes resets pagination and preserves the other supported filters.

### 5. Lint Remediation

All nine existing web lint errors will be fixed without disabling rules or adding blanket exceptions:

- `AiConnectionCard`: derive effective connection state from query data so an effect does not mirror server state into local state;
- `AppShell`: represent mobile-navigation state with the route for which it was opened, making route-change closure derived rather than effect-driven;
- `button.tsx`: move the reusable variant export to a non-component module, leaving the component module compatible with Fast Refresh;
- `Insights`: move `Metric` to module scope so component identity is stable across renders; and
- `SequenceEditor`: replace effect-driven prop/query-to-form mirroring with keyed editor/form boundaries and explicit local edit ownership.

Behavioral regression tests will be added before each non-mechanical refactor where an existing test harness can observe the behavior. The final lint command must complete with zero errors and zero new rule suppressions.

### 6. Test and Verification Strategy

Implementation will follow red-green-refactor for each behavioral change.

#### Unit and API contract coverage

- prospective and historical mixed-case recovery-copy rendering;
- authenticated approval actor and rejection of caller-controlled actor identity;
- fixed-`asOf` pagination, tie ordering, and cursor continuation;
- candidate detail evidence and verified-permalink resolution;
- idempotent historical mark-reviewed behavior and audit emission;
- canonical versus raw conversation list/count semantics; and
- the state transitions affected by the lint-driven React refactors.

#### Browser coverage

Extend the existing Playwright network harness with a historical-recovery scenario that exercises:

1. choosing a campaign other than the first campaign;
2. phase-aware copy for both no-reply and interrupted-journey candidates;
3. campaign approval;
4. stage configuration submission;
5. cursor pagination through **Load more** while retaining `asOf`;
6. candidate-detail evidence and a stored source permalink;
7. idempotent **Mark reviewed** behavior; and
8. canonical versus raw conversation display, including alias labeling.

#### Local verification commands

The implementation handoff will include fresh results for the repository's focused tests, complete unit suite, web lint, web build, and Playwright suite. Exact commands will be finalized against the package scripts during implementation planning.

#### Credential-gated verification

If `MIGRATION_TEST_DATABASE_URL` remains unavailable, database-contract suites that require a disposable migration database will be recorded as blocked rather than skipped silently. The QA report will include the exact invocation and required database characteristics.

If controlled Meta credentials remain unavailable, the final QA report will include a runbook for a sandbox/test Instagram account covering source comment creation, recovery delivery, provider response capture, reconciliation, and cleanup. No live provider mutation will be attempted without those credentials and an explicitly controlled account.

## Error Handling and Safety

- All new endpoints remain behind the existing admin authentication middleware.
- Operator identity is taken only from authenticated request context.
- Mutations are idempotent where users can safely retry them.
- Candidate details expose curated fields rather than raw database/provider objects.
- Verified stored permalinks are used as-is; missing permalinks produce no external link.
- Existing server validation and error response conventions are reused.
- Unrelated dirty P1 files will not be staged, reverted, reformatted, or included in P2 commits.

## Expected Files

The implementation is expected to touch the focused recovery-copy service/tests, historical-recovery routes/tests, conversation routes/tests, historical-recovery and conversation dashboard pages/types, the specific files with current lint failures, and the Playwright harness/specs. Exact file boundaries will be confirmed in the implementation plan after the written design is approved.

No Prisma schema or migration change is expected.

## Acceptance Criteria

### QA-18

- Prospective and historical user-visible recovery keywords use the same trim-and-uppercase rule.
- Mixed-case regression tests pass for both paths.

### QA-19

- An operator can choose, approve, configure, and inspect any campaign from the dashboard.
- Approval attribution comes from the authenticated admin, not client input.
- Candidate pagination uses a stable `asOf` traversal and exposes **Load more**.
- Candidate detail shows phase, source evidence, canonical intent, triggers, aliases, audit events, and only a verified media permalink.
- Attention-required historical candidates can be marked reviewed idempotently.
- Phase-aware copy no longer describes every recovery candidate as having received no reply.
- Conversation lists default to canonical/unreconciled records with an explicit raw-history mode and clear alias ownership.

### QA-20

- Web lint passes with no rule suppressions added for these fixes.
- Historical-recovery and canonical-conversation Playwright coverage passes.
- Locally runnable unit, build, lint, and browser checks pass.
- Database-contract and controlled-Meta verification either run successfully or are explicitly documented as credential-blocked with exact reproduction/runbook steps.
- The deep-QA report is updated with the result and evidence for every P2 item.

## Delivery Sequence

1. Add failing tests and implement shared keyword normalization.
2. Add failing route/service tests and implement historical approval, pagination, detail, and review contracts.
3. Add failing tests and implement canonical/raw conversation contracts.
4. Wire the historical-recovery and conversation dashboard behaviors.
5. Add Playwright regression coverage.
6. Remove the nine lint failures with focused behavior-preserving refactors.
7. Run complete local verification and update the QA report, including credential-gated blockers.

