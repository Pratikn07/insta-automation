# Task 9 report — expanded historical-recovery audience

**Worktree:** `/Users/pratik.nandoskar/Documents/working/mch/insta-automation/.worktrees/expanded-recovery-audience`

**Database:** disposable loopback PostgreSQL 16 at `127.0.0.1:64571`

**Production mutations/Supabase/Meta access:** not used. One read-only Railway
status inspection occurred in Fix Round 4; see that round's evidence.

## Delivered

- `docs/qa/2026-08-11-expanded-historical-recovery-audience-qa.md`: exact inert
  deploy, reclassify, select, audit, approve, start, verify, rollback, and
  emergency group-pause runbook.
- `docs/meta-verification.md`: approved `llm_v3` policy: five non-South-Asian
  segments allow, both South-Asian confidence levels block, and stale/malformed
  provenance defers.
- `prisma/migrations/20260811210000_expanded_recovery_audience_segments/migration.sql`:
  null-safe rollout-group shape constraint.
- `src/services/historicalAudienceSegmentMigrationContract.test.ts`: fixture
  cleanup uses the documented parent-delete cascade after approval sealing.

The runbook explicitly keeps `DM_RECOVERY_ENABLED=false` and
`DM_RECOVERY_HISTORICAL_ENABLED=false` until reclassification and every audit
gate passes. It includes exact SQL/commands for method/segment/confidence counts,
stale target zero, deterministic no-name classification, both-confidence
South-Asian exclusion, cross-campaign duplicate zero, caps `10`/`1000`, first
Meta comment readback, health signals, owner approval/start, rollback, and atomic
rollout-group emergency pause.

## Database diagnosis and TDD correction

Initial complete backend run:

```bash
MIGRATION_TEST_DATABASE_DISPOSABLE=true \
MIGRATION_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64571/insta_recovery_test \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64571/insta_recovery_test \
npm test
```

Result: **116 files: 115 passed, 1 failed; 1,847 tests: 1,845 passed, 2 failed;
0 skipped reported.** Both failures were in
`historicalAudienceSegmentMigrationContract.test.ts`.

Root cause evidence:

1. PostgreSQL accepts a `CHECK` that evaluates to `NULL`. The existing
   `rollout_group_hourly_cap BETWEEN 1 AND 1000` allowed a non-null group ID with
   a null cap.
2. The test approved a manifest then deleted its child first. The existing
   immutable-manifest trigger correctly rejected that child deletion; parent
   deletion is the documented cascade path.

The existing contract was the failing test observed before the migration change.
The scoped green change added `rollout_group_hourly_cap IS NOT NULL` and reordered
the fixture cleanup. Only the supplied disposable database was reset:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64571/insta_recovery_test \
npx prisma migrate reset --force --skip-seed

MIGRATION_TEST_DATABASE_DISPOSABLE=true \
MIGRATION_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64571/insta_recovery_test \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64571/insta_recovery_test \
npx vitest run src/services/historicalAudienceSegmentMigrationContract.test.ts
```

Focused result: **1 file, 3 tests passed; 0 failures; 0 skipped.** The reset
applied all migrations including `20260811210000_expanded_recovery_audience_segments`.

## Final verification

```bash
MIGRATION_TEST_DATABASE_DISPOSABLE=true \
MIGRATION_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64571/insta_recovery_test \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64571/insta_recovery_test \
npm test

npm run build && npx prisma validate

npm --prefix web test && npm --prefix web run lint && npm --prefix web run build

