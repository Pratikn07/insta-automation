# Instagram Automation Features 1–4 — Deep Logic QA

**Audit date:** 2026-08-07  
**Audited commit:** `e15f0d5230863b0f54462454da614d59f30df72a` (`main`)  
**P2 remediation revalidation:** 2026-08-08 on `fix/instagram-p2-remediation` through `a28cda7`
**Specifications:**

- `docs/superpowers/specs/2026-08-07-instagram-automation-feature-requests-1-3-4-design.md`
- `docs/superpowers/specs/2026-08-06-instagram-read-recovery-reminders-design.md` (Feature 2)

**Method:** requirements-to-code trace, static control-flow review, focused logic reproductions, unit/integration suite, TypeScript builds, and frontend lint. No production data was changed and no Meta API send was attempted.

## Executive verdict

**Do not enable historical recovery (Feature 4).** The current implementation can mix the two rollout phases, assign a small pilot entirely to holdout, allow two workers to claim and post the same candidate, and publish copy whose requested action is not connected to any recovery flow. Feature 3 is also not complete: reconciled aliases remain actionable in gate, completion, recovery, and dashboard code.

Feature 1 and the prospective Feature 2 have substantially better safety machinery and broad unit coverage, but they still have cross-feature/canonical-state gaps. Feature 1 must remain inert until a controlled Meta settings-rejection signature is verified and its evidence/version is carried into the recovery audit record.

The daily cap omission was fixed concurrently during this audit in `d18bec4`; this report was revalidated after that change and does **not** list “daily cap is absent” as an open defect. The remaining cap problem is transactional/global reservation and failure to use the campaign batch size.

### Severity

- **P0 — release blocker:** can double-contact a person, send an unapproved/false public statement, corrupt cohort meaning, or bypass a core safety invariant.
- **P1 — high:** can suppress or send the wrong candidate, make campaign safety/measurement unreliable, or leave production behavior unauditable.
- **P2 — medium:** operational, dashboard, audit, or validation gap that should be fixed before declaring the feature complete.

## Findings summary

| ID | Feature(s) | Severity | Finding |
|---|---|---:|---|
| QA-01 | 4 | P0 | Historical public copy is not the approved copy and its “reply here” action has no recovery path |
| QA-02 | 4 | P0 | Candidate claims are not exclusive; overlapping workers can post the same public reply twice |
| QA-03 | 4 | P0 | Campaign phase is stored but ignored during selection, so confirmed and unknown-read cohorts mix |
| QA-04 | 1, 2, 4 | P0 | Person cooldown and capacity are not shared across prospective and historical recovery |
| QA-05 | 3 | P0 | Reconciled aliases remain actionable and can still own gate retry, DONE completion, recovery, and dashboard rows |
| QA-06 | 2, 3 | P1 | Feature 2's final send check can miss a same-keyword completion on a sibling/canonical journey |
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
| QA-18 | 1, 2 | P2 | **Fixed 2026-08-08:** prospective and historical snapshots now use one trim/uppercase rule |
| QA-19 | 3, 4 | P2 | **Fixed 2026-08-08:** historical and canonical/raw owner controls are implemented and browser-covered |
| QA-20 | 1–4 | P2 | **Partially verified — external credential blocker:** the full local matrix passes; disposable-Postgres and controlled-Meta runs remain blocked |

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

### QA-03 — Phase is ignored and cohorts mix

**Severity:** P0  
**Evidence:** `selectHistoricalCandidates` accepts `phase` at `src/services/historicalRecoverySelector.ts:159-173`, but eligibility at lines 177–235 includes both `gate_exhausted` and `gate_sent_no_read`. `phase` is used only when the campaign row is created at lines 249–262. `scripts/select-historical-recovery.ts:42-55` hardcodes `unknown_read_pilot`, so there is no normal Phase 1 selector command.

**Failure scenario:** a campaign labeled `confirmed_failure` can contain unknown-read people, or the current `unknown_read_pilot` can contain confirmed failures. Copy, approval, sequencing, experiment analysis, and launch gates no longer mean what the campaign label says.

**Required fix:** filter the included pool before deduplication/limit/arm assignment:

- `confirmed_failure` -> only `gate_exhausted` (and any separately verified settings subclass);
- `unknown_read_pilot` -> only `gate_sent_no_read`.

