# Instagram Read-Recovery Reminders: Tasks 1–13 QA Plan

## Document purpose

This document is the implementation-gap register and QA plan for Tasks 1–13 in
`docs/superpowers/plans/2026-08-06-instagram-read-recovery-reminders.md`.

It answers four questions for every task:

1. What is implemented now?
2. What is missing, unsafe, or not yet proven?
3. Which automated, database, integration, or manual tests must be run?
4. What evidence is required before the task can be accepted?

This is a read-only audit of the implementation. It does not mark a task complete merely because
its unit tests pass.

## Audit snapshot

- Branch: `feat/instagram-read-recovery-reminders`
- Audited through commit: `4e48a12` (`fix(scheduler): prove the kill switch instead of assuming it`)
- Task 12 hardening commit: `a225985`
- Audit date: 2026-08-06
- Scope: backend Tasks 1–13 only
- Excluded: Task 14 and later admin API/UI/metrics work
- Unrelated work present during the audit: uncommitted Task 14 API route, router, and test changes;
  they were not modified as part of this QA document
- `MIGRATION_TEST_DATABASE_URL`: not configured during this audit

## Status vocabulary

| Status | Meaning |
|---|---|
| Complete | Required behavior is implemented and covered by appropriate automated tests. |
| Functionally complete with gap | Main behavior exists, but a safety, privacy, or acceptance item remains. |
| Partial | One or more required behaviors are not implemented correctly. |
| Verification blocked | Code exists, but the required environment-backed test has not run. |
| Not run | QA case is documented but has not been executed in the required environment. |

## Executive status and missing-work register

| Task | Current status | Missing, incorrect, or unproven work |
|---|---|---|
| 1. Durable recovery schema | Verification blocked | The real PostgreSQL migration, constraint, RLS, timestamp, and concurrency contract has not run because `MIGRATION_TEST_DATABASE_URL` is absent. |
| 2. Configuration, copy, policy | Complete | No known implementation blocker. Still requires configuration-boundary and exact-copy regression checks before release. |
| 3. Graph failure classifier | Complete | Production settings-blocked code/subcode signatures still require evidence and explicit configuration; an empty allowlist intentionally produces no automatic settings fallback. |
| 4. Outbound/public identifiers | Complete | No known implementation blocker. Staging must confirm the real Meta responses contain the IDs expected by the code. |
| 5. Recovery persistence/evidence | Partial | Reaction and postback handlers store `reactedAt`/`postbackAt` but do not populate the shared `engagedAt`, `engagedReceivedAt`, and `firstEngagementKind` fields used by final authorization. A signal arriving while status is `sending` can therefore fail to stop a public comment. |
| 6. Live comment integration | Partial | Duplicate/replayed comment webhooks are not made idempotent before the Meta private-reply call. The same comment can open another conversation and send another gate DM. Initial known auth/permanent failures are also queued for a later unnecessary retry. |
| 7. Queued gate retry | Partial | The worker claims the whole batch before processing. If it stops after a rate limit, later claimed-but-unattempted rows remain `sending`; stale reconciliation can misclassify them as `send_uncertain`. |
| 8. Webhook evidence | Partial | Any reaction action other than exact `unreact` is treated as positive engagement; only exact `react` should count. Message `mid` is not runtime-validated before inbound/deletion persistence. The Task 5 reaction/postback final-check race also applies. |
| 9. Completion suppression | Complete | No known implementation blocker. Real transaction rollback and concurrent completion/send behavior still need database/integration evidence. |
| 10. Atomic claim and cooldown | Partial | Exactly 24 hours is treated as still inside cooldown (`gte`); due selection is not bounded above the worker batch; claim events are written inside the serializable transaction; uncertain finalized attempts are omitted from hourly-cap accounting; real two-client concurrency tests have not run. |
| 11. Persistent health circuit | Partial | An already-open `auth_or_permission` circuit can be overwritten by a newly observed recoverable anomaly because anomaly selection happens before reading the stored latch. Backlog counts include rows whose retry time is still in the future. Reaction/postback signals do not contribute to health until Task 5 is fixed. Database-failure counting covers only part of the recovery persistence surface. |
| 12. Paced recovery worker | Partial | Repository finalizers return `false` on failed writes, but the worker generally assumes success unless they throw. A Meta-accepted public reply can therefore be counted/logged as sent when final persistence returned `false`. Planned suppression events are absent, and the top-level tick logs a raw error object. |
| 13. Kill-switched scheduler | Functionally complete with gap | Timer behavior, immediate execution, stop behavior, rejection handling, and server registration exist. The scheduler logs the raw caught error despite the plan’s safe `errorCode`-only payload. The scheduler relies on the worker’s `running` guard for production non-overlap rather than enforcing non-overlap itself. |

## Release-blocking defects

The following items must be fixed before `DM_RECOVERY_ENABLED=true` is used on a production
account:

1. Prevent a duplicate comment webhook from sending a second private gate DM.
2. Make reaction and postback evidence participate in the same final engagement check as inbound
   messages.
3. Release claimed-but-unattempted gate queue rows when a batch stops early.
4. Honor `false` from every recovery finalizer and emit a reconciliation outcome instead of a
   false success.
