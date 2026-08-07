# Instagram Read-Recovery Reminders: Tasks 1–18 QA Audit

## Document purpose

This document is the implementation-gap register, verification record, and release QA plan for
Tasks 1–18 in:

`docs/superpowers/plans/2026-08-06-instagram-read-recovery-reminders.md`

It supersedes the earlier Tasks 1–13-only audit for the current implementation snapshot. The
earlier document remains useful as historical evidence of which defects were found before commit
`3ac27a6` and which were subsequently corrected.

For every task, this document records:

1. what is implemented in the audited snapshot;
2. what remains missing, incorrect, unsafe, or unproven;
3. which automated, database, browser, staging, and manual cases must pass;
4. the evidence required before release acceptance.

Passing tests do not automatically make a task complete. A task is incomplete when required
behavior is absent, when a test asserts the wrong contract, or when the documented launch process
contradicts the code.

## Audit snapshot

- Branch: `feat/instagram-read-recovery-reminders`
- Audited through commit: `ac36d3b` (`fix(origin): harden the classifier against injection, loops, and blind spend`)
- Audit date: 2026-08-06
- Audit time: approximately 23:49 PDT
- Scope: implementation-plan Tasks 1–18
- Excluded: Task 19 implementation work, production deployment, live Meta writes, and historical
  recovery backfill
- Worktree before this document was written: no tracked changes; `docs/qa/` was already untracked
- Meta staging was not used. No Instagram comments or DMs were sent during this audit.

## Status vocabulary

| Status | Meaning |
|---|---|
| Complete | Planned behavior is implemented and the proportionate automated gate passed. |
| Complete, staging pending | Code-level contract is complete, but a real Meta/environment check remains a launch prerequisite. |
| Partial | At least one planned requirement is missing or implemented incorrectly. |
| Branch blocked | Core task behavior may exist, but additional branch behavior prevents approval. |
| Verification blocked | Code exists, but its required test environment was unavailable. |
| Not run | Test is documented but was not executed in this audit. |

## Fresh automated verification evidence

All commands below were run against commit `ac36d3b` during this audit.

| Gate | Command | Result |
|---|---|---|
| Backend unit/integration suite | `npm test -- --run` | PASS: 63 files passed, 2 skipped; 887 tests passed, 29 skipped |
| Backend build | `npm run build` | PASS: Prisma generation and TypeScript compilation completed |
| Recovery DB contract | Disposable PostgreSQL 16 plus `npx vitest run src/services/dmRecoveryDatabaseContract.test.ts` | PASS: 20/20 tests |
| Origin/recovery focused regression | Four focused service test files | PASS: 96/96 tests |
| Frontend suite | `cd web && npm test -- --run` | PASS: 23 files, 315/315 tests |
| Frontend production build | `cd web && npm run build` | PASS |
| Full browser suite | `E2E_PORT=5276 npm run test:e2e` | PASS: 66/66 desktop/mobile tests |
| Frontend lint | `cd web && npm run lint` | FAIL: 9 errors in existing non-recovery files |

The default local Playwright port was not used because port 5174 belonged to another worktree.
Using the default configuration initially produced 36 false failures against that other server.
The isolated-port result proves the current recovery harness passes, while also exposing a
Playwright configuration defect documented under Task 17.

The 29 skipped backend tests include opt-in database contracts. The recovery database contract
relevant to Task 1 was separately run against a disposable local PostgreSQL instance and passed
all 20 tests.

## Executive status

| Task | Status | Open work |
|---|---|---|
| 1. Durable recovery schema | Complete | Production migration-history review remains a deployment prerequisite. |
| 2. Configuration, copy, and policy | Branch blocked | The branch adds name/script/LLM-based ethnicity or national-origin inference and withholds reminders from users classified as South Asian. This was not in the approved Task 2 contract. |
| 3. Structured Graph classifier | Complete, staging pending | A settings-blocked code/subcode must still be verified with a controlled Meta account before allowlisting. |
| 4. Exact outbound/public IDs | Complete, staging pending | Confirm real Meta response shapes and ID correlation in staging. |
| 5. Recovery rows and evidence | Complete | No known implementation blocker. |
| 6. Live comment gate integration | Partial | Duplicate/replayed comment events are not atomically deduplicated before the public reply and private DM calls. |
| 7. Safe gate retries | Complete | No known implementation blocker. |
| 8. Webhook evidence ingestion | Complete, staging pending | Real signed `messaging_seen`, reaction, postback, inbound, and deletion fixtures still need staging verification. |
| 9. Completion suppression | Complete | No known implementation blocker. |
| 10. Atomic claim/cooldown/capacity | Complete | Real DB claim contract passed. |
| 11. Persistent circuit breaker | Complete | No known implementation blocker. |
| 12. Paced public worker | Partial | A configured batch of 5 can process up to 15 IDs; several boolean finalizer failures are still treated as success-like outcomes. |
| 13. Kill-switched scheduler | Complete | Production non-overlap depends on the worker guard, as documented. |
| 14. Admin API and metrics | Partial | Pagination skips a row; review is not fully race-idempotent; detail/audit history is incomplete. |
| 15. Frontend types and labels | Partial | `settings_blocked` does not always take precedence; the read-tracking field name differs from the plan. |
| 16. Recovery dashboard | Partial | Several specified filters, summaries, links, race states, legacy-copy changes, and query-isolation behaviors are absent. Lint is red. |
| 17. Browser coverage | Partial | Current suite passes, but required completion/accuracy/legacy cases are absent and the default server reuse is unsafe across worktrees. |
| 18. Launch documentation | Partial | `100:2534025` is described inconsistently, and documentation contains contradictory unread language and unapproved identity-filter operations. |