git diff $(git merge-base HEAD main)..HEAD --check
git diff --check
git status --short
git log --oneline --decorate main..HEAD
```

Results:

- Backend: **116 files passed; 1,847 tests passed; 0 failures; 0 skipped
  reported** (57.95 seconds). Database-gated contracts executed under the
  loopback migration harness.
- Backend build: Prisma generation and TypeScript compilation passed.
- Prisma validation: passed.
- Web: **34 files passed; 487 tests passed; 0 failures; 0 skipped reported**.
- Web lint: passed with 0 errors.
- Web production build: passed.
- Both whitespace checks: passed.

## Runbook SQL evidence

All 15 read-only runbook query shapes were executed through the local `pg`
client against the disposable schema: method/segment/confidence, stale-targeted,
no-name, manifest, caps, candidate provenance, bad provenance, South-Asian,
exclusions, duplicates, stale candidates, capacity, outcomes, health, and
dispatches. All parsed and executed successfully.

The refreshed database constraint is:

```sql
(rollout_group_id IS NULL AND rollout_group_hourly_cap IS NULL)
OR (rollout_group_id IS NOT NULL
    AND rollout_group_hourly_cap IS NOT NULL
    AND rollout_group_hourly_cap BETWEEN 1 AND 1000)
```

## Commit and concerns

**Commit:** `eea36d3` — `docs: add expanded recovery rollout runbook`.

The prior local migration history reflected an older in-progress migration file,
so the disposable database reset was necessary for truthful contract evidence.
No production state changed. Remaining production prerequisites are intentional:
use the approved environment, reclassify to zero stale targets, pass the owner
audit, and complete the first-comment Meta readback before expanded sending is
enabled.

## Fix Round 1/5 — executable rollout hardening

### Scope and files

Addressed all five review findings without accessing Railway project state,
production, Supabase, or the main checkout. Inspected only local Railway CLI
help and repository code. Changed:

- `scripts/expanded-recovery-rollout.sh` — canonical operator implementation.
- `scripts/expanded-recovery-rollout.test.sh` — shell syntax and required-safety
  literal regression check.
- `docs/qa/2026-08-11-expanded-historical-recovery-audience-qa.md` — concise
  runbook delegating every executable operation and SQL gate to the canonical
  script.

`docs/meta-verification.md` was inspected and already matches the approved v3
policy: `llm_v3`; the four expanded segments allowed in their own campaigns;
`south_asian` blocked at both confidence levels; `unknown_no_name` for both
normalized identity values empty. It required no further change.

### Railway 4.65 evidence and exact rollout commands

Local inspection confirmed `railway 4.65.0` and these relevant contracts:

- `railway variable set [OPTIONS] <VARIABLES>...` supports `--skip-deploys`.
- `railway up --detach --json` starts but does not wait; its own help directs
  polling `railway deployment list --json`.
- `railway logs [DEPLOYMENT_ID]` defaults to a latest deployment only when no
  positional ID is provided.
- `railway ssh --deployment-instance <id>` executes on the deployed service;
  `railway run` explicitly runs a **local** command with active-environment
  variables and therefore cannot bind selection to deployed release files.
- `railway restart` has service/environment selectors but no deployment-ID
  selector.

The exact operator sequence is now:

```bash
bash -n scripts/expanded-recovery-rollout.sh
bash scripts/expanded-recovery-rollout.test.sh
bash scripts/expanded-recovery-rollout.sh deploy-inert
bash scripts/expanded-recovery-rollout.sh wait-live
export DEPLOYMENT_INSTANCE_ID='00000000-0000-4000-8000-000000000000'
bash scripts/expanded-recovery-rollout.sh select
bash scripts/expanded-recovery-rollout.sh audit-drafts
bash scripts/expanded-recovery-rollout.sh approve-start
bash scripts/expanded-recovery-rollout.sh verify
export EMERGENCY_REASON='unexpected recovery health signal'
bash scripts/expanded-recovery-rollout.sh pause
```

`deploy-inert` first runs the exact `railway variable set --skip-deploys`
command with `DM_RECOVERY_ENABLED=false` and
`DM_RECOVERY_HISTORICAL_ENABLED=false`, then captures the ID returned by
`railway up --detach --json`. It polls that ID only (60 × 10 seconds), and
inspects the exact record and `railway logs "$deployment_id"` on either success
or bounded failure. It never uses a latest-success fallback.

The generated state file contains only validated deployment/group/campaign UUIDs
and the non-empty campaign count; it never contains a URL or bearer token and
the script never sources `.env`. Selection uses `railway ssh` with an explicitly
verified exact deployment-instance ID. In the remote release it proves the
selector file hash and the deployed `DATABASE_URL`'s expected non-loopback host
and database before writing drafts. The API base is independently required to
be HTTPS and to match the expected host/environment. Campaign IDs, rollout IDs,
and owner email are validated; selection requires exactly one through four
non-empty, unique campaign UUIDs.

Approve/start has an ERR trap that attempts an authenticated atomic group pause
on every partial failure. It approves every campaign paused, audits paused state,
sets flags with `--skip-deploys`, refuses a restart if a newer deployment makes
the target ambiguous, then checks the shared circuit before resuming all. Meta
readback uses `Authorization: Bearer $META_ACCESS_TOKEN`, never a token query
parameter.

### SQL and shared-circuit evidence

The canonical SQL checks every `historicalAudienceSegment.ts` structural map:

- current method `llm_v3`; confidence `high` or `low`;
- `western/us_western`, `other/other`, all three unknown segments/`unknown`,
  and `south_asian/south_asian`;
- exact live/candidate/campaign segment equality for targeted candidate rows;
- `unknown_no_name` parity using trimmed whitespace then ASCII-hyphen-only
  removal, including whitespace-only, space-padded `-`, and space-padded em
  dash behavior;
- stale target zero, duplicate zero, selected South-Asian zero, group rolling
  capacity `<=10`, campaign hourly cap `<=10`, and daily cap `1000`.

Executed the corrected query forms against the supplied disposable PostgreSQL
16 database with `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64571/insta_recovery_test`:

- `live-stale-structure=0`
- `draft-manifest=0`
- `candidate-live-campaign-equality=0`
- `duplicate-zero=0`
- `south-asian-zero=0`
- `capacity-10=0`
- normalization evidence: `" - " => true` and `" — " => false` for the
  no-name predicate.

The script calls authenticated `GET /api/recovery-reminders/metrics` and
requires `.health.circuitOpen == false` before approval/start and before and
after first-send verification. It calls the running-state audit during
verification.

### Validation

The operator script was written test-first: its regression check initially
failed because the implementation did not exist, then passed after the script
was added. Final focused results:

- `bash -n scripts/expanded-recovery-rollout.sh`: passed.
- `bash scripts/expanded-recovery-rollout.test.sh`: passed; 0 failures.
- Extracted every `bash` block from the runbook and ran `bash -n`: passed; 0
  parse failures.
- `git diff --check`: passed.

Complete repository validation used both required disposable database variables:

```bash
MIGRATION_TEST_DATABASE_DISPOSABLE=true \
MIGRATION_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64571/insta_recovery_test \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:64571/insta_recovery_test \
npm test
npm run build && npx prisma validate
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
git diff --check
git status --short
git log --oneline -3
```

Results: backend **116 files / 1,847 tests passed**, 0 failures, 0 skipped
reported; web **34 files / 487 tests passed**, 0 failures, 0 skipped reported;
backend build, Prisma validate, web lint, web build, shell syntax, and diff
checks all passed.

### Commit and concerns

**Commit:** `4f1db7a` — `fix: make recovery rollout runbook executable`.

No production command was run. The local workstation has no `psql` executable,
so the production-guarded script was not pointed at the disposable database;
the same corrected read-only SQL was executed through the repository `pg`
client instead. A real operator must have `psql`, Railway credentials, an
approved read-only production URL, and an owner/Meta token. Railway CLI 4.65
cannot programmatically map a deployment ID to an SSH instance ID or restart a
specific deployment; the runbook treats those limitations as fail-closed human
verification/ambiguity gates.

## Fix Round 2/5 — fail-closed lifecycle and parity audit

### Changes

- Replaced the ad-hoc operator shell workflow with an explicit armed cleanup
  lifecycle: `EXIT`, `INT`, and `TERM` all pause and verify the exact group and
  restore only the historical flag before exit. Cleanup is armed before
  approval/start and verification mutations and disarmed only after their safe
  terminal phase.
- Added exact campaign-set/state checks through a read-only Node/PostgreSQL
  helper before approval, resume, verification, and pause.
- Added a phaseful, mode-0600, gitignored JSON state file with Railway/API/DB
  fingerprints, project/service/environment IDs, deployment/instance IDs,
  release SHA, group/campaign set, and prior historical flag; it has no token or
  database URL. Unknown/uncertain selection now fails closed and requires
  explicit audited `adopt` rather than creating a second group.
- Only `DM_RECOVERY_HISTORICAL_ENABLED` changes. Enabling uses a new captured
  `railway up --detach --json` deployment, waits through `WAITING` and other
  nonterminal states, and requires `sendingEnabled=true`; no restart is used.
- Added Node parity audit sharing `classifyIdentityPresence` and
  `evaluateHistoricalAudience`, so JavaScript trim and em-dash behavior cannot
  drift from SQL emulation. Every query uses `BEGIN READ ONLY`; production audit
  role DML privilege is rejected.
- Added behavioral fake-binary coverage for armed failure cleanup, campaign-set
  mismatch blocking before approval, verification Meta failure cleanup, absence
  of secrets from state/logs, and no Railway restart.

### TDD and evidence

The initial behavioral test failed before the lifecycle existed (no pause log);
the initial parity test failed because the helper did not exist, then failed on
the em-dash case, proving the first helper version was too permissive. The
production-normalization fix made both green.

Focused commands and results:

```bash
bash -n scripts/expanded-recovery-rollout.sh
bash scripts/expanded-recovery-rollout.test.sh
npx vitest run src/services/expandedRecoveryOperatorAudit.test.ts
EXPANDED_AUDIT_TEST_ALLOW_DML_ROLE=true \
  PGURL=postgresql://postgres:postgres@127.0.0.1:64571/insta_recovery_test \
  npx tsx scripts/expanded-recovery-audit.ts audit-live
