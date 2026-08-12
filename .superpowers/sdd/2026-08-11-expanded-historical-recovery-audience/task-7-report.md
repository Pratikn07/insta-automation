# Task 7 Report — Stop Expanded Recovery as a Group

## Outcome

Implemented rollout-group campaign pausing for owner/admin actions and direct health signals while preserving legacy single-campaign behavior and campaign-specific rate evaluation. The implementation is scoped to Task 7; the plan, ledger, and main worktree were not modified.

## RED / GREEN

RED was established before implementation with:

```sh
npx vitest run src/services/recoveryCampaignControl.test.ts src/services/campaignHealthObservationContract.test.ts src/api/historicalRecovery.routes.test.ts
```

Result: 2 failed files, 1 skipped; 10 failed, 56 passed, 13 skipped. Failures demonstrated the missing `pauseCampaignGroup` service and missing group-pause route.

After implementation, the same command was GREEN: 2 passed files, 1 skipped; 66 passed, 13 skipped.

## Service and Transaction Behavior

- `pauseCampaignGroup` validates and trims a 1–200 character reason before opening a transaction.
- The transaction locks the singleton recovery-control row first, then locks every campaign in the rollout group using `ORDER BY id FOR UPDATE`.
- Only `running` members transition to `paused`; all other members are returned in `skipped` with their current state, and campaigns outside the group are untouched.
- The update count is checked against the locked running-member set. A mismatch aborts the transaction rather than returning a partial result.
- Repeated pauses are state-idempotent: already paused or otherwise non-running campaigns remain unchanged and appear in `skipped`.
- One `historical_campaign_group_paused` audit event is emitted per successful group-pause request with `rolloutGroupId`, normalized `reason`, `pausedCampaignIds`, and `skipped`.

Direct health observations now acquire the same singleton-control lock before campaign locks. For grouped campaigns, all group members are locked in stable ID order and every running sibling is paused with `auto:<kind>` for `complaint`, `opt_out`, `block`, `negative_reply`, and `classifier_anomaly`. Duplicate observation delivery remains idempotent. A campaign with a null legacy group keeps the existing single-campaign pause and audit behavior.

The shared singleton-first order aligns group pause and dispatch authorization: whichever transaction acquires the control lock first establishes the outcome, avoiding a control/campaign lock inversion. Rate-based health evaluation was intentionally left campaign-specific.

## Endpoint and Authorization

Added:

```text
POST /historical-recovery/rollout-groups/:id/pause
```

The route validates `id` as a UUID and a trimmed `reason` of 1–200 characters, returns `400 { error: "invalid_group_pause" }` for invalid input, and returns the exact service result on success. It inherits the existing owner/admin middleware from the historical-recovery router mount; the route contract verifies unauthenticated access is rejected.

## Additional Contract Tests

Two contract files beyond the brief's initially named test files were modified because they are the existing integration boundaries for explicit Task 7 requirements:

- `historicalRecoveryDispatchInterleavingContract.test.ts` verifies singleton-first ordering and that a concurrent group pause wins safely against dispatch without deadlock or post-pause authorization.
- `historicalRecoveryHealthContract.test.ts` places sibling campaigns in the same rollout group and verifies rate-based evaluation pauses only the failing campaign.

These changes are necessary and in scope: they directly cover the requested concurrent group-pause/dispatch behavior and preservation of campaign-specific rate evaluation. They do not broaden production behavior beyond Task 7.

## Verification

- Focused RED/GREEN suite: 66 passed, 13 skipped.
- Impacted backend suite: 238 passed, 89 skipped; 6 files passed, 4 skipped.
- Full backend suite: 1,516 passed, 303 skipped; 92 files passed, 23 skipped.
- `npm run build`: passed, including Prisma Client generation and TypeScript compilation.
- `npx prisma generate`: passed.
- `npx prisma validate`: passed; schema valid.
- `git diff --check`: passed.
- Independent review: no actionable correctness findings; build and 38 focused control tests passed in the review environment.

## Concerns / Follow-up