Summary: 10 tasks are complete at code level, 7 are partial, and Task 2 is branch-blocked by
additional out-of-scope behavior. This branch is not release-ready.

## Release-blocking findings

The following must be resolved before `DM_RECOVERY_ENABLED=true` is enabled in production:

1. Remove or disable identity-based treatment that infers South Asian ethnicity/national origin
   from names, usernames, or writing and withholds a requested reminder on that basis. Use
   non-sensitive market signals if geographic/business targeting is required.
2. Add an atomic processed-comment/idempotency boundary before any public reply or private gate DM
   is sent. A database uniqueness error after Meta calls is too late.
3. Enforce the configured recovery batch limit inside the worker even when due-selection headroom
   returns more candidate IDs.
4. Honor `false` from every conditional recovery finalizer and emit a reconciliation outcome
   instead of incrementing a durable-state metric that did not commit.
5. Correct Task 14 cursor pagination so the next page begins with, rather than skips, the extra
   `limit + 1` row.
6. Make `mark-reviewed` idempotent under concurrent owner requests and include old/new status in
   action audit events.
7. Complete the Task 16 UI requirements, including 409 handling, legacy uncertainty copy, filters,
   metrics, original-post fallback, user-journey link, and query isolation.
8. Reconcile the contradictory `100:2534025` operator guidance before any settings allowlist or
   incident response uses the document.
9. Restore the required frontend lint gate to green.

---

## Task 1 — Durable recovery schema and migration contract

### Implemented

- Recovery trigger, status, cohort, and suppression enums exist.
- `dm_recovery_reminder` and singleton `dm_recovery_control` exist in Prisma and SQL migrations.
- Recovery timestamps use PostgreSQL `timestamptz`.
- RLS is enabled with no permissive anonymous/authenticated policies.
- Unique comment/message identifiers and the partial one-`sending`-row-per-person index exist.
- Terminal-state constraints reject incomplete `sent`, `cancelled`, and other invalid records.
- The contract creates valid foreign-key fixtures and tests real concurrent claims.

### Fresh evidence

The disposable PostgreSQL 16 contract passed all 20 tests, including migrations, table names, RLS,
policies, singleton enforcement, uniqueness, timestamp types, terminal-state constraints, and
two-worker claim behavior.

### Remaining deployment checks

- Confirm whether the feature migration has already been applied to any shared environment.
- Never edit an already-applied migration; create a follow-up migration if production history
  differs.
- Run `prisma migrate deploy` against staging before application code is enabled.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T1-01 | Migrate a completely empty local database. | All migrations apply without manual SQL. | PASS |
| T1-02 | Inspect table names, enums, and timestamp types. | Exact schema contract exists. | PASS |
| T1-03 | Inspect RLS and policies. | RLS enabled; no permissive public policy. | PASS |
| T1-04 | Insert duplicate `comment_id`. | Second insert rejected. | PASS |
| T1-05 | Insert two `sending` rows for one person. | At most one succeeds. | PASS |
| T1-06 | Run two concurrent claims for one due row. | Exactly one claim succeeds. | PASS |
| T1-07 | Insert invalid terminal states. | Named constraints reject each state. | PASS |
| T1-08 | Generate Prisma client and compile. | Build succeeds. | PASS |
| T1-09 | Apply migration to staging. | History/checksum clean; no destructive change. | Not run |

### Acceptance

Accepted at local code/database level. Staging migration review remains required before deployment.

---

## Task 2 — Configuration, approved copy, and pure policy

### Implemented

- Kill switch, delay, cooldown, batch, cap, lease, retry, experiment, and health settings are
  parsed and bounded.
- Exact no-confirmed-read and settings-fallback copy is snapshotted.
- Deterministic treatment/control allocation is implemented.
- Seen, engagement, completion, cancellation, cooldown, source availability, tracking availability,
  experiment window, and holdout decisions are covered.
- Missing read evidence is described as uncertainty, never proof that a DM was unread.

### Blocking scope drift

The branch adds `DM_RECOVERY_WESTERN_ONLY`, inferred-origin columns, a name/script token classifier,
a Gemini classifier, and a policy suppression reason named `audience_out_of_market`. The model
prompt explicitly classifies South Asian origin, including diaspora, from display name and username.
High-confidence `south_asian` results are used to withhold the public reminder.

This is not ordinary market-location targeting. It infers ethnicity or national origin from
personal identifiers and changes service behavior on that basis. The approved implementation plan
does not include this rule, and the plan history explicitly removed identity-based eligibility.
This audit cannot approve or recommend enabling that behavior.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T2-01 | Recovery disabled. | No worker send behavior. | PASS |
| T2-02 | Invalid/missing paired experiment dates. | Startup validation fails. | PASS |
| T2-03 | Render every keyword reminder. | Exact approved copy and keyword substitution. | PASS |
| T2-04 | Render settings fallback. | Exact approved fallback copy. | PASS |
| T2-05 | Repeat cohort evaluation. | Stable user/version assignment. | PASS |
| T2-06 | Seen/engaged/completed/cancelled/cooldown/newer candidate. | Correct suppression precedence. | PASS |
| T2-07 | No read evidence and otherwise eligible. | Send decision says no confirmed read, not unread. | PASS |
| T2-08 | Control cohort. | No public send; evidence retained. | PASS |
| T2-09 | Identity-origin switch enabled. | No treatment difference based on inferred ethnicity/national origin. | FAIL: current branch withholds |

