# Remaining P0 Safety Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close QA-02, QA-04, and QA-05 by proving exclusive claim ownership, making one PostgreSQL ledger authoritative for every public recovery dispatch, and restricting operational work to canonical conversations.

**Architecture:** Add an append-only `PublicRecoveryDispatch` ledger and put prospective and historical authorization behind one lock-ordered reservation protocol. Add a transaction-aware canonical-conversation resolver and use its predicate in gate, DONE, completion, recovery, reconciliation, API, and web paths. Preserve raw history behind an explicit mode.

**Tech Stack:** TypeScript, Prisma, PostgreSQL 17, Express, Zod, React 19, TanStack React Query, Vitest, Testing Library, ESLint, and Vite.

## Global Constraints

- Follow red-green-refactor: add each regression first and observe it fail for the expected reason.
- Use real PostgreSQL contracts for locks, leases, partial indexes, backfill, and concurrent reservation behavior.
- Keep the lock order `dm_recovery_control(1)` -> `ig_users(person)` -> feature source -> ledger.
- Fail closed on database errors and stale claims; no failed authorization may reach Meta.
- Keep `DM_RECOVERY_HISTORICAL_ENABLED=false` and do not deploy, apply production migrations, enable a campaign, or run reconciliation with `--write`.
- Keep the ledger backend-only: enable RLS, grant no direct `anon` or `authenticated` table access, and access it through the server database role.
- Preserve `.claude/`, `probe-tmp.mjs`, and any unrelated worktree changes.

---

### Task 1: Add the dispatch-ledger migration contract

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260809010000_add_public_recovery_dispatch/migration.sql`
- Create: `src/services/publicRecoveryDispatchMigrationContract.test.ts`

**Interfaces:**

```ts
enum PublicRecoverySourceKind { prospective historical }
enum PublicRecoveryDispatchState { reserved dispatch_started sent uncertain released }
```

`PublicRecoveryDispatch` stores `reservationToken`, `igUserId`, `sourceKind`, `sourceId`, `attemptNumber`, optional `campaignId`, state timestamps, provider reply ID, and terminal reason. `DmRecoveryReminder` gains a nullable unique `claimToken` so prospective workers have the same fencing semantics as historical workers.

- [ ] Add a PostgreSQL migration contract that applies the complete migration chain to a fresh PG17 database and asserts the ledger's state checks, source-attempt uniqueness, active-person partial uniqueness, lookup indexes, RLS, and absence of `anon`/`authenticated` grants.
- [ ] Run the contract and observe RED because the table does not exist.
- [ ] Add the Prisma models/enums and generate a migration. Extend its SQL with state-shape checks, source backfill, a collision assertion before active uniqueness, indexes, and RLS.
- [ ] Add fixtures for sent, uncertain, retryable, active, released, and reconciled rows. Prove valid backfill succeeds and conflicting active people fail atomically.
- [ ] Run `npm test -- src/services/publicRecoveryDispatchMigrationContract.test.ts` with `MIGRATION_TEST_DATABASE_URL` and require GREEN.

---

### Task 2: Fence source claims and implement the shared reservation protocol

**Files:**
- Create: `src/services/publicRecoveryDispatchRepository.ts`
- Create: `src/services/publicRecoveryDispatchRepository.test.ts`
- Modify: `src/services/historicalRecoveryRepository.ts`
- Modify: `src/services/historicalRecoveryRepository.test.ts`
- Modify: `src/services/dmRecoveryRepository.ts`
- Modify: `src/services/dmRecoveryRepository.test.ts`
- Create: `src/services/publicRecoveryDispatchPostgresContract.test.ts`

**Interfaces:**

```ts
type DispatchDecision =
  | { kind: "reserved"; dispatchId: string; reservationToken: string }
  | { kind: "blocked"; reason: DispatchBlockReason };

