# Expanded Historical-Recovery Audience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow every valid non-South-Asian historical-recovery audience segment, including no-name users, while blocking South Asian users at both confidence levels and enforcing one shared 10-per-rolling-hour cap across the four expanded campaigns.

**Architecture:** Introduce one versioned audience-segment domain shared by Gemini normalization, selection, immutable candidate snapshots, and final dispatch authorization. Add explicit campaign rollout-group metadata so the shared dispatch ledger can reserve aggregate capacity under its existing lock, then propagate safety signals and owner pauses across only that group. Keep legacy campaigns readable while requiring the new method and segment for new expanded campaigns.

**Tech Stack:** Node.js 22, TypeScript 5.7, Prisma 5.22, PostgreSQL, Express, Zod, Vitest, React 19, TanStack Query, Vite.

## Global Constraints

- Only `south_asian` blocks for audience origin; both `high` and `low` confidence block.
- Allowed segments are `western`, `other`, `unknown_cue`, `unknown_generic`, and `unknown_no_name`.
- Both normalized identity fields empty deterministically produce `unknown_no_name`; Gemini is not called.
- Missing, stale, malformed, or incomplete classification defers and never default-allows.
- Gemini free-text evidence is audit-only and never controls authorization.
- Create separate campaigns for `other`, `unknown_cue`, `unknown_generic`, and `unknown_no_name`; do not duplicate the already-supported Western population.
- The four expanded campaigns share at most 10 dispatch starts in any rolling hour and use daily cap `1000`.
- No observation pause, 20-person stage, or manual review queue is added.
- Existing inbound, completion, prior-contact, keyword, source, alias, cooldown, duplicate, circuit, and health checks remain in force.
- Existing completed campaign and control rows remain immutable.
- Preserve unrelated user changes already present in the main checkout.

---

### Task 1: Versioned Audience-Segment Domain and Gemini Boundary

**Files:**
- Create: `src/services/historicalAudienceSegment.ts`
- Create: `src/services/historicalAudienceSegment.test.ts`
- Modify: `src/services/historicalRecoveryOriginPolicy.ts`
- Modify: `src/services/historicalRecoveryOriginPolicy.test.ts`
- Modify: `src/services/originClassifier.ts`
- Modify: `src/services/originClassifier.test.ts`

**Interfaces:**
- Produces: `AudienceSegment`, `AUDIENCE_SEGMENTS`, `CURRENT_ORIGIN_METHOD = "llm_v3"`, `deriveAudienceSegment()`, `evaluateHistoricalAudience()`.
- `deriveAudienceSegment(input)` returns an allowed segment only for a structurally consistent response; otherwise `null`.
- `evaluateHistoricalAudience(input)` returns `allow`, `block: audience_south_asian`, or `defer` with `origin_not_current_gemini` / `audience_segment_invalid`.

- [ ] **Step 1: Write failing segment-policy tests**

Add table-driven tests covering this exact matrix:

```ts
it.each([
  ["us_western", "positive_cue", "distinctive_cultural", "western"],
  ["other", "positive_cue", "distinctive_cultural", "other"],
  ["unknown", "positive_cue", "ambiguous_cultural", "unknown_cue"],
  ["unknown", "no_meaningful_cue", "generic_or_no_cue", "unknown_generic"],
  ["south_asian", "positive_cue", "distinctive_cultural", "south_asian"],
] as const)("derives %s/%s/%s as %s", (origin, cueAssessment, cueKind, expected) => {
  expect(deriveAudienceSegment({ origin, cueAssessment, cueKind })).toBe(expected);
});

it.each(["high", "low"] as const)("blocks %s-confidence South Asian", (confidence) => {
  expect(evaluateHistoricalAudience({
    segment: "south_asian",
    origin: "south_asian",
    confidence,
    method: CURRENT_ORIGIN_METHOD,
  })).toEqual({ kind: "block", reason: "audience_south_asian" });
});
```

Also assert contradictory field combinations return `null`, all five allowed segments authorize, an invalid confidence defers, and `llm_v2` is stale.

- [ ] **Step 2: Run the focused tests and confirm red**

Run: `npx vitest run src/services/historicalAudienceSegment.test.ts src/services/historicalRecoveryOriginPolicy.test.ts src/services/originClassifier.test.ts`