### Acceptance

Core Task 2 requirements are implemented, but the branch is blocked until identity-based eligibility
is removed from the recovery decision path.

---

## Task 3 — Structured Graph failure classification

### Implemented

- Errors are normalized into safe HTTP status, numeric Graph code/subcode, trace, and transport
  categories.
- Classification does not guess from human-readable error strings.
- Settings-specific handling is driven by an explicit code/subcode allowlist that defaults empty.
- Rate limit, auth/permission, permanent, safe retry, and uncertain transport outcomes are separated.
- Raw provider response bodies are excluded from recovery logs.

### Remaining verification

- Reproduce an actual settings-blocked request with a controlled Instagram account.
- Capture the numeric structured signature without logging message bodies or access tokens.
- Confirm the signature cannot also mean deleted, expired, already-replied, or invalid comment.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T3-01 | Allowlist empty. | No settings-specific fallback. | PASS |
| T3-02 | Exact allowlisted code/subcode. | Settings-blocked classification. | PASS |
| T3-03 | Same text but different code/subcode. | No settings classification. | PASS |
| T3-04 | 429/code 4. | Retryable rate limit. | PASS |
| T3-05 | 401/code 190. | Auth circuit category. | PASS |
| T3-06 | Timeout/reset/unknown. | Uncertain, never automatic duplicate. | PASS |
| T3-07 | Real controlled settings rejection. | One verified numeric signature. | Not run |

### Acceptance

Complete at code level. The production allowlist must remain empty until T3-07 is verified.

---

## Task 4 — Exact outbound and public-reply identifiers

### Implemented

- Tracked private replies return the provider message ID, local DM message ID, and acceptance time.
- Public comment replies return the created reply ID or an explicit missing-ID outcome.
- Recovery scheduling consumes the exact accepted gate receipt.
- A public success without a usable reply ID becomes uncertain rather than confirmed sent.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T4-01 | Private reply accepted with provider ID. | Provider/local IDs returned and stored. | PASS |
| T4-02 | Private reply response lacks ID. | Tracking unavailable/uncertain path. | PASS |
| T4-03 | Public reply returns ID. | Exact ID finalizes `sent`. | PASS |
| T4-04 | Public reply succeeds without ID. | `send_uncertain`; no retry. | PASS |
| T4-05 | Real Meta test response. | Response fields correlate with stored identifiers. | Not run |

### Acceptance

Complete at code level; staging correlation remains required.

---

## Task 5 — Recovery rows and idempotent positive evidence

### Implemented

- Accepted gate sends create prospective recovery records.
- Settings-blocked and tracking-unavailable paths create their specific records.
- Duplicate evidence is idempotent.
- Seen, inbound, reaction, postback, quick reply, and attachment evidence populate shared engagement
  fields used by final authorization.
- Evidence timestamps preserve both provider and receipt time.
- Safe event logging avoids DM bodies and raw provider payloads.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T5-01 | Accepted gate scheduled twice for one comment. | One recovery row. | PASS |
| T5-02 | Duplicate seen event. | One durable evidence state. | PASS |
| T5-03 | Reaction/postback evidence. | Shared engagement fields populated. | PASS |
| T5-04 | Evidence while reminder is claimed. | Final authorization suppresses. | PASS |
| T5-05 | Invalid provider time. | Receipt-time fallback, safe observation. | PASS |

### Acceptance

Complete.

---

## Task 6 — Schedule recovery after a live comment gate send

### Implemented

- A successful private reply schedules recovery using the exact accepted receipt.
- Post-acceptance local persistence failure does not enqueue a duplicate private DM retry.
- Allowlisted settings rejection schedules its immediate fallback candidate.
- Retryable pre-acceptance failures enter the gate queue.
- Ambiguous initial transport outcomes create dashboard attention/tracking-unavailable evidence.
- Public acknowledgement failure does not stop private gate handling.

### Open defect: replay idempotency occurs too late

The handler resolves a keyword, opens a conversation, posts the public acknowledgement, and sends
the private gate before an atomic processed-comment guard exists. The unique recovery `commentId`
constraint can prevent a second recovery row after those outbound actions, but it cannot undo a
second public reply or gate DM already sent by a replayed/concurrent webhook.

### Required design

- Add a unique, durable processed-comment or live-gate record keyed by the Meta comment ID.
- Atomically reserve the comment before any outbound call.
- A replay must observe the reservation/result and perform no second outbound call.
- Define safe recovery for a process crash after reservation but before/after Meta acceptance;
  uncertain sends must not be blindly retried.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T6-01 | Normal accepted comment. | One public acknowledgement, one gate DM, one recovery row. | PASS |
| T6-02 | Same webhook delivered sequentially twice. | One public acknowledgement and one gate DM total. | FAIL/not guaranteed |
| T6-03 | Same webhook processed concurrently. | Exactly one outbound owner. | Missing |
| T6-04 | Recovery persistence fails after Meta success. | No gate requeue/resend. | PASS |
| T6-05 | Verified settings rejection. | No private retry; one fallback candidate. | PASS |
| T6-06 | Business-authored/ignored comment. | No conversation or recovery work. | PASS |