Make `--phase` explicit in the CLI, reject absent/invalid phase, show excluded-out-of-phase counts, and enforce phase/evidence compatibility when candidates are written.

**Regression tests:** mixed fixture produces disjoint campaigns; Phase 1 never contains accepted/no-read evidence; Phase 2 never contains exhausted evidence.

### QA-04 — Public-recovery cooldown is not shared

**Severity:** P0  
**Evidence:**

- Prospective recovery checks only `dm_recovery_reminder` in `src/services/dmRecoveryRepository.ts:51-90`.
- Historical selection and recheck check `dm_recovery_reminder` only (`src/services/historicalRecoverySelector.ts:118-120`, `src/services/historicalRecoveryWorker.ts:109-120`), not prior/current `recovery_candidate` sends from other campaigns.
- The historical database uniqueness rule is only `(campaignId, igUserId)` (`prisma/schema.prisma:950-955`), so it does not span campaigns.

**Failure scenario:** a Feature 2 reminder and a Feature 4 reminder are authorized at the same time, or two historical campaigns contain the same person. Each path sees no contact in the other table and both post publicly inside the cooldown.

**Required fix:** create one authoritative public-recovery dispatch/contact ledger (or consolidate candidates) keyed by person, with transactionally reserved attempts. Both workers must consult it under the same person/control lock. Apply the prospective 24-hour and historical 30-day rules explicitly, with the stricter applicable result winning. Include in-flight and uncertain attempts.

**Regression tests:** prospective-vs-historical and historical-vs-historical concurrent races; different keyword IDs still share person cooldown; exactly-at-boundary behavior.

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

### QA-06 — Feature 2 final send check can miss sibling completion

**Severity:** P1  
**Evidence:** `suppressRecoveriesForCompletionSafely` intentionally swallows database errors (`src/services/dmRecoveryService.ts:696-726`). Its comment claims the final worker policy remains safe, but `loadPolicyContext` reads completion only from the recovery row's source conversation (`src/services/dmRecoveryRepository.ts:41-49`, `117-125`). It does not read the canonical intent or any completed same-person/keyword conversation.

**Failure scenario:** a sibling/alias journey completes, the best-effort bulk suppression fails, and the source conversation remains incomplete. The final authorization sees no completion and can post a public reminder for a guide already delivered.

**Required fix:** make the final transaction query the canonical intent's `completedAt` (preferred) or any current same-person/keyword completion. Best-effort denormalized stamping may remain for UI speed, but it cannot be the safety authority.

**Regression test:** force completion suppression to fail, complete a sibling journey, then prove `authorizeClaimForSend` suppresses the original recovery.

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
**Remediation status (2026-08-08): Fixed.**

**Implementation:** `src/services/recoveryCopyCore.ts` now owns the shared `trim().toUpperCase()` normalization rule. `src/services/dmRecoveryPolicy.ts` and `src/services/historicalRecoveryCopy.ts` both use it before rendering and snapshotting copy, preventing prospective and historical recovery from drifting into different casing behavior.

**Regression evidence:**

- `src/services/dmRecoveryPolicy.test.ts` covers mixed/lowercase input, surrounding whitespace, and the exact uppercase snapshot.
- `src/services/historicalRecoveryCopy.test.ts` continues to cover the phase-safe historical templates through the shared renderer.
- Fresh root verification on 2026-08-08: **76 files passed, 10 skipped; 1,229 tests passed, 144 skipped**.

The skipped tests are external database contracts, not keyword-copy tests.

### QA-19 — Dashboard/API acceptance gaps

**Severity:** P2  
**Remediation status (2026-08-08): Fixed.**

**Implementation:**

- `src/api/historicalRecovery.routes.ts` now applies and returns one stable `asOf` boundary, attributes approval from authenticated `req.adminEmail`, and exposes campaign phase/audit timestamps.
- `src/services/historicalRecoveryCandidateDetail.ts` returns a curated evidence contract: candidate/campaign facts, canonical intent owner, aliases, triggers, safe audit fields, and only a stored source permalink selected through the Reel → Feed → Keyword fallback.
- `src/api/historicalRecovery.routes.ts` now provides candidate detail and an authenticated, idempotent `mark-reviewed` action with audit recording.
- `web/src/pages/HistoricalRecovery.tsx`, `HistoricalStageForm.tsx`, and `HistoricalCandidateDrawer.tsx` add campaign selection, phase-safe wording, stable infinite pagination with ID deduplication, server-owned approval attribution, staging controls, real source navigation, evidence inspection, and review retirement. The fabricated reply-ID permalink is gone.
- `src/api/conversations.routes.ts` defaults list and counts to canonical history and offers explicit `mode=raw`; every row identifies its history role, canonical owner, alias count, and reconciliation reason.
- `web/src/pages/Conversations.tsx` exposes Canonical / Raw history modes and visible Canonical, Alias, and Unreconciled ownership labels. Mode is part of both React Query identities, so raw history cannot inherit a canonical cursor.

