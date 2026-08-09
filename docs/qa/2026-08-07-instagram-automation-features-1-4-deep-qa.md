# Instagram Automation Features 1–4 — Deep Logic QA

**Audit date:** 2026-08-07  
**Audited commit:** `e15f0d5230863b0f54462454da614d59f30df72a` (`main`)  
**Specifications:**

- `docs/superpowers/specs/2026-08-07-instagram-automation-feature-requests-1-3-4-design.md`
- `docs/superpowers/specs/2026-08-06-instagram-read-recovery-reminders-design.md` (Feature 2)

**Method:** requirements-to-code trace, static control-flow review, focused logic reproductions, unit/integration suite, TypeScript builds, and frontend lint. No production data was changed and no Meta API send was attempted.

## P0 remediation verification — 2026-08-08

**Code-level verdict:** all five P0 findings are closed on branch
`fix/remaining-p0-safety`. QA-01 and QA-03 landed earlier; this branch closes the three
remaining items, QA-02, QA-04, and QA-05. The final runtime/contract-test revision is
`6390907` plus its ancestors through `16b5128`; later QA-only commits do not change code.

This is not a production-launch verdict. This work did not deploy, apply a production
migration, run reconciliation with `--write`, change a production flag, approve a live
campaign, or call Meta. Keep `DM_RECOVERY_HISTORICAL_ENABLED=false` until the separate
production preflight and rollout authorization are complete.

| P0 | Code status | Verification evidence |
|---|---|---|
| QA-01 | Closed | `2b04537` requires executable `DM @tinysoho "{KEYWORD}"` copy and uncertainty-safe wording; copy tests pass in the full suite. |
| QA-02 | Closed | Historical claims require an unexpired UUID claim token; source attempts are fenced through reserve/start/finalize. Real PostgreSQL races prove one winner for two and five workers, and stale claim/reservation tokens cannot start or finalize. |
| QA-03 | Closed | `197beb1` separates phase selection and `20260808060000_enforce_candidate_phase` enforces phase/evidence compatibility in PostgreSQL. Selector and migration contracts pass. |
| QA-04 | Closed | `public_recovery_dispatch` is the single prospective/historical cooldown and capacity authority. Real PostgreSQL tests cover prospective-vs-historical, historical-vs-historical, both global-cap directions, different keywords, released/uncertain capacity, and exact 24-hour/30-day boundaries. |
| QA-05 | Closed | One canonical resolver now controls gate, DONE, completion, both recovery paths, reconciliation, API counts/listing, and the web view. Alias work is terminalized or reconciliation declines active network work; canonical/raw history modes are explicit and independently queried. |

Fresh verification against a new disposable PostgreSQL 17 database:

- Backend: **90 files / 1,385 tests passed; 0 skipped** with
  `MIGRATION_TEST_DATABASE_URL` set.
- Migration fixture: valid sent, uncertain, retryable, active, cancelled, and
  reconciled-alias source rows backfilled correctly; conflicting active-person rows
  failed and rolled back atomically.
- Backend build: Prisma generation and TypeScript passed.
- Frontend: **25 files / 376 tests passed**; TypeScript/Vite production build passed.
- ESLint on every touched frontend file passed. Repository-wide lint still has the same
  nine pre-existing errors in five unrelated files listed under QA-20.
- Diff audit found no credential values, new unsafe raw-SQL APIs, lock-order reversal,
  source-only send finalizer, copied canonical predicate, or path to Meta without a
  successful token-bearing dispatch-start transition.

## P1 dispatch-safety remediation verification — 2026-08-08

**Code-level verdict:** the dispatch-safety slice closes QA-08, QA-10, and QA-13.
It also closes the approval, holdout-settlement, drain, and restart-reconciliation part
of QA-12; earliest/windowed outcome attribution remains in the separate
selection-attribution slice. The implementation is in `51a0931` through `faf0fe7` on
branch `fix/p1-dispatch-safety`.

This is not production authorization. The historical feature flag remained false, all
database verification used a disposable local PostgreSQL database, and no production
migration, campaign write, Meta request, merge, push, or deployment was performed.

| P1 | Code status | Verification evidence |
|---|---|---|
| QA-08 | Closed | A distributed singleton tick lease and database-backed per-campaign batch runs fence concurrent workers; the final dispatch-start transaction consumes the campaign allowance; prospective and historical recovery share rolling global hour/day authority, including uncertain and in-flight attempts. |
| QA-10 | Closed | The last authorization boundary rechecks the campaign, circuit, claim, batch lease, allowance, and reservation; pre-network failures release safely, dispatch-started work remains truthful through cancellation, and expired in-flight work reconciles to `send_uncertain`. |
| QA-12 | Lifecycle portion closed; attribution portion pending | Approval and holdout settlement are one transaction, only actionable treatment rows block drain, and every running campaign is restart-reconciled to its actual terminal state. Earliest 24/48-hour attribution is intentionally left for the selection-attribution slice. |
| QA-13 | Closed | Append-only, idempotent complaint, opt-out, block, negative-reply, and classifier-anomaly observations join failure/uncertainty/source/duplicate rates. Health is evaluated after each terminal outcome before the next candidate, and stop reasons remain owner-latched. |

Fresh verification against the disposable PostgreSQL database:

- Prisma client generation and schema validation passed; `git diff --check` passed.
- Focused migration, interleaving, claim, ledger, lifecycle, distributed-tick, and health
  matrix: **8 files / 100 tests passed**, then passed unchanged on three consecutive
  repeat runs.
- Database-enabled Vitest files run serially by configuration because these contract
  files deliberately exercise shared singleton/global tables. Concurrency remains real
  inside each multi-client contract; unit-only files retain normal parallel execution.
- Independent code review found and remediation closed migration-target guarding,
  pre-dispatch health fencing, health-query fail-closed behavior, inbound evidence retry,
  real reservation timestamps, acknowledged-webhook durability, concurrent lifecycle
  gaps, reserve/start opt-out attribution, and captured-inbound final authorization.
  Its final verdict was **Ready: Yes** with no Critical or Important findings; the
  focused fix suite passed **7 files / 163 tests**.
- Complete backend: **97 files / 1,487 tests passed**; Prisma/TypeScript build passed.
- Frontend: **25 files / 376 tests passed**; production build passed; Playwright passed
  **66/66** desktop/mobile tests.
- Repository-wide frontend lint still reports the same nine pre-existing P2 errors in
  the same five untouched files; no suppression or unrelated change was made here.

## P1 selection-attribution remediation verification — 2026-08-08

**Code-level verdict:** the deterministic selection and attribution slice closes QA-07,
QA-11, QA-14, and the remaining attribution portion of QA-12. The implementation is in
`e7462f1` through `25d7747` on branch `fix/p1-selection-attribution`, stacked on the
reviewed dispatch-safety branch.

This is not production authorization. Historical recovery remained disabled, every
database write was confined to the disposable local PostgreSQL container, and no
production migration, selector, campaign approval, Meta request, push, merge, or deploy
was performed.