### Acceptance

Partial. T6-02 and T6-03 are release blockers.

---

## Task 7 — Safe queued gate retries

### Implemented

- Queue rows carry comment/media/error metadata.
- Claims use a lease and compare-and-set state transition.
- Claimed-but-unattempted rows are released when the worker stops early.
- Accepted retry sends schedule recovery from the exact receipt.
- Verified settings failures leave the private queue and schedule fallback once.
- Stale possibly-attempted sends become uncertain rather than pending.
- Permanent/auth initial failures are not needlessly queued.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T7-01 | Two workers claim one row. | One claim. | PASS |
| T7-02 | Batch stops after rate limit/auth. | Untouched claims return safely. | PASS |
| T7-03 | Accepted retry. | Gated plus one recovery row. | PASS |
| T7-04 | Crash after possible dispatch. | Uncertain; no automatic duplicate. | PASS |
| T7-05 | Verified permanent settings rejection. | Fallback candidate; no queue retry. | PASS |

### Acceptance

Complete.

---

## Task 8 — Read, reaction, postback, inbound, and deletion webhooks

### Implemented

- `messaging_seen`, reactions, postbacks, ordinary inbound messages, quick replies, attachments,
  echoes, and deletion signals are routed.
- Only exact `react` is positive; `unreact`, missing, and unknown actions do not invent engagement.
- Message IDs and provider timestamps are runtime-validated.
- Reaction/postback evidence updates both specific and shared engagement fields.
- Duplicate delivery is idempotent and deletion does not erase historical evidence.

### Remaining staging verification

- Verify signed real fixtures for every newly subscribed field.
- Confirm `read.mid` matches the stored accepted gate message ID.
- Confirm Meta retry delivery leaves one evidence update.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T8-01 | Valid read payload. | Exact message marked seen. | PASS |
| T8-02 | Exact reaction/postback. | Specific and shared engagement recorded. | PASS |
| T8-03 | Unknown/missing reaction action. | Safe no-op. | PASS |
| T8-04 | Missing/blank `mid`. | Safe acknowledgement; no write. | PASS |
| T8-05 | Quick reply/attachment. | Correct engagement kind. | PASS |
| T8-06 | Echo/duplicate/deletion. | No invented or duplicated evidence. | PASS |
| T8-07 | Real signed Meta fixtures. | Same outcomes as unit fixtures. | Not run |

### Acceptance

Complete at code level; staging webhook subscription and correlation remain launch prerequisites.

---

## Task 9 — Completion suppression

### Implemented

- Conversation completion, gate abandonment, and recovery suppression share one transaction.
- Source and same-person/same-keyword unfinished journeys receive precise completed or
  completed-elsewhere evidence.
- Control rows retain experiment assignment and completion evidence.
- A completion race is rechecked before public send.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T9-01 | Complete source journey. | Atomic completion and suppression. | PASS |
| T9-02 | Complete another matching journey. | Other unfinished rows suppressed. | PASS |
| T9-03 | Different user/keyword. | Unchanged. | PASS |
| T9-04 | Completion while claimed. | No public reminder. | PASS |
| T9-05 | Completion replay. | Idempotent. | PASS |

### Acceptance

Complete.

---

## Task 10 — Atomic claim, person cooldown, and capacity reservation

### Implemented

- Due selection honors eligibility and `nextAttemptAt`.
- Serializable transactions, per-person row locks, compare-and-set updates, and P2034 retries are
  implemented.
- The exact 24-hour cooldown boundary uses the approved strict comparison.
- Confirmed, uncertain, and currently sending attempts consume person/hourly capacity.
- Claim events are emitted only after a successful commit.
- The final policy is rechecked and the attempt is durably reserved immediately before Meta.

### Fresh evidence

The real database contract proved that exactly one of two workers claims the same row and that one
person cannot hold two simultaneous `sending` claims.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T10-01 | Two workers claim one row. | One succeeds. | PASS/real DB |
| T10-02 | Two due rows for one person. | At most one sending claim. | PASS/real DB |
| T10-03 | Attempt 23:59:59 ago. | Cooldown suppresses. | PASS |
| T10-04 | Attempt exactly 24 hours ago. | Eligible. | PASS |
| T10-05 | Uncertain attempt within cooldown/hour. | Consumes safety capacity. | PASS |
| T10-06 | Transaction rollback. | No false claim event. | PASS |

### Acceptance

Complete. Task 12 must still enforce its configured per-tick batch independently.

---

## Task 11 — Persistent circuit breaker and health snapshot

### Implemented

- Auth/permission, webhook gap, backlog, failure rate, hourly cap, and database failure reasons are
  represented safely.
- Auth/permission remains latched and cannot be overwritten by a recoverable anomaly.
- Recoverable circuits require consecutive healthy observations before closing.
- Due backlog honors future retry times.
- Reaction/postback evidence contributes through shared engagement fields.
- Database failures across evidence, claims, finalizers, health, and reconciliation contribute to
  the health signal.
- Health responses and logs expose stable categories, not raw provider errors.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T11-01 | Each anomaly reaches threshold. | Correct circuit opens. | PASS |
| T11-02 | Sample below minimum. | No noisy trip. | PASS |
| T11-03 | Auth circuit plus other anomaly. | Auth reason remains latched. | PASS |
| T11-04 | Recoverable circuit becomes healthy. | Closes only after required proof count. | PASS |
| T11-05 | Future retry backlog. | Not counted as presently due. | PASS |
| T11-06 | Database operations fail. | Stable failure count/circuit behavior. | PASS |

