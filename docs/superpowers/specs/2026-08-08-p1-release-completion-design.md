# Instagram Automation P1 Release Completion Design

**Date:** 2026-08-08
**Status:** Approved for written review
**Source:** `docs/qa/2026-08-07-instagram-automation-features-1-4-deep-qa.md`
**Scope:** Remaining launch work in QA-07 through QA-17 after the merged P0 safety changes

## Goal

Finish the P1 release without enabling historical recovery, merging to `main`, deploying production, or sending a real Instagram comment. The result must close the remaining dispatch, campaign-lifecycle, evidence, reconciliation, history, and audit gaps with deterministic PostgreSQL contracts and reviewable delivery boundaries.

QA-06 is already complete and is preserved as a regression constraint. QA-09's implementation is complete; its controlled-Meta validation remains a release gate. The remaining work is delivered as four stacked, independently reviewable pull requests.

## Global Safety Constraints

- `DM_RECOVERY_HISTORICAL_ENABLED` remains `false` throughout implementation and review.
- No production migration, reconciliation `--write`, campaign approval, Meta send, merge, or deployment is part of this work.
- Every final authorization fails closed on database, state, evidence, circuit, or ownership uncertainty.
- Database behavior involving transactions, locks, uniqueness, or concurrency requires real-PostgreSQL tests.
- New migrations are additive and compatible with the currently deployed pre-P0 application until a separately authorized deployment.
- Safe API responses may expose reason codes and version identifiers, but never access tokens, raw provider bodies, database URLs, or secrets.

## Delivery Architecture

### PR 1: Dispatch and Campaign Safety

This PR closes the cross-cutting launch blockers in QA-08, QA-10, QA-12, and QA-13. It establishes a final, transactional stop boundary before every historical Graph call and makes campaign state transitions crash-safe.

#### Final dispatch authorization

`startHistoricalDispatch` becomes the final authorization boundary. In the existing global lock order it must:

1. lock the shared recovery-control row;
2. lock the person row;
3. lock the candidate row;
4. lock and read the candidate's campaign;
5. require a closed shared circuit, a running campaign, a treatment candidate with `outcome = pending`, the exact unexpired claim token, and an exact live dispatch reservation;
6. atomically transition the ledger and stamp the candidate as dispatch-started.

If any check fails, the operation returns a typed non-send reason. The worker releases a still-reserved ledger entry and does not call Meta. A pause that commits before this transaction obtains the campaign lock therefore prevents the Graph call. If dispatch start commits first, the work is explicitly in flight and must be reconciled as sent, failed, or uncertain rather than rewritten as ordinary cancellation.

#### Pause and cancellation semantics

Pausing changes campaign state but does not rewrite candidate outcomes. Claimed work that has not started dispatch is released by the worker or lease reconciler. Dispatch-started work is allowed to finalize into its truthful terminal state.

Cancellation terminalizes only candidates that are provably pre-dispatch. Candidates with a `dispatch_started` ledger entry or candidate `dispatchStartedAt` remain in-flight and retain the campaign cancellation reason separately. Their finalizer may record `sent`, `send_failed`, or `send_uncertain` even though the campaign is cancelled. Expired in-flight work is reconciled to uncertainty. Cancellation and ledger/source updates use the established control-person-source lock order.

The API response reports both pre-dispatch candidates cancelled and in-flight candidates awaiting reconciliation. It never reports an in-flight Meta operation as safely cancelled.

#### Atomic campaign lifecycle

Approval locks the campaign and performs all of the following in one transaction:

- validate the campaign is approvable;
- validate the reviewed snapshot is complete;
- stamp authenticated approval identity and timestamps;
- terminalize every holdout as `holdout_withheld`;
- set the campaign to `running` only when treatment work remains, otherwise `completed`;
- return the actual persisted state.

Completion may transition only a `running` campaign. An auto-paused campaign remains paused even if it is drained, preserving the health latch and owner-review requirement.

A periodic drain reconciler scans every running campaign with no pending treatment or in-flight dispatch and completes it. It does not depend on the final candidate having changed during the current process tick, so a restart after the final outcome cannot strand a campaign in `running`.

#### Batch and capacity authority

