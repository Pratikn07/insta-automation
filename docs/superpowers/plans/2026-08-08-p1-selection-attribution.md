# P1 Deterministic Selection and Attribution Implementation Plan

> **Branch:** `fix/p1-selection-attribution`, stacked on `fix/p1-dispatch-safety`
>
> **Safety boundary:** keep historical sending disabled; use only the disposable local
> PostgreSQL database; do not run a production selector write, approve a real campaign,
> call Meta, push, merge, deploy, or migrate production.

**Goal:** Close QA-07, QA-11, the attribution half of QA-12, and QA-14 with one atomic,
owner-verifiable selection snapshot, same-intent evidence, deterministic approved-source
fallback, and earliest 24/48-hour attribution.

**Architecture:** Compute a normalized manifest entirely in memory, including arms,
ordered source choices, exclusions, counts, fingerprint, and decision hash. Persist that
manifest in one Serializable PostgreSQL transaction and recompute it from stored rows
under the campaign lock at approval. Keep approved source candidates immutable and pass
the selected approved comment through the final dispatch authorization. Attribute live
events with a bounded SQL update using `LEAST`, anchored at treatment dispatch start or
holdout approval.

**Stack:** TypeScript, Prisma 5, PostgreSQL, Vitest, Express.

---

## Task 1: Add the additive snapshot/source/window schema

**Files:**

- Create: `prisma/migrations/20260809040000_p1_selection_attribution/migration.sql`
- Modify: `prisma/schema.prisma`
- Create: `src/services/historicalRecoverySelectionMigrationContract.test.ts`

**Steps:**

1. Write a failing migration contract for the new nullable/backward-compatible campaign
   fingerprint and policy-version fields, explicit inbound/completion window hours, the
   candidate source-choice snapshot, and the unique normalized selection identity.
2. Add the migration with contradiction-safe checks and indexes. Existing campaigns
   remain readable but are deliberately unapprovable until their complete new manifest
   is present.
3. Update the Prisma models and validate the full migration chain on the disposable DB.
4. Prove the currently deployed pre-PR2 read shapes still work against the additive
   schema.

## Task 2: Build and atomically persist the complete reviewed manifest

**Files:**

- Modify: `src/services/historicalRecoverySelector.ts`
- Modify: `src/services/historicalRecoveryEligibility.ts`
- Modify: `src/services/historicalRecoveryEligibility.test.ts`
- Modify: `src/services/historicalRecoverySelectorContract.test.ts`
- Create: `src/services/historicalRecoverySnapshot.ts`
- Create: `src/services/historicalRecoverySnapshot.test.ts`
- Create: `src/services/historicalRecoverySnapshotContract.test.ts`

**Steps:**

1. Write failing pure tests showing that the normalized fingerprint covers phase,
   cutoff, comment bounds, audience policy, holdout percentage, copy/selection/policy
   versions, and measurement windows; and that the decision hash also covers ordered
   inclusions, exclusions, arms, approved sources, and reason codes.
2. Write failing real-PostgreSQL contracts showing an unusable arm split writes nothing,
   failures at campaign/exclusion/candidate write stages roll back everything, and a
   duplicate normalized identity is rejected.
3. Move arm assignment and validation before the first write. Make selection produce a
   complete immutable manifest, then persist campaign, exclusions, candidates, approved
   source evidence, counts, fingerprint, and hash in one Serializable transaction.
4. Remove the current skip-on-missing-FK behavior: a changed/deleted source row makes
   the snapshot transaction fail closed instead of silently changing the manifest.
5. Re-run focused snapshot and selector contracts.

## Task 3: Make approval verify the stored snapshot, not merely its counts

**Files:**

- Modify: `src/services/recoveryCampaignControl.ts`
- Modify: `src/services/recoveryCampaignControl.test.ts`
- Modify: `src/services/historicalRecoveryLifecycleContract.test.ts`
- Modify: `src/api/historicalRecovery.routes.ts`

**Steps:**

1. Write failing tests for missing fingerprint/hash, candidate/exclusion count drift,
   changed arm/source/reason/config, and approval racing an attempted manifest mutation.
