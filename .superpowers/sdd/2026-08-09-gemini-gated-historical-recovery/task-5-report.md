# Task 5 Report — Live Pre-Send Public-Comment Gate

## Status

Completed and verified.

## Scope and files

Modified only Task 5 implementation/tests plus this report:

- `src/services/historicalRecoveryRecheck.ts`
- `src/services/historicalRecoveryRecheck.test.ts`
- `src/services/historicalRecoveryWorker.ts`
- `src/services/historicalRecoveryWorker.test.ts`
- `src/services/historicalRecoveryRepository.ts`
- `src/services/historicalRecoveryDispatchInterleavingContract.test.ts`
- `.superpowers/sdd/2026-08-09-gemini-gated-historical-recovery/task-5-report.md`

The shared policy implementation was intentionally reused unchanged:
`CURRENT_ORIGIN_METHOD` and `evaluateHistoricalOrigin()` remain the single policy source.

## Behavior delivered

- The unlocked worker recheck reads the live `inferredOrigin`, `originConfidence`, and `originMethod` fields and routes them through `evaluateHistoricalOrigin()`.
- A stale or missing method defers with `origin_not_current_gemini`, releases the claim, and does not reserve capacity, start dispatch, or call `replyToComment`.
- Current `south_asian`, `unknown`, and `other` verdicts suppress with `audience_south_asian`, `audience_unknown`, and `audience_other`, respectively, regardless of `westernOnly`.
- The locked `startHistoricalDispatch()` authorization re-reads all three origin fields under the existing locks and evaluates the same policy immediately before `dispatch_started`.
- A post-reservation stale method atomically releases the ledger reservation and candidate claim, returns `{ kind: "deferred", reason: "origin_not_current_gemini" }`, and permits retry after enrichment.
- A current disallowed verdict atomically releases the reservation and terminally suppresses the candidate with its explicit reason. Neither path consumes the campaign batch or starts a dispatch.

## TDD evidence

### Baseline

Command:

```sh
npx vitest run src/services/historicalRecoveryRecheck.test.ts src/services/historicalRecoveryWorker.test.ts
```

Result: PASS — 92 tests.

### RED

Command:

```sh
npx vitest run src/services/historicalRecoveryRecheck.test.ts src/services/historicalRecoveryWorker.test.ts
```

Result: FAIL — 12 failures. The old recheck sent current South Asian/unknown/other and stale-method cases; the worker selected only `inferredOrigin`, reserved, and called the provider for stale method cases.

Command:

```sh
MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/insta_contract DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/insta_contract npx vitest run src/services/historicalRecoveryDispatchInterleavingContract.test.ts
```

Result: FAIL — 6 failures. The final authorization returned the legacy `audience_out_of_market` reason for South Asian, started dispatch for current unknown/other, and started dispatch when the method became stale while waiting on the final lock.

Command:

```sh
npx vitest run src/services/historicalRecoveryWorker.test.ts -t "defers a final locked stale Gemini verdict without calling Meta"
```

Result: FAIL — the provider mock was called after a synthetic final-lock `deferred` result until the worker explicitly handled that result kind.

### GREEN

Command:

```sh
npx vitest run src/services/historicalRecoveryOriginPolicy.test.ts src/services/historicalRecoveryRecheck.test.ts src/services/historicalRecoveryWorker.test.ts
```

Result: PASS — 111 tests.

Command:

```sh
MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/insta_contract DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/insta_contract npx vitest run src/services/historicalRecoveryDispatchInterleavingContract.test.ts
```

Result: PASS — 19 tests.

Command:

```sh
npm test
```

Result: PASS — 86 test files passed, 24 skipped; 1,377 tests passed, 278 skipped.

Command:

```sh
npm run build
```

Result: PASS — `prisma generate && tsc` completed successfully.

## Race and lock reasoning

`startHistoricalDispatch()` preserves the established lock order:

1. `dm_recovery_control`
2. `ig_users`
3. `recovery_candidate`

It retains the existing campaign, keyword, approved-source, circuit, inbound-health, batch, and reservation checks. Because the person row is locked before the final `igUser` read, an origin update committed before that linearization point is observed; an update after it waits until the dispatch start has been explicitly stamped.