| P1 | Code status | Verification evidence |
|---|---|---|
| QA-07 | Closed | Arm assignment is stable per person and selection version, is independent of candidate position, and is fully realized and validated before the first database write. Invalid small-cohort splits leave no partial campaign. |
| QA-11 | Closed | Reminder engagement is same-person/same-keyword scoped; every eligible comment source is frozen newest-first; definitive absence falls back only within that approved set; auth/transient/unknown reads never redirect; final authorization stamps the exact approved source used. |
| QA-12 | Closed | Attribution now uses an atomic earliest-wins update under reverse, concurrent, and replayed delivery. Treatment is anchored at dispatch start, holdout at approval; explicit campaign windows default to fixed 24-hour inbound and 48-hour completion observations; outside-window events cannot mutate attribution or enter the recovered view. |
| QA-14 | Closed | The inert draft is the reviewed artifact. One Serializable transaction persists configuration fingerprint, decision hash, dense inclusion order, arms, every approved source and reason, every exclusion and reason, and declared counts. Approval locks and re-hashes that exact stored manifest and fails closed on incomplete or altered evidence. |

Fresh verification against the disposable PostgreSQL database:

- Prisma schema validation passed; all **36 migrations** are applied; the authoritative
  migration-chain-to-database diff reports no difference.
- Combined PR2 selection/snapshot/approval/source/attribution/API matrix:
  **15 files / 307 tests passed**.
- Race-sensitive PostgreSQL subset: **8 files / 107 tests passed** on three consecutive
  runs, covering atomic snapshot rollback, approval tamper refusal, source authorization,
  dispatch interleavings, reverse/concurrent attribution, and fixed boundary timestamps.
- Complete backend: **101 files / 1,538 tests passed**; Prisma/TypeScript build passed.
- Frontend: **25 files / 376 tests passed**; production build passed; a clean full
  Playwright run passed **66/66** desktop/mobile tests. One prior run exposed a known
  untouched clock-harness loading race; isolated repetition passed 5/6 and the full rerun
  passed, so it is recorded as test-infrastructure flakiness rather than hidden.
- Repository-wide frontend lint still reports exactly the same nine pre-existing P2
  errors in the same five untouched files; PR2 introduced no frontend file change.

## P1 journey-history and settings-evidence verification — 2026-08-08

**Code-level verdict:** the remaining P1 findings QA-15, QA-16, and QA-17 are closed by
`f24fdae` and `a435cc3`, stacked on the dispatch and selection slices above. QA-09 was
also rechecked and remains closed by `903b524`. All P1 findings QA-06 through QA-17 are
therefore closed at code level.

This is not production or controlled-Meta authorization. The historical feature stayed
disabled, database verification used only disposable local PostgreSQL databases, and no
production migration, reconciliation write, campaign, Meta call, push, merge, or deploy
was performed. QA-17's external evidence package still requires separately authorized
controlled-account credentials and the runbook in `docs/meta-verification.md`.

| P1 | Code status | Verification evidence |
|---|---|---|
| QA-09 | Closed | Source reads suppress only definitive missing-object responses; auth opens the shared circuit and transient/rate-limit/unknown failures defer. Unit and worker contracts cover every family. |
| QA-15 | Closed | Authoritative accepted-recovery evidence joins safe event evidence; live creation and reconciliation share person-keyword locks; every overlapping intent and active work row is fenced; stable tie-breaks plus an approved dry-run/write manifest make reconciliation atomic, reviewable, resumable, and restart-idempotent. |
| QA-16 | Closed | One immutable source event can retain every distinct keyword/intent association, original event/time/media/source/disposition, and acknowledgement outcome. Backfill fails closed on contradictory identity and preserves multi-keyword comments and alias history. |
| QA-17 | Closed at code level; controlled evidence pending | A versioned immutable registry, exact composite evidence foreign key, active/stale/retired checks, row-locked scheduling, replay preservation, safe APIs/metrics, and owner activation controls cover both first-send and retry paths. No signature can be armed without both the environment allowlist and a current exact registry version. |

Focused QA-17 verification before the final release suite:

- Backend settings registry, activation, database/interleaving, scheduler, handler,
  retry-worker, and API matrix: **7 files / 175 tests passed**.
- The real-PostgreSQL contract includes exact identity constraints, immutable evidence,
  one-active-version enforcement, new-legacy-row rejection, and both orders of the
  insert-versus-retirement race.
- Backend Prisma/TypeScript build passed.
- Frontend evidence drawer/list/activation/view-model matrix: **3 files / 81 tests
  passed**; production build and touched-file ESLint passed.
- The controlled Meta procedure was documented but deliberately not executed; Feature 1
  remains inert until an owner supplies authorized controlled-account evidence.

Final consolidated P1 verification after the review fixes:

- A brand-new disposable PostgreSQL 17 database applied all **45 migrations** from zero.
  `prisma migrate status` reports the schema up to date, and the authoritative
  migration-chain-to-database diff against a separate fresh shadow database reports no
  difference.
- The six contracts whose pre-QA-17 fixtures no longer satisfied the sealed evidence
  model passed **6 files / 71 tests** after the fixtures were made production-valid in
  `9331e18`.
- Complete backend: **107 files / 1,610 tests passed** against that fresh database;
  Prisma generation and the TypeScript production build passed.
- Complete frontend: **25 files / 382 tests passed**; the TypeScript/Vite production
  build passed; ESLint passed on all eight frontend files changed by the P1 stack.
- The first browser run exposed an incomplete-response crash in the new settings
  registry panel and a missing registry route in the browser fixture. `259c27d` adds a
  red/green regression, handles malformed or absent registry records without hiding the
  recovery list, and makes the fixture match the real endpoint. The affected browser
  file then passed **36/36**, and the final desktop/mobile Playwright run passed
  **66/66**.
- `git diff --check`, changed-file scope review, and a secret-pattern audit passed. No
  controlled Meta call, production read/write, feature enable, push, merge, PR, or
  deployment occurred.

## Executive verdict

**All P0 and P1 findings are closed at code level. Do not enable historical recovery
(Feature 4) in production yet.** Production still requires the read-only
collision/backfill preflight, migration compatibility review, P2 owner-flow QA, and
separate rollout authorization. Code completion is not permission to create or approve
a real campaign.

Feature 1 must remain inert until a controlled Meta settings rejection is verified,
stored as a sanitized versioned evidence package, activated in the registry, and armed
with the same exact environment signature. Feature 2, Feature 3, and Feature 4 now share
code-level dispatch and canonical-ownership safety, but no statement here substitutes
for live Meta or production rollout evidence.

The detailed evidence below preserves the original 2026-08-07 failure descriptions so
the regressions remain auditable. The dated resolution blocks and status table above are
the current P0 verdict.

### Severity

- **P0 — release blocker:** can double-contact a person, send an unapproved/false public statement, corrupt cohort meaning, or bypass a core safety invariant.
- **P1 — high:** can suppress or send the wrong candidate, make campaign safety/measurement unreliable, or leave production behavior unauditable.
- **P2 — medium:** operational, dashboard, audit, or validation gap that should be fixed before declaring the feature complete.

## Findings summary