Expected: failure because the new module, segment field, and `llm_v3` method do not exist.

- [ ] **Step 3: Implement the pure domain**

Use these public shapes:

```ts
export const AUDIENCE_SEGMENTS = [
  "western", "other", "unknown_cue", "unknown_generic", "unknown_no_name", "south_asian",
] as const;
export type AudienceSegment = (typeof AUDIENCE_SEGMENTS)[number];
export const CURRENT_ORIGIN_METHOD = "llm_v3";
export type GeminiCueKind = "distinctive_cultural" | "ambiguous_cultural" | "generic_or_no_cue";
```

`deriveAudienceSegment()` must use only enums, never `evidence`. `unknown_no_name` is not a Gemini-derived result. `evaluateHistoricalAudience()` must validate the segment/origin pairing before allowing.

- [ ] **Step 4: Update Gemini's schema and prompt**

Require `cueKind` in each response row and add it to `OriginVerdict` together with `audienceSegment`. Drop malformed or contradictory rows in `toVerdict()` so the enrichment worker retries them. Preserve evidence only for audit.

- [ ] **Step 5: Run focused tests and confirm green**

Run: `npx vitest run src/services/historicalAudienceSegment.test.ts src/services/historicalRecoveryOriginPolicy.test.ts src/services/originClassifier.test.ts`

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/historicalAudienceSegment.ts src/services/historicalAudienceSegment.test.ts src/services/historicalRecoveryOriginPolicy.ts src/services/historicalRecoveryOriginPolicy.test.ts src/services/originClassifier.ts src/services/originClassifier.test.ts
git commit -m "feat: define historical audience segments"
```

### Task 2: Persist Current and Frozen Audience Segments

**Files:**
- Create: `prisma/migrations/20260811210000_expanded_recovery_audience_segments/migration.sql`
- Modify: `prisma/schema.prisma`
- Create: `src/services/historicalAudienceSegmentMigrationContract.test.ts`
- Modify: `src/services/originEnrichmentWorker.ts`
- Modify: `src/services/originEnrichmentWorker.test.ts`
- Modify: `src/services/igUserService.ts`
- Modify: `src/services/igUserService.test.ts`

**Interfaces:**
- Produces nullable `IgUser.audienceSegment`, `RecoveryCandidate.audienceSegment`, and campaign fields `audienceSegment`, `rolloutGroupId`, `rolloutGroupHourlyCap`.
- Produces `classifyIdentityPresence({ username, name }): "unknown_no_name" | null` for deterministic no-name handling.

- [ ] **Step 1: Write failing migration and enrichment tests**

Assert the database exposes enum `historical_audience_segment`; the three segment columns; `rollout_group_id UUID`; `rollout_group_hourly_cap INTEGER`; and a check requiring group ID and cap together with cap `1..1000`. Assert the sealed-manifest triggers reject post-approval changes to candidate segment and campaign segment/group metadata.

In the worker tests, assert no-name users are written as:

```ts
{
  inferredOrigin: "unknown",
  originConfidence: "low",
  originMethod: CURRENT_ORIGIN_METHOD,
  originEvidence: "no name or username to classify",
  audienceSegment: "unknown_no_name",
  originCheckedAt: expect.any(Date),
}
```

and `classifyOrigins` is not called for them.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npx vitest run src/services/historicalAudienceSegmentMigrationContract.test.ts src/services/originEnrichmentWorker.test.ts src/services/igUserService.test.ts`

Expected: failures for absent fields and segment writes.

- [ ] **Step 3: Add schema and migration**

Add a PostgreSQL enum for all six values. Keep columns nullable for legacy rows. Add indexes on `ig_users(audience_segment, origin_method)` and `recovery_campaign(rollout_group_id, state)`. Replace the explicit sealed-manifest trigger column lists so candidate `audience_segment` and campaign `audience_segment`, `rollout_group_id`, and `rollout_group_hourly_cap` are immutable after approval.

- [ ] **Step 4: Persist segments with identity-fenced compare-and-set**

Extend `compareAndSetOrigin()` data to include `audienceSegment`. No-name users receive the deterministic segment. Gemini rows receive `v.audienceSegment`. Profile identity changes must clear `audienceSegment` together with the existing origin fields in `igUserService`.