Batch allowance is per campaign, not the minimum across all running campaigns. A database-backed campaign stage reservation prevents overlapping scheduler ticks or multiple service instances from each consuming the same batch allowance. The scheduler also gains a local non-overlap guard for efficiency, while the database remains authoritative.

The shared public-dispatch ledger adds a global daily cap alongside its global hourly cap. Campaign hourly/daily and global hourly/daily capacity count `reserved`, `dispatch_started`, `sent`, and `uncertain`; a proven pre-network release frees capacity. Exact boundaries remain eligible.

#### Campaign health stops

Historical campaign health adds durable, trustworthy observations for:

- complaint or report;
- explicit opt-out;
- user block signal;
- negative reply classification;
- classifier anomaly;
- duplicate provider reply or duplicate dispatch evidence.

Signals are stored as append-only campaign health observations with source identity, safe category, observed timestamp, and optional provider/event identifier. Idempotency prevents webhook replay from increasing counts.

Health evaluation reads dispatch ledger/provider evidence for duplicates rather than the structurally unique candidate table. After each terminal candidate outcome, the worker reevaluates health before authorizing the next row. Crossing a threshold atomically pauses the campaign and latches the stop reason. Resume requires authenticated owner acknowledgement and does not erase observations.

## PR 2: Deterministic Selection and Attribution

This PR closes QA-07, QA-11, QA-12, and QA-14 snapshot and measurement gaps.

### Atomic reviewed snapshot

Selection first computes and validates the complete in-memory decision, including arm realization, before writing anything. A single transaction then persists:

- campaign configuration;
- normalized filter/configuration fingerprint;
- decision hash;
- included candidates;
- exclusions and exclusion reasons;
- candidate and exclusion counts;
- source-choice evidence.

The normalized fingerprint includes selection version, source-data cutoff, phase, comment date bounds, audience filter, holdout percentage, and every eligibility-policy version that affects membership. A database uniqueness constraint prevents duplicate snapshots for the same normalized selection identity.

The decision hash covers configuration, ordered inclusions, ordered exclusions, assigned arms, chosen source IDs, and reason codes. Approval locks the campaign and refuses a null hash, duplicate identity, count mismatch, missing row, altered source evidence, or recomputed hash mismatch.

### Evidence scope and source selection

Engagement evidence that comes from recovery reminders must match the same person and keyword or authoritative intent. Unrelated-guide reads, reactions, replies, or postbacks do not suppress a candidate.

Selection snapshots the deterministic ordered list of eligible comment sources and the reason for choosing the first source. Source availability is checked before approval. A fenced pre-dispatch check may fall back to the next snapshotted eligible source when the newest source is definitively missing or hidden; it may not use a source outside the approved ordered set. Auth, rate, timeout, and unknown source reads defer or open the circuit and never trigger fallback.

### Earliest, windowed attribution

Campaigns persist explicit inbound and completion measurement-window durations. Treatment windows start at confirmed or uncertain dispatch start; holdout windows start at approval. Reporting exposes the fixed 24-hour and 48-hour observations required by the experiment rather than treating any future event as recovery.

Attribution uses a single atomic update equivalent to `stored = LEAST(stored, incoming)` for qualifying timestamps. It therefore preserves the chronologically earliest event under reverse arrival, concurrent delivery, and webhook replay. Events outside the campaign's measurement window do not mutate candidate attribution. A person appearing in successive campaigns is credited only to each campaign whose own window contains the event.

## PR 3: Durable Journey History and Reconciliation

This PR closes QA-15 and QA-16.

### Source events and intent associations

The globally unique Instagram comment is modeled once as a source event. A separate association table links that source event to every matched journey intent/keyword. Its uniqueness is `(source_event_id, intent_id)`, so one comment matching `SLEEP` and `POTTY` retains both legitimate relationships without duplicating the source event.

Each association records:

- intent and keyword identity;
- trigger kind and disposition;
- received timestamp;
- public acknowledgement state;
- provider acknowledgement reply ID when confirmed;
- safe acknowledgement error category when failed or uncertain;
- creation and update timestamps.

Existing `journey_trigger` data is migrated without loss. A single-keyword trigger creates one event and one association. Multi-keyword historical rows create one event and every reconstructable association. The migration fails closed if existing rows contradict source-event identity instead of silently selecting a winner.