| ID | Feature(s) | Severity | Finding |
|---|---|---:|---|
| QA-01 | 4 | P0 | **Closed at code level (`2b04537`)** — historical copy uses a working keyword-DM action and evidence-safe wording |
| QA-02 | 4 | P0 | **Closed at code level (`937c903`, `1653208`)** — token-fenced claims plus one authoritative dispatch ledger prevent duplicate authorization |
| QA-03 | 4 | P0 | **Closed at code level (`197beb1`)** — selection and database constraints keep phases disjoint |
| QA-04 | 1, 2, 4 | P0 | **Closed at code level (`fb7e5b2`, `937c903`, `1653208`)** — cooldown and capacity are shared through the dispatch ledger |
| QA-05 | 3 | P0 | **Closed at code level (`eaf2c1a`, `5e2c6a6`, `c3cae3a`)** — only canonical owners remain operational |
| QA-06 | 2, 3 | P1 | **Closed at code level (`5e2c6a6`)** — final authorization reads canonical intent and sibling completion authority |
| QA-07 | 4 | P1 | **Closed at code level (`07efaf7`)** — stable hash assignment is realized and validated before atomic snapshot persistence |
| QA-08 | 4 | P1 | **Closed at code level (`e30ef49`)** — distributed per-campaign batch runs and shared rolling global capacity fence concurrent ticks |
| QA-09 | 4 | P1 | **Closed at code level (`903b524`)** — only definitive missing-object responses suppress; auth opens the circuit and transient reads defer |
| QA-10 | 4 | P1 | **Closed at code level (`d82cfe1`)** — final dispatch authorization and truthful cancellation separate pre-network retry from in-flight uncertainty |
| QA-11 | 3, 4 | P1 | **Closed at code level (`07efaf7`, `4346ecc`)** — same-keyword evidence and owner-approved ordered source fallback are enforced through dispatch start |
| QA-12 | 4 | P1 | **Closed at code level (`fda2ee9`, `25d7747`)** — lifecycle plus earliest bounded 24/48-hour attribution are complete |
| QA-13 | 4 | P1 | **Closed at code level (`4015e5b`, `a019786`, `faf0fe7`)** — durable observations, acknowledged-webhook reconciliation, and ledger-derived checks stop a campaign before the next candidate |
| QA-14 | 4 | P1 | **Closed at code level (`07efaf7`, `ee5f8be`)** — one atomic reviewed manifest is fingerprinted, hashed, and reverified at approval |
| QA-15 | 3 | P1 | **Closed at code level (`f24fdae`)** — authoritative evidence, shared locks, stable ordering, and an approved resumable manifest make reconciliation atomic |
| QA-16 | 3 | P1 | **Closed at code level (`f24fdae`)** — source-event associations preserve every alias, keyword, provenance field, and acknowledgement outcome |
| QA-17 | 1 | P1 | **Closed at code level (`a435cc3`)** — immutable verified signatures fence both scheduling paths and are safely exposed/controlled; external controlled evidence remains a launch gate |
| QA-18 | 1, 2 | P2 | Snapshotted keywords are trimmed but not forced to the approved uppercase form |
| QA-19 | 3, 4 | P2 | Historical/canonical dashboard and API controls are incomplete or misleading |
| QA-20 | 1–4 | P2 | Database contracts, historical browser flows, and controlled Meta behavior are not verified in this audit environment |

## Detailed findings and required fixes

### QA-01 — Historical copy has no executable recovery action

**Severity:** P0  
**Evidence:**

- The approved Phase 1 and Phase 2 copy explicitly directs the person to DM `@tinysoho` with the snapshotted keyword (`design` lines 621–650).
- `src/services/historicalRecoveryCopy.ts:27-43` instead renders “Reply here...” and does not accept a keyword.
- `src/services/historicalRecoverySelector.ts:283-290` snapshots that keyword-free text.
- `src/handlers/commentHandler.ts:74-89` ignores a new comment unless its text matches an active keyword; it has no lookup from a parent historical public-reply ID/candidate to a guide.
- The unknown-read copy says the DM “never made it,” even though this cohort proves only that no read signal was recorded.

**Failure scenario:** a person follows the literal instruction and posts a generic reply. Nothing correlates that reply to the historical candidate or sends the guide. For the unknown-read cohort, the account also makes a public delivery-failure claim it cannot prove.

**Required fix:**

1. Change historical copy rendering to require `(phase/evidence, keywordSnapshot)`.
2. Use the approved uncertainty-aware templates, including `DM @tinysoho “{KEYWORD}”`; never ask for a generic “reply here” unless a dedicated parent-reply correlation flow is implemented and tested.
3. Store the exact rendered keyword copy in the immutable candidate snapshot.
4. Add negative wording tests: unknown-read copy must not say or imply that delivery failed.

**Regression tests:** exact-copy snapshot for both phases, lowercase input normalized to uppercase, no free-form input, and an end-to-end test proving the instructed action starts the correct keyword flow.

**2026-08-08 resolution:** Closed at code level. `historicalRecoveryCopy.ts` requires a
non-empty normalized keyword, renders the working keyword-DM action, and reserves failure
language for confirmed failure evidence. The focused copy cases and full backend suite pass.

### QA-02 — Historical candidate claims are not exclusive

**Severity:** P0  
**Evidence:** `src/services/historicalRecoveryRepository.ts:63-88` updates a candidate where only `id`, `outcome = pending`, and `arm = treatment` match. The row stays `pending`, and the predicate does not require `claimedAt IS NULL` or an expired lease. Finalizers at lines 130–195 match only `id` plus `outcome = pending`; they do not verify a lease token. `src/services/historicalRecoveryWorker.ts:48-58` also has no in-process running guard.

**Failure scenario:** workers A and B read the same due ID. A writes its claim, then B's identical `updateMany` also matches the still-pending row and overwrites the lease. Both receive the candidate and both can call Meta. The first finalizer succeeds, but that does not undo the second already-posted public comment.

**Required fix:**

1. Introduce an explicit `sending` outcome/state or compare-and-set on `claimedAt IS NULL` / expired lease.
2. Generate a claim/lease token and require it in every release/finalizer predicate.
3. Serialize the per-person final authorization and capacity reservation in the database; an in-process mutex is only additional protection, not the multi-instance solution.
4. Count `sending` and `send_uncertain` as contact/cap reservations.

**Regression tests:** a real-Postgres race with two clients must return exactly one claim and invoke the send stub once; a stale claimant must be unable to finalize or release the winner's lease.

**2026-08-08 resolution:** Closed at code level. A candidate can be claimed only while
`claim_token IS NULL`; lease reconciliation alone retires expired ownership. A separate
reservation token fences the shared ledger at dispatch start and finalization. PostgreSQL
contracts prove one winner under two- and five-way contention and reject stale tokens at
every network boundary.

### QA-03 — Phase is ignored and cohorts mix

**Severity:** P0  
**Evidence:** `selectHistoricalCandidates` accepts `phase` at `src/services/historicalRecoverySelector.ts:159-173`, but eligibility at lines 177–235 includes both `gate_exhausted` and `gate_sent_no_read`. `phase` is used only when the campaign row is created at lines 249–262. `scripts/select-historical-recovery.ts:42-55` hardcodes `unknown_read_pilot`, so there is no normal Phase 1 selector command.

