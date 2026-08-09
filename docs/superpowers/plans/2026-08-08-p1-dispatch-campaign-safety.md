# P1 Dispatch and Campaign Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining QA-08, QA-10, QA-12, and QA-13 launch blockers by fencing the final Graph-call boundary, preserving truthful in-flight state, making campaign transitions crash-safe, enforcing distributed batch/cap limits, and adding durable campaign health signals.

**Architecture:** The existing `public_recovery_dispatch` ledger remains the authority for contact and capacity. An additive migration adds a distributed historical-tick lease, per-campaign batch-run records, and append-only health observations. Historical dispatch start validates campaign, circuit, claim, reservation, and batch allowance in one lock-ordered transaction; campaign approval/cancellation/drain operations become transactionally truthful; health is evaluated after each terminal outcome before another send is authorized.

**Tech Stack:** TypeScript, Node.js 22, Prisma 5, PostgreSQL, Vitest 4, Express, Zod

## Global Constraints

- Keep `DM_RECOVERY_HISTORICAL_ENABLED=false`; tests call services directly.
- Do not deploy, apply a production migration, run reconciliation `--write`, merge to `main`, or contact Meta.
- Follow the lock order `dm_recovery_control(1) -> ig_users(person) -> recovery_candidate(source) -> recovery_campaign -> campaign batch run -> public dispatch` wherever those rows participate.
- Every network authorization fails closed on unknown state or database failure.
- Write each behavioral test first, run it, and observe the expected failure before changing production code.
- Use a disposable PostgreSQL database through `MIGRATION_TEST_DATABASE_URL` for migration, lock, race, and rollback contracts.
- Do not expose tokens, raw provider responses, message/comment text, or database URLs in logs or API responses.

---

### Task 1: Add the dispatch-safety persistence model and configuration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260809020000_p1_dispatch_campaign_safety/migration.sql`
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Create: `src/services/historicalRecoverySafetyMigrationContract.test.ts`

**Interfaces:**
- Produces Prisma models `RecoveryCampaignBatchRun` and `RecoveryCampaignHealthObservation`.
- Produces enums `RecoveryCampaignBatchStatus` and `RecoveryCampaignHealthKind`.
- Adds `DmRecoveryControl.historicalTickToken` and `historicalTickExpiresAt`.
- Adds configuration `DM_RECOVERY_GLOBAL_DAILY_CAP: number` with default `100` and minimum `1`.

- [ ] **Step 1: Write the failing configuration tests**

Add cases to `src/config/env.test.ts` that parse `baseEnv` through the exported `envSchema` and assert:

```ts
expect(envSchema.parse(baseEnv).DM_RECOVERY_GLOBAL_DAILY_CAP).toBe(100);
expect(
  envSchema.parse({ ...baseEnv, DM_RECOVERY_GLOBAL_DAILY_CAP: "250" })
    .DM_RECOVERY_GLOBAL_DAILY_CAP,
).toBe(250);
expect(
  envSchema.safeParse({ ...baseEnv, DM_RECOVERY_GLOBAL_DAILY_CAP: "0" }).success,
).toBe(false);
```

- [ ] **Step 2: Run the configuration tests and verify RED**

Run: `npm test -- src/config/env.test.ts`

Expected: FAIL because `DM_RECOVERY_GLOBAL_DAILY_CAP` is not defined.

- [ ] **Step 3: Write the failing migration contract**

Create `src/services/historicalRecoverySafetyMigrationContract.test.ts` using the repository's disposable-database helpers. After applying the complete migration chain, assert:

```ts
expect(await columns("dm_recovery_control")).toEqual(
  expect.arrayContaining(["historical_tick_token", "historical_tick_expires_at"]),
);
expect(await tables()).toEqual(
  expect.arrayContaining(["recovery_campaign_batch_run", "recovery_campaign_health_observation"]),
);
```

Insert invalid fixtures and require PostgreSQL to reject:

```ts
await expect(insertControlLeaseWithTokenOnly()).rejects.toThrow();
await expect(insertBatchRun({ allowance: 1, consumed: 2 })).rejects.toThrow();
await expect(insertDuplicateHealthSource()).rejects.toThrow();
await expect(insertSecondActiveBatchForCampaign()).rejects.toThrow();
```

- [ ] **Step 4: Run the migration contract and verify RED**

Run: `MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- src/services/historicalRecoverySafetyMigrationContract.test.ts --no-file-parallelism`

Expected: FAIL because the new columns, tables, enums, and constraints do not exist.

- [ ] **Step 5: Add the Prisma schema and SQL migration**

Add this schema shape, using the existing naming conventions:

```prisma
enum RecoveryCampaignBatchStatus {
  active
  completed
  expired

  @@map("recovery_campaign_batch_status")
}

enum RecoveryCampaignHealthKind {
  complaint
  opt_out
  block
  negative_reply
  classifier_anomaly

  @@map("recovery_campaign_health_kind")
}

model RecoveryCampaignBatchRun {
  id             String                      @id @default(uuid()) @db.Uuid
  campaignId     String                      @map("campaign_id") @db.Uuid
  tickToken      String                      @map("tick_token") @db.Uuid
  allowance      Int
  consumed       Int                         @default(0)
  status         RecoveryCampaignBatchStatus @default(active)
  startedAt      DateTime                    @map("started_at") @db.Timestamptz(3)
  leaseExpiresAt DateTime                    @map("lease_expires_at") @db.Timestamptz(3)
  endedAt        DateTime?                   @map("ended_at") @db.Timestamptz(3)
  createdAt      DateTime                    @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt      DateTime                    @updatedAt @map("updated_at") @db.Timestamptz(3)
  campaign       RecoveryCampaign            @relation(fields: [campaignId], references: [id], onDelete: Restrict)

  @@unique([campaignId, tickToken])
  @@index([status, leaseExpiresAt])
  @@map("recovery_campaign_batch_run")
}

model RecoveryCampaignHealthObservation {
  id          String                     @id @default(uuid()) @db.Uuid
  campaignId  String                     @map("campaign_id") @db.Uuid
  kind        RecoveryCampaignHealthKind
  sourceKey   String                     @map("source_key")
  observedAt  DateTime                   @map("observed_at") @db.Timestamptz(3)
  safeDetail  String?                    @map("safe_detail")
  createdAt   DateTime                   @default(now()) @map("created_at") @db.Timestamptz(3)
  campaign    RecoveryCampaign           @relation(fields: [campaignId], references: [id], onDelete: Restrict)

  @@unique([campaignId, sourceKey])
  @@index([campaignId, kind, observedAt])
  @@map("recovery_campaign_health_observation")
}
```

Add the corresponding relations to `RecoveryCampaign` and nullable lease fields to `DmRecoveryControl`. In SQL, add checks requiring the control token/expiry pair to be both null or both non-null, `allowance > 0`, `consumed BETWEEN 0 AND allowance`, terminal batch rows to have `ended_at`, active rows to have no `ended_at`, and a partial unique index on `campaign_id WHERE status = 'active'`.

Add `DM_RECOVERY_GLOBAL_DAILY_CAP` to the Zod environment schema with integer coercion, default `100`, and `.min(1)`.

- [ ] **Step 6: Generate Prisma and verify GREEN**

Run: `npm run prisma:generate`

Run: `npm test -- src/config/env.test.ts`

Run: `MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- src/services/historicalRecoverySafetyMigrationContract.test.ts --no-file-parallelism`

Expected: all commands PASS.

- [ ] **Step 7: Commit the persistence boundary**

```bash
git add prisma/schema.prisma prisma/migrations/20260809020000_p1_dispatch_campaign_safety/migration.sql src/config/env.ts src/config/env.test.ts src/services/historicalRecoverySafetyMigrationContract.test.ts
git commit -m "feat: add historical recovery safety records"
```