**Regression evidence:**

- `src/api/historicalRecovery.routes.test.ts`
- `src/services/historicalRecoveryCandidateDetail.test.ts`
- `src/api/conversations.routes.test.ts`
- `web/src/pages/HistoricalRecovery.test.tsx`
- `web/src/components/historical/HistoricalCandidateDrawer.test.tsx`
- `web/src/components/historical/historicalRecoveryViewModel.test.ts`
- `web/src/pages/Conversations.test.tsx`
- `web/e2e/historical-recovery.spec.ts`

The new real-component Playwright journeys pass on desktop and mobile and cover campaign selection, phase wording, authenticated approval after refetch, cap staging, stable `asOf` pagination, deduplication, exact stored permalink evidence, canonical owner/alias/trigger/audit facts, idempotent review UX, and canonical-to-raw conversation history.

### QA-20 — Release verification gaps

**Severity:** P2  
**Remediation status (2026-08-08): Partially verified — external credential blocker.**

**Fresh local verification:**

- Root tests: **76 files passed, 10 skipped; 1,229 passed, 144 skipped** (`npm test`, exit 0).
- Root Prisma/TypeScript production build: passed (`npm run build`, exit 0).
- Web tests: **29 files / 392 tests passed** (`npm --prefix web test`, exit 0).
- Web lint: passed with **zero errors and zero warnings** (`npm --prefix web run lint`, exit 0). The former nine errors were removed without rule suppression; `AppShell.test.tsx` and `SequenceEditor.test.tsx` protect the state-ownership behavior changed during cleanup.
- Web TypeScript/Vite production build: passed (`npm --prefix web run build`, exit 0).
- Playwright: **74 desktop/mobile journeys passed** (`npm --prefix web run test:e2e`, exit 0), including the new `web/e2e/historical-recovery.spec.ts`.

**Disposable PostgreSQL blocker:** `MIGRATION_TEST_DATABASE_URL` is unset. Blocked: `MIGRATION_TEST_DATABASE_URL` is required and must point to a disposable PostgreSQL database on which migrations may be applied and test rows destroyed.

When available, run:

```bash
npm test -- src/services/recoveryCampaignDatabaseContract.test.ts src/services/historicalRecoveryClaimContract.test.ts src/services/historicalRecoveryLifecycleContract.test.ts src/services/historicalRecoveryHealthContract.test.ts src/services/historicalRecoverySelectorContract.test.ts
```

Never point this variable at staging or production.

**Controlled Meta blocker:** `IG_ACCESS_TOKEN` and `IG_USER_ID` are configured, but controlled test media and comment identifiers are absent. No Meta API send was attempted. Complete this controlled-account runbook before enabling the feature:

1. Configure a sandbox/test Instagram professional account and a test post.
2. Comment a mixed-case configured keyword from a controlled user.
3. Force the verified settings-rejection path and capture the categorized provider response.
4. Verify the snapshotted public recovery copy contains the uppercase keyword.
5. Approve a one-person historical confirmed-failure campaign.
6. Confirm exactly one public comment is created and its stored permalink opens the original post.
7. Mark the candidate reviewed, replay the request, and confirm one review audit event.
8. Remove the controlled test comment and revoke/rotate temporary credentials.

QA-20 remains partial until both external runs are completed and their redacted evidence is attached. This status does not weaken the report's P0/P1 launch blockers.

## Acceptance coverage by feature

### Feature 1 — Explicit settings failure