### Acceptance

Complete.

---

## Task 12 — Paced public-recovery worker

### Implemented

- Tick is kill-switched, non-throwing, sequential, and protected from reentrancy.
- Expired send leases become uncertain.
- Circuit health is evaluated before work.
- Only explicit approved send decisions can call Meta.
- Exact snapshotted public text is used.
- Auth, retryable rate limit, permanent, ambiguous, and missing-ID outcomes are separated.
- Attempt arithmetic and bounded exponential backoff are correct.
- A confirmed public ID becomes sent; a thrown post-acceptance persistence failure never causes a
  Meta retry.
- Late sends and precise suppression/deferred outcomes are observable.

### Open defect 1: batch limit can be exceeded

`listDueRecoveryIds(now, limit)` intentionally fetches `limit * 3` candidates to get past rows that
will be suppressed at claim time. The worker loops through every returned ID without stopping after
`batchSize` examined/claimed/sendable records. With batch size 5, as many as 15 public comments can
be posted in one tick. The existing pacing test mocks only five IDs and therefore cannot detect the
repository/worker integration error.

### Open defect 2: boolean finalizer outcomes are not consistently honored

`markRecoverySent(false)` has a reconciliation path, but the worker still ignores the boolean from
`markRecoveryRetryable`, `markRecoveryFailed`, `markRecoveryUncertain`, and
`releaseOrSuppressClaim`. It can increment failed/uncertain/suppressed counts and emit outcome
events even though no conditional database update committed.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T12-01 | Disabled tick. | No DB/Meta work. | PASS |
| T12-02 | Two simultaneous ticks. | Second reports already running. | PASS |
| T12-03 | Repository returns 15 IDs, batch 5. | At most 5 claims/public calls. | FAIL/missing regression |
| T12-04 | 29-hour overdue row. | Re-evaluated and sent if still safe. | PASS |
| T12-05 | Evidence arrives after claim. | No public send. | PASS |
| T12-06 | Public success with ID. | Conditional sent finalization. | PASS |
| T12-07 | `markRecoverySent` returns false. | No false sent metric/event. | PASS |
| T12-08 | Any other finalizer returns false. | Reconciliation; no false outcome metric. | FAIL/missing |
| T12-09 | Timeout/reset/unknown/missing ID. | Uncertain; never auto-retry. | PASS |
| T12-10 | Auth/permission. | Backoff, latched circuit, stop batch. | PASS |
| T12-11 | Rate limit below/at max. | Retry with backoff, then exhausted failure. | PASS |

### Acceptance

Partial. T12-03 and T12-08 must pass before launch.

---

## Task 13 — Kill-switched worker scheduler

### Implemented

- Disabled configuration registers no immediate tick or interval.
- Enabled configuration runs immediately and registers the configured interval.
- Synchronous throws and rejected ticks are caught with safe stable logging.
- Stop clears the timer.
- `server.ts` registers the scheduler once.
- Production non-overlap is supplied by Task 12's worker-level guard.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T13-01 | Disabled scheduler. | No run and no timer. | PASS |
| T13-02 | Enabled scheduler. | Immediate run plus one interval. | PASS |
| T13-03 | Tick rejects/throws. | Process survives; safe log. | PASS |
| T13-04 | Stop scheduler. | Exact timer cleared. | PASS |
| T13-05 | Interval fires while tick active. | Worker body does not overlap. | PASS via worker guard |

### Acceptance

Complete with an explicit dependency on Task 12's reentrancy guard.

---

## Task 14 — Admin recovery API and experiment metrics

### Implemented

- Admin-authenticated list, counts, metrics, detail, cancel, and mark-reviewed endpoints exist.
- List input is validated and view predicates are server-side.
- User enrichment is batched.
- Counts expose records and unique people.
- Experiment and accuracy structures include treatment/control outcomes, keyword breakdown, delayed
  signals, uncertainty, cooldown, failure, and health evidence.
- Cancel uses a conditional update and returns 404 versus 409 appropriately.
- Conversations expose a bounded newest recovery summary plus tracking availability.

### Open defect 1: cursor skips the extra row

The list fetches `limit + 1`, returns `rows.slice(0, limit)`, but sets `nextCursor` to
`rows[limit].id`. The next request uses that cursor with `skip: 1`. For `a,b,c` at limit 2, page one
returns `a,b`, chooses `c`, and page two starts after `c`; record `c` is never returned. The route
test currently asserts this incorrect cursor.

### Open defect 2: mark-reviewed is not race-idempotent

The conditional update checks only ID and reviewable status. It does not require `reviewedAt: null`.
Two concurrent owner requests can both update the row and both emit reviewed events.

### Open defect 3: incomplete detail/audit contract

- Detail does not return a useful related conversation journey/completion summary.
- Timeline is built from row timestamps but omits the specified initial public acknowledgement and
  explicit policy-decision event.