### Task 2: Fence dispatch start and preserve truthful cancellation

**Files:**
- Modify: `src/services/historicalRecoveryRepository.ts`
- Modify: `src/services/publicRecoveryDispatchRepository.ts`
- Modify: `src/services/historicalRecoveryWorker.ts`
- Modify: `src/services/recoveryCampaignControl.ts`
- Modify: `src/services/historicalRecoveryWorker.test.ts`
- Modify: `src/services/recoveryCampaignControl.test.ts`
- Modify: `src/services/historicalRecoveryClaimContract.test.ts`
- Modify: `src/services/publicRecoveryDispatchPostgresContract.test.ts`
- Create: `src/services/historicalRecoveryDispatchInterleavingContract.test.ts`

**Interfaces:**
- Changes `startHistoricalDispatch(input)` from `Promise<boolean>` to `Promise<StartHistoricalDispatchResult>`.
- Adds `releaseHistoricalReservation(input): Promise<boolean>` that can safely release an unstarted ledger reservation even when the source was cancelled.
- Changes successful cancellation to `{ ok: true, state: "cancelled", cancelledCandidates: number, inFlightCandidates: number }`.

Use these exact result types:

```ts
export type HistoricalDispatchStartBlockReason =
  | "stale_claim"
  | "campaign_not_running"
  | "circuit_open"
  | "batch_not_active"
  | "campaign_batch_exhausted"
  | "reservation_not_active";

export type StartHistoricalDispatchResult =
  | { kind: "started" }
  | { kind: "blocked"; reason: HistoricalDispatchStartBlockReason };
```

- [ ] **Step 1: Write failing real-PostgreSQL interleaving contracts**

Create contracts that coordinate two Prisma clients with promises/barriers and prove:

```ts
expect(await startAfterPause()).toEqual({ kind: "blocked", reason: "campaign_not_running" });
expect(metaCalls).toBe(0);

expect(await cancelAfterDispatchStarted()).toMatchObject({
  ok: true,
  cancelledCandidates: 0,
  inFlightCandidates: 1,
});
expect(await finalizeMetaSuccess()).toBe(true);
expect(await candidateOutcome()).toBe("sent");
expect(await ledgerState()).toBe("sent");
```

Add cases for cancellation before start releasing the reservation, cancellation after Meta success but before finalization, circuit opening between reserve/start, and expired/cancelled in-flight work becoming `send_uncertain`.

- [ ] **Step 2: Run the interleaving contracts and verify RED**

Run: `MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- src/services/historicalRecoveryDispatchInterleavingContract.test.ts --no-file-parallelism`

Expected: FAIL because dispatch start ignores campaign/circuit state and cancellation rewrites in-flight candidates.

- [ ] **Step 3: Write failing unit expectations for typed start results**

Update `historicalRecoveryWorker.test.ts` so the happy path returns `{ kind: "started" }`, and blocked cases assert that `replyToComment` is not called. Update `recoveryCampaignControl.test.ts` to expect separate `cancelledCandidates` and `inFlightCandidates` counts.

- [ ] **Step 4: Run the focused unit tests and verify RED**

Run: `npm test -- src/services/historicalRecoveryWorker.test.ts src/services/recoveryCampaignControl.test.ts`

Expected: FAIL on the old boolean start contract and old cancellation response.

- [ ] **Step 5: Implement final authorization under locks**

In `startHistoricalDispatch`, after acquiring control/person/candidate locks, read the control and candidate with campaign. Return the exact blocked reason for each failed invariant. Lock the campaign row before changing the ledger. Require `campaign.state === "running"`, `control.circuitOpen === false`, exact claim ownership, and an active reservation. Task 4 adds the batch-run validation; until then, accept an optional `batchRunId` and validate it only when supplied.

Transition the public ledger and stamp `dispatchStartedAt` in the same transaction. Update the worker so only `{ kind: "started" }` can reach `replyToComment`.