**Failure scenario:** a campaign labeled `confirmed_failure` can contain unknown-read people, or the current `unknown_read_pilot` can contain confirmed failures. Copy, approval, sequencing, experiment analysis, and launch gates no longer mean what the campaign label says.

**Required fix:** filter the included pool before deduplication/limit/arm assignment:

- `confirmed_failure` -> only `gate_exhausted` (and any separately verified settings subclass);
- `unknown_read_pilot` -> only `gate_sent_no_read`.

Make `--phase` explicit in the CLI, reject absent/invalid phase, show excluded-out-of-phase counts, and enforce phase/evidence compatibility when candidates are written.

**Regression tests:** mixed fixture produces disjoint campaigns; Phase 1 never contains accepted/no-read evidence; Phase 2 never contains exhausted evidence.

**2026-08-08 resolution:** Closed at code level. Selection filters by phase before the
snapshot is written, and a database check plus phase-sync trigger rejects incompatible
campaign/candidate evidence. The phase selector and database contracts pass.

### QA-04 — Public-recovery cooldown is not shared

**Severity:** P0  
**Evidence:**

- Prospective recovery checks only `dm_recovery_reminder` in `src/services/dmRecoveryRepository.ts:51-90`.
- Historical selection and recheck check `dm_recovery_reminder` only (`src/services/historicalRecoverySelector.ts:118-120`, `src/services/historicalRecoveryWorker.ts:109-120`), not prior/current `recovery_candidate` sends from other campaigns.
- The historical database uniqueness rule is only `(campaignId, igUserId)` (`prisma/schema.prisma:950-955`), so it does not span campaigns.

**Failure scenario:** a Feature 2 reminder and a Feature 4 reminder are authorized at the same time, or two historical campaigns contain the same person. Each path sees no contact in the other table and both post publicly inside the cooldown.

**Required fix:** create one authoritative public-recovery dispatch/contact ledger (or consolidate candidates) keyed by person, with transactionally reserved attempts. Both workers must consult it under the same person/control lock. Apply the prospective 24-hour and historical 30-day rules explicitly, with the stricter applicable result winning. Include in-flight and uncertain attempts.

**Regression tests:** prospective-vs-historical and historical-vs-historical concurrent races; different keyword IDs still share person cooldown; exactly-at-boundary behavior.

**2026-08-08 resolution:** Closed at code level. Both features reserve from
`public_recovery_dispatch` under the same control/person/source lock order. Its partial
unique index permits only one active reservation per person, while all capacity and
cooldown queries read the ledger. PostgreSQL contracts pass for every race, symmetry,
release, uncertainty, keyword, and boundary case named above.

### QA-05 — Reconciled aliases remain actionable

**Severity:** P0  
**Evidence:**

- Reconciliation only stamps `canonicalIntentId` and labels (`scripts/reconcile-journeys.ts:134-154`); it does not transfer/abandon alias-owned work.
- The gate worker selects raw pending `gate_queue` rows and checks only the source conversation's state (`src/services/gateQueueWorker.ts:83-111`, `155-176`).
- DONE routing reads raw conversations without canonical ownership filters (`src/services/conversationService.ts:51-81`).
- `markIntentCompleted` updates only an intent whose `canonicalConversationId` equals the completed conversation (`src/services/journeyIntentService.ts:287-301`); completion through an alias does not complete the intent.
- Conversation lists and counts query raw conversation state without canonical filtering (`src/api/conversations.routes.ts:66-91`, `161-193`), and the frontend exposes no canonical/alias view.

**Failure scenario:** after reconciliation, an alias's old gate queue can still deliver a second gate. DONE can complete an alias while leaving the canonical intent open, so canonical recovery can later post publicly. Dashboard counts continue to show aliases as actionable failures.

**Required fix:**

1. Add a central canonical-resolution service used by gate, DONE, completion, recovery, and UI queries.
2. During reconciliation, migrate or terminally abandon alias gate queues/recovery records/drafts with an auditable reason.
3. Resolve completion by `conversation.canonicalIntentId`, atomically complete the intent/canonical conversation, and reconcile alias state without deleting history.
4. Default operational lists/counts to canonical intents; provide an explicit raw-history/alias view.

**Regression tests:** CF-04 through CF-09, especially “alias completes” and “pending alias gate after reconciliation.”

**2026-08-08 resolution:** Closed at code level. The central resolver makes unreconciled
and canonical conversations operational and aliases historical-only. Gate, DONE,
completion, prospective/historical recovery, reconciliation, API, and web paths use that
authority. Real-PostgreSQL reconciliation contracts also prove claimed/sending alias work
is never repointed underneath an active worker.

### QA-06 — Feature 2 final send check can miss sibling completion

**Severity:** P1  
**Evidence:** `suppressRecoveriesForCompletionSafely` intentionally swallows database errors (`src/services/dmRecoveryService.ts:696-726`). Its comment claims the final worker policy remains safe, but `loadPolicyContext` reads completion only from the recovery row's source conversation (`src/services/dmRecoveryRepository.ts:41-49`, `117-125`). It does not read the canonical intent or any completed same-person/keyword conversation.

**Failure scenario:** a sibling/alias journey completes, the best-effort bulk suppression fails, and the source conversation remains incomplete. The final authorization sees no completion and can post a public reminder for a guide already delivered.

**Required fix:** make the final transaction query the canonical intent's `completedAt` (preferred) or any current same-person/keyword completion. Best-effort denormalized stamping may remain for UI speed, but it cannot be the safety authority.

**Regression test:** force completion suppression to fail, complete a sibling journey, then prove `authorizeClaimForSend` suppresses the original recovery.

**2026-08-08 resolution:** Closed at code level as part of canonical ownership. The final
prospective policy context resolves the source conversation, reads authoritative intent
completion, and retains the unreconciled same-person/keyword fallback. The canonical and
legacy sibling-completion contract cases pass against PostgreSQL.

### QA-07 — Holdout assignment breaks the small pilot

**Severity:** P1  
**Evidence:** `src/services/historicalRecoverySelector.ts:264-271` uses `index % 100 < holdoutPercent` on an oldest-first list. A direct reproduction for the specified 25-person pilot gives:

```text
10% holdout, N=25 => 10 holdout / 15 treatment
50% holdout, N=25 => 25 holdout / 0 treatment
```

At 50%, the first 25-person pilot sends to nobody. At 10%, it withholds 40%, not 10%, and assignment is confounded with comment age.

**Required fix:** use a stable hash of campaign/experiment version plus Instagram user ID, or a deterministic seeded stratified permutation. Validate the realized arm counts at campaign creation and refuse a pilot with zero treatment or zero required holdout.

**Regression tests:** N=25 at 10% and 50%, deterministic rerun, stable per person, no ordering/age confound.

### QA-08 — Campaign pacing is only partially enforced

**Severity:** P1  
**Evidence:**