- Cancellation/review logs omit the prior status required by the approved audit contract.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T14-01 | Validate each view/filter. | Exact predicate and 400 on invalid input. | PASS |
| T14-02 | Three rows, limit 2, then next page. | Pages return `a,b` then `c` exactly once. | FAIL |
| T14-03 | Batched usernames. | One user lookup, no N+1. | PASS |
| T14-04 | Counts. | Records and people for every view. | PASS |
| T14-05 | Experiment metrics. | Correct windows, unique people, raw numerators. | PASS unit-level |
| T14-06 | Cancel allowed/disallowed states. | 204/404/409 race-safe results. | PASS |
| T14-07 | Concurrent mark-reviewed. | One winner; second 409/idempotent no-op. | FAIL/missing |
| T14-08 | Detail timeline. | Complete ordered comment-to-outcome story. | Partial |
| T14-09 | Audit event. | Actor, action, old status, new status, ID only. | Partial |

### Acceptance

Partial. Cursor pagination and concurrent review are release blockers; detail/audit omissions must
also be completed.

---

## Task 15 — Uncertainty-aware frontend types and labels

### Implemented

- Closed frontend unions and typed API helpers exist.
- Required no-confirmed-read tooltip is exact.
- Waiting, ready, sent, late, suppressed, control, tracking-unavailable, cancelled, failed, and
  uncertain labels exist.
- No standalone `Unread` status is presented.
- Cancel/review eligibility is derived in a pure view model.
- The one-minute on-time allowance matches the worker interval contract.

### Open findings

1. `settings_blocked` precedence is checked only inside the `waiting` switch branch. The approved
   contract says it always takes trigger-specific precedence. A settings-triggered row in another
   status is labelled by generic status first.
2. The server/frontend property is named `readTracking`, while the approved type name is
   `readTrackingAvailability`. Both sides agree with each other, but they diverge from the planned
   public contract.
3. The view model contains the additional identity-filter suppression state discussed in Task 2.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T15-01 | Full label matrix. | Exact approved labels and actions. | PASS for covered states |
| T15-02 | Search standalone `Unread`. | No status/claim. | PASS |
| T15-03 | Settings trigger in every status. | Settings-specific precedence where contract requires. | Partial |
| T15-04 | Read-tracking field contract. | Plan/API/frontend use one stable name. | Partial |
| T15-05 | Late boundary at allowance. | On-time through one minute; late afterward. | PASS |

### Acceptance

Partial until trigger precedence and the public type contract are reconciled.

---

## Task 16 — DM recovery list, drawer, and owner actions

### Implemented

- A separate `DM recovery` lens exists while the default remains `Needs reply`.
- Status tabs, people/journey counts, loading, empty, retry, pagination, and health banner exist.
- List rows use uncertainty-aware labels and do not expose stored public text.
- Detail shows the comment, stored timeline, evidence description, original-post link when present,
  cancel confirmation, and mark-reviewed where permitted.
- There is no `Send now` control.
- Successful actions invalidate the recovery query family.
- Desktop/mobile browser flows for current implemented states pass.

### Missing or incorrect requirements

1. Legacy `conversationsQ` has no `enabled: lens === "journeys"`; it fetches journey pages while
   viewing Needs reply or DM recovery.
2. The recovery lens has no keyword or cohort filters.
3. Status tabs show record counts only; the specification requires people and journeys for each
   filter.
4. Metrics are fetched, but experiment/accuracy summaries are not rendered.
5. Rows do not display the planned media/time detail or media link.
6. A missing media permalink silently omits the link instead of showing `Original post unavailable`.
7. The recovery detail is an inline bordered block, not the existing Drawer pattern.
8. There is no `View user journey` action using `UserLineage`.
9. Mutation 409s have no `This reminder changed before your action. Refreshing…` state, no
   prescribed close/refresh behavior, and general mutation errors are not shown inline.
10. The legacy expired-detail sentence still says the person `never replied`; it must say no reply
    completed the journey before expiration.
11. Legacy rows do not render the prospective recovery badge or the
    `Read status unavailable—journey predates read tracking.` secondary text.
12. The required lint gate fails with nine errors, currently in non-recovery files.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T16-01 | Initial render. | Needs reply default; no recovery/legacy unnecessary fetch. | FAIL query isolation |
| T16-02 | Recovery status/keyword/cohort filters. | All filters work and show people/journeys. | Partial |
| T16-03 | Loading/empty/error/load more. | Accessible complete states. | PASS current status filter |
| T16-04 | Health and experiment summaries. | Both rendered without raw provider text. | Partial: health only |
| T16-05 | Missing username/media. | Safe fallback including original-post unavailable. | Partial |
| T16-06 | Detail story. | Full ordered story and user journey link. | Partial |
| T16-07 | Cancel/review success. | Disabled while pending; all caches invalidated. | PASS basic path |
| T16-08 | 409 mutation race. | Exact refresh message, close/refetch. | Missing |
| T16-09 | General mutation error. | Drawer remains open with retryable inline error. | Missing |
| T16-10 | Expired legacy journey. | Revised uncertainty sentence. | FAIL |
| T16-11 | Predates/current tracking markers. | Correct secondary badge/text. | Missing |
| T16-12 | Lint/build. | Both green. | Build PASS; lint FAIL |

### Acceptance

Partial. The UI must meet T16-01 through T16-12 and lint must be green.

---

## Task 17 — Browser coverage for the recovery workflow

### Implemented and verified

- The harness mocks the HTTP boundary while mounting real page, React Query, and components.
- Recovery fixtures cover ready, seen, inbound reply, sent late, control, settings, tracking
  unavailable, uncertain review, cooldown, circuit, cancellation, and legacy lens switching.