Add `releaseHistoricalReservation` as an idempotent ledger finalizer for a `reserved` row. It must never release `dispatch_started`.

- [ ] **Step 6: Implement truthful cancellation**

Inside the cancellation transaction, lock the campaign and candidate rows. For each pending candidate:

- a matching `reserved` ledger row is released and the candidate becomes `cancelled`;
- a `dispatch_started` ledger row or non-null candidate `dispatchStartedAt` is counted as in-flight and left `pending`;
- an unclaimed/pre-dispatch candidate becomes `cancelled`.

Change only the campaign state to `cancelled`; do not prevent pending in-flight candidates from finalizing. Ensure lease reconciliation continues to scan them after campaign cancellation.

- [ ] **Step 7: Verify GREEN and existing dispatch regression coverage**

Run: `npm test -- src/services/historicalRecoveryWorker.test.ts src/services/recoveryCampaignControl.test.ts`

Run: `MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- src/services/historicalRecoveryDispatchInterleavingContract.test.ts src/services/historicalRecoveryClaimContract.test.ts src/services/publicRecoveryDispatchPostgresContract.test.ts --no-file-parallelism`

Expected: all tests PASS and no contract calls Meta.

- [ ] **Step 8: Commit the dispatch boundary**

```bash
git add src/services/historicalRecoveryRepository.ts src/services/publicRecoveryDispatchRepository.ts src/services/historicalRecoveryWorker.ts src/services/recoveryCampaignControl.ts src/services/historicalRecoveryWorker.test.ts src/services/recoveryCampaignControl.test.ts src/services/historicalRecoveryClaimContract.test.ts src/services/publicRecoveryDispatchPostgresContract.test.ts src/services/historicalRecoveryDispatchInterleavingContract.test.ts
git commit -m "fix: fence historical dispatch cancellation"
```

### Task 3: Make approval and draining crash-safe

**Files:**
- Modify: `src/services/recoveryCampaignControl.ts`
- Modify: `src/services/recoveryCampaignControl.test.ts`
- Modify: `src/services/historicalRecoveryLifecycleContract.test.ts`
- Modify: `src/services/historicalRecoveryWorker.ts`
- Modify: `src/services/historicalRecoveryWorker.test.ts`

**Interfaces:**
- `approveCampaign` keeps its existing inputs but returns the actual state, `running` or `completed`.
- `completeCampaignIfDrained` transitions only from `running`.
- Adds `reconcileDrainedCampaigns(now?: Date): Promise<string[]>` returning campaign IDs completed during the scan.

- [ ] **Step 1: Write failing lifecycle contracts**

Add real-PostgreSQL cases that:

1. install a temporary trigger that raises during holdout settlement and prove approval rolls back campaign state, approval fields, and every candidate outcome;
2. approve an all-holdout campaign and expect `{ ok: true, state: "completed" }`;
3. drain an auto-paused campaign and expect it to remain `paused`;
4. commit the final candidate outcome, simulate process restart, call `reconcileDrainedCampaigns`, and expect the running campaign to become completed;
5. leave a `dispatch_started` ledger row and expect drain reconciliation not to complete the campaign.

- [ ] **Step 2: Run lifecycle contracts and verify RED**

Run: `MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- src/services/historicalRecoveryLifecycleContract.test.ts --no-file-parallelism`

Expected: FAIL on non-atomic approval, the incorrect returned state, paused completion, and missing restart reconciler.

- [ ] **Step 3: Implement transactional approval**

Use one interactive transaction. Lock the campaign row, require `draft` or `awaiting_approval`, settle holdouts, count pending treatment rows, and write exactly one final campaign state. Set `endedAt = now` only for the all-holdout completed case. Commit before emitting the audit event. Return the persisted state.

PR 2 will add full manifest verification; in this PR require the current minimum evidence: non-null `decisionHash`, `candidateCount` equal to stored candidates, and at least one stored candidate.

- [ ] **Step 4: Implement safe completion reconciliation**