- `RecoveryCampaign.batchSize` is stored and stageable (`prisma/schema.prisma:875-901`, `src/services/recoveryCampaignControl.ts:188-210`), but the worker uses only global `DM_RECOVERY_BATCH_SIZE` (`src/services/historicalRecoveryWorker.ts:83-92`).
- Hour/day counts are read and then the send occurs without a shared transactional lock or reservation (`src/services/historicalRecoveryWorker.ts:95-145`, `176-251`).
- Counts include only confirmed `sent` rows, explicitly excluding uncertain attempts (`src/services/historicalRecoveryRepository.ts:198-210`). They are per campaign and do not share the prospective global capacity control.

**Failure scenario:** advancing `batchSize` in the dashboard/API has no effect. Multiple workers/campaigns can each observe headroom and exceed caps. An uncertain post does not consume a slot even though it may be live.

**Required fix:** use the campaign batch size (bounded by an emergency global maximum), and reserve campaign plus global hour/day capacity in the same transaction that authorizes the claimed row. Count in-flight and uncertain attempts. Keep the newly added daily check, but move it behind the authoritative reservation.

**Regression tests:** two-process cap race, campaign batch-size stage change, uncertain-attempt capacity, prospective+historical global cap.

**2026-08-08 resolution:** Closed at code level. A database singleton lease admits one
historical tick across service instances, and each running campaign receives its own
database-backed batch run and allowance. Dispatch start validates and consumes that
allowance under the documented lock order. The public dispatch ledger now reserves a
shared rolling global daily cap as well as the existing hourly/campaign limits. Real
PostgreSQL contracts cover concurrent ticks, different campaign batch sizes, stale lease
tokens, exact expiry boundaries, cross-feature daily exhaustion, and in-flight/uncertain
capacity.

### QA-09 — Fetch failures are mislabeled as deleted comments

**Severity:** P1  
**Evidence:** `src/meta/fetchComment.ts:16-25` explicitly throws so deletion and network failure can be distinguished. `src/services/historicalRecoveryWorker.ts:121-124` catches every failure and returns `null`, which `historicalRecoveryRecheck.ts:67-74` turns into terminal `source_comment_deleted`. The unit test at `src/services/historicalRecoveryWorker.test.ts:184-193` encodes this behavior with an arbitrary rejected promise.

**Failure scenario:** timeout, rate limit, Meta 5xx, expired token, or permission regression permanently suppresses an otherwise valid candidate and corrupts source-unavailable metrics.

**Required fix:** classify the read error. Suppress only a provider response proven to mean the comment is missing/unresolvable; open the circuit for auth/permission; defer with backoff for rate limit/transient/unknown failures. Record the safe category separately from source deletion.

**Regression tests:** definitive missing, hidden, auth, rate limit, timeout, and 5xx cases.

**2026-08-08 resolution:** Closed at code level. `903b524` preserves the distinction
returned by `fetchComment`: only a definitive missing/unresolvable provider response can
exhaust a source. Auth/permission opens the shared circuit, while rate limit, transport,
5xx, and unknown failures defer without terminally suppressing the candidate. The live
recheck retains approved fallback ordering and never interprets an unavailable read as a
deleted comment.

### QA-10 — Retry/lease outcome model is unsafe

**Severity:** P1  
**Evidence:**

- `safe_retry` just releases the claim (`src/services/historicalRecoveryWorker.ts:212-219`); `RecoveryCandidate` has no `attempts`, `lastAttemptAt`, or `nextAttemptAt` (`prisma/schema.prisma:909-943`). A rate limit can retry every tick forever.
- The worker claims before campaign/person/contact/source/cap database reads (`src/services/historicalRecoveryWorker.ts:95-145`). If any of those reads throws, the outer catch returns `tick_failed` without releasing the current claim. Lease reconciliation later marks it `send_uncertain` (`src/services/historicalRecoveryRepository.ts:91-113`) even though Meta was never called.

**Required fix:** add an explicit attempt state with durable attempts, exponential backoff/jitter, and a maximum. Distinguish `claimed/preparing` from `dispatch_started`; release safely on pre-network failures, and mark uncertain only when dispatch may have started. Store a claim token as required by QA-02.

**Regression tests:** DB failure before dispatch returns candidate to retry without uncertainty; crash after dispatch start becomes uncertain; repeated safe-retry respects backoff/max.

**2026-08-08 resolution:** Closed at code level. Historical dispatch start now returns a
typed result and performs the final campaign, circuit, claim, batch, allowance, and
reservation checks before any network call. Pre-network blocks release only a reserved
ledger row; a dispatch-started row cannot be released or rewritten as ordinary
cancellation. Cancellation reports in-flight candidates separately, terminal outcomes
may still finalize after cancellation, and expired dispatch-started work reconciles to
`send_uncertain`. Real PostgreSQL interleaving contracts cover pause/cancel/circuit races
on both sides of the dispatch boundary.

### QA-11 — Source and eligibility evidence are wrong or incomplete

**Severity:** P1  
**Evidence:**

- The selector picks the **oldest** trigger (`ORDER BY received_at ASC`) at `src/services/historicalRecoverySelector.ts:139-145`, while the design requires the newest still-available eligible source.
- `hasEngagementEvidence` checks only any inbound DM, not exact read/reaction/postback/quick-reply evidence, and does not prove it occurred after the request (`src/services/historicalRecoverySelector.ts:105-111`).
- `priorPublicRecovery` checks prospective rows only (`lines 118-120`).
- Final recheck counts any lifetime inbound and any completed keyword (`src/services/historicalRecoveryWorker.ts:109-120`), not “since selection” and not the candidate's same keyword. `ClaimedCandidate` omits `keywordId` and selection cutoff (`src/services/historicalRecoveryRepository.ts:16-27`).

**Failure scenarios:** a deleted oldest comment suppresses a candidate even when a newer trigger is available; an inbound predating the request excludes the candidate; completion of an unrelated guide suppresses it; exact positive read/reaction evidence is missed.

**Required fix:** select the newest available trigger with deterministic fallback and snapshot the chosen-trigger reason. Build one evidence query scoped to person + keyword + intent + relevant timestamps, including all positive signals and both recovery systems. Carry keyword/cutoff through the claimed row and final recheck.

**Regression tests:** oldest deleted/newest valid, pre-request inbound, unrelated-keyword completion, exact seen/reaction/postback, and prior historical send.

### QA-12 — Campaign and measurement lifecycle cannot complete

**Severity:** P1  
**Evidence:**

- `completeCampaignIfDrained` exists (`src/services/recoveryCampaignControl.ts:152-175`) but has no production caller.
- Holdout rows remain `outcome = pending`; the `holdout_withheld` enum is never written. Even if completion were called, its pending count includes holdouts, so a holdout campaign cannot drain.
- `laterInboundAt` and `laterCompletedAt` exist in the schema/UI but have no writer (repository-wide search finds only declarations/reads).
- The dashboard's recovered view depends on `laterCompletedAt` (`src/api/historicalRecovery.routes.ts:59-61`), so it remains empty and recovery rate cannot be measured.

**Required fix:** terminally mark holdout assignment at approval/start (without ever sending), define “drained” as no actionable treatment candidates, call completion after every terminal transition/tick, and wire inbound/completion events to both treatment and holdout candidate attribution using person/keyword/time rules. Make attribution idempotent and preserve earliest timestamps.

