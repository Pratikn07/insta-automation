# Task 6 Report — Frozen Origin Provenance in Review APIs

## Status

Completed and verified.

## Scope and files

Modified only Task 6 implementation/tests plus this report:

- `src/services/historicalRecoveryCandidateDetail.ts`
- `src/services/historicalRecoveryCandidateDetail.test.ts`
- `src/api/historicalRecovery.routes.ts`
- `src/api/historicalRecovery.routes.test.ts`
- `web/src/components/historical/historicalRecoveryViewModel.ts`
- `web/src/components/historical/historicalRecoveryViewModel.test.ts`
- `web/src/components/historical/HistoricalCandidateDrawer.tsx`
- `web/src/components/historical/HistoricalCandidateDrawer.test.tsx`
- `.superpowers/sdd/2026-08-09-gemini-gated-historical-recovery/task-6-report.md`

## Behavior delivered

- Candidate-list JSON includes the frozen `audienceOrigin`,
  `audienceOriginMethod`, and `audienceOriginConfidence` copied from the
  recovery candidate.
- Candidate-detail JSON selects and returns the same three frozen values.
- The list `CandidateRow` type and the drawer's detail-response type retain all
  three nullable provenance fields.
- The owner-review drawer displays origin, method, and confidence, including a
  clear `Not recorded` value for legacy nullable snapshots.
- No eligibility, origin policy, live `IgUser` lookup, or sending behavior was
  changed.

## TDD evidence

### RED

Command:

```sh
npx vitest run src/services/historicalRecoveryCandidateDetail.test.ts src/api/historicalRecovery.routes.test.ts web/src/components/historical/historicalRecoveryViewModel.test.ts web/src/components/historical/HistoricalCandidateDrawer.test.tsx
```

Result: FAIL — the backend test run reported 2 expected contract failures:
candidate list and detail omitted `audienceOriginMethod`.

Command:

```sh
cd web && npx vitest run src/components/historical/historicalRecoveryViewModel.test.ts src/components/historical/HistoricalCandidateDrawer.test.tsx
```

Result: FAIL — the new drawer assertion could not find `Audience origin`.

### GREEN

Command:

```sh
npx vitest run src/services/historicalRecoveryCandidateDetail.test.ts src/api/historicalRecovery.routes.test.ts
```

Result: PASS — 2 files, 25 tests.

Command:

```sh
cd web && npx vitest run src/components/historical/historicalRecoveryViewModel.test.ts src/components/historical/HistoricalCandidateDrawer.test.tsx
```

Result: PASS — 2 files, 32 tests.

Command:

```sh
npm run build
```

Result: PASS — backend `prisma generate && tsc` completed successfully.

Command:

```sh
cd web && npm run build
```

Result: PASS — web `tsc -b && vite build` completed successfully.

Command:

```sh
cd web && npm run lint
```

Result: PASS — ESLint completed with no errors.

## Self-review

- Reviewed the full scoped diff and confirmed both JSON serializers copy the
  candidate snapshot fields rather than live user fields.
- Confirmed the method is selected before the detail serializer reads it.
- Confirmed both frontend response types preserve origin, method, and
  confidence; the drawer test exercises the visible review surface.
- Confirmed no files related to selection, eligibility, dispatch, or sending
  were changed.
- Ran `git diff --check`; no whitespace errors.

## Commit

`feat: expose historical origin provenance` — includes every Task 6 file listed
above, including this report.

## Concerns

No blocking concerns. The worktree initially lacked `web/node_modules`; running
`npm ci` in `web/` restored the locked test environment without changing tracked
dependency files. Its existing audit output reports 6 dependency vulnerabilities
(1 moderate, 5 high), outside this Task 6 scope.