5. Preserve the `auth_or_permission` circuit latch even while other anomalies are present.
6. Remove raw error objects from recovery worker/scheduler logs.
7. Run the real PostgreSQL migration and concurrency contracts.

## QA environments and prerequisites

### Unit-test environment

- Use the repository’s pinned Node/npm versions and lockfile.
- Use test doubles only; unit tests must not contact Meta or production Supabase.
- Keep `DM_RECOVERY_ENABLED=false` unless a test explicitly mocks it to true.
- Freeze or inject time for exact eligibility/cooldown tests.

### Local PostgreSQL/Supabase-compatible environment

- Use a disposable local PostgreSQL database only.
- Never point `MIGRATION_TEST_DATABASE_URL` at staging or production.
- The existing database contract refuses non-local hostnames and requires `DATABASE_URL` to equal
  `MIGRATION_TEST_DATABASE_URL`.
- Apply all migrations from an empty database and run the contract with two independent Prisma
  clients.

Example variables, using a locally created disposable database:

```bash
export MIGRATION_TEST_DATABASE_URL='postgresql://LOCAL_USER:LOCAL_PASSWORD@127.0.0.1:5432/insta_recovery_qa'
export DATABASE_URL="$MIGRATION_TEST_DATABASE_URL"
npm test -- --run src/services/dmRecoveryDatabaseContract.test.ts
```

### Meta staging/manual environment

Prepare:

- A non-production Instagram professional test account.
- A test Reel/post with a unique recovery keyword.
- At least two test users:
  - one allowing message requests;
  - one configured to reject new message requests, if Meta exposes that test path.
- Webhook subscriptions for comments, messages, reads, reactions, and postbacks.
- A way to capture Graph request/response IDs without logging tokens, private DM text, or raw
  provider bodies.
- A test-only public-comment prefix so cleanup is unambiguous.

## Standard automated verification commands

```bash
npm test -- --run
npm run build
git diff --check
```

Database contract, when the disposable local database is configured:

```bash
npm test -- --run src/services/dmRecoveryDatabaseContract.test.ts
```

No task requiring the database contract can be accepted while that test file is skipped.

---

## Task 1 — Durable recovery schema and migration contract

### Current implementation

- Recovery trigger, status, and cohort enums exist.
- `dm_recovery_reminder` and singleton `dm_recovery_control` exist in Prisma and SQL migration.
- Recovery timestamps use `timestamptz` mappings.
- Foreign keys, state constraints, due indexes, unique comment/message identifiers, and the partial
  one-`sending`-row-per-person index exist.
- RLS is enabled with no permissive `anon` or `authenticated` policies.
- The database contract creates valid foreign-key fixtures and includes real concurrency cases.

### Not implemented or not proven

- The migration and contract have not been executed against a disposable real PostgreSQL database
  in this audit.
- The partial unique index and serializable-claim behavior are therefore code-reviewed but not
  environment-proven.
- If this feature migration has already been applied to any shared database, its checksum/history
  must be checked before deployment; changes to an already-applied migration require a follow-up
  migration rather than editing history.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T1-01 | Apply all migrations to an empty local database. | Migration succeeds with no manual SQL. | Automated contract, not run |
| T1-02 | Inspect both recovery table names and enums. | Exact snake_case names and enum values exist. | Automated, skipped without DB |
| T1-03 | Inspect RLS and policies. | RLS enabled; no public permissive policy. | Automated, skipped without DB |
| T1-04 | Insert control row with `id=2`. | Check constraint rejects it. | Automated, skipped without DB |
| T1-05 | Insert two reminders with the same `comment_id`. | Second insert fails with unique violation/P2002. | Automated, skipped without DB |
| T1-06 | Insert two `sending` rows for one person concurrently. | At most one succeeds. | Automated, skipped without DB |
| T1-07 | Insert `waiting` plus `sending` for one person. | Both are allowed; index is partial. | Automated, skipped without DB |
| T1-08 | Inspect every recovery timestamp column. | Every planned timestamp is `timestamp with time zone`. | Automated, skipped without DB |
| T1-09 | Insert invalid terminal states: `sent` without `sent_at`, etc. | Each state constraint rejects invalid data. | Automated, skipped without DB |
| T1-10 | Run `prisma generate` and TypeScript build. | Prisma client exposes the new models and build succeeds. | Build command |

### Acceptance gate

Task 1 is accepted only after T1-01 through T1-10 pass against the disposable local database and
the migration history is confirmed safe for the deployment target.

---

## Task 2 — Configuration, approved copy, and pure policy

### Current implementation

- Kill switch, delay, cooldown, batch, cap, lease, retries, experiment, and health settings are
  parsed and bounded.
- Blank experiment dates normalize to absent values.
- Start/end dates are paired and ordered.
- Exact settings-fallback and keyword-substituted reminder copy are snapshotted.
- Deterministic treatment/control allocation and policy precedence are implemented.
- Missing read evidence is treated as uncertainty, never proof of unread status.

### Not implemented or not proven

- No known code blocker.
- Release configuration values have not been exercised as one production-like configuration.
- Add an explicit regression proving that unrelated public-comment activity is not treated as DM
  engagement if such a field is ever added to the policy input.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T2-01 | Parse defaults with recovery disabled. | Valid configuration; no experiment dates required. | Automated |