Live comment handling and historical recovery selection read the association model. Webhook replay is idempotent at both source-event and association levels. Partial acknowledgement failure on one keyword does not erase the other association.

### Reconciliation evidence and serialization

Accepted recovery evidence is the union of safe event-log evidence and authoritative `dm_recovery_reminder.acceptedAt`/Instagram message receipt evidence. A missing best-effort event log cannot override a persisted accepted receipt.

Live journey creation and reconciliation share a transaction-scoped person-keyword advisory lock derived from a stable identifier. This prevents either path from creating an overlapping differently timestamped intent while the other is settling the same window.

Reconciliation persists a run record and a per-window result record. A run contains its stable ID, source cutoff, selection/query version, dry-run/write mode, start/end status, and resume cursor. Every window records its input identity, proposed canonical owner, evidence choice, result, and exact conflict reason. Restart resumes after the last committed window; a window transaction commits its mutation, result, and checkpoint together.

Dry-run and write mode use the same frozen input identity and decision function. Write mode refuses to proceed if the saved input fingerprint differs from the dry-run manifest approved by the operator.

## PR 4: Versioned Settings-Failure Evidence

This PR closes QA-17 and the remaining controlled-verification gate for settings-blocked recovery.

### Verification registry

Add a versioned verification record for each trusted settings-blocked Graph signature. It stores:

- immutable verification version;
- numeric Graph error code and subcode;
- safe semantic category;
- verification timestamp;
- verifier identity;
- controlled account/API version context;
- sanitized evidence-package reference and hash;
- active/retired state and retirement reason.

Raw provider bodies, tokens, usernames, comment text, and personal identifiers are not stored in the application table or exposed by the API.

### Reminder evidence

A settings-blocked recovery reminder stores the exact numeric code/subcode, verification-record ID/version, classification timestamp, and sanitized evidence reference used at creation. These fields are immutable after creation. Exact webhook or queue replay preserves the original evidence and cannot silently upgrade the reminder to a newer verification version.

Both first-send and retry/gate-worker paths must supply a currently active verified signature. Missing, unknown, stale, retired, or malformed versions fail closed and do not schedule a settings-blocked public recovery. `no_confirmed_read` reminders remain governed by their separate evidence path.

### API and dashboard

Admin APIs expose safe evidence fields and aggregates by verification version, code/subcode, age, status, and outcome. The dashboard shows whether evidence is current, stale, retired, or missing and blocks approval/activation of invalid settings-failure cohorts. No endpoint exposes raw Meta payloads.

A controlled-Meta runbook records how to verify each signature on a sandbox/test Instagram account, sanitize the evidence, activate the version, test both first-send and retry paths, and clean up. Running that procedure requires separately supplied controlled credentials and explicit authorization; implementation does not contact real accounts.

## Error Handling and Observability

All safety decisions use typed codes. Expected codes include:

- `campaign_not_running`;
- `circuit_open`;
- `stale_claim`;
- `dispatch_already_started`;
- `campaign_batch_exhausted`;
- `global_daily_cap_reached`;
- `campaign_health_paused`;
- `snapshot_incomplete`;
- `snapshot_hash_mismatch`;
- `source_set_exhausted`;
- `attribution_outside_window`;
- `reconciliation_manifest_mismatch`;
- `verification_missing`, `verification_stale`, and `verification_retired`.

Database errors fail closed and leave enough durable state for retry or owner review. Logs use internal IDs, versions, counts, and safe categories. They do not include tokens, raw Graph responses, direct-message text, comment text, or database connection strings.

## Migration Strategy

Each PR owns only the additive schema needed for that boundary. Migrations create new nullable columns/tables and indexes before application code requires them. Backfills are deterministic and idempotent under Prisma migration execution.

Before constraints become authoritative, each migration runs contradiction queries and raises an exception if source data cannot be migrated without discarding a relationship or inventing evidence. Indexes support every new lock, capacity, attribution, manifest, and reconciliation lookup. Foreign keys use restrictive deletion for immutable audit evidence and cascade only where deletion of the owning aggregate is already an explicit system behavior.

Migration verification includes:

1. the full chain on a fresh disposable PostgreSQL database;
2. upgrade from the merged `origin/main` schema populated with production-shaped fixtures;
3. backward-compatibility checks with queries made by the currently deployed application;
4. rollback by application version while leaving additive schema in place; and
5. deterministic reruns of every backfill contract in isolated databases.