`MIGRATION_TEST_DATABASE_URL` is not configured in this worktree, so PostgreSQL-backed contract cases were skipped by their existing environment guard. The non-database portions, full available backend suite, build, Prisma generation/validation, and diff checks pass. The skipped database contracts should also be run against the project's disposable PostgreSQL test database before production release.

## Fix Round 1/5 — Transactional Group Pause

### Review Findings Addressed

- Health observations now acquire the singleton recovery-control lock, then lock and read the target campaign row with `FOR UPDATE`, and only then lock all rollout-group members using `ORDER BY id FOR UPDATE`.
- The Express 4 group-pause handler catches rejected service promises. Known empty-group errors return `404 { error: "not_found" }`; unexpected errors are passed to `next(error)` and the API error middleware returns `500 { error: "internal_error" }`.
- A valid UUID with no matching campaigns now throws the distinct `campaign_group_not_found` service error before update or audit. An existing all-non-running group remains a successful idempotent result with every member in `skipped`.
- Group-pause audits are written through `tx.eventLog.create` in the same Prisma transaction as campaign updates. The swallowing `logEvent` helper is no longer used for grouped owner or health pauses.

### RED / GREEN

RED command:

```sh
npx vitest run src/services/recoveryCampaignControl.test.ts src/services/campaignHealthObservation.test.ts src/api/historicalRecovery.routes.test.ts
```

Before the fix: 10 failed and 76 passed. The two route rejection cases timed out and Vitest reported two unhandled promise rejections; service tests demonstrated pre-lock identity reads, missing transactional audit writes, and successful empty-group responses.

After the fix, the same command is GREEN: 86 passed in 3 files with no unhandled errors.

### Transaction, Lock, and Audit Semantics

The serialized order is `dm_recovery_control → target campaign → rollout-group campaigns ordered by id`. PostgreSQL row locks remain held until transaction completion; the target lock is therefore re-encountered by the ordered group query. This cannot create a target-first/group-order cycle among health, group-pause, or dispatch authorization paths because all three must first own the same singleton control lock. Other campaign-only transitions do not subsequently request the singleton or another group member, so they cannot complete a reverse cycle.

The ordered group update count must equal the locked running-member count. A count mismatch throws before audit insertion. Audit insertion occurs after the conditional campaign update but before transaction commit; an audit rejection propagates and Prisma rolls back the campaign changes. For grouped health observations, the observation insert, sibling pauses, and group audit share one transaction. Only the caller that wins the idempotent observation insert writes the audit; duplicate delivery writes neither another pause nor another event.

Owner retries are separate invocations: every successful invocation writes exactly one durable event, including an idempotent retry whose result contains only skipped states. This is per-invocation cardinality, not global deduplication.

### Added Coverage

- Unit mutation coverage fails if target identity is read before its row lock, if the group lock loses stable ordering, if the audit moves back to `logEvent`, or if empty groups regain success behavior.
- Service tests cover audit failure propagation, pause-count mismatch before audit, all-non-running idempotency, and one persisted audit call for each successful owner retry.
- Route tests cover `404 not_found` and unexpected service rejection through error middleware as `500 internal_error`, with no unhandled promise.
- PostgreSQL contracts cover durable audit payload/cardinality, duplicate grouped-health delivery, unknown-group no-audit behavior, pause-first and dispatch-first serialization, and two target-first sibling health observations completing without deadlock.

### Verification

- Focused: 86 passed.
- Impacted: 248 passed, 110 skipped; 7 files passed, 4 skipped.
- Full backend: 1,525 passed, 307 skipped; 92 files passed, 23 skipped.
- Build: passed with Prisma Client generation and TypeScript compilation.
- Independent review: no actionable regressions; 56 focused service tests and build passed in its restricted environment.
- No Prisma schema or migration changes were made.

### Remaining Concern

`MIGRATION_TEST_DATABASE_URL` remains unset, so the new PostgreSQL cardinality and interleaving cases are compiled but skipped locally. The reviewer sandbox also forbids local HTTP listeners, while the same route tests pass in the normal worktree. Run the PostgreSQL contract cases against the disposable local database before release.
