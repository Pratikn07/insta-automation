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
remaining items, QA-02, QA-04, and QA-05. The verified implementation revision is
`1653208` plus its ancestors through `16b5128`.

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

## Executive verdict

**Do not enable historical recovery (Feature 4) in production yet.** The five P0 code
defects from the original audit are now closed, but production still requires the
read-only collision/backfill preflight, migration compatibility review, controlled Meta
verification, and separate rollout authorization. Remaining non-P0 findings and launch
evidence in this report are not waived by the P0 remediation.

Feature 1 must remain inert until a controlled Meta settings-rejection signature is
verified and its evidence/version is carried into the recovery audit record. Feature 2,
Feature 3, and Feature 4 now share code-level dispatch and canonical-ownership safety,
but no statement here substitutes for live Meta or production rollout evidence.

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
| QA-07 | 4 | P1 | Position-based arm assignment breaks the small randomized pilot |
| QA-08 | 4 | P1 | Campaign batch size is ignored and cap accounting has no transactional reservation |
| QA-09 | 4 | P1 | Source lookup errors are converted into confirmed deletion suppressions |
| QA-10 | 4 | P1 | Safe retries are unbounded, while pre-dispatch failures can become false `send_uncertain` outcomes |
| QA-11 | 3, 4 | P1 | Historical source/evidence selection uses the oldest trigger and incomplete or incorrectly scoped evidence |
| QA-12 | 4 | P1 | Holdout, completion, and outcome-attribution lifecycle is not wired, so campaigns and recovery metrics cannot finish |
| QA-13 | 4 | P1 | Historical failure, uncertainty, complaint, and duplicate stop conditions are not implemented |
| QA-14 | 4 | P1 | The claimed selection cutoff does not make selection reproducible |
| QA-15 | 3 | P1 | Historical reconciliation uses incomplete gate evidence and is not atomic per intent window |
| QA-16 | 3 | P1 | Trigger backfill retains only one canonical trigger and drops alias/distinct-keyword history |
| QA-17 | 1 | P1 | Verified settings signature and verification version are not persisted or exposed |
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

### QA-09 — Fetch failures are mislabeled as deleted comments

**Severity:** P1  
**Evidence:** `src/meta/fetchComment.ts:16-25` explicitly throws so deletion and network failure can be distinguished. `src/services/historicalRecoveryWorker.ts:121-124` catches every failure and returns `null`, which `historicalRecoveryRecheck.ts:67-74` turns into terminal `source_comment_deleted`. The unit test at `src/services/historicalRecoveryWorker.test.ts:184-193` encodes this behavior with an arbitrary rejected promise.

**Failure scenario:** timeout, rate limit, Meta 5xx, expired token, or permission regression permanently suppresses an otherwise valid candidate and corrupts source-unavailable metrics.

**Required fix:** classify the read error. Suppress only a provider response proven to mean the comment is missing/unresolvable; open the circuit for auth/permission; defer with backoff for rate limit/transient/unknown failures. Record the safe category separately from source deletion.

**Regression tests:** definitive missing, hidden, auth, rate limit, timeout, and 5xx cases.

### QA-10 — Retry/lease outcome model is unsafe

**Severity:** P1  
**Evidence:**

- `safe_retry` just releases the claim (`src/services/historicalRecoveryWorker.ts:212-219`); `RecoveryCandidate` has no `attempts`, `lastAttemptAt`, or `nextAttemptAt` (`prisma/schema.prisma:909-943`). A rate limit can retry every tick forever.
- The worker claims before campaign/person/contact/source/cap database reads (`src/services/historicalRecoveryWorker.ts:95-145`). If any of those reads throws, the outer catch returns `tick_failed` without releasing the current claim. Lease reconciliation later marks it `send_uncertain` (`src/services/historicalRecoveryRepository.ts:91-113`) even though Meta was never called.

**Required fix:** add an explicit attempt state with durable attempts, exponential backoff/jitter, and a maximum. Distinguish `claimed/preparing` from `dispatch_started`; release safely on pre-network failures, and mark uncertain only when dispatch may have started. Store a claim token as required by QA-02.

**Regression tests:** DB failure before dispatch returns candidate to retry without uncertainty; crash after dispatch start becomes uncertain; repeated safe-retry respects backoff/max.

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

### QA-13 — Required historical stop conditions are absent

**Severity:** P1  
**Evidence:** the historical worker calls `evaluateRecoveryHealth` (`src/services/historicalRecoveryWorker.ts:78-81`), but `src/services/dmRecoveryHealth.ts:70-148` derives backlog, failure rate, webhook coverage, and send counts only from `dm_recovery_reminder`. It never reads `recovery_candidate`. Repository search finds no historical complaint, opt-out, duplicate-post, or unexpected-classifier stop signal.

**Failure scenario:** historical sends begin failing or producing uncertainty/complaints while prospective recovery remains healthy; the circuit stays open for sending rather than pausing the historical campaign.