Make `completeCampaignIfDrained` conditional on `state = running`. Its drained predicate requires zero pending treatment candidates and zero `reserved`/`dispatch_started` public ledger rows for the campaign.

Implement `reconcileDrainedCampaigns` by selecting running campaigns with no actionable candidate or active dispatch, then calling the same locked completion helper for each. Call it near the start and end of the historical worker tick, independently of `campaignsToEvaluate`.

- [ ] **Step 5: Update unit tests and verify GREEN**

Run: `npm test -- src/services/recoveryCampaignControl.test.ts src/services/historicalRecoveryWorker.test.ts`

Run: `MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- src/services/historicalRecoveryLifecycleContract.test.ts --no-file-parallelism`

Expected: all tests PASS.

- [ ] **Step 6: Commit lifecycle safety**

```bash
git add src/services/recoveryCampaignControl.ts src/services/recoveryCampaignControl.test.ts src/services/historicalRecoveryLifecycleContract.test.ts src/services/historicalRecoveryWorker.ts src/services/historicalRecoveryWorker.test.ts
git commit -m "fix: make recovery campaign lifecycle atomic"
```

### Task 4: Enforce distributed ticks, per-campaign batches, and global daily capacity

**Files:**
- Create: `src/services/historicalRecoveryTickRepository.ts`
- Create: `src/services/historicalRecoveryTickRepository.test.ts`
- Create: `src/services/historicalRecoveryTickContract.test.ts`
- Modify: `src/services/historicalRecoveryRepository.ts`
- Modify: `src/services/publicRecoveryDispatchRepository.ts`
- Modify: `src/services/dmRecoveryRepository.ts`
- Modify: `src/services/historicalRecoveryWorker.ts`
- Modify: `src/services/historicalRecoveryWorker.test.ts`
- Modify: `src/services/dmRecoveryScheduler.ts`
- Modify: `src/services/dmRecoveryScheduler.test.ts`
- Modify: `src/services/publicRecoveryDispatchPostgresContract.test.ts`

**Interfaces:**

```ts
export type HistoricalTickLease = { token: string; expiresAt: Date };

export async function acquireHistoricalTick(
  now: Date,
  expiresAt: Date,
): Promise<HistoricalTickLease | null>;

export async function openCampaignBatch(
  tick: HistoricalTickLease,
  campaignId: string,
  now: Date,
): Promise<{ id: string; allowance: number } | null>;

export async function finishHistoricalTick(token: string, now: Date): Promise<boolean>;
```

`startHistoricalDispatch` gains required `batchRunId`. `ReserveDispatchInput` gains `globalDailyCap` and its block-reason union gains `global_daily_cap_reached`.

- [ ] **Step 1: Write failing scheduler and repository tests**

In `dmRecoveryScheduler.test.ts`, use a deferred promise and invoke the captured timer callback while the initial tick is unresolved. Assert `runTick` remains called once; resolve it, invoke again, and assert the second call starts.

In `historicalRecoveryTickRepository.test.ts`, mock Prisma only for typed mapping/error behavior. Put all lease and concurrency behavior in the PostgreSQL contract.

- [ ] **Step 2: Write failing PostgreSQL concurrency contracts**

Prove:

```ts
expect(await Promise.all(fiveAcquireAttempts())).toHaveExactlyOneNonNull();
expect(await openTwoBatchesForSameCampaignAndTick()).toHaveOneActiveBatch();
expect(await consumeBatchConcurrently({ allowance: 1, attempts: 5 })).toHaveOneStartedDispatch();
expect(await acquireAfterLeaseExpiry()).toMatchObject({ token: expect.any(String) });
```