- [ ] **Step 5: Generate Prisma and run focused tests**

Run: `npx prisma generate && npx vitest run src/services/historicalAudienceSegmentMigrationContract.test.ts src/services/originEnrichmentWorker.test.ts src/services/igUserService.test.ts`

Expected: all focused tests pass; database contract runs when `MIGRATION_TEST_DATABASE_URL` is available.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260811210000_expanded_recovery_audience_segments src/services/historicalAudienceSegmentMigrationContract.test.ts src/services/originEnrichmentWorker.ts src/services/originEnrichmentWorker.test.ts src/services/igUserService.ts src/services/igUserService.test.ts
git commit -m "feat: persist recovery audience segments"
```

### Task 3: Segment-Specific Immutable Selection

**Files:**
- Modify: `src/services/historicalRecoveryEligibility.ts`
- Modify: `src/services/historicalRecoveryEligibility.test.ts`
- Modify: `src/services/historicalRecoverySelector.ts`
- Modify: `src/services/historicalRecoverySelectorContract.test.ts`
- Modify: `src/services/historicalRecoverySnapshot.ts`
- Modify: `src/services/historicalRecoverySnapshot.test.ts`
- Modify: `src/services/recoveryCampaignControl.ts`
- Modify: `src/services/recoveryCampaignControl.test.ts`
- Modify: `scripts/select-historical-recovery.ts`

**Interfaces:**
- `selectHistoricalCandidates()` consumes `audienceSegment?: AudienceSegment`, `rolloutGroupId?: string`, and `rolloutGroupHourlyCap?: number`.
- New expanded campaigns require all three fields; legacy/general selections omit all three.
- Snapshot inclusions carry `audienceSegment`; expanded snapshot configuration carries exact segment/group metadata.

- [ ] **Step 1: Write failing eligibility and snapshot tests**

Assert `decideEligibility()` allows each current valid non-South-Asian segment, excludes `south_asian` at both confidences, and excludes stale/invalid classification with explicit reasons. Assert an exact campaign segment rejects users from another allowed segment. Assert changing only candidate segment or rollout group changes the decision hash.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npx vitest run src/services/historicalRecoveryEligibility.test.ts src/services/historicalRecoverySnapshot.test.ts src/services/historicalRecoverySelectorContract.test.ts src/services/recoveryCampaignControl.test.ts`

Expected: failures for absent segment-aware selection and snapshot fields.

- [ ] **Step 3: Extend selection facts and SQL**

Read `u.audience_segment AS "audienceSegment"`. Evaluate the current method, origin, confidence, and segment. If `input.audienceSegment` is set, include only exact matches and record `audience_segment_mismatch` for other otherwise-eligible segments.

- [ ] **Step 4: Preserve legacy snapshot verification**

Do not add null keys to hashes of already-created campaigns. Build the expanded configuration fields only when `eligibilityPolicyVersion === "eligibility-v4-expanded-audience"`; reconstruct the same shape in `recoveryCampaignControl.ts`. New expanded approvals must fail when any segment/group field is missing.

- [ ] **Step 5: Freeze segment and metadata**

Persist candidate `audienceSegment` and campaign `audienceSegment`, `rolloutGroupId`, `rolloutGroupHourlyCap`. Include segment in candidate reconstruction, decision hashes, and approval checks.

- [ ] **Step 6: Run focused tests and confirm green**

Run: `npx vitest run src/services/historicalRecoveryEligibility.test.ts src/services/historicalRecoverySnapshot.test.ts src/services/historicalRecoverySelectorContract.test.ts src/services/recoveryCampaignControl.test.ts`

Expected: all focused tests pass, including a legacy snapshot fixture.

- [ ] **Step 7: Commit**

```bash
git add src/services/historicalRecoveryEligibility.ts src/services/historicalRecoveryEligibility.test.ts src/services/historicalRecoverySelector.ts src/services/historicalRecoverySelectorContract.test.ts src/services/historicalRecoverySnapshot.ts src/services/historicalRecoverySnapshot.test.ts src/services/recoveryCampaignControl.ts src/services/recoveryCampaignControl.test.ts scripts/select-historical-recovery.ts
git commit -m "feat: select immutable audience cohorts"
```