| T2-02 | Enable recovery without both experiment dates. | Configuration rejects startup. | Automated |
| T2-03 | Supply blank dates. | Blanks normalize to absent, not invalid dates. | Automated |
| T2-04 | End date at/before start date. | Configuration rejects startup. | Automated |
| T2-05 | Render PROTEIN reminder. | Exact approved sentence and punctuation are preserved. | Automated |
| T2-06 | Render settings fallback. | Exact approved settings-blocked copy is preserved. | Automated |
| T2-07 | Same stable key/version evaluated repeatedly. | Cohort is deterministic. | Automated |
| T2-08 | Seen, engagement, completion, cancellation, cooldown, newer candidate. | Each suppresses with the correct reason and precedence. | Automated |
| T2-09 | No read receipt and otherwise eligible treatment row. | Returns send decision without claiming the user is unread. | Automated |
| T2-10 | Control cohort. | No public send; evidence remains measurable. | Automated |
| T2-11 | Before, during, and after experiment window. | Correct pre-window, experiment, and post-window policy. | Automated/service integration |

### Acceptance gate

All policy and environment tests pass, and a configuration review records the exact rollout dates,
holdout percentage, cap, and copy version.

---

## Task 3 — Structured Graph error classification

### Current implementation

- Graph response metadata is reduced to safe numeric status/code/subcode and safe trace ID.
- Transport codes use a closed allowlist.
- Settings-blocked classification requires an explicitly configured structured signature.
- Definite pre-dispatch transport failures are retryable; timeouts/resets are uncertain.
- Error message text and raw provider bodies are not used for classification.
- Bare `100:2534025` is treated as permanent unless separately proven; it is not guessed to be a
  rate limit or settings error.

### Not implemented or not proven

- The exact production signature for “cannot receive message requests” must be collected from a
  safe real Meta error and configured explicitly.
- Until configured, the correct safe behavior is no automatic settings-specific public fallback.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T3-01 | Allowlisted code/subcode. | `settings_blocked`. | Automated |
| T3-02 | Same message text but non-allowlisted codes. | Never `settings_blocked`. | Automated |
| T3-03 | 429/code 4 and known rate-limit codes. | `rate_limited`/safe retry. | Automated |
| T3-04 | Permission/auth code not settings-allowlisted. | Operational auth failure; no settings copy. | Automated |
| T3-05 | ECONNREFUSED/ENOTFOUND/EAI_AGAIN. | Definitely retryable pre-dispatch transport failure. | Automated |
| T3-06 | Timeout/reset/EPIPE/unknown network outcome. | `transport_uncertain`; no automatic resend. | Automated |
| T3-07 | Raw provider body contains token/private text. | Neither logger nor event metadata contains it. | Automated/static audit |
| T3-08 | Real staging settings rejection. | Safe numeric signature captured and matched after owner approval. | Manual, not run |

### Acceptance gate

Unit matrix passes and any production signature added to
`DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES` has recorded evidence and owner approval.

---

## Task 4 — Exact outbound and public-reply identifiers

### Current implementation

- Public comment replies return `{ replyId }` or a safe null identifier.
- Tracked private sends return Meta message ID, local DM row ID, and one acceptance timestamp.
- The same acceptance timestamp is used in local history and recovery scheduling.
- A local history-write failure does not reclassify an accepted Meta send as a failed send.

### Not implemented or not proven

- Real staging responses have not been checked against the current Graph API response shapes in
  this QA cycle.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T4-01 | Successful private reply. | Receipt contains nonempty Meta ID, local DM ID, and accepted time. | Automated |
| T4-02 | Successful public reply. | Function returns exact public reply ID. | Automated |
| T4-03 | Meta success without reply ID. | Caller receives null/uncertain result; never records confirmed sent. | Automated |
| T4-04 | Meta accepted, local DM persistence fails. | No private resend; safe reconciliation error only. | Automated |
| T4-05 | Compare receipt time with persisted outbound history. | Timestamps are identical. | Automated |
| T4-06 | Staging private/public reply. | Returned identifiers resolve to the created Meta objects. | Manual, not run |

### Acceptance gate

Automated tests pass and one staging private reply plus one staging public reply confirm the real
identifier contract without exposing content or credentials in logs.

---

## Task 5 — Recovery rows and idempotent positive evidence

### Current implementation

- Accepted comment gates, verified settings rejection, and tracking-unavailable outcomes create or
  reconcile recovery rows.
- Comment ID and gate message ID provide idempotency keys.
- Earliest read/reply evidence is preserved.
- Waiting rows suppress on seen/inbound/reaction/postback evidence.
- Terminal rows are protected from later evidence rewriting.
- Experiment cohort/window behavior is applied during creation.

### Not implemented or incorrect

- `recordRecoveryReaction` updates `reactedAt` but not `engagedAt`,
  `engagedReceivedAt`, or `firstEngagementKind`.
- `recordRecoveryPostback` updates `postbackAt` but not the shared engagement fields.
- Final authorization reads `engagedAt`; a reaction/postback arriving while the row is already
  `sending` leaves status `sending` and can be missed by the final check.
- Reaction/postback database failures do not feed the persistent database-failure health counter.

### Required fix validation