Add two campaigns with batch sizes `1` and `5`; one tick must allow one and five starts respectively. Add simultaneous prospective/historical reservations exhausting a global daily cap and assert the next attempt returns `global_daily_cap_reached`. Test the exact 24-hour boundary as eligible.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm test -- src/services/dmRecoveryScheduler.test.ts src/services/historicalRecoveryTickRepository.test.ts`

Run: `MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- src/services/historicalRecoveryTickContract.test.ts src/services/publicRecoveryDispatchPostgresContract.test.ts --no-file-parallelism`

Expected: FAIL because tick leases, per-campaign batches, local overlap protection, and global daily capacity do not exist.

- [ ] **Step 4: Implement the database tick and batch repository**

Acquire the control row with `FOR UPDATE`. Return null for an unexpired lease. For an expired lease, mark its active batch runs `expired`, then replace the token/expiry. `openCampaignBatch` validates the token/expiry and locks the running campaign before inserting one active batch with `allowance = campaign.batchSize`.

`finishHistoricalTick` compare-and-clears the control lease and marks that token's active batch runs `completed`. A stale token cannot clear a newer lease.

In `startHistoricalDispatch`, lock and validate the batch row belongs to the candidate campaign, is active, carries the current tick token, is unexpired, and has `consumed < allowance`; increment `consumed` in the same transaction as dispatch start.

- [ ] **Step 5: Process campaigns independently**

Replace `smallestRunningBatchSize` and the global due-ID list with explicit running-campaign enumeration. Open one batch per campaign, fetch due IDs scoped to that campaign up to its allowance plus suppression headroom, and process it independently. Always finish the tick in `finally`; a process crash is handled by lease expiry.

Add the scheduler's local `running` boolean so timer callbacks do not overlap within one process. Keep the database lease as the cross-instance authority.

- [ ] **Step 6: Add global daily capacity**

Count ledger capacity states whose `reservedAt > now - 24 hours` before campaign-specific limits. Thread `env.DM_RECOVERY_GLOBAL_DAILY_CAP` through prospective and historical reservations. Return `global_daily_cap_reached` without inserting a ledger row.

- [ ] **Step 7: Verify GREEN**

Run: `npm test -- src/services/dmRecoveryScheduler.test.ts src/services/historicalRecoveryTickRepository.test.ts src/services/historicalRecoveryWorker.test.ts`

Run: `MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- src/services/historicalRecoveryTickContract.test.ts src/services/publicRecoveryDispatchPostgresContract.test.ts --no-file-parallelism`

Expected: all tests PASS.

- [ ] **Step 8: Commit distributed pacing**

```bash
git add src/services/historicalRecoveryTickRepository.ts src/services/historicalRecoveryTickRepository.test.ts src/services/historicalRecoveryTickContract.test.ts src/services/historicalRecoveryRepository.ts src/services/publicRecoveryDispatchRepository.ts src/services/dmRecoveryRepository.ts src/services/historicalRecoveryWorker.ts src/services/historicalRecoveryWorker.test.ts src/services/dmRecoveryScheduler.ts src/services/dmRecoveryScheduler.test.ts src/services/publicRecoveryDispatchPostgresContract.test.ts
git commit -m "fix: enforce distributed recovery pacing"
```

### Task 5: Capture durable health signals and stop mid-batch

**Files:**
- Create: `src/services/campaignHealthObservation.ts`
- Create: `src/services/campaignHealthObservation.test.ts`
- Create: `src/services/campaignHealthObservationContract.test.ts`
- Modify: `src/services/historicalRecoveryHealth.ts`
- Modify: `src/services/historicalRecoveryHealth.test.ts`
- Modify: `src/services/historicalRecoveryHealthContract.test.ts`
- Modify: `src/services/historicalRecoveryWorker.ts`
- Modify: `src/services/historicalRecoveryWorker.test.ts`
- Modify: `src/handlers/messageHandler.ts`
- Modify: `src/handlers/messageHandler.test.ts`
- Modify: `src/api/historicalRecovery.routes.ts`
- Modify: `src/api/historicalRecovery.routes.test.ts`

**Interfaces:**

```ts
export type CampaignHealthSignal =
  | "complaint"
  | "opt_out"
  | "block"
  | "negative_reply"
  | "classifier_anomaly";