**Regression tests:** treatment+holdout campaign finishes, recovered treatment attribution, spontaneous holdout completion, idempotent replay, cancellation and no-treatment campaigns.

**2026-08-08 partial resolution:** The campaign-lifecycle half is closed. Approval and
holdout settlement now commit atomically; approval verifies the persisted manifest,
decision hash, and declared counts. Drain ignores terminal holdouts, preserves a paused
latch, and reconciles all running campaigns on worker start/end so a crash after the last
candidate cannot strand a campaign in `running`. Earliest event handling and explicit
24/48-hour outcome windows remain part of the selection-attribution slice, so QA-12 is
not yet fully closed.

### QA-13 — Required historical stop conditions are absent

**Severity:** P1  
**Evidence:** the historical worker calls `evaluateRecoveryHealth` (`src/services/historicalRecoveryWorker.ts:78-81`), but `src/services/dmRecoveryHealth.ts:70-148` derives backlog, failure rate, webhook coverage, and send counts only from `dm_recovery_reminder`. It never reads `recovery_candidate`. Repository search finds no historical complaint, opt-out, duplicate-post, or unexpected-classifier stop signal.

**Failure scenario:** historical sends begin failing or producing uncertainty/complaints while prospective recovery remains healthy; the circuit stays open for sending rather than pausing the historical campaign.

**Required fix:** add phase/campaign health observations for failure, uncertainty, source-unavailable, complaint/negative reply, opt-out/block, duplicate reply, and classifier anomalies. Pause and latch the campaign automatically at conservative thresholds; require owner review to resume the relevant stop reasons.

**Regression tests:** each required stop signal, campaign-only pause, shared auth circuit, and controlled recovery/resume.

**2026-08-08 resolution:** Closed at code level. Safe, append-only campaign observations
record complaint, opt-out, block, negative-reply, and classifier-anomaly signals without
storing inbound text or provider payloads. Observation insert and campaign pause share
the final dispatch campaign lock, so a committed signal fences the next start. Source
keys make capture idempotent. Because the webhook endpoint acknowledges before handler
work, every new inbound message also remains a durable pending safety-inbox row until
classification succeeds; the historical worker drains that inbox or fails closed before
opening a batch. Inbound persistence shares the global dispatch-control lock, reserved
attempts use their reservation timestamp for attribution, and final authorization
rechecks all inbound evidence since candidate selection even after its safety-inbox row
was marked captured. Manual safety observations require admin identity and a bounded
safe detail. Duplicate contact is derived from terminal/in-flight dispatch-ledger
history rather than the one-row-per-candidate table. After every terminal worker
outcome, health is reevaluated and the campaign is stopped before the next candidate
when a conservative threshold is crossed. An unavailable health reading also fails
closed for that campaign. Stop reasons remain owner-latched.

### QA-14 — Source cutoff does not make selection reproducible

**Severity:** P1  
**Evidence:** `src/services/historicalRecoverySelector.ts:61-63` claims every time-sensitive subquery is cutoff-bounded. In the query, only selected event/message timestamps use `${cutoff}`. Gate status, same-keyword completion, prior recovery, newer intent, keyword activity, and audience-origin reads at lines 87-148 are live and unbounded.

**Failure scenario:** rerunning the same selection version and cutoff after a completion, gate update, recovery send, keyword edit, or origin reclassification returns a different list, defeating reviewed dry-run reproducibility.

**Required fix:** either query versioned/as-of evidence for every predicate or persist a complete dry-run decision snapshot (including every inclusion/exclusion) before approval and promote that exact snapshot. Add a uniqueness key for selection version/cutoff/filter set and compare rerun hashes.

**Regression test:** mutate each live predicate after a fixed cutoff; rerun must produce the same candidate/exclusion manifest and hash.

### QA-15 — Reconciliation evidence is incomplete and writes are non-atomic

**Severity:** P1  
**Evidence:**

- `scripts/reconcile-journeys.ts:36-53` treats only `gate_queue.status = sent` as accepted-gate evidence. A successful first-attempt gate creates no gate queue, so its authoritative accepted event/recovery message ID is ignored.
- The script upserts an intent, then updates canonical and aliases in separate operations (`lines 104-154`) without a transaction per window or checkpoint.
- Existing live canonical intent keys can differ from a new grouping derived from raw `conversation.createdAt`, increasing mixed-history rerun risk.

**Failure scenario:** an actually gated journey loses canonical precedence to an earlier failed journey. A crash leaves some aliases repointed and others raw; a rerun against live-created intents can produce a different partial interpretation.

**Required fix:** derive accepted delivery from authoritative tracked gate receipt/recovery row plus safe confirmed event IDs, not only the retry queue. Reconcile each window in one transaction, merge/skip existing canonical intent IDs explicitly, and write a restart checkpoint/conflict manifest.

**Regression tests:** first-attempt accepted vs retry accepted precedence, crash/restart, rerun idempotency, and coexistence with live canonical intents.

**2026-08-08 resolution:** Closed at code level. `f24fdae` includes authoritative
`dm_recovery_reminder.acceptedAt` and tracked Instagram message evidence when the
best-effort event log is absent. Live resolution and reconciliation take the same stable
person-keyword transaction advisory lock, then fence all overlapping intents and every
claimable alias work row. Equal timestamps use stable IDs. Each frozen window is written
with its fingerprint, evidence choice, exact conflict/result, and checkpoint in one
transaction; write mode requires the matching approved dry-run manifest and restart
resumes only after the last committed window.

### QA-16 — Trigger backfill loses history

**Severity:** P1  
**Evidence:** `scripts/backfill-journey-triggers.ts:34-68` joins only `journey_intent.canonical_conversation_id` and only intents with zero triggers. It creates one trigger, always with `disposition = new_journey` (`lines 89-124`). It never reconstructs triggers from alias conversations. The global unique comment rule makes the script deliberately skip a second distinct-keyword intent for one comment (`lines 74-98`).

**Failure scenario:** media/comment/acknowledgement history from aliases disappears from the canonical timeline, the selector cannot choose the newest source, and “every trigger retained” metrics are false.

**Required fix:** enumerate every raw conversation/source event in each reconciled window, attach every distinct trigger to the canonical intent with its original conversation, media, time, disposition, and acknowledgement result. Model one source comment matching multiple distinct keyword IDs without silently discarding one relationship (for example, separate source-event identity from intent-trigger association).

**Regression tests:** two alias comments, cross-post repeat, same comment with two distinct keyword IDs, replay, and idempotent rerun.

**2026-08-08 resolution:** Closed at code level. `f24fdae` separates globally unique
source-event identity from keyword/intent associations. Backfill enumerates every
reconstructable source event and association, retaining the original event ID, time,
media, source, disposition, public acknowledgement state, reply ID, and safe error
category. One comment may belong to multiple distinct keyword intents without weakening
webhook replay uniqueness, and contradictory media identity fails the migration instead
of selecting a silent winner.

### QA-17 — Settings signature audit evidence is missing

**Severity:** P1  
**Evidence:**