- POSTs mutate harness state so success assertions are not network-only.
- The original-post target and timeline order are exercised.
- Focused recovery suite passed 36/36 on desktop/mobile.
- Full browser suite passed 66/66 on desktop/mobile with an isolated port.

### Missing plan cases

1. There is no explicit completion-suppression browser scenario distinct from ordinary reply.
2. There is no delayed pre-send read fixture asserting the accuracy metric increments.
3. The legacy test checks the `No confirmed reply` tab label, not the exact revised expired-detail
   narrative required by Task 16.

### Harness isolation defect

The config defaults `reuseExistingServer` to true when `E2E_PORT` is not set. On a developer machine
with another worktree already serving port 5174, `npm run test:e2e` can silently test the wrong
branch. That happened during this audit: all 36 recovery checks initially saw `Unknown scenario`
from another worktree. Setting an isolated `E2E_PORT` made all tests pass.

The test command required by the plan should be reliable without knowing that another worktree is
active. CI is isolated, but local verification is currently not hermetic.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T17-01 | Focused recovery suite, isolated port. | All desktop/mobile cases pass. | PASS 36/36 |
| T17-02 | Full browser suite, isolated port. | No legacy regressions. | PASS 66/66 |
| T17-03 | Completion suppression. | Completed label/timeline; no reminder. | Missing |
| T17-04 | Delayed pre-send read. | Accuracy false-positive metric increments. | Missing |
| T17-05 | Expired journey detail. | Exact revised narrative. | Missing |
| T17-06 | Another worktree owns default port. | Test starts own server or fails loudly. | FAIL: silently reused |

### Acceptance

Partial. Current implemented flows pass, but required cases and local server isolation remain.

---

## Task 18 — Meta setup, controlled launch, monitoring, and rollback

### Implemented

- Required webhook fields and an owner checklist are documented.
- Redacted read/reaction/postback/inbound/deletion shapes and correlation checks are described.
- The document says Business Suite's gray warning is not an API event.
- The settings allowlist begins empty and forbids message-text classification.
- Migration, disabled deployment, signal verification, two-week experiment, controlled enabling,
  first-send audit, comparison, and post-experiment sequence are documented.
- Kill-switch rollback, circuit reset SQL, gradual overdue processing, monitoring, and no migration
  rollback are documented.

### Contradiction 1: `100:2534025`

The opening of `docs/meta-verification.md` says code 100/subcode 2534025 is an account-level
rate/quota limitation and recommends verification/access work to raise the ceiling. The recovery
runbook later says not to allowlist it, describes it as an invalid-comment family, and explicitly
says the plan's rate-limit interpretation is wrong. Operators cannot safely follow both statements.

The document must be split or corrected using verified evidence. Until then, it must not drive
classifier configuration or incident response.

### Contradiction 2: unread language

README correctly says a missing receipt means `No confirmed read`, never `Unread`, but the same
paragraph says the worker would otherwise treat healthy journeys as unread ones. That wording
should describe missing positive evidence rather than claim unread state.

### Out-of-scope operational content

The latest runbook documents name/username cultural-origin inference and withholding South Asian
users, including diaspora. This is outside the approved Tasks 1–18 plan and depends on the
identity-based treatment blocked in Task 2. It should not be part of an approved launch runbook.

### QA cases

| ID | Case | Expected | Current |
|---|---|---|---|
| T18-01 | Webhook checklist. | All new fields and real fixture checks listed. | PASS |
| T18-02 | Missing read evidence wording. | No inference of unread. | Partial/contradictory sentence |
| T18-03 | Settings allowlist process. | Empty by default; structured verified pair only. | PASS |
| T18-04 | Search every `2534025` statement. | One consistent verified classification. | FAIL |
| T18-05 | Launch order. | Migration → disabled deploy → signals → experiment → enable. | PASS |
| T18-06 | Rollback/circuit reset. | Safe kill switch and trusted SQL procedure. | PASS |
| T18-07 | Identity-sensitive treatment. | No ethnicity/national-origin exclusion in runbook. | FAIL |
| T18-08 | Rehearse staging launch/rollback. | Owner records timestamps/screenshots/results. | Not run |

### Acceptance

Partial. Correct the contradictions, remove identity-based exclusion guidance, and rehearse the
runbook in staging.

---

## Cross-task end-to-end QA matrix

| ID | Scenario | Expected result | Automated evidence |
|---|---|---|---|
| E2E-01 | Comment keyword; gate accepted; no positive evidence for ten hours. | One ready treatment row; exact public reminder at most once. | Partial: UI/worker paths; duplicate webhook gap remains |
| E2E-02 | Seen arrives before eligibility. | Suppressed as seen; no public comment. | PASS |
| E2E-03 | Reaction/postback arrives after claim before authorization. | Suppressed with precise evidence. | PASS service-level |
| E2E-04 | Any inbound DM arrives after gate. | All unfinished person recoveries suppress. | PASS |
| E2E-05 | Verified settings rejection. | No private retry; immediate approved fallback candidate. | Unit PASS; real signature not run |
| E2E-06 | Private/public transport timeout. | Uncertain; never blindly retried. | PASS |
| E2E-07 | Duplicate comment event concurrently delivered. | One acknowledgement and one gate DM. | FAIL/missing atomic guard |
| E2E-08 | Worker unavailable for 29 hours. | Overdue rows retained and paced after recovery. | PASS behavior; batch cap defect remains |
| E2E-09 | One person has several due keywords. | One send per cooldown; others suppressed/superseded. | PASS |
| E2E-10 | Completion arrives during send race. | No public reminder. | PASS service-level; browser completion case missing |
| E2E-11 | Auth revoked while another anomaly exists. | Auth circuit stays latched; no sends. | PASS |
| E2E-12 | Meta accepts public reply, DB finalization fails. | Uncertain reconciliation; no duplicate. | Partial: thrown/mark-sent false covered; other finalizers not |
| E2E-13 | Kill switch off and process restarted. | No recovery worker Meta activity. | PASS unit-level |
| E2E-14 | Owner cancels while worker wins race. | One action wins; UI shows 409 refresh state. | API partial; UI missing |
| E2E-15 | Cursor through more than one recovery page. | Every row exactly once in stable order. | FAIL |