```

All passed. The disposable audit returned `{"ok":true,"targeted":0}`. The
test-only DML override was necessary because the disposable `postgres` role is
intentionally privileged; the helper still began a read-only transaction.

Complete final verification:

- Backend disposable contract suite: **117 files, 1,848 tests passed; 0
  failures; 0 skips reported.**
- Backend build and Prisma validate: passed.
- Web: **34 files, 487 tests passed; 0 failures; 0 skips reported**; lint and
  production build passed.
- Shell syntax, behavioral test, Node parity audit, and `git diff --check`:
  passed.

### Files and commit

- `.gitignore`
- `docs/qa/2026-08-11-expanded-historical-recovery-audience-qa.md`
- `scripts/expanded-recovery-rollout.sh`
- `scripts/expanded-recovery-rollout.test.sh`
- `scripts/expanded-recovery-audit.ts`
- `scripts/pg.d.ts`
- `src/services/expandedRecoveryOperatorAudit.test.ts`

**Commit:** `77260cc` — `fix: make recovery rollout fail closed`.

No Railway, production, Supabase, or main-checkout command was run. A production
operator still needs an actual read-only database role, explicit SSH
deployment-instance verification, and approved credentials; the implementation
fails closed when those proofs are absent.

## Fix Round 3/5 — reconcile lifecycle safety

Implemented final same-implementer hardening in the isolated worktree only.

- Cleanup is armed at entry to approval and verification, before any state,
  ownership, circuit, or group check that could fail while campaigns are running.
  `EXIT`, `INT`, `TERM`, and `HUP` all run the same lifecycle.
- Exact group pause/verification and historical-flag restoration each retry three
  bounded times. Any unproven rollback writes `phase=cleanup_required`, emits a
  loud safety warning, and exits 75 rather than preserving the original status.
- Inert reruns preserve the original historical flag from the first deploy;
  they reconcile rather than recapture it. The prospective master flag remains
  untouched.
- Approval now runs live parity audit and complete group audit before the first
  approval. The group audit adds immutable hashes, exact 10/1000 caps, holdout,
  duplicate-person, rolling-capacity, and live/candidate/campaign equality
  checks. Verification accepts running or completed campaigns and is armed
  throughout its first-send path.
- Restored remote selector execution: state moves to `selecting` before the
  exact-instance command, output is parsed and audited, then state becomes
  `selected`; interrupted/uncertain selection remains adopt-only.
- All owner and Meta bearer headers are now curl config supplied over stdin, so
  tokens are absent from child argv. API hostname checks, owner `/api/me`,
  PGURL environment-only use, and Node read-only audit remain enforced.

Focused behavioral test passed after the red/green fixes, including explicit
negative `rg` assertions for no restart and no secret leakage. The initial run
exposed Meta’s direct `-H` token argument; moving it to stdin config corrected
that failure.

Final verification:

- Backend disposable PostgreSQL suite: **117 files / 1,848 tests passed; 0
  failures; 0 skips reported.**
- Web: **34 files / 487 tests passed; 0 failures; 0 skips reported**; lint and
  production build passed.
- Backend build, Prisma validation, Node parity audit (`targeted: 0`), shell
  syntax/behavior test, and diff check passed.

**Commit:** `7b2776e` — `fix: reconcile recovery rollout phases`.

No production, Railway project, Supabase, web search, or main checkout access
occurred.

## Fix Round 4/5 — typed, recoverable production-safety operator

### Round 3 finding disposition

Round 3 left one Critical and seven Important findings open. This round
addresses all eight without weakening the rollout contract:

1. Cleanup is now a total TypeScript routine, not an exiting shell trap. It
   durably writes `cleanup_required` first, independently retries exact-group
   pause/verification and historical-flag deployment/verification three times,
   coalesces repeated `INT`/`TERM`/`HUP`, and returns 75 whenever safety or the
   durable state transition is unproven.
2. Strict version-2 state persists and reconciles exact Railway project,
   service, environment, selector deployment/instance, active deployment,
   release SHA, selector SHA-256, API origin/host/owner/fingerprint, and exact
   PostgreSQL protocol/host/port/database/fingerprint. Missing fields and any
   current/saved drift fail before a rollout mutation.
3. `cleanup_required` is an explicit command lock. Only `retry-cleanup` is
   accepted, and retry re-proves both current safety conditions rather than
   trusting stale partial-success flags. `selecting`, `approving`, `enabling`,
   `resuming`, and `verifying` carry durable operation intent and are adoptable,
   resumable, or cleanup-only as appropriate.
4. Remote selection verifies that the requested Railway instance attests the
   saved deployment and exact project/service/environment, release, selector
   hash, PostgreSQL identity, and disabled historical flag. Selector output is
   one strict JSON record; malformed/human output is rejected, and uncertain
   `selecting` state has an explicit exact-record `adopt` path.
5. Before approval mutation, the API locks the recovery singleton and every
   exact campaign/user/candidate/source/exclusion row, reconstructs all
   manifests, recomputes fingerprints and decision hashes, binds them to the
   selector's expected hashes, and validates versions, phase, frozen counts,
   treatment arms, canonical topology/order, live audience parity, and caps.
   Only after all non-empty campaigns pass does one group update occur.
6. First-send verification now requires a running or completed campaign,
   `source_kind='historical'`, `source_id` equal to the candidate ID, and the
   dispatch comment in that candidate's immutable approved source set before
   Meta readback.
7. API and database parsers use exact URL/hostname/database comparisons and
   reject suffix hosts and non-PostgreSQL protocols. Owner/Meta tokens stay in
   headers; `PGURL` stays in a child environment; none are put in argv, state,
   or error text.
8. Behavioral tests exercise the executable operator paths for all three
   signals, deployment and attestation rollback failures, retry/status 75,
   cleanup lock recovery, identity drift, selector contracts, adoption,
   intermediate-phase resume, and completed first-send verification.

Adjacent safety defects corrected during the round:

- Atomic group resume preserves an existing `startedAt` and sets it only for a
  campaign's first launch.
- Group approve/resume requests now carry the selector decision hash, closing a
  TOCTOU gap where a different self-consistent draft could otherwise be sealed.
- `/health` supplies a strict, non-secret active-deployment attestation.
- `approve-start` revalidates the serving deployment and expected historical
  flag before any approval mutation, including resumed phases.
- The shell entrypoint is now only an `exec` wrapper, so signals reach the typed
  operator directly and no unbound shell variable can abort cleanup.

### Files

- `scripts/expanded-recovery-rollout-core.ts`
- `scripts/expanded-recovery-rollout.ts`
- `scripts/expanded-recovery-rollout.sh`
- `scripts/expanded-recovery-rollout.test.sh`
- `scripts/expanded-recovery-audit.ts`
- `scripts/select-expanded-historical-recovery.ts`
- `src/services/expandedRecoveryRolloutCore.test.ts`
- `src/services/expandedRecoveryRolloutOperator.test.ts`
- `src/services/expandedRecoveryOperatorAudit.test.ts`
- `src/services/expandedRecoveryCampaignOutput.ts`
- `src/services/expandedRecoveryCampaignOutput.test.ts`
- `src/services/deploymentHealth.ts`
- `src/services/deploymentHealth.test.ts`
- `src/services/recoveryCampaignControl.ts`
- `src/services/recoveryCampaignControl.test.ts`
- `src/api/historicalRecovery.routes.ts`
- `src/api/historicalRecovery.routes.test.ts`
- `src/server.ts`
- `docs/qa/2026-08-11-expanded-historical-recovery-audience-qa.md`

### TDD and focused verification

Red tests first reproduced the old defects: a mixed group overwrote a prior
launch time; atomic approval accepted a changed selector hash; selecting state
lacked durable intent; post-selection state accepted a missing manifest;
cleanup trusted stale partial proofs; protocol drift passed the local identity;
and the old operator lacked injectable, executable behavior coverage.

Final focused command:

```bash
npx vitest run \
  src/services/expandedRecoveryCampaignOutput.test.ts \
  src/services/deploymentHealth.test.ts \
  src/services/expandedRecoveryRolloutCore.test.ts \
  src/services/expandedRecoveryRolloutOperator.test.ts \
  src/services/expandedRecoveryOperatorAudit.test.ts \
  src/services/recoveryCampaignControl.test.ts \
  src/api/historicalRecovery.routes.test.ts
npx tsc --noEmit
bash -n scripts/expanded-recovery-rollout.sh scripts/expanded-recovery-rollout.test.sh
```

Result: **7 files / 172 tests passed**, TypeScript typecheck passed, and both
shell files parsed. The behavioral subset covers failed rollback deployment,
successful deployment with failed serving attestation, three retries/status 75,
initial state-write failure and durable lock retry, explicit cleanup recovery,
saved/current identity mismatch before mutation, exact deployment binding,
malformed/valid selector records, selecting/adopt state, approved-phase resume,
completed verification, no secret argv/state, and `INT`, `TERM`, and `HUP`.

The complete backend/web suite was intentionally not used as completion
evidence in this round: a full backend run was started, then stopped immediately
at the supervising user's checkpoint request so the parent agent can run final
full verification. No deployment, database write, Meta call, merge, push, or
main-checkout change occurred. One earlier read-only `railway status --json`
inspection exposed project metadata but made no mutation; no further Railway or
production access occurred.

### Residual verification gates

- Parent must run the complete disposable-PostgreSQL backend suite plus backend
  build/Prisma validation and the web test/lint/build suite on this commit.
- Real Railway/API/Meta execution remains intentionally credential-gated and
  was not exercised by this implementation round.