### Task 4: Atomic Four-Campaign Draft Creation

**Files:**
- Create: `src/services/expandedRecoveryCampaignSelector.ts`
- Create: `src/services/expandedRecoveryCampaignSelector.test.ts`
- Create: `scripts/select-expanded-historical-recovery.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `selectExpandedRecoveryCampaigns(input): Promise<{ rolloutGroupId: string; campaigns: Array<{ segment; campaignId; candidateCount }>; excludedPeople: number }>`.
- Script creates drafts only; it never approves or sends.

- [ ] **Step 1: Write failing orchestration tests**

Mock `selectHistoricalCandidates()` and assert one shared cutoff and rollout-group UUID are passed to exactly four calls in this order: `other`, `unknown_cue`, `unknown_generic`, `unknown_no_name`. Assert `holdoutPercent: 0`, `rolloutGroupHourlyCap: 10`, `eligibilityPolicyVersion: "eligibility-v4-expanded-audience"`, and that duplicate selected `igUserId` values abort the transaction/result before approval.

- [ ] **Step 2: Run the test and confirm red**

Run: `npx vitest run src/services/expandedRecoveryCampaignSelector.test.ts`

Expected: failure because the orchestration service is absent.

- [ ] **Step 3: Implement draft orchestration**

Use one generated `rolloutGroupId` and one `now` cutoff. Run segment selections inside one service-level transaction boundary or refactor selector persistence so all four drafts commit together. Return empty segments explicitly rather than creating zero-candidate campaigns. Query persisted candidates by rollout group and hard-fail if a person occurs more than once.

- [ ] **Step 4: Add the operator script**

Add package script `recovery:select-expanded` invoking `tsx scripts/select-expanded-historical-recovery.ts`. Print rollout group, campaign IDs, decision hashes, segment counts, exclusion counts, and the invariant `one person across rollout: OK`. Do not include approval logic.

- [ ] **Step 5: Run focused tests and confirm green**

Run: `npx vitest run src/services/expandedRecoveryCampaignSelector.test.ts`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/expandedRecoveryCampaignSelector.ts src/services/expandedRecoveryCampaignSelector.test.ts scripts/select-expanded-historical-recovery.ts package.json
git commit -m "feat: draft expanded recovery campaigns"
```

### Task 5: Shared Rollout-Group Capacity Reservation

**Files:**
- Modify: `src/services/publicRecoveryDispatchRepository.ts`
- Modify: `src/services/publicRecoveryDispatchPostgresContract.test.ts`
- Modify: `src/services/historicalRecoveryRepository.ts`
- Modify: `src/services/historicalRecoveryClaimContract.test.ts`
- Modify: `src/services/historicalRecoveryWorker.ts`
- Modify: `src/services/historicalRecoveryWorker.test.ts`

**Interfaces:**
- Adds block reason `rollout_group_hourly_cap_reached`.
- `ReserveDispatchInput` accepts optional `rolloutGroupId` and `rolloutGroupHourlyCap`, supplied from locked campaign metadata rather than worker arguments.

- [ ] **Step 1: Write failing PostgreSQL concurrency tests**