reserveHistoricalDispatch(candidateId, claimToken, now): Promise<DispatchDecision>;
reserveProspectiveDispatch(reminderId, claimToken, now): Promise<DispatchDecision>;
startHistoricalDispatch(candidateId, claimToken, dispatchId, reservationToken, now): Promise<boolean>;
startProspectiveDispatch(reminderId, claimToken, dispatchId, reservationToken, now): Promise<boolean>;
```

- [ ] Add real-PG RED tests proving an expired historical token can currently be overwritten and two workers can both authorize one source.
- [ ] Add RED races for prospective versus historical and historical versus historical on one person; each must produce exactly one ledger reservation.
- [ ] Add RED tests for stale tokens, different-keyword person cooldown, symmetric global capacity, released-capacity reuse, and exact 24-hour/30-day boundaries.
- [ ] Change `claimCandidate` to claim only `claimToken: null`; lease reconciliation exclusively owns expired claims. Generate and fence prospective claims with `DmRecoveryReminder.claimToken`.
- [ ] Implement shared transaction helpers. Lock control, person, source, then inspect/insert the ledger. Translate unique conflicts into typed blocked decisions.
- [ ] Count `reserved`, `dispatch_started`, `sent`, and `uncertain` ledger rows for capacity. Count terminal `sent`/`uncertain` rows for cooldown; treat exact boundaries as eligible.
- [ ] Implement compare-and-set dispatch start and token-aware sent/uncertain/released finalizers. Expired reserved rows release; expired started rows become uncertain.
- [ ] Run focused unit and PG contracts and require GREEN.

---

### Task 3: Put both workers behind reserve/start/finalize fencing

**Files:**
- Modify: `src/services/historicalRecoveryWorker.ts`
- Modify: `src/services/historicalRecoveryWorker.test.ts`
- Modify: `src/services/dmRecoveryWorker.ts`
- Modify: `src/services/dmRecoveryWorker.test.ts`

- [ ] Add RED worker tests proving stale reservations, failed dispatch-start transitions, and database errors never call Meta.
- [ ] Add RED tests proving confirmed replies finalize `sent`, ambiguous network outcomes finalize `uncertain`, proven pre-create rejection releases capacity with source backoff, and pre-network suppression releases safely.
- [ ] Replace historical `reserveSendCapacity` and prospective `authorizeClaimForSend` send authority with the shared reservation result.
- [ ] Require a successful token-bearing `start*Dispatch` immediately before the Meta call.
- [ ] Finalize source and ledger atomically with candidate/reminder claim token plus reservation token.
- [ ] Run both worker suites and the concurrent PG contract and require GREEN.

---

### Task 4: Centralize canonical ownership and retire alias work

**Files:**
- Create: `src/services/canonicalConversation.ts`
- Create: `src/services/canonicalConversation.test.ts`
- Modify: `src/services/gateQueueWorker.ts`
- Modify: `src/services/gateQueueWorker.test.ts`
- Modify: `src/services/conversationService.ts`
- Modify: `src/services/conversationService.test.ts`
- Modify: `src/services/dmRecoveryRepository.ts`
- Modify: `src/services/dmRecoveryRepository.test.ts`
- Modify: `src/services/journeyReconciliationRepository.ts`
- Modify: `src/services/journeyReconciliationRepository.test.ts`

**Interfaces:**

```ts
type ConversationRole = "unreconciled" | "canonical" | "alias";
resolveCanonicalConversation(tx, conversationId): Promise<CanonicalResolution | null>;
operationalConversationWhere(): Prisma.ConversationWhereInput;
```

- [ ] Add RED tests for an open alias gate, alias DONE lookup, completion invoked through an alias, alias recovery authorization, and reconciliation with safe versus active alias work.
- [ ] Implement the one resolver and derived operational predicate. Unreconciled and canonical conversations are operational; aliases never are.
- [ ] Make the gate worker abandon open aliases as `reconciled_alias` before Meta.
- [ ] Restrict DONE lookups to operational conversations. Make alias completion atomically preserve alias history, complete the canonical owner and intent using the earliest timestamp, and retire pending sibling gate/recovery work.
- [ ] Suppress prospective alias recovery at final authorization. Validate historical conversation snapshots against the canonical intent.
- [ ] During reconciliation, abandon pending alias gates, suppress non-dispatching recovery, supersede non-sending follow-up drafts, and skip the whole window as `skipped_active_work` if alias network work is active.
- [ ] Run focused canonical, gate, conversation, recovery, and reconciliation tests and require GREEN.

---

### Task 5: Expose canonical and raw conversation modes

**Files:**
- Modify: `src/api/conversations.routes.ts`
- Modify: `src/api/conversations.routes.test.ts`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/pages/Conversations.tsx`
- Modify: `web/src/pages/Conversations.test.tsx`

- [ ] Add route RED tests proving list/count default to operational owners and `mode=raw` includes aliases with `historyRole`, `canonicalConversationId`, and `aliasCount`.
- [ ] Add web RED tests proving Canonical and Raw history use independent query keys, URLs, counts, and visible alias labels.
- [ ] Apply `operationalConversationWhere()` to default list/count queries and enrich raw rows without changing pagination ordering.
- [ ] Add the explicit Canonical/Raw history control and mode-aware query keys in the web view.
- [ ] Run backend route and frontend page tests and require GREEN.

---

### Task 6: Verify all P0 contracts and update the QA record

**Files:**
- Modify: `docs/qa/2026-08-07-instagram-automation-features-1-4-deep-qa.md`

- [ ] Apply every migration to a fresh PG17 database and apply the new migration to the production-shaped fixture.
- [ ] Run backend tests with `MIGRATION_TEST_DATABASE_URL` set so contract suites cannot skip.
- [ ] Run `npm run build`, web tests, web build, and lint for every touched file.
- [ ] Re-run the original QA-02 and QA-04 concurrent probes and require one authorization; run the QA-05 canonical-flow contract.
- [ ] Review the diff for secret leakage, raw SQL interpolation, lock-order reversal, non-token finalizers, copied canonical predicates, and unrelated changes.
- [ ] Update the QA document with exact commands/results and mark an item closed only when its original acceptance criteria pass.
- [ ] Do not deploy. Hand off the implementation branch and verification evidence for separate production authorization.
