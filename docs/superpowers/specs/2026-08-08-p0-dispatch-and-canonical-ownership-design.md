# P0 Dispatch Integrity and Canonical Ownership Design

**Status:** Approved for implementation on 2026-08-08  
**Scope:** Close QA-02, QA-04, and QA-05 from `docs/qa/2026-08-07-instagram-automation-features-1-4-deep-qa.md`  
**Production boundary:** This work does not deploy code, apply production migrations, run reconciliation with `--write`, or enable `DM_RECOVERY_HISTORICAL_ENABLED`.

## Objective

Prevent a public recovery from being authorized twice, make person cooldown and capacity one database decision across prospective and historical recovery, and ensure only a canonical conversation can own operational gate, DONE, recovery, draft, and dashboard work.

The work is complete only when the original P0 concurrency and canonical-flow acceptance cases pass against PostgreSQL. Passing the existing sequential tests is not sufficient.

## Decisions

### Authoritative dispatch ledger

Create an append-only `public_recovery_dispatch` table. It becomes the authority for public-recovery reservations, attempts, cooldown, and global capacity. `dm_recovery_reminder` and `recovery_candidate` remain the feature-specific source records; neither is independently authoritative for cross-system contact safety.

Each dispatch records:

- `id` and an unguessable `reservation_token`;
- `ig_user_id`;
- `source_kind`: `prospective` or `historical`;
- the polymorphic `source_id` and durable `attempt_number`;
- `campaign_id` for historical attempts;
- `state`: `reserved`, `dispatch_started`, `sent`, `uncertain`, or `released`;
- `reserved_at`, `lease_expires_at`, `dispatch_started_at`, `sent_at`, and `released_at`;
- the confirmed provider reply ID when sent;
- a terminal reason for uncertainty or release;
- normal creation and update timestamps.

Database constraints enforce complete state shapes. In particular:

- `reserved` has a live token and lease but no dispatch or terminal timestamp;
- `dispatch_started` has a dispatch timestamp and live token;
- `sent` has a dispatch timestamp, send timestamp, and provider reply ID;
- `uncertain` has a dispatch timestamp and reason;
- `released` has a release timestamp and reason and consumes neither cooldown nor capacity.

A partial unique index permits at most one active row (`reserved` or `dispatch_started`) per `ig_user_id`. A second unique index permits only one ledger row for a source attempt: `(source_kind, source_id, attempt_number)`.

### Lock order and reservation protocol

Every final authorization uses the same transaction and lock order:

1. Read the source row to identify the person, then lock `dm_recovery_control` row `1`.
2. Lock that person's `ig_users` row.
3. Lock and validate the source row.
4. Validate feature state, claim ownership, lease, campaign state, evidence, canonical ownership, cooldown, and capacity.
5. Insert the exclusive ledger reservation and commit.

No transaction may acquire these locks in the opposite order. A lost unique-index race is an ordinary non-send decision, never an exception that falls through to Meta.

The worker then calls `startPublicRecoveryDispatch` immediately before Meta. That operation requires the reservation ID and token, revalidates the source claim and unexpired lease, and changes `reserved` to `dispatch_started` by compare-and-set. Only a successful transition permits the network call.

Every finalizer requires the same reservation ID and token and atomically updates the ledger and source row:

- confirmed provider reply -> `sent`;
- timeout, connection reset, missing provider ID, or other ambiguous outcome -> `uncertain`;
- a proven pre-create provider rejection such as rate limiting -> `released` with durable source backoff;
- pre-network cancellation or policy suppression -> `released`.

An expired `reserved` row is safely released. An expired `dispatch_started` row becomes `uncertain` and is never retried automatically.

### Historical claim ownership (QA-02)

`claimCandidate` may claim only `claim_token IS NULL`. It may not overwrite an expired token directly. Expired rows are handled by lease reconciliation first, where `dispatch_started_at` and the ledger determine whether the source is safe to release or must become uncertain.

Historical reservation and dispatch-start calls require all of:

- candidate ID;
- candidate claim token;
- `outcome = pending`;
- `claim_expires_at > now`;
- treatment arm;
- running campaign;
- no existing `dispatch_started_at` owned by a different attempt.

Updating zero rows means `stale_claim`; the worker must not call Meta. The source claim token remains required by every release and finalizer.

### Cross-system cooldown and capacity (QA-04)

Active `reserved` and `dispatch_started` rows block every other recovery for the person regardless of source or keyword.

Terminal cooldown rules are explicit and boundary-safe:

- A new historical attempt is blocked by any prospective or historical `sent` or `uncertain` attempt strictly inside the preceding 30 days.
- A new prospective attempt is blocked by a historical `sent` or `uncertain` attempt strictly inside the preceding 30 days, or a prospective attempt strictly inside its configured prospective cooldown (24 hours by default).
- An attempt exactly on the applicable boundary is eligible.
- Source keyword does not partition person cooldown.

Global hourly capacity counts ledger rows in `reserved`, `dispatch_started`, `sent`, or `uncertain`. A safe `released` attempt frees its reservation. Historical campaign hour/day limits use the same ledger filtered by `campaign_id`. This makes the global cap symmetric: prospective sees historical consumption and historical sees prospective consumption.

The old cross-table cooldown and cap queries are removed after backfill and cutover so there is only one authority.

### Migration and backfill

The migration is additive and idempotent under Prisma's migration model:

1. Create ledger enums/table without active uniqueness.
2. Backfill confirmed and uncertain attempts from both source tables with their original timestamps and provider IDs.
3. Backfill active prospective `sending` rows and historical pending claims. Existing historical `dispatch_started_at` distinguishes `reserved` from `dispatch_started`; an existing prospective `sending` row is conservatively `dispatch_started` because `last_attempt_at` is written at its final authorization.
4. Run a PostgreSQL assertion that fails the migration if the backfill contains more than one active attempt for a person or an invalid state shape. The migration must not silently choose a winner.
5. Add state checks, source-attempt uniqueness, active-person uniqueness, and lookup indexes.