| Acceptance area | Status | Notes |
|---|---|---|
| Empty-default exact numeric allowlist; no message-text match | Pass | Config and classifier are narrow; forbidden `100:2534025` is rejected |
| Negative error-family classification | Pass in unit tests | Rate limit precedes allowlist; auth/invalid/ambiguous families are separated |
| Exact copy snapshot | Pass | Shared prospective/historical renderer trims and uppercases before snapshotting (QA-18 fixed) |
| Idempotent source record and prospective worker uncertainty safety | Pass in local tests | Real-DB contract skipped locally |
| Evidence/version visible to owner and signature metrics | Fail | QA-17 |
| Controlled Meta test and first-match audit | Unverified | Feature must remain inert until completed |

### Feature 2 — Prospective no-confirmed-read recovery

| Acceptance area | Status | Notes |
|---|---|---|
| Exact gate message correlation and positive-signal suppression | Pass in local tests | Read/reaction/postback/inbound paths exist |
| Durable leases, final authorization, retries, uncertain outcomes | Pass in local tests | This path has stronger state/cap machinery than Feature 4 |
| Deterministic treatment/control and dashboard states | Pass in local tests | Separate settings rows are excluded from experiment metrics |
| Same-keyword/canonical completion authority | Fail | QA-06 |
| Shared person cooldown/cap with Feature 4 | Fail | QA-04 |
| Production Meta/webhook observation period | Unverified | Required before Feature 4 |

### Feature 3 — Journey canonicalization

| Acceptance area | Status | Notes |
|---|---|---|
| Live same-person/keyword 48-hour reuse and replay handling | Pass in unit tests | Serializable real-DB suite skipped locally |
| Exactly one canonical owner for gate/completion/recovery | Fail | QA-05/06 |
| Alias completion reconciles canonical state | Fail | `markIntentCompleted` is canonical-conversation-only |
| Historical reconciliation dry-run/idempotency/restartability | Partial/Fail | Dry-run exists; evidence/atomic/restart behavior incomplete (QA-15) |
| Every trigger preserved | Fail | QA-16 |
| Canonical actionable UI and separate metrics | Partial | Canonical-only list/count defaults and raw-history ownership UI now pass; broader alias action ownership remains blocked by QA-05 |

### Feature 4 — Historical recovery

| Acceptance area | Status | Notes |
|---|---|---|
| Canonical unique-person snapshot | Partial | Per-campaign uniqueness exists, but source/evidence/cutoff correctness fails |
| Confirmed vs unknown-read phases separate | Fail | QA-03 |
| Approved uncertainty-aware copy | Fail | QA-01 |
| Stable randomized pilot/holdout | Fail | QA-07 |
| Exclusive claims and no duplicate public sends | Fail | QA-02/04 |
| Final source/evidence/cooldown recheck | Partial | Recheck exists, but QA-04/09/11 remain |
| Batch/hour/day caps and outage recovery | Partial | Daily check now exists; QA-08/10 remain |
| Kill switch/pause/cancel/shared auth circuit | Partial pass | Basic controls exist; historical stop conditions do not |
| Campaign lifecycle, attribution, audit dashboard | Partial | Owner controls/evidence/audit dashboard pass (QA-19 fixed); terminal lifecycle and outcome attribution remain blocked by QA-12 |
| Phase 1 observation before Phase 2 pilot | Not enforceable | CLI defaults directly to unknown-read and dependencies are not gated |

## Required implementation order

1. **Keep `DM_RECOVERY_HISTORICAL_ENABLED=false`.** Do not create/approve a production historical campaign from the current selector.
2. Fix P0 dispatch integrity: QA-01 through QA-05.
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
```

### P2 remediation revalidation — 2026-08-08

```text
DOTENV_CONFIG_PATH=<project .env> npm test
# exit 0; 76 files passed, 10 skipped; 1,229 tests passed, 144 skipped

DOTENV_CONFIG_PATH=<project .env> npm run build
# exit 0; Prisma Client generated and TypeScript compiled

npm --prefix web test
# exit 0; 29 files / 392 tests passed

npm --prefix web run lint
# exit 0; zero errors and warnings

npm --prefix web run build
# exit 0; TypeScript and Vite production build passed

E2E_PORT=5189 npm --prefix web run test:e2e
# exit 0; 74 desktop/mobile Playwright journeys passed

MIGRATION_TEST_DATABASE_URL presence check
# unset — database-contract command blocked as documented in QA-20

Controlled Meta prerequisite presence check
# IG_ACCESS_TOKEN=set, IG_USER_ID=set, controlled media/comment identifiers=unset
# no Meta API send attempted
```