For reaction and postback, atomically preserve the earliest dedicated timestamp and also populate
the earliest shared engagement timestamp/receipt time and first engagement kind. Do not force a
`sending` row to a terminal state in the evidence handler; let final authorization observe the
evidence and suppress it.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T5-01 | Schedule accepted gate twice with same comment. | One recovery row; exact IDs retained. | Automated |
| T5-02 | Replay older/newer seen events. | Earliest provider and received timestamps retained. | Automated |
| T5-03 | Inbound message on waiting row. | `engagedAt` populated and row suppressed. | Automated |
| T5-04 | Reaction on waiting row. | Dedicated and shared engagement fields populated; row suppressed. | Known gap |
| T5-05 | Reaction arrives after claim while row is `sending`. | Status remains claim-safe, but final authorization suppresses before Meta. | Missing regression/known gap |
| T5-06 | Postback arrives after claim while row is `sending`. | Final authorization suppresses before Meta. | Missing regression/known gap |
| T5-07 | Evidence replay against sent/failed/uncertain/cancelled row. | Terminal state and outcome fields remain unchanged. | Automated |
| T5-08 | Settings rejection scheduling. | Immediate treatment candidate with settings copy; no unread claim. | Automated |
| T5-09 | Tracking-unavailable scheduling. | Owner-visible non-send state; never auto-posted. | Automated |
| T5-10 | Database failure in any evidence writer. | Safe log, health failure counter increment, webhook remains acknowledged. | Partial/missing |

### Acceptance gate

T5-04 through T5-06 must have failing-before/fixed-after regression tests, and all evidence writers
must preserve terminal-state and earliest-evidence invariants.

---

## Task 6 — Live comment gate integration

### Current implementation

- A successful comment-origin gate send schedules recovery from the exact tracked receipt.
- Verified settings-blocked failure schedules immediate fallback and avoids the private retry queue.
- Rate-limit/temporary failures enter the queue.
- Ambiguous transport outcomes become `send_uncertain` attention plus tracking-unavailable recovery.
- Public acknowledgement failure is nonfatal to the private gate flow.
- Post-acceptance local recovery persistence failure does not enqueue a duplicate private send.
- Business-authored comments are ignored before automation work.

### Not implemented or incorrect

- There is no atomic processed-comment/idempotency guard before `openConversation` and
  `sendTrackedPrivateReply`.
- A duplicate or concurrently replayed Meta comment webhook can create another conversation,
  public acknowledgement, and gate DM before the recovery row’s unique comment key can help.
- Known initial auth/permanent private-send failures are queued as pending and can consume one later
  unnecessary retry instead of being retired immediately.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T6-01 | Accepted gate send. | Exact receipt schedules one recovery candidate. | Automated |
| T6-02 | Recovery persistence fails after Meta acceptance. | No gate retry and no second Meta send. | Automated |
| T6-03 | Allowlisted settings rejection. | Immediate settings candidate; queue not used. | Automated |
| T6-04 | Temporary/rate-limit failure. | Pending queue row with media/source metadata. | Automated |
| T6-05 | Ambiguous transport failure. | Queue `send_uncertain`; tracking-unavailable recovery; no retry. | Automated |
| T6-06 | Public acknowledgement fails. | Private gate and recovery scheduling still proceed. | Automated |
| T6-07 | Exact duplicate webhook delivered sequentially. | One conversation/send/public acknowledgement or an idempotent no-op. | Missing/known gap |
| T6-08 | Same webhook delivered concurrently to two processes. | At most one Meta private send. | Missing DB/integration test |
| T6-09 | Business account’s own public comment. | No event, conversation, queue, recovery, or Meta send. | Automated |
| T6-10 | Initial auth/permanent failure. | Terminal operational outcome; no delayed private retry and no public fallback. | Partial/missing |

### Acceptance gate

Sequential and concurrent duplicate delivery tests must prove at-most-once private gate sending
before production rollout.

---

## Task 7 — Safe queued gate retries

### Current implementation

- Queue rows preserve comment/media/source metadata.
- Pending rows are conditionally claimed with a lease and backoff predicate.
- Stale sending leases become `send_uncertain`, never automatic retries.
- Accepted sends are finalized before recovery scheduling.
- Settings, ambiguous, retryable, permanent, and auth outcomes are classified separately.
- Recovery persistence failure after acceptance leaves the gate queue sent.

### Not implemented or incorrect

- All due candidates are claimed before the first candidate is processed.
- If processing breaks on a rate limit, remaining claimed rows are not returned to `pending`.
- When their leases expire, those never-attempted rows become `send_uncertain` and may never receive
  their legitimate gate DM.
- The test suite covers backoff re-claim prevention but not release of untouched claims after an
  early batch stop.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T7-01 | Two workers claim same queue row. | One sends; the other no-ops. | Unit + DB integration needed |