Create two campaigns with the same rollout group and cap `10`. Seed nine capacity-state ledger rows across them. Race two reservations and assert exactly one reserves and the other returns `rollout_group_hourly_cap_reached`. Add cases proving `reserved`, `dispatch_started`, `sent`, and `uncertain` count; `released` does not; an unrelated rollout group does not count; and the broader global cap still wins when exhausted.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npx vitest run src/services/publicRecoveryDispatchPostgresContract.test.ts src/services/historicalRecoveryClaimContract.test.ts src/services/historicalRecoveryWorker.test.ts`

Expected: aggregate-cap assertions fail.

- [ ] **Step 3: Enforce the group cap under the existing control lock**

Inside `reservePublicRecoveryDispatch()`, count capacity states whose related campaign has the same `rolloutGroupId` and whose `reservedAt` is within the rolling hour. Check this after global limits and before campaign limits. Reject partial group metadata.

- [ ] **Step 4: Source metadata from the locked campaign**

Extend `reserveHistoricalDispatch()`'s source include to read campaign rollout fields and pass them to the shared ledger helper. The worker must handle `rollout_group_hourly_cap_reached` as a defer/stop-for-this-tick condition without suppressing the candidate.

- [ ] **Step 5: Run focused tests and confirm green**

Run: `npx vitest run src/services/publicRecoveryDispatchPostgresContract.test.ts src/services/historicalRecoveryClaimContract.test.ts src/services/historicalRecoveryWorker.test.ts`

Expected: all focused tests pass and the race never exceeds 10.

- [ ] **Step 6: Commit**

```bash
git add src/services/publicRecoveryDispatchRepository.ts src/services/publicRecoveryDispatchPostgresContract.test.ts src/services/historicalRecoveryRepository.ts src/services/historicalRecoveryClaimContract.test.ts src/services/historicalRecoveryWorker.ts src/services/historicalRecoveryWorker.test.ts
git commit -m "feat: cap expanded recovery rollout"
```

### Task 6: Live and Final Locked Segment Authorization

**Files:**
- Modify: `src/services/historicalRecoveryRecheck.ts`
- Modify: `src/services/historicalRecoveryRecheck.test.ts`
- Modify: `src/services/historicalRecoveryRepository.ts`
- Modify: `src/services/historicalRecoveryDispatchInterleavingContract.test.ts`
- Modify: `src/services/historicalRecoveryWorker.ts`
- Modify: `src/services/historicalRecoveryWorker.test.ts`

**Interfaces:**
- Advisory and locked checks consume frozen campaign/candidate segment plus live `audienceSegment`, `origin`, `confidence`, and `method`.
- South Asian is terminally suppressed; stale/invalid or allowed-segment drift is deferred; every valid allowed segment may send only in its matching campaign.

- [ ] **Step 1: Write failing policy and race tests**

Add table tests for all five allowed live segments and both South Asian confidences. Add an interleaving contract where the user changes from `other` to `south_asian` after advisory recheck but before dispatch start; assert no provider boundary is authorized and the reservation is released with audience suppression. Add stale/malformed drift cases and an `other` to `unknown_cue` campaign-segment mismatch that defer with `audience_segment_changed`.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npx vitest run src/services/historicalRecoveryRecheck.test.ts src/services/historicalRecoveryDispatchInterleavingContract.test.ts src/services/historicalRecoveryWorker.test.ts`

Expected: current code still suppresses `other`/`unknown` and does not read segment.

- [ ] **Step 3: Extend advisory facts and policy**

Select current `audienceSegment` in `gatherPreDispatchFacts()`. Replace origin-only authorization with `evaluateHistoricalAudience()`. Keep all non-audience checks in their current order.

- [ ] **Step 4: Repeat authorization under locks**

Inside `startHistoricalDispatch()`, select current segment under the existing control/person/candidate/campaign/keyword locks. Compare it with a structurally valid current method result and the campaign's frozen segment. Suppress South Asian, defer stale/invalid/mismatched allowed segments, and allow a non-South-Asian segment only when it still matches the campaign.

- [ ] **Step 5: Run focused tests and confirm green**

Run: `npx vitest run src/services/historicalRecoveryRecheck.test.ts src/services/historicalRecoveryDispatchInterleavingContract.test.ts src/services/historicalRecoveryWorker.test.ts`

Expected: all focused tests pass and no disallowed drift calls Meta.

- [ ] **Step 6: Commit**

```bash
git add src/services/historicalRecoveryRecheck.ts src/services/historicalRecoveryRecheck.test.ts src/services/historicalRecoveryRepository.ts src/services/historicalRecoveryDispatchInterleavingContract.test.ts src/services/historicalRecoveryWorker.ts src/services/historicalRecoveryWorker.test.ts
git commit -m "feat: authorize recovery by live segment"
```

### Task 7: Rollout-Group Health Stop and Owner Emergency Pause

**Files:**
- Modify: `src/services/campaignHealthObservation.ts`
- Modify: `src/services/campaignHealthObservationContract.test.ts`
- Modify: `src/services/recoveryCampaignControl.ts`
- Modify: `src/services/recoveryCampaignControl.test.ts`
- Modify: `src/api/historicalRecovery.routes.ts`
- Modify: `src/api/historicalRecovery.routes.test.ts`