export async function recordCampaignHealthObservation(input: {
  campaignId: string;
  kind: CampaignHealthSignal;
  sourceKey: string;
  observedAt: Date;
  safeDetail?: string;
}): Promise<{ created: boolean }>;

export function classifyInboundHealthSignal(text: string):
  | "opt_out"
  | "negative_reply"
  | null;
```

- [ ] **Step 1: Write failing pure classifier tests**

Use exact, conservative phrase behavior:

```ts
expect(classifyInboundHealthSignal("STOP")).toBe("opt_out");
expect(classifyInboundHealthSignal("unsubscribe please")).toBe("opt_out");
expect(classifyInboundHealthSignal("do not contact me")).toBe("opt_out");
expect(classifyInboundHealthSignal("leave me alone")).toBe("negative_reply");
expect(classifyInboundHealthSignal("please stop by tomorrow")).toBeNull();
expect(classifyInboundHealthSignal("I cannot stop thinking about this")).toBeNull();
```

Only whole normalized messages matching the reviewed phrase set classify; substrings do not.

- [ ] **Step 2: Write failing observation and health contracts**

Against PostgreSQL, assert source-key replay creates one observation, each signal kind pauses a running campaign, and the pause reason is latched as `auto:<kind>`. Create two terminal dispatch-ledger rows for the same campaign/person and assert duplicate detection stops the campaign even though the candidate table has one row.

Add an authenticated route contract for:

```http
POST /api/historical-recovery/campaigns/:id/health-observations
Content-Type: application/json

{
  "kind": "complaint",
  "sourceKey": "moderation:case-123",
  "observedAt": "2026-08-08T20:00:00.000Z",
  "safeDetail": "verified_report"
}
```

Require admin authentication, restrict `kind` to `complaint`, `block`, or `classifier_anomaly` for manual ingestion, bound keys/details to 200 characters, and return `{ created: true|false }` idempotently.

- [ ] **Step 3: Write the failing mid-batch worker test**

Arrange two candidates. Make the first finalization create a stop observation and `evaluateCampaignHealth` return a stop. Assert the second candidate is never reserved and `replyToComment` is called once.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `npm test -- src/services/campaignHealthObservation.test.ts src/services/historicalRecoveryHealth.test.ts src/services/historicalRecoveryWorker.test.ts src/handlers/messageHandler.test.ts src/api/historicalRecovery.routes.test.ts`

Run: `MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- src/services/campaignHealthObservationContract.test.ts src/services/historicalRecoveryHealthContract.test.ts --no-file-parallelism`

Expected: FAIL because observations, trusted ingestion, ledger duplicate detection, and mid-batch health checks do not exist.

- [ ] **Step 5: Implement observation recording and inbound capture**

Normalize inbound text only inside the pure classifier; do not log or persist the message in the health table. After the normal inbound message record succeeds, find recent historical campaigns for that person whose dispatch ledger contains `sent` or `uncertain`, and write one observation per campaign using `sourceKey = inbound:<instagram-message-id>`.

The opt-out and negative-reply classification must not depend on AI or an external call. An inbound message without a stable provider ID is not promoted to a health observation.

Implement the authenticated manual-ingestion endpoint for externally verified complaint, block, and classifier-anomaly evidence. Audit only campaign ID, observation kind, source key, safe detail, and authenticated admin identity.

- [ ] **Step 6: Make health observations authoritative**

Extend `CampaignStopReason` with the five observation kinds. In `observe`, count append-only observations and derive duplicate contact from `public_recovery_dispatch` grouped by `igUserId` with more than one `sent`/`uncertain` row. `chooseStopReason` checks complaint, opt-out, block, classifier anomaly, negative reply, and duplicate contact before rate-based thresholds.

After each suppressed, failed, uncertain, or sent outcome, call `evaluateCampaignHealth` before the worker proceeds to another candidate in the same campaign batch. A stop breaks that campaign's loop and prevents another reservation.

- [ ] **Step 7: Verify GREEN**

Run: `npm test -- src/services/campaignHealthObservation.test.ts src/services/historicalRecoveryHealth.test.ts src/services/historicalRecoveryWorker.test.ts src/handlers/messageHandler.test.ts src/api/historicalRecovery.routes.test.ts`

Run: `MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- src/services/campaignHealthObservationContract.test.ts src/services/historicalRecoveryHealthContract.test.ts --no-file-parallelism`

Expected: all tests PASS.

- [ ] **Step 8: Commit health stops**

```bash
git add src/services/campaignHealthObservation.ts src/services/campaignHealthObservation.test.ts src/services/campaignHealthObservationContract.test.ts src/services/historicalRecoveryHealth.ts src/services/historicalRecoveryHealth.test.ts src/services/historicalRecoveryHealthContract.test.ts src/services/historicalRecoveryWorker.ts src/services/historicalRecoveryWorker.test.ts src/handlers/messageHandler.ts src/handlers/messageHandler.test.ts src/api/historicalRecovery.routes.ts src/api/historicalRecovery.routes.test.ts
git commit -m "feat: stop campaigns on durable health signals"
```

### Task 6: Run PR 1 release gates and record QA evidence

**Files:**
- Modify: `docs/qa/2026-08-07-instagram-automation-features-1-4-deep-qa.md`

**Interfaces:**
- Produces a review-ready `fix/p1-dispatch-safety` branch.
- Does not push, open, merge, deploy, migrate production, or enable historical sending without separate authorization.

- [ ] **Step 1: Verify schema and migration formatting**

Run: `npm run prisma:generate`

Run: `npx prisma validate`

Run: `git diff --check origin/main...HEAD`

Expected: all commands PASS with no warnings attributable to changed files.

- [ ] **Step 2: Run the focused P1 safety matrix serially**

Run:

```bash
MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- \
  src/services/historicalRecoverySafetyMigrationContract.test.ts \
  src/services/historicalRecoveryDispatchInterleavingContract.test.ts \
  src/services/historicalRecoveryClaimContract.test.ts \
  src/services/publicRecoveryDispatchPostgresContract.test.ts \
  src/services/historicalRecoveryLifecycleContract.test.ts \
  src/services/historicalRecoveryTickContract.test.ts \
  src/services/campaignHealthObservationContract.test.ts \
  src/services/historicalRecoveryHealthContract.test.ts \
  --no-file-parallelism