- Feature 1 classification correctly uses the exact numeric allowlist (`src/services/graphErrorClassifier.ts:64-90`) and the default is empty (`src/config/env.ts:154-196`).
- However, `scheduleSettingsBlockedRecovery` stores no matched code, subcode, verification version, verified date, or evidence package ID (`src/services/dmRecoveryService.ts:247-289`). Callers at `src/handlers/commentHandler.ts:200-224` and `src/services/gateQueueWorker.ts:225-247` do not pass them.
- Recovery UI/API metrics identify only `triggerKind = settings_blocked`; they cannot show the required signature/version or classifier breakdown.

**Failure scenario:** after an allowlist change, an owner cannot prove which verified pair justified a specific public settings claim or audit first-production matches by version.

**Required fix:** persist safe numeric `graphCode`, `graphSubcode`, `verificationVersion`, and evidence-package/version metadata on the recovery decision (or immutable linked audit row). Pass them through both first-send and retry paths, display them in detail, and aggregate signature breakdown without raw provider text.

**Regression tests:** exact values survive create/upsert/replay; unverified or missing version cannot create the settings candidate; UI/API expose only safe fields.

**2026-08-08 resolution:** Closed at code level by `a435cc3`. A row-level-security
registry stores immutable versioned controlled evidence with bounded validity and one
active version per exact signature. New settings reminders require a complete snapshot
whose registry ID/version/code/subcode is enforced by a composite foreign key; an insert
cannot claim legacy status and evidence cannot be rewritten. Scheduling locks and
revalidates the registry row in the same transaction as insertion, closing the retirement
race, while exact replay preserves the original evidence. Both first-send and retry paths
require the independent environment allowlist plus a current exact registry record. Safe
admin APIs, metrics, drawer/list states, and activation controls expose current, stale,
retired, or missing status without controlled-account, verifier, raw response, token, or
message data. The separately authorized controlled-Meta evidence run remains a production
gate and was not executed here.

### QA-18 — Approved uppercase keyword rule is not enforced

**Severity:** P2  
**Evidence:** `src/services/dmRecoveryPolicy.ts:39-50` trims `keywordSnapshot` but interpolates its original case. The Feature 1 design requires the snapshotted configured keyword displayed in uppercase (`design` lines 139–145).

**Required fix:** normalize with a documented locale-safe uppercase rule at snapshot/render time and store the exact result. Apply the same rule to the repaired historical templates.

**Regression tests:** lowercase/mixed-case, whitespace, nonempty validation, and immutable copy after keyword rename.

### QA-19 — Dashboard/API acceptance gaps

**Severity:** P2  
**Evidence:**

- Historical UI always selects the newest campaign (`web/src/pages/HistoricalRecovery.tsx:65-77`); prior campaigns cannot be inspected.
- Header says everyone “never received” the guide (`lines 138-142`), which is false for unknown-read candidates.
- Approval sends hardcoded `approvedBy: "owner"` (`lines 81-95`), and the API trusts the body instead of the authenticated `req.adminEmail` (`src/api/historicalRecovery.routes.ts:196-219`).
- The API parses `asOf` but does not use or return it (`src/api/historicalRecovery.routes.ts:119-193`), and the client has no stable pagination flow.
- The view model exposes `canAdvanceStage`, but the page has no stage action. There is no historical mark-reviewed action or candidate audit/detail drawer.
- A Graph reply ID is rendered as an Instagram post shortcode (`web/src/pages/HistoricalRecovery.tsx:303-311`), producing an invalid `/p/{replyId}` link.
- Feature 3 canonical/alias labels, canonical-only operational counts, and raw-history toggle are absent from the conversation UI/API.

**Required fix:** add campaign selection/history, phase/evidence-aware wording, authenticated approval identity, stable pagination, stage controls, mark-reviewed, candidate audit detail, a valid source-post/comment navigation strategy, and canonical/alias dashboard views. Add browser tests for all owner actions and attention states.

### QA-20 — Release verification gaps

**Severity:** P2  
**Evidence from this audit:**

- Root tests: **72 files passed, 5 skipped; 1,069 passed, 72 skipped**.
- The five skipped suites are real-Postgres contracts gated by `MIGRATION_TEST_DATABASE_URL`: comment claims, DM recovery, journey intent, recovery campaign, and reply drafts.
- Web tests: **25 files / 372 tests passed**.
- Root and web production builds passed.
- Web lint failed with 9 existing errors in `AiConnectionCard.tsx`, `AppShell.tsx`, `button.tsx`, `Insights.tsx`, and `SequenceEditor.tsx`.
- There is no historical-recovery Playwright specification under `web/e2e`.
- No controlled Meta settings rejection, read/reaction/postback delivery, or public historical reply was executed.

**2026-08-08 rerun:** the database-contract portion of this finding is now closed. A fresh
PostgreSQL 17 database ran all 90 backend files and 1,385 tests with zero skips, including
the new migration/backfill, dispatch-race, lease, capacity/cooldown, and canonical-flow
contracts. Backend and frontend builds pass; all 376 frontend tests pass; touched-file
lint passes. QA-20 remains open for the unrelated repository-wide lint baseline,
historical owner-flow browser coverage, controlled Meta verification, and production
rollout evidence.

**Required fix before launch:** run all database contract suites against the exact deployed PostgreSQL migration set; add multi-client race contracts for QA-02/04/08; add historical owner-flow Playwright coverage; clear the lint baseline; execute the controlled Meta verification/evidence runbook and archive its redacted evidence.

## Acceptance coverage by feature

### Feature 1 — Explicit settings failure

| Acceptance area | Status | Notes |
|---|---|---|
| Empty-default exact numeric allowlist; no message-text match | Pass | Config and classifier are narrow; forbidden `100:2534025` is rejected |
| Negative error-family classification | Pass in unit tests | Rate limit precedes allowlist; auth/invalid/ambiguous families are separated |
| Exact copy snapshot | Partial | Copy is snapshotted, but uppercase is not enforced |
| Idempotent source record and prospective worker uncertainty safety | Pass | Real-PostgreSQL first-send, retry, replay, and verification-identity contracts pass |
| Evidence/version visible to owner and signature metrics | Pass at code level | Immutable safe evidence and current/stale/retired/missing states are exposed; controlled Meta evidence is still unverified |
| Controlled Meta test and first-match audit | Unverified | Feature must remain inert until completed |

### Feature 2 — Prospective no-confirmed-read recovery

| Acceptance area | Status | Notes |
|---|---|---|
| Exact gate message correlation and positive-signal suppression | Pass in local tests | Read/reaction/postback/inbound paths exist |
| Durable leases, final authorization, retries, uncertain outcomes | Pass in local tests | This path has stronger state/cap machinery than Feature 4 |
| Deterministic treatment/control and dashboard states | Pass in local tests | Separate settings rows are excluded from experiment metrics |
| Same-keyword/canonical completion authority | Pass at code level | Canonical intent and sibling completion are rechecked before reservation |
| Shared person cooldown/cap with Feature 4 | Pass at code level | QA-04 closed by the shared dispatch ledger |
| Production Meta/webhook observation period | Unverified | Required before Feature 4 |

### Feature 3 — Journey canonicalization