**Interfaces:**
- Produces `pauseCampaignGroup(rolloutGroupId, reason, now): Promise<GroupPauseResult>`.
- Adds `POST /historical-recovery/rollout-groups/:id/pause` with `{ reason: string }`.
- A complaint, opt-out, block, negative reply, or classifier anomaly pauses all running campaigns in the same non-null group.

- [ ] **Step 1: Write failing group-pause tests**

Assert `pauseCampaignGroup()` locks group campaigns in ID order, pauses only running members, reports terminal members, rejects blank reasons, and leaves unrelated campaigns unchanged. In the health contract, record one observation against a grouped campaign and assert all running siblings receive `auto:<kind>`.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npx vitest run src/services/recoveryCampaignControl.test.ts src/services/campaignHealthObservationContract.test.ts src/api/historicalRecovery.routes.test.ts`

Expected: group pause behavior and endpoint are absent.

- [ ] **Step 3: Implement transactional group pause**

Lock the `dm_recovery_control` row, then matching campaign rows ordered by ID. Update only `state = running`. Emit one audit event containing rollout group, reason, paused campaign IDs, and skipped states. Do not include unrelated campaigns.

- [ ] **Step 4: Propagate direct safety signals**

In `recordCampaignHealthObservation()`, read the target campaign's `rolloutGroupId` under lock. For direct safety kinds, pause the whole group when non-null; preserve single-campaign behavior for legacy campaigns. Rate-based health evaluation remains campaign-specific.

- [ ] **Step 5: Add and validate the owner endpoint**

Use UUID path validation and a `1..200` character reason. Return `{ rolloutGroupId, pausedCampaignIds, skipped }`. Require existing admin authentication inherited from the router.

- [ ] **Step 6: Run focused tests and confirm green**

Run: `npx vitest run src/services/recoveryCampaignControl.test.ts src/services/campaignHealthObservationContract.test.ts src/api/historicalRecovery.routes.test.ts`

Expected: all focused tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/campaignHealthObservation.ts src/services/campaignHealthObservationContract.test.ts src/services/recoveryCampaignControl.ts src/services/recoveryCampaignControl.test.ts src/api/historicalRecovery.routes.ts src/api/historicalRecovery.routes.test.ts
git commit -m "feat: stop expanded recovery as a group"
```

### Task 8: Segment and Aggregate Reporting in Admin UI

**Files:**
- Modify: `src/api/historicalRecovery.routes.ts`
- Modify: `src/api/historicalRecovery.routes.test.ts`
- Modify: `web/src/components/historical/historicalRecoveryViewModel.ts`
- Modify: `web/src/components/historical/historicalRecoveryViewModel.test.ts`
- Modify: `web/src/components/historical/HistoricalCandidateDrawer.tsx`
- Modify: `web/src/pages/HistoricalRecovery.tsx`
- Modify: `web/src/pages/HistoricalRecovery.test.tsx`

**Interfaces:**
- Campaign rows expose `audienceSegment`, `rolloutGroupId`, `rolloutGroupHourlyCap`, and `rolloutGroupSentLastHour`.
- Candidate list/detail exposes frozen `audienceSegment` and live `currentAudienceSegment`.

- [ ] **Step 1: Write failing API and UI tests**

Assert campaign JSON reports the group rolling-hour count from capacity states; candidate rows include frozen and current segments; the drawer renders both; no-name renders `Unknown — no username/display name`; and a grouped running campaign exposes `Pause all expanded campaigns`.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npx vitest run src/api/historicalRecovery.routes.test.ts && npm --prefix web test -- --run src/components/historical/historicalRecoveryViewModel.test.ts src/pages/HistoricalRecovery.test.tsx`

Expected: missing response fields and controls.

- [ ] **Step 3: Extend API read models**

Read candidate frozen segment plus current user segment. Group campaign progress by rollout group and count `reserved`, `dispatch_started`, `sent`, and `uncertain` rows with `reservedAt > now - 1 hour`. Return zero for ungrouped campaigns.

- [ ] **Step 4: Extend view models and drawer**

Add typed fields and a pure `audienceSegmentLabel()` mapping for every enum. Show frozen/current values separately when they drift.

- [ ] **Step 5: Add emergency group-pause control**

Show the control only when `rolloutGroupId` exists and at least one group campaign is running. Reuse the confirmation dialog and call the group pause endpoint with `Stopped from the dashboard`.

- [ ] **Step 6: Run focused tests and confirm green**

Run: `npx vitest run src/api/historicalRecovery.routes.test.ts && npm --prefix web test -- --run src/components/historical/historicalRecoveryViewModel.test.ts src/pages/HistoricalRecovery.test.tsx`

Expected: all focused tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/api/historicalRecovery.routes.ts src/api/historicalRecovery.routes.test.ts web/src/components/historical/historicalRecoveryViewModel.ts web/src/components/historical/historicalRecoveryViewModel.test.ts web/src/components/historical/HistoricalCandidateDrawer.tsx web/src/pages/HistoricalRecovery.tsx web/src/pages/HistoricalRecovery.test.tsx
git commit -m "feat: report expanded recovery cohorts"
```