```

Expected: all files and tests PASS.

- [ ] **Step 3: Prove the database matrix is deterministic in normal parallel mode**

Run the same focused command without `--no-file-parallelism` three times. Every run must pass; a global-sweep fixture race is a failure, not an acceptable retry.

- [ ] **Step 4: Run complete backend and web gates**

Run: `MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test`

Run: `npm run build`

Run: `npm --prefix web test`

Run: `npm --prefix web run lint`

Run: `npm --prefix web run build`

Run: `npm --prefix web run test:e2e`

Expected: every command exits `0`. Existing lint errors must be fixed on their owning P2 branch or rebased before this PR can be called fully release-ready; do not hide them with rule suppressions.

- [ ] **Step 5: Update the QA document with exact evidence**

Under QA-08, QA-10, QA-12, and QA-13, record:

- commit IDs;
- migration name;
- exact focused/full commands;
- file/test counts and exit status;
- remaining controlled-Meta or production-only gates;
- confirmation that historical recovery remained disabled and no provider call occurred.

- [ ] **Step 6: Commit the QA evidence**

```bash
git add docs/qa/2026-08-07-instagram-automation-features-1-4-deep-qa.md
git commit -m "docs: record P1 dispatch safety verification"
```

- [ ] **Step 7: Review the branch boundary**

Run: `git status --short`

Run: `git log --oneline origin/main..HEAD`

Run: `git diff --stat origin/main...HEAD`

Expected: clean worktree; only PR 1 design, migration, dispatch/campaign safety, tests, and QA evidence are present.