The shared current-Gemini policy is evaluated after all batch authorization checks and directly before `startPublicRecoveryDispatch()`. For a stale method, the repository releases the reserved ledger row and clears the candidate claim in the same transaction, then returns a deferred result. For a current disallowed verdict, it performs the existing release-plus-suppress transaction with the explicit policy reason. The Postgres interleaving test holds the control lock, changes `originMethod` from `llm_v1` to `name`, then releases the lock; it proves the final authorization returns deferred with the ledger `released`, candidate `pending`/unclaimed, no `dispatchStartedAt`, and batch consumption of zero.

The worker calls `replyToComment()` only after `startHistoricalDispatch()` returns `started`. Its new `deferred` branch intentionally does not call `releaseHistoricalReservation()` because the final locked transaction already released it; this prevents a duplicate stale-token release.

## Self-review

- Reviewed the complete scoped diff and ran `git diff --check` (clean).
- Confirmed recheck tests cover current Western verdicts at both confidence values, current South Asian verdicts at both confidence values, unknown/other suppression, and stale/missing method deferral.
- Confirmed worker tests assert stale/disallowed paths make no provider, reservation, or dispatch-start call.
- Confirmed the real Postgres contract covers all three current disallowed locked outcomes and the stale-after-reservation interleaving.
- Confirmed the full test suite, dedicated contract, and TypeScript build pass.
- No reviewer subagent was available in this session; the requested self-review was performed directly.

## Commit

`feat: gate historical sends on live Gemini origin` — includes every Task 5 file listed above, including this report.

## Concerns

None blocking. Existing historical candidates without `originMethod === "llm_v1"` now defer until origin enrichment writes a current verdict; this is the intended fail-closed behavior and avoids any public reply on stale classification.

## Fix round 1/5 — runtime result allowlists

### Finding addressed

The worker previously handled the declared `defer`/`suppress` and
`suppressed`/`deferred`/`blocked` variants, then relied on TypeScript narrowing to
fall through. A malformed runtime result with a different `kind` could therefore
reserve capacity or reach `replyToComment`.

The worker now requires the literal positive checks `decision.kind === "send"`
before reservation and `dispatchStart.kind === "started"` before dispatch-start
accounting/provider invocation. Every other runtime kind is logged with only a
stable error code and `kind`, deferred, and cleaned up without terminal
suppression. The unlocked path releases the claim before any reservation; the
locked-start path calls `releaseHistoricalReservation()` with its fenced tokens,
which releases both reservation and claim.

The repository header now documents that the worker read is advisory, while the
repository repeats the authoritative critical checks under final locks.

### RED

Command:

```sh
npx vitest run src/services/historicalRecoveryWorker.test.ts -t "posts only for exact send and started results|defers an unexpected unlocked recheck result without reserving or posting|releases a reservation for an unexpected final start result without posting"
```

Result: FAIL — 2 failures, 1 passing, 71 skipped. A runtime
`{ kind: "unexpected" } as never` from the recheck did not release the claim,
and the same malformed final-start result reached the provider mock.

### GREEN

Command:

```sh
npx vitest run src/services/historicalRecoveryWorker.test.ts -t "posts only for exact send and started results|defers an unexpected unlocked recheck result without reserving or posting|releases a reservation for an unexpected final start result without posting"
```

Result: PASS — 3 passing, 71 skipped.

Command:

```sh
npx vitest run src/services/historicalRecoveryWorker.test.ts src/services/historicalRecoveryRecheck.test.ts src/services/historicalRecoveryOriginPolicy.test.ts
```

Result: PASS — 114 tests.

Command:

```sh
npm run build
```

Result: PASS — `prisma generate && tsc` completed successfully.

Command:

```sh
git diff --check
```

Result: PASS — no whitespace errors.

### Fix-round files and commit

- `src/services/historicalRecoveryWorker.ts`
- `src/services/historicalRecoveryWorker.test.ts`
- `src/services/historicalRecoveryRepository.ts`
- `.superpowers/sdd/2026-08-09-gemini-gated-historical-recovery/task-5-report.md`

The fix-round commit is created after this report append and contains only the files above.