2. Under the existing control/person/candidate/campaign lock order, load the complete
   stored manifest, recompute its normalized fingerprint and decision hash, and require
   exact equality before settling holdouts or changing campaign state.
3. Return typed `snapshot_incomplete`, `snapshot_fingerprint_mismatch`, or
   `snapshot_hash_mismatch` reasons without changing any row.
4. Expose safe fingerprint/hash/version/window identifiers in the admin campaign read
   model so the reviewed artifact is auditable.

## Task 4: Scope engagement evidence and implement approved-source fallback

**Files:**

- Modify: `src/services/historicalRecoverySelector.ts`
- Modify: `src/services/historicalRecoverySelectorContract.test.ts`
- Modify: `src/services/historicalRecoveryRepository.ts`
- Modify: `src/services/historicalRecoveryWorker.ts`
- Modify: `src/services/historicalRecoveryWorker.test.ts`
- Create: `src/services/historicalRecoverySourceChoice.ts`
- Create: `src/services/historicalRecoverySourceChoice.test.ts`
- Create: `src/services/historicalRecoverySourceFallbackContract.test.ts`

**Steps:**

1. Write a failing selector contract proving a read/reaction on another keyword does not
   suppress this intent, while same-person/same-keyword evidence does.
2. Load every eligible comment trigger in deterministic newest-first order and freeze
   that ordered set plus the primary-choice reason into the manifest/hash.
3. Write failing source-choice tests: definitive missing/hidden advances only within the
   approved ordered set; auth/rate/timeout/unknown defers and never falls back; exhausting
   the set returns `source_set_exhausted`.
4. Pass the resolved approved comment ID through `startHistoricalDispatch`; under the
   candidate lock validate that it belongs to the immutable approved set and stamp the
   exact dispatch source before returning `started`.
5. Make the worker send only that authorized comment ID. Add a real-PostgreSQL contract
   for newest-deleted/older-present and unit contracts for every non-definitive state.

## Task 5: Implement earliest, bounded 24/48-hour attribution

**Files:**

- Modify: `src/services/historicalRecoveryAttribution.ts`
- Modify: `src/services/historicalRecoveryLifecycleContract.test.ts`
- Create: `src/services/historicalRecoveryAttributionContract.test.ts`
- Modify: `src/api/historicalRecovery.routes.ts`
- Modify: relevant API tests under `src/api/`

**Steps:**

1. Write failing real-PostgreSQL tests for later-first/earlier-second delivery,
   concurrent delivery, replay, exact 24-hour and 48-hour boundaries, an event one
   millisecond beyond the configured window, treatment versus holdout anchors, and the
   same person in successive campaigns.
2. Replace null-only Prisma updates with two static parameterized SQL statements (one
   per timestamp column) that join campaign configuration, enforce the correct anchor
   and upper bound, and assign `LEAST(existing, incoming)` atomically.
3. Preserve keyword scoping for completion and person-level truth for inbound without
   allowing an event outside a campaign's own window to mutate that candidate.
4. Report safe 24-hour and 48-hour outcome buckets in the campaign/candidate API; make
   the recovered view use bounded qualifying attribution only.
5. Re-run attribution, lifecycle, and API contracts.

## Task 6: Review and verification

**Files:**

- Modify: `docs/qa/2026-08-07-instagram-automation-features-1-4-deep-qa.md`

**Steps:**

1. Run schema validation, migration status, migration contracts, selector/snapshot/
   source/attribution focused suites, and repeat the race-sensitive PostgreSQL matrix.
2. Run the complete backend suite and build, web unit tests/build, Playwright, and lint;
   record the unchanged unrelated lint baseline separately if it remains.
3. Request an independent code review for Critical/Important correctness, resolve every
   finding test-first, and re-run the affected matrix.
4. Update the QA report with exact commits and command counts. Keep rollout gates and
   historical feature flags explicitly pending/false.
5. Commit a clean local branch. Do not push, open a remote PR, merge, deploy, or enable
   production without separate authorization.
