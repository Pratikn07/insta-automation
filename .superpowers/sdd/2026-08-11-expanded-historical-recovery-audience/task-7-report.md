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