| T7-02 | Stale lease after possible request dispatch. | `send_uncertain`; no automatic resend. | Automated |
| T7-03 | Accepted queued send. | Queue `sent`, conversation gated, accepted recovery scheduled. | Automated |
| T7-04 | Recovery scheduling fails after acceptance. | Queue remains `sent`; no retry. | Automated |
| T7-05 | Verified settings rejection. | Queue abandoned; one settings fallback candidate. | Automated |
| T7-06 | Timeout/reset ambiguity. | `send_uncertain`; tracking attention; no resend. | Automated |
| T7-07 | Definite retryable transport/rate limit. | Pending with bounded exponential backoff. | Automated |
| T7-08 | Rate limit on first of five claimed rows. | First row backs off; four unattempted rows return to pending without attempt increments. | Missing/known gap |
| T7-09 | Closed seven-day window/attempt ceiling/permanent error. | Exhausted; no send. | Automated |
| T7-10 | Missing conversation/keyword. | Permanent queue failure, no Meta call. | Automated |

### Acceptance gate

T7-08 must pass and a concurrent-worker test must demonstrate that every claimed row is either
attempted exactly once or explicitly released.

---

## Task 8 — Read, reaction, postback, inbound, and deletion webhooks

### Current implementation

- Router dispatch order is read, reaction, postback, message, unknown.
- Seen handling independently updates outbound history and recovery correlation.
- Provider timestamps pass through one finite-millisecond validator.
- Inbound evidence is recorded before later conversation-routing exits.
- Duplicate and echo inbound messages do not create repeated evidence.
- Deletion captures deletion without inventing new engagement.
- Quick replies and attachments receive distinct engagement kinds.

### Not implemented or incorrect

- Reaction handling ignores only `unreact`; arbitrary/unknown/missing actions are treated as a
  positive reaction. Only `action === "react"` should create engagement.
- `message.mid` is trusted at runtime. Malformed untrusted JSON can reach persistence with a missing
  identifier and throw into router-level handling.
- Reaction/postback signals do not populate the shared engagement fields required by final
  authorization; see Task 5.
- No focused test proves an auth-safe durable observation for an entirely unknown event shape; the
  current behavior is an application log only.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T8-01 | One event containing read payload. | Seen handler invoked exactly once. | Automated |
| T8-02 | Reaction with `action=react`. | Exact `mid` engagement recorded. | Automated, shared-field assertion missing |
| T8-03 | Reaction with `action=unreact`. | Existing suppression retained; no new/broadened evidence. | Automated |
| T8-04 | Reaction with unknown/missing action. | Acknowledge/log and do not record engagement. | Missing/known gap |
| T8-05 | Postback with exact `mid`. | Exact-message engagement and shared fields recorded. | Partial/shared-field gap |
| T8-06 | Reaction/postback missing `mid`. | Safe no-op; never person-wide suppression. | Automated |
| T8-07 | Quick reply with both message and quick-reply fields. | Message handler only; engagement kind `quick_reply`. | Automated |
| T8-08 | Attachment-only inbound. | `attachment` engagement, even if not latest message. | Automated |
| T8-09 | Duplicate/echo inbound. | No second evidence or automation. | Automated |
| T8-10 | Deletion for captured/unmatched inbound. | Historical engagement retained; no new engagement for unmatched deletion. | Automated |
| T8-11 | Message payload missing/blank `mid`. | Acknowledge safely without database write. | Missing/known gap |
| T8-12 | Invalid provider timestamp. | Receipt time fallback and safe `provider_timestamp_invalid` observation. | Automated |

### Acceptance gate

Unknown reaction actions and malformed message IDs must be safe no-ops, and reaction/postback races
must suppress a claimed public reminder at the final authorization boundary.

---

## Task 9 — Completion suppression

### Current implementation

- Conversation completion, pending gate abandonment, and recovery suppression share one Prisma
  transaction.
- The source recovery becomes `completed` suppression.
- Other unfinished same-person/same-keyword rows become `completed_elsewhere`.
- Control rows retain evidence without changing control assignment.
- `sending` rows are left claim-safe and are expected to be stopped by the final completion recheck.

### Not implemented or not proven

- No known unit-level implementation blocker.
- Real PostgreSQL rollback and concurrent completion/final-authorization behavior are not yet
  environment-proven.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T9-01 | Complete source conversation. | Conversation, queue abandonment, and recovery suppression commit together. | Automated |
| T9-02 | Failure during any transaction step. | Entire transaction rolls back. | Unit mock + DB integration needed |
| T9-03 | Same person/keyword has other waiting journeys. | Bulk `completed_elsewhere` suppression. | Automated |
| T9-04 | Other journey belongs to different keyword/person. | Remains unchanged. | Automated |
| T9-05 | Control row completes. | Completion evidence retained without changing cohort/status. | Automated |
| T9-06 | Completion arrives while reminder is `sending`. | Final authorization suppresses; no public comment. | Automated repository test + DB race needed |
| T9-07 | Completion webhook/event replay. | Idempotent final state and no duplicate guide. | Automated |

### Acceptance gate

All unit tests pass and at least one real-database rollback/race test confirms no partial completion
state and no post-completion public comment.

---

## Task 10 — Atomic claim, person cooldown, and capacity reservation

### Current implementation

- Due rows filter waiting status, eligibility, and retry time.
- Claims use serializable transactions, compare-and-set updates, and a per-person row lock.
- The pure policy runs both during claim and immediately before the network call.
- Final authorization locks the singleton control row and reserves `lastAttemptAt`/attempt count.
- Confirmed sent and `send_uncertain` attempts participate in person cooldown.
- Conditional finalizers require `status=sending` and clear lease fields.