**Required fix:** add phase/campaign health observations for failure, uncertainty, source-unavailable, complaint/negative reply, opt-out/block, duplicate reply, and classifier anomalies. Pause and latch the campaign automatically at conservative thresholds; require owner review to resume the relevant stop reasons.

**Regression tests:** each required stop signal, campaign-only pause, shared auth circuit, and controlled recovery/resume.

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

### QA-16 — Trigger backfill loses history

**Severity:** P1  
**Evidence:** `scripts/backfill-journey-triggers.ts:34-68` joins only `journey_intent.canonical_conversation_id` and only intents with zero triggers. It creates one trigger, always with `disposition = new_journey` (`lines 89-124`). It never reconstructs triggers from alias conversations. The global unique comment rule makes the script deliberately skip a second distinct-keyword intent for one comment (`lines 74-98`).

**Failure scenario:** media/comment/acknowledgement history from aliases disappears from the canonical timeline, the selector cannot choose the newest source, and “every trigger retained” metrics are false.

**Required fix:** enumerate every raw conversation/source event in each reconciled window, attach every distinct trigger to the canonical intent with its original conversation, media, time, disposition, and acknowledgement result. Model one source comment matching multiple distinct keyword IDs without silently discarding one relationship (for example, separate source-event identity from intent-trigger association).

**Regression tests:** two alias comments, cross-post repeat, same comment with two distinct keyword IDs, replay, and idempotent rerun.

### QA-17 — Settings signature audit evidence is missing

**Severity:** P1  
**Evidence:**

- Feature 1 classification correctly uses the exact numeric allowlist (`src/services/graphErrorClassifier.ts:64-90`) and the default is empty (`src/config/env.ts:154-196`).
- However, `scheduleSettingsBlockedRecovery` stores no matched code, subcode, verification version, verified date, or evidence package ID (`src/services/dmRecoveryService.ts:247-289`). Callers at `src/handlers/commentHandler.ts:200-224` and `src/services/gateQueueWorker.ts:225-247` do not pass them.
- Recovery UI/API metrics identify only `triggerKind = settings_blocked`; they cannot show the required signature/version or classifier breakdown.

**Failure scenario:** after an allowlist change, an owner cannot prove which verified pair justified a specific public settings claim or audit first-production matches by version.

**Required fix:** persist safe numeric `graphCode`, `graphSubcode`, `verificationVersion`, and evidence-package/version metadata on the recovery decision (or immutable linked audit row). Pass them through both first-send and retry paths, display them in detail, and aggregate signature breakdown without raw provider text.

**Regression tests:** exact values survive create/upsert/replay; unverified or missing version cannot create the settings candidate; UI/API expose only safe fields.

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
| Idempotent source record and prospective worker uncertainty safety | Pass in local tests | Real-DB contract skipped locally |
| Evidence/version visible to owner and signature metrics | Fail | QA-17 |
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
| Historical reconciliation dry-run/idempotency/restartability | Partial/Fail | Dry-run exists; evidence/atomic/restart behavior incomplete (QA-15) |
| Every trigger preserved | Fail | QA-16 |
| Canonical actionable UI and separate metrics | Partial | Canonical/raw conversation modes are complete; broader QA-19 historical controls remain |

### Feature 4 — Historical recovery

| Acceptance area | Status | Notes |
|---|---|---|
| Canonical unique-person snapshot | Partial | Per-campaign uniqueness exists, but source/evidence/cutoff correctness fails |
| Confirmed vs unknown-read phases separate | Pass at code level | QA-03 selector and database constraints pass |
| Approved uncertainty-aware copy | Pass at code level | QA-01 working action and negative wording tests pass |
| Stable randomized pilot/holdout | Fail | QA-07 |
| Exclusive claims and no duplicate public sends | Pass at code level | QA-02/04 real-PostgreSQL concurrency contracts pass |
| Final source/evidence/cooldown recheck | Partial | QA-04 is closed; QA-09/11 remain separate findings |
| Batch/hour/day caps and outage recovery | Partial | Daily check now exists; QA-08/10 remain |
| Kill switch/pause/cancel/shared auth circuit | Partial pass | Basic controls exist; historical stop conditions do not |
| Campaign lifecycle, attribution, audit dashboard | Fail/Partial | QA-12/19 |
| Phase 1 observation before Phase 2 pilot | Not enforceable | CLI defaults directly to unknown-read and dependencies are not gated |

## Required implementation order

1. **Keep `DM_RECOVERY_HISTORICAL_ENABLED=false`.** Do not create/approve a production historical campaign from the current selector.
2. P0 code remediation is complete for QA-01 through QA-05. Before production, run the read-only collision/backfill preflight and review migration compatibility.
3. Fix authoritative final policy and pacing: QA-06 through QA-11, with real-Postgres concurrency tests.
4. Wire lifecycle, measurement, stop conditions, and reproducible manifests: QA-12 through QA-16.
5. Finish Feature 1 audit evidence and operational UI: QA-17 through QA-19.
6. Run QA-20 verification, then perform a reviewed Phase 1 dry run. Only after owner-reviewed Phase 1 and prospective Feature 2 evidence should a small randomized Phase 2 pilot be selectable.

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
```