Before any production deployment, a read-only preflight must run the same collision queries against production. Migration failure leaves historical sending disabled and does not authorize any contact.

## Canonical Conversation Authority (QA-05)

### Central resolver

Add a transaction-aware canonical resolver returning:

- the requested conversation;
- `role`: `unreconciled`, `canonical`, or `alias`;
- canonical intent ID and canonical conversation ID when present;
- authoritative intent completion;
- whether the conversation may own operational work.

Role rules are exact:

- `canonical_intent_id IS NULL` -> `unreconciled`, operational for legacy/live compatibility;
- conversation ID equals the linked intent's `canonical_conversation_id` -> `canonical`, operational;
- linked to an intent owned by a different conversation -> `alias`, never operational.

All gate, DONE, completion, recovery, reconciliation, and conversation API paths use this resolver or a query predicate derived from the same rules. No caller may recreate its own approximation.

### Gate and DONE behavior

The gate worker abandons an alias gate even when the intent is still open. It also abandons any gate whose canonical intent completed. The reason distinguishes `reconciled_alias`, `intent_completed_elsewhere`, and ordinary `conversation_completed`.

DONE lookups return only canonical or unreconciled conversations. `markCompleted` resolves its input transactionally so a direct call with an alias still:

- preserves the alias's completion as history;
- completes the canonical conversation;
- records the earliest completion on the canonical intent;
- abandons pending gate work for every conversation linked to the intent;
- suppresses safe-to-cancel recovery work for every linked conversation.

Completion is idempotent and never moves an earlier completion timestamp forward.

### Recovery and reconciliation behavior

Prospective final authorization suppresses a reminder whose source conversation is an alias. Historical selection remains intent-based, and its final authorization verifies that any snapshotted conversation still resolves to the candidate's canonical intent.

When reconciliation writes a settled window, the same transaction:

- assigns canonical and alias labels;
- abandons pending alias gate queues;
- suppresses alias recovery reminders that have not started dispatch;
- supersedes non-sending follow-up drafts whose `source_conversation_id` is an alias;
- records auditable reasons on every terminalized row.

A window containing alias work already in `sending` or `dispatch_started` is not rewritten. Reconciliation reports it as `skipped_active_work`; the worker or lease reconciler must settle it first. This avoids repointing a journey underneath a network call.

### Operational and raw history APIs

Conversation lists and counts default to operational owners:

- canonical conversations referenced by an intent;
- unreconciled conversations with no intent.

Aliases are excluded from default counts. `mode=raw` returns all conversations and includes `historyRole`, canonical owner ID, and alias count. The web conversation view exposes an explicit Canonical/Raw history control and labels alias rows; it does not silently mix the two interpretations.

## Error Handling and Observability

All non-send decisions are explicit typed outcomes. Database errors fail closed: they pause/defer and never reach Meta.

Required event reasons include:

- `stale_claim`;
- `person_reservation_active`;
- `person_cooldown`;
- `hourly_cap_reached`, `daily_cap_reached`, and `global_hourly_cap_reached`;
- `reconciled_alias`;
- `skipped_active_work`;
- `dispatch_lease_expired`.

Logs contain internal IDs and reason codes, not access tokens, message text, or database URLs.

## Test Strategy

Every production change follows red-green TDD. Real-PostgreSQL contracts are mandatory for behavior that depends on locks, partial indexes, transactions, or isolation.

### Dispatch contracts

- Two and five simultaneous live claims produce one historical owner.
- A due ID read before another worker's claim cannot replace the owner after lease expiry and authorize both workers.
- A stale token cannot reserve, start dispatch, release, or finalize.
- Prospective versus historical simultaneous reservation for one person yields one winner.
- Historical versus historical reservations across campaigns yield one winner.
- Different keyword IDs still share person cooldown.
- Prospective global capacity includes historical attempts and vice versa.
- Reserved and uncertain attempts consume capacity; safe release frees it.
- 24-hour and 30-day exact-boundary cases are verified.
- Expiry before dispatch releases; expiry after dispatch becomes uncertain.

### Canonical-flow contracts

- An open alias gate is abandoned without a Meta call.
- Completion through an alias atomically completes the canonical conversation and intent.
- Pending gate and safe recovery work on every sibling is terminalized.
- Alias recovery authorization cannot reserve a public dispatch.
- Reconciliation retires safe alias work and skips active network work.
- Default DONE lookup, list, and counts exclude aliases.
- Raw mode includes aliases with canonical-owner metadata.
- Canonical and raw frontend modes render and count independently.

### Verification

- Apply the complete migration chain to a fresh disposable PostgreSQL database.
- Apply the new migration to a production-shaped fixture containing sent, uncertain, retryable, active, cancelled, and reconciled-alias rows.
- Run all backend tests with `MIGRATION_TEST_DATABASE_URL` set so no contract suite skips.
- Run the backend build, web tests, web build, and focused lint for touched files.
- Re-run the three original failing concurrency probes and require one authorization.

## Rollout

Implementation ends with committed code and verification evidence. Deployment is a separate authorized task.

Before deployment:

1. Keep `DM_RECOVERY_HISTORICAL_ENABLED=false`.
2. Run the read-only production collision/backfill preflight.
3. Review migration compatibility with the currently running release.
4. Deploy with the documented Railway procedure and verify migrations, health, and error logs.
5. Keep historical sending disabled until a reviewed dry run confirms ledger counts and canonical reconciliation output.

No production reconciliation `--write` or historical campaign enablement is part of this design.