### Not implemented or incorrect

- Cooldown uses `gte cooldownSince`; a reminder exactly 24 hours old still suppresses, contrary to
  the plan’s “exactly 24 hours is eligible” boundary.
- `listDueRecoveryIds` uses exactly the worker batch limit instead of fetching above it. Rows later
  suppressed during claim can delay sendable people behind them.
- `dm_recovery_ready`, `dm_recovery_claimed`, and cooldown events are written through the global
  event logger while the serializable transaction is still open. A rollback can leave false audit
  events, and the extra database call lengthens the transaction.
- Hourly capacity counts confirmed sends and current `sending` reservations but omits recently
  finalized `send_uncertain` attempts. A possibly successful public post stops consuming capacity
  immediately after uncertain finalization.
- Real two-client claim and same-person exclusion tests are skipped without the local database.
- Unit coverage does not exercise every finalizer returning `false` or throwing.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T10-01 | Two claimants target same row. | Exactly one successful claim. | DB contract, not run |
| T10-02 | Two due rows for same person. | At most one `sending`; newest eligible candidate wins. | Unit + DB contract, DB not run |
| T10-03 | Seen/engaged/completed/cancelled before claim. | Suppressed before claim. | Automated |
| T10-04 | Evidence arrives after claim. | Final authorization suppresses before Meta. | Partial; reaction/postback gap |
| T10-05 | Confirmed or uncertain attempt 23:59:59 ago. | Person cooldown suppresses. | Automated query shape; boundary test missing |
| T10-06 | Attempt exactly 24:00:00 ago. | Candidate is eligible. | Missing/known gap |
| T10-07 | Attempt more than 24 hours ago. | Candidate is eligible. | Add explicit regression |
| T10-08 | First page contains only rows suppressed at claim. | Worker can still reach later sendable IDs within its batch budget. | Missing/known gap |
| T10-09 | Transaction rolls back after policy decision. | No false ready/claimed/suppressed event. | Missing/known gap |
| T10-10 | Cap reached by sent plus sending plus recent uncertain attempts. | No further authorization. | Partial/uncertain-count gap |
| T10-11 | Claim lease expired before final check. | Release/no Meta call. | Automated |
| T10-12 | Each conditional finalizer loses race (`count=0`). | Worker records reconciliation/no false success. | Repository partial; worker gap |

### Acceptance gate

Exact cooldown boundaries, capacity accounting, after-commit event logging, pagination/starvation, and
the real concurrency contract must pass.

---

## Task 11 — Persistent circuit breaker and health snapshot

### Current implementation

- Typed reasons exist for auth, webhook gap, backlog, public failures, hourly cap, and database
  failures.
- Health observations are queried from recovery rows.
- Failure rate and webhook-gap checks require minimum samples.
- Recoverable anomalies require three consecutive healthy evaluations before closing.
- The health check does not mutate individual recovery rows.
- Circuit transitions produce stable events.

### Not implemented or incorrect

- `evaluateRecoveryHealth` chooses a new anomaly before loading the stored circuit. If the stored
  reason is latched `auth_or_permission`, another anomaly can overwrite it with a recoverable reason
  and later auto-close it.
- `dueCount` ignores `nextAttemptAt`, so waiting rows still in backoff can falsely contribute to a
  backlog anomaly.
- Positive signal sampling reads only `seenAt`/`engagedAt`; reaction/postback signals are invisible
  until Task 5 populates shared engagement.
- `recordRecoveryDatabaseFailure` is called for claim/authorization failures but not all evidence,
  finalizer, health, and reconciliation database failures.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T11-01 | Each configured anomaly reaches threshold. | Correct stable circuit reason opens. | Automated |
| T11-02 | Sample below minimum. | No webhook-gap/failure-rate circuit. | Automated |
| T11-03 | Auth circuit plus otherwise healthy observations. | Remains latched. | Automated |
| T11-04 | Auth circuit plus simultaneous backlog/failure anomaly. | Remains `auth_or_permission`; reason not overwritten. | Missing/known gap |
| T11-05 | Recoverable circuit becomes healthy twice. | Remains open. | Automated |
| T11-06 | Third consecutive healthy evaluation. | Auto-closes with reset metadata. | Automated |
| T11-07 | Process restart during proof window. | Healthy counter restarts; persisted circuit remains open. | Automated |
| T11-08 | 500 waiting rows with future `nextAttemptAt`. | They do not count as due backlog. | Missing/known gap |
| T11-09 | Accepted sample contains reaction/postback only. | Counts as positive signal; no false webhook gap. | Missing/shared-field gap |
| T11-10 | Failures across every recovery DB operation. | Configured threshold opens database-failure circuit. | Partial/missing |
| T11-11 | Health dashboard reads snapshot. | Does not consume/reset database-failure observations. | Automated |

### Acceptance gate

The auth latch must survive every other anomaly, due backlog must honor retry time, and database
failure coverage must include the complete recovery persistence surface.

---

## Task 12 — Paced public-recovery worker

### Current implementation