### Task 9: Full Regression Verification and Operations Runbook

**Files:**
- Create: `docs/qa/2026-08-11-expanded-historical-recovery-audience-qa.md`
- Modify: `docs/meta-verification.md`

**Interfaces:**
- Produces an exact deploy/reclassify/select/audit/approve/start/verify sequence with rollback and emergency-pause commands.

- [ ] **Step 1: Write the runbook**

Document exact queries for counts by method/segment/confidence, zero stale targeted users, zero cross-campaign duplicates, South Asian exclusion counts, group cap `10`, daily cap `1000`, first-comment Meta readback, health signals, and group emergency pause. State that expanded sending remains disabled until the audit passes.

- [ ] **Step 2: Run backend verification**

Run: `npm test`

Expected: all backend test files pass with zero failures.

- [ ] **Step 3: Run backend build and schema verification**

Run: `npm run build && npx prisma validate`

Expected: TypeScript build and Prisma validation exit 0.

- [ ] **Step 4: Run web verification**

Run: `npm --prefix web test && npm --prefix web run lint && npm --prefix web run build`

Expected: all web tests pass; lint and build exit 0.

- [ ] **Step 5: Inspect the complete diff**

Run: `git diff $(git merge-base HEAD main)..HEAD --check && git status --short && git log --oneline --decorate main..HEAD`

Expected: no whitespace errors; only intended feature files are changed; task commits are present.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/qa/2026-08-11-expanded-historical-recovery-audience-qa.md docs/meta-verification.md
git commit -m "docs: add expanded recovery rollout runbook"
```

### Task 10: Merge, Deploy, Reclassify, and Start the Expanded Rollout

**Files:**
- Operational task; no source files should change.

**Interfaces:**
- Consumes the verified feature branch and operator scripts.
- Produces four approved production campaigns sharing one rollout group and aggregate cap `10`.

- [ ] **Step 1: Review and integrate**

Use `superpowers:requesting-code-review`, address all P0/P1 findings, rerun Task 9 verification, then use `superpowers:finishing-a-development-branch` to fast-forward `main` and push only after fresh green evidence.

- [ ] **Step 2: Deploy inert code and migration**

Deploy API and web with expanded campaigns absent. Verify Railway deployment success, migration status, API health, and Vercel production readiness before any campaign creation.

- [ ] **Step 3: Reclassify to `llm_v3`**

Run paced origin enrichment until the targeted historical pool has zero users with missing/stale method or segment. Verify no-name rows are `unknown_no_name` and both South Asian confidences are `south_asian`.

- [ ] **Step 4: Create and audit four drafts**

Run `npm run recovery:select-expanded`. Verify exact segment membership, zero South Asian candidates, zero duplicate people across the rollout group, valid immutable hashes, and caps `10`/`1000`.

- [ ] **Step 5: Approve and start without an observation pause**

Approve each non-empty campaign using the owner identity, then start all of them. Do not create a holdout and do not delay between cohorts.

- [ ] **Step 6: Verify production behavior**

After the first eligible ticks, confirm each non-empty campaign's first successful Meta comment is visible, the group rolling-hour maximum is at most `10`, no failures/uncertainties/duplicates occurred, and no health signal or circuit breaker opened. Report campaign IDs, counts, and exact first-comment links to the user.