| Acceptance area | Status | Notes |
|---|---|---|
| Live same-person/keyword 48-hour reuse and replay handling | Pass | Serializable real-PostgreSQL contracts ran in the 2026-08-08 fresh-database suite |
| Exactly one canonical owner for gate/completion/recovery | Pass at code level | QA-05 closed by the central resolver and operational predicate |
| Alias completion reconciles canonical state | Pass at code level | Alias history is preserved while the canonical owner/intent complete atomically |
| Historical reconciliation dry-run/idempotency/restartability | Pass at code level | Approved manifest, transaction checkpoint, shared locks, and exact conflicts close QA-15 |
| Every trigger preserved | Pass at code level | Source-event associations preserve alias and multi-keyword history under QA-16 |
| Canonical actionable UI and separate metrics | Partial | Canonical/raw conversation modes are complete; broader QA-19 historical controls remain |

### Feature 4 — Historical recovery

| Acceptance area | Status | Notes |
|---|---|---|
| Canonical unique-person snapshot | Pass at code level | Stable per-person assignment, bounded source/evidence rules, cutoff fencing, and manifest integrity are enforced |
| Confirmed vs unknown-read phases separate | Pass at code level | QA-03 selector and database constraints pass |
| Approved uncertainty-aware copy | Pass at code level | QA-01 working action and negative wording tests pass |
| Stable randomized pilot/holdout | Pass at code level | QA-07 deterministic assignment and atomic reviewed snapshot are closed |
| Exclusive claims and no duplicate public sends | Pass at code level | QA-02/04 real-PostgreSQL concurrency contracts pass |
| Final source/evidence/cooldown recheck | Pass at code level | QA-04, QA-09, and QA-11 are closed, including approved fallback and final transactional fences |
| Batch/hour/day caps and outage recovery | Pass at code level | QA-08/10 closed with distributed tick/batch fencing, shared rolling capacity, and truthful reconciliation |
| Kill switch/pause/cancel/shared auth circuit | Pass at code level | Final dispatch authorization and QA-13 durable stop observations are owner-latched and tested |
| Campaign lifecycle, attribution, audit dashboard | Partial | Lifecycle and attribution are closed; broader P2 QA-19 owner controls remain |
| Phase 1 observation before Phase 2 pilot | Not enforceable | CLI defaults directly to unknown-read and dependencies are not gated |

## Required implementation order

1. **Keep `DM_RECOVERY_HISTORICAL_ENABLED=false`.** Do not create/approve a production historical campaign from the current selector.
2. P0 code remediation is complete for QA-01 through QA-05. Before production, run the read-only collision/backfill preflight and review migration compatibility.
3. P0 and P1 remediation is complete at code level for QA-01 through QA-17.
4. Finish the remaining P2 correctness/owner-flow work in QA-18 and QA-19.
5. Complete QA-20's controlled Meta run and production preflight. Create and activate a
   settings verification version only from separately authorized sanitized evidence.
6. Perform a reviewed Phase 1 dry run. Only after owner-reviewed Phase 1 and prospective
   Feature 2 evidence should a small randomized Phase 2 pilot be selectable.

## Commands and evidence captured

```text
npm test -- --reporter=dot
# 72 passed files, 5 skipped; 1,069 passed tests, 72 skipped

npm run build
# passed (Prisma generate + TypeScript)

cd web && npm test -- --reporter=dot
# 25 passed files; 372 passed tests

cd web && npm run build
# passed; Vite warned about a 936.22 kB minified bundle

cd web && npm run lint
# failed: 9 errors in 5 pre-existing frontend files

node holdout reproduction
# N=25: 10% setting produces 10/15, 50% setting produces 25/0

# 2026-08-08 P0 remediation rerun on a fresh disposable PG17 database
MIGRATION_TEST_DATABASE_URL=<local-pg17-url> DATABASE_URL=<same-local-pg17-url> npm test
# 90 passed files; 1,385 passed tests; 0 skipped

npm run build
# passed (Prisma generate + TypeScript)

cd web && npm test
# 25 passed files; 376 passed tests

cd web && npm run build
# passed (2,312 modules; 356.02 kB JS / 104.03 kB gzip)

cd web && npx eslint src/pages/Conversations.tsx src/pages/Conversations.test.tsx src/lib/types.ts
# passed

cd web && npm run lint
# unchanged repository baseline: 9 errors in 5 unrelated files

# 2026-08-08 P1 dispatch-safety slice, disposable local PostgreSQL database
npm run prisma:generate
npx prisma validate
git diff --check origin/main...HEAD
# all passed

MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL=<disposable-local-url> DATABASE_URL=<same-local-url> npm test -- \
  src/services/historicalRecoverySafetyMigrationContract.test.ts \
  src/services/historicalRecoveryDispatchInterleavingContract.test.ts \
  src/services/historicalRecoveryClaimContract.test.ts \
  src/services/publicRecoveryDispatchPostgresContract.test.ts \
  src/services/historicalRecoveryLifecycleContract.test.ts \
  src/services/historicalRecoveryTickContract.test.ts \
  src/services/campaignHealthObservationContract.test.ts \
  src/services/historicalRecoveryHealthContract.test.ts
# 8 passed files; 100 passed tests; passed initially and on three repeat runs

MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL=<disposable-local-url> DATABASE_URL=<same-local-url> npm test
# 97 passed files; 1,487 passed tests

npm run build
# passed (Prisma generate + TypeScript)

cd web && npm test
# 25 passed files; 376 passed tests

cd web && npm run build
# passed (2,312 modules; 356.02 kB JS / 104.03 kB gzip)

cd web && npm run test:e2e
# 66 passed (desktop and mobile)

cd web && npm run lint
# unchanged repository baseline: 9 errors in the same 5 untouched P2 files

# 2026-08-08 consolidated P1 release verification, fresh disposable PG17 + shadow
npx prisma migrate deploy
npx prisma migrate status
npx prisma migrate diff --exit-code --from-migrations prisma/migrations \
  --to-url <fresh-disposable-url> --shadow-database-url <fresh-shadow-url>
# 45 migrations applied; schema up to date; no difference detected

MIGRATION_TEST_DATABASE_DISPOSABLE=true \
  MIGRATION_TEST_DATABASE_URL=<fresh-disposable-url> \
  DATABASE_URL=<same-fresh-disposable-url> npx vitest run
# 107 passed files; 1,610 passed tests

npm run build
# passed (Prisma generate + TypeScript)

cd web && npm test
# 25 passed files; 382 passed tests

cd web && npm run build
# passed (2,312 modules; 356.02 kB JS / 104.03 kB gzip)

cd web && npx eslint e2e/main.tsx \
  src/components/conversations/DmRecoveryDrawer.test.tsx \
  src/components/conversations/DmRecoveryDrawer.tsx \
  src/components/conversations/DmRecoveryList.test.tsx \
  src/components/conversations/DmRecoveryList.tsx \
  src/components/conversations/dmRecoveryViewModel.test.ts \
  src/lib/api.ts src/lib/types.ts
# passed

cd web && E2E_PORT=<unused-local-port> npm run test:e2e
# 66 passed (desktop and mobile)
```