## Privacy, safety, and observability QA

Before release, inspect static search results and event samples:

```bash
rg -n 'response\.data|access_token|raw.*error|error\.message|logger\.(error|warn).*\b(err|error)\b' src
rg -n 'South Asian|south_asian|Indian|Pakistani|Bangladeshi|ethnicity|national origin|inferredOrigin|WESTERN_ONLY' src prisma README.md docs
rg -n '\bUnread\b|never replied|2534025' README.md docs web/src
```

Required result:

- No access token, private DM body, public-copy body, raw provider response, or raw exception is
  logged.
- Missing read evidence is always described as `No confirmed read` or tracking unavailable.
- No eligibility or treatment difference is based on inferred ethnicity or national origin.
- Every Graph signature has one consistent structured interpretation supported by evidence.
- Public-send metrics reconcile with durable states; a failed conditional update never produces a
  success event.

## Manual Meta staging plan

Use a non-production Instagram professional account and test-only posts/comments.

1. Subscribe `comments`, `messages`, `messaging_seen`, `message_reactions`, and
   `messaging_postbacks`.
2. Capture one signed redacted fixture for read, reaction, postback, ordinary inbound, attachment,
   quick reply, and deletion.
3. Confirm a real accepted gate returns the provider ID stored in `instagramGateMessageId`.
4. Confirm a real `read.mid` correlates to that exact ID and suppresses the reminder.
5. Replay each fixture and confirm one durable update.
6. Use a controlled message-request-disabled account and capture the structured rejection, if Meta
   exposes one.
7. Do not add the signature until it has one unambiguous meaning.
8. Run the worker with batch 1/hourly cap 1 and audit the first treatment reminder.
9. Stop the worker past eligibility, restart it, and confirm the overdue row is still re-evaluated.
10. Open an auth circuit using controlled invalid credentials, restore credentials, perform the
    documented reset, and verify gradual recovery.
11. Exercise cancel and review races from two browser sessions.
12. Verify every posted test comment manually in Instagram and remove test-only content afterward.

## Required regression additions

Add these automated tests before release:

1. Concurrent duplicate comment event results in one outbound acknowledgement and one gate DM.
2. Repository returns `batchSize * 3`; worker still makes at most `batchSize` claims/public calls.
3. Each non-sent finalizer returns `false`; worker records reconciliation without false metrics.
4. Recovery API cursor returns all rows exactly once across pages.
5. Two concurrent `mark-reviewed` requests produce one durable review/audit event.
6. Recovery detail includes related completion state and every planned timeline phase.
7. Recovery lens does not fetch legacy journey pages.
8. Keyword/cohort filters and per-filter people/journey counts work.
9. 409 and general mutation errors render their exact recovery UI.
10. Legacy expired detail uses the revised uncertainty sentence.
11. Predates-tracking rows render the required secondary text.
12. Browser completion suppression and delayed pre-send accuracy metric cases.
13. Playwright cannot reuse a server from another worktree silently.
14. Documentation consistency check for every mention of `2534025`, unread, and identity targeting.

## Final release sign-off checklist

- [ ] Task 2 identity-based suppression removed from the recovery eligibility path.
- [ ] Task 6 duplicate comment idempotency is enforced before outbound calls.
- [ ] Task 12 sends no more than its configured batch and honors every finalizer result.
- [ ] Task 14 pagination, review race, detail, and audit gaps are fixed.
- [ ] Task 15 precedence/type contract is reconciled.
- [ ] Task 16 meets all list/drawer/action/query/copy requirements.
- [ ] Task 17 missing browser cases and server isolation are fixed.
- [ ] Task 18 contains one verified Graph-signature interpretation and no identity exclusion.
- [ ] Backend full suite passes from the final commit.
- [ ] Recovery database contract passes against disposable PostgreSQL.
- [ ] Frontend full unit suite passes.
- [ ] Frontend lint and production build pass.
- [ ] Focused and full Playwright suites pass without borrowing another worktree's server.
- [ ] Meta staging signed fixtures and ID correlation have been recorded.
- [ ] First treatment/control/settings/attention records have an owner audit trail.
- [ ] Kill switch and circuit-reset rollback have been rehearsed.
- [ ] Production migration history is reviewed and additive.

## Current release recommendation

Do not enable the production recovery worker from this snapshot. Keep
`DM_RECOVERY_ENABLED=false` while the release-blocking items are corrected and re-audited. Data
ingestion and prospective persistence can be staged separately only after the identity-based
eligibility path is removed and the migration history is confirmed safe.