- Tick is disabled by default, non-throwing, and protected by a module-level reentrancy guard.
- Stale public-send leases reconcile to `send_uncertain`.
- Health is evaluated before work.
- Due IDs are processed sequentially with a configured batch limit.
- Meta is called only for explicit approved send decisions.
- Exact snapshotted public copy is used.
- Auth, rate-limit, permanent, ambiguous, and missing-ID outcomes are separated.
- Attempts are durably reserved before the Meta call and retry arithmetic is based on the reserved
  attempt.
- Post-acceptance thrown persistence errors do not cause a retry.
- Late sends are observable.

### Not implemented or incorrect

- Repository finalizers catch database errors and return `false`; the worker normally ignores that
  boolean. For example, `markRecoverySent=false` still increments `result.sent` and emits
  `dm_recovery_sent`.
- The test for post-acceptance persistence failure mocks a thrown rejection, not the real
  `false`-return contract.
- The same ignored-return problem applies to retryable, failed, uncertain, and release/suppression
  finalization; metrics/events can disagree with durable state.
- The planned `dm_recovery_suppressed` worker event is not emitted.
- Rate-limit/auth paths do not consistently emit the planned stable failure/retry observations.
- The top-level catch logs the raw `error` object, which can contain unsafe database/provider data.
- `suppressed` result count includes release/wait/holdout outcomes, so it is not a literal count of
  suppressed people.
- Candidate listing uses the exact batch size, allowing suppressed front-of-queue rows to delay
  later sendable candidates.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T12-01 | Recovery disabled. | No DB or Meta work. | Automated |
| T12-02 | Two simultaneous ticks. | Second returns `already_running`; one worker body. | Automated |
| T12-03 | 100 overdue rows, batch 5. | At most five claims and five public calls. | Automated/bounded variant |
| T12-04 | 29-hour-overdue eligible reminder. | Still sent if all current predicates pass; emits late observation. | Automated |
| T12-05 | Evidence/completion/cancel/cooldown/circuit arrives after claim. | No public call; precise persisted no-send outcome. | Automated except reaction/postback race |
| T12-06 | Public success with nonempty reply ID. | Conditional `sent` finalization and one sent event. | Automated |
| T12-07 | `markRecoverySent` returns `false`. | Do not increment sent or emit sent; emit safe reconciliation event; never resend. | Missing/known gap |
| T12-08 | Any other finalizer returns `false`. | Safe reconciliation state/event; no false metric and no duplicate send. | Missing/known gap |
| T12-09 | Success without ID or timeout/reset/unknown. | `send_uncertain`; never automatic retry. | Automated |
| T12-10 | Rate limit below max attempts. | Waiting with bounded jittered backoff. | Automated |
| T12-11 | Rate limit at max attempts. | `send_failed/rate_limit_exhausted`. | Automated |
| T12-12 | Auth/permission. | Safe backoff, auth circuit open, remainder of batch stops. | Automated |
| T12-13 | One item’s permanent failure. | Later items continue; exactly one finalizer. | Automated |
| T12-14 | Top-level error contains secret-like/raw fields. | Log contains only stable error code and safe identifiers. | Missing/known gap |
| T12-15 | Suppress/release/wait/control decisions. | Metrics and events identify each accurately. | Partial/missing |

### Acceptance gate

Every boolean finalizer outcome must be honored, safe logs must contain no raw error, and worker
metrics/events must reconcile exactly with durable row states.

---

## Task 13 — Kill-switched worker scheduler

### Current implementation

- Disabled scheduler returns without immediate tick or timer registration.
- Enabled scheduler immediately invokes the worker and registers one configured interval.
- Rejected and synchronously thrown ticks are caught.
- A stop function clears the interval.
- `server.ts` registers the scheduler once using `DM_RECOVERY_ENABLED` and
  `DM_RECOVERY_WORKER_INTERVAL_MS`.
- Production tick overlap is prevented by Task 12’s `running` guard.

### Not implemented or incorrect

- The catch block logs `{ errorCode, err }`. The approved design logs only the stable error code;
  the raw error can expose database details, provider data, or credentials.
- The scheduler test uses `objectContaining`, so it proves the error code exists but does not reject
  unsafe extra fields.
- Scheduler-level non-overlap is not independently enforced for an arbitrary injected `runTick`;
  production safety currently depends on Task 12’s guard. This dependency must remain explicit or
  the scheduler should enforce it itself.

### QA cases

| ID | Test | Expected result | Current coverage |
|---|---|---|---|
| T13-01 | Disabled scheduler. | No immediate run, no timer, inert stop function. | Automated |
| T13-02 | Enabled scheduler. | One immediate run and one configured interval. | Automated |
| T13-03 | Rejected promise from tick. | Caught/logged; no unhandled rejection. | Automated |
| T13-04 | Synchronous throw from tick. | Caught/logged; process survives. | Automated |
| T13-05 | Stop function. | Exact interval handle cleared once. | Automated |
| T13-06 | Error contains secret-like fields. | Logger receives exactly safe stable metadata, no raw error. | Missing/known gap |
| T13-07 | Interval fires while prior production tick is running. | No overlapping worker body and no second Meta call. | Worker test; add scheduler integration assertion |
| T13-08 | Start server with recovery disabled. | No recovery DB or Meta work before/after listen. | Integration/manual |
| T13-09 | Start server with recovery enabled. | Immediate tick plus interval; no webhook-handler registration. | Integration/manual |