## Test Strategy

Every behavioral change follows red-green-refactor. Each new test is first observed failing for the intended missing behavior.

### PR 1 contracts

- Pause before dispatch start prevents Meta authorization.
- Pause after dispatch start preserves truthful finalization.
- Cancel before start releases ledger capacity and terminalizes the candidate.
- Cancel after start never records the attempt as safely cancelled.
- Meta success racing cancellation records the provider reply and terminal ledger state.
- Approval rollback leaves campaign and holdouts unchanged.
- All-holdout approval returns `completed`, not `running`.
- A drained auto-paused campaign remains paused.
- Restart after the final candidate outcome completes a running campaign.
- Two overlapping ticks and two service instances consume one per-campaign batch allowance.
- Different campaign batch sizes do not throttle each other.
- Global daily capacity spans prospective and historical sends.
- Complaint, opt-out, block, negative reply, classifier anomaly, and duplicate provider evidence each latch an auto-pause.
- A threshold crossed mid-batch prevents authorization of the next row.

### PR 2 contracts

- Invalid arm realization writes no campaign, exclusion, or candidate.
- Injected failure at every snapshot write stage rolls back the complete snapshot.
- Duplicate normalized selection identity is rejected.
- Approval rejects missing rows, count drift, hash drift, and config drift.
- Unrelated-keyword reminder engagement does not suppress a candidate.
- Definitively deleted newest source falls back to the next approved source.
- Unknown/auth/transient source reads never fall back or send.
- Later-first then earlier webhook delivery stores the earlier timestamp.
- Concurrent attribution stores the earlier timestamp.
- Exact 24-hour and 48-hour boundaries are attributed; later events are not.
- Successive campaigns receive only events inside their respective windows.

### PR 3 contracts

- One comment matching two keywords creates one source event and two associations.
- Replay creates neither a duplicate event nor duplicate association.
- Partial acknowledgement failure preserves both associations and each outcome.
- Migration reconstructs every valid association and refuses contradictory identities.
- Receipt-present/event-missing evidence wins accepted-gate precedence.
- Live create racing reconciliation yields one serialized window decision.
- Crash after a committed window resumes at the next window.
- Dry-run/write manifest mismatch refuses mutation.
- Parallel contract files use isolated databases or schemas and pass repeatedly.

### PR 4 contracts

- Missing, unknown, retired, and stale verification versions cannot schedule settings-blocked recovery.
- An active exact code/subcode/version can schedule through first-send and retry paths.
- Replay preserves the original immutable evidence reference.
- A different code/subcode cannot borrow another signature's verification version.
- API detail and aggregate responses expose safe evidence but redact raw provider data.
- Dashboard state and activation controls reflect current/stale/retired/missing evidence.

### Complete release verification

- Apply every migration to a fresh disposable PostgreSQL database.
- Run focused contracts without file parallelism while developing, then run the same matrix with normal parallelism repeatedly.
- Run the complete backend suite with `MIGRATION_TEST_DATABASE_URL` configured so database contracts do not skip.
- Run backend build, web tests, web lint, web build, and the complete Playwright suite.
- Require a clean git worktree and record exact command output in the QA report.
- Keep controlled-Meta verification recorded as pending until authorized credentials and a sandbox account are available.

## Pull Request Sequence

The branches are stacked only while implementation is in progress:

1. `fix/p1-dispatch-safety` from `origin/main`;
2. `fix/p1-selection-attribution` from PR 1;
3. `fix/p1-journey-history` from PR 2;
4. `fix/p1-verification-evidence` from PR 3.

Each PR contains its focused migration, tests, implementation, and QA evidence. No PR is merged automatically. Before review, each PR is also presented as an independent diff against its parent so reviewers do not need to inspect unrelated later work.

## Completion Criteria

- Every per-PR contract above passes against PostgreSQL.
- The focused P1 matrix is deterministic under normal file parallelism.
- The complete backend, web, lint, build, and Playwright gates pass.
- The deep-QA document records evidence and final status for QA-07 through QA-17.
- Historical recovery and unverified settings-failure recovery remain disabled.
- Four reviewable PRs exist with no merge or deployment performed.