### Acceptance gate

The safe-log test must use an exact payload assertion, and an integration test must preserve the
non-overlap guarantee between scheduler and worker.

---

## Cross-task end-to-end scenarios

These scenarios exercise the feature as a state machine rather than isolated services.

| ID | Scenario | Expected result |
|---|---|---|
| E2E-01 | User comments PROTEIN; gate DM accepted; no evidence for 10 hours. | One treatment reminder becomes due; exact public copy posted once; Meta reply ID stored. |
| E2E-02 | User comments; gate DM accepted; seen receipt arrives before 10 hours. | Recovery suppressed as seen; no public comment. |
| E2E-03 | Reaction arrives after worker claim but before final authorization. | Recovery suppressed as reaction; no public comment. |
| E2E-04 | User sends any inbound DM after gate. | All unfinished recoveries for that person suppress; no public comment. |
| E2E-05 | Meta returns verified settings-blocked signature. | No private retry; immediate approved settings fallback candidate; public comment at most once. |
| E2E-06 | Meta times out after private/public request dispatch. | Outcome uncertain; no automatic duplicate attempt. |
| E2E-07 | Duplicate comment webhook arrives concurrently. | One gate DM and one recovery row. |
| E2E-08 | Service is down for 29 hours. | Overdue eligible reminders remain eligible and are paced through normal safety checks. |
| E2E-09 | One person has multiple due keywords. | Newest eligible candidate wins; person receives at most one recovery comment in 24 hours. |
| E2E-10 | User completes another matching journey while reminder is claimed. | Final authorization suppresses with completed/completed-elsewhere; no public comment. |
| E2E-11 | Auth token is revoked while backlog anomaly also exists. | Auth circuit stays latched; no public comments until operational reset. |
| E2E-12 | Worker crashes after Meta accepts but before final DB write. | Lease later becomes uncertain; no automatic resend; owner can reconcile. |
| E2E-13 | Kill switch is turned off and process restarted. | No scheduler tick, interval, recovery DB mutation, or public Meta request. |

## Privacy and safety checks

Run static searches and inspect each result:

```bash
rg -n 'response\.data|access_token|raw.*error|error\.message|logger\.(error|warn).*\b(err|error)\b' src
rg -n 'South Asian|Indian|Pakistani|Bangladeshi|ethnicity|national origin|name classifier' src prisma
```

Expected:

- Recovery logs contain safe identifiers, stable classifications, numeric Graph codes/subcodes,
  and allowlisted trace/transport codes only.
- No public reminder copy, private DM body, access token, raw provider response, or raw exception is
  logged.
- No identity, ethnicity, name, script, or inferred-origin targeting affects eligibility.

## Rollout QA sequence

1. Fix every release-blocking defect in this document with regression tests.
2. Run the full unit suite and build.
3. Run the real local PostgreSQL migration/concurrency contract.
4. Run the cross-task E2E suite with Meta test accounts and test-only content.
5. Keep `DM_RECOVERY_ENABLED=false` while reviewing dashboard/API visibility and health snapshots.
6. Enable a tiny treatment cohort with the hourly cap set conservatively.
7. Verify durable rows against actual Instagram comments and confirm no duplicate posts.
8. Confirm read/reaction/postback/inbound suppression accuracy.
9. Confirm circuit opening/closing and manual auth reset procedures.
10. Expand only after the measured false-positive, uncertain, duplicate, and failure rates satisfy the
    owner-approved rollout thresholds.

## Final release sign-off checklist

- [ ] Tasks 1–13 have no open release-blocking defect above.
- [ ] Full unit suite passes from a clean checkout.
- [ ] TypeScript/Prisma build passes.
- [ ] `git diff --check` passes.
- [ ] Real PostgreSQL database contract passes without skips.
- [ ] Meta staging E2E scenarios pass.
- [ ] Exact public copy is owner-approved and snapshotted.
- [ ] Settings-blocked structured signatures are evidence-backed and owner-approved.
- [ ] Kill switch is verified off by default.
- [ ] Hourly cap, batch size, experiment dates, and holdout are reviewed.
- [ ] No raw error/provider/token/private-message data appears in logs.
- [ ] No identity-based targeting exists.
- [ ] Dashboard/API work required for operational monitoring is ready before production enablement.

## Verification evidence for this document

Record each QA execution below rather than overwriting prior evidence.

| Date/time | Commit | Command/environment | Result | Notes |
|---|---|---|---|---|
| 2026-08-06 | `4e48a12` + uncommitted Task 14 work | Focused Tasks 1–13 suite (23 files) | PASS: 309 passed, 20 skipped | The skipped file is the real PostgreSQL contract |
| 2026-08-06 | `4e48a12` + uncommitted Task 14 work | Full `npm test -- --run` | FAIL: 8 failed, 798 passed, 29 skipped | All eight failures are from unfinished, out-of-scope `src/api/conversations.routes.test.ts` Task 14 work |
| 2026-08-06 | `4e48a12` + uncommitted Task 14 work | `npm run build` | PASS | Prisma generation and TypeScript compilation succeeded |
| 2026-08-06 | `4e48a12` | Real PostgreSQL contract | NOT RUN | `MIGRATION_TEST_DATABASE_URL` absent |
