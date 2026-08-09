# Gemini-Gated Historical Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a historical public recovery reply can be selected and sent only when the user has a current Gemini classification whose normalized origin is `us_western`.

**Architecture:** Add a small pure origin-policy module shared by selection and pre-send recheck, while keeping Gemini response normalization in the classifier boundary. Reclassify stale records, freeze the classification method into each candidate and its decision hash, then query the live method/origin immediately before every provider call. The existing paused campaign remains inert and will be cancelled only after the replacement code and reclassification are verified.

**Tech Stack:** TypeScript, Node.js 22, Vitest, Prisma 5, PostgreSQL, Express, React, Railway

## Global Constraints

- Require the current Gemini prompt method, currently `llm_v1`, for historical recovery.
- Allow normalized `us_western` at both `high` and `low` confidence.
- Exclude `south_asian` at both confidence levels and exclude `unknown` and `other`.
- Normalize contradictory `us_western` evidence such as `generic handle`, `no cue`, and `no strong cue` to `unknown` with low confidence.
- Keep the old campaign paused; never resume it.
- Preserve a 50% control holdout, batch size 1, 10 sends per hour, and 1,000 sends per day for the replacement campaign.
- No Instagram Graph API write may occur for a stale or disallowed classification.

---

### Task 1: Canonical Gemini origin policy

**Files:**
- Create: `src/services/historicalRecoveryOriginPolicy.ts`
- Create: `src/services/historicalRecoveryOriginPolicy.test.ts`
- Modify: `src/services/originClassifier.ts`
- Modify: `src/services/originClassifier.test.ts`

**Interfaces:**
- Produces: `CURRENT_ORIGIN_METHOD`, `normalizeGeminiVerdict()`, and `evaluateHistoricalOrigin()`.
- Consumes: Existing `Origin` and `OriginVerdict` shapes.

- [ ] **Step 1: Write failing policy and classifier tests**

```ts
expect(normalizeGeminiVerdict({
  id: "u1", origin: "us_western", confidence: "low", evidence: "generic handle, no strong cue",
})).toEqual({
  id: "u1", origin: "unknown", confidence: "low", evidence: "generic handle, no strong cue",
});

expect(evaluateHistoricalOrigin({
  origin: "us_western", confidence: "low", method: CURRENT_ORIGIN_METHOD,
})).toEqual({ kind: "allow" });

expect(evaluateHistoricalOrigin({
  origin: "south_asian", confidence: "low", method: CURRENT_ORIGIN_METHOD,
})).toEqual({ kind: "block", reason: "audience_south_asian" });
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `npx vitest run src/services/historicalRecoveryOriginPolicy.test.ts src/services/originClassifier.test.ts`

Expected: FAIL because the policy module and normalization do not exist.

- [ ] **Step 3: Implement the pure policy and classifier-boundary normalization**

```ts
export const CURRENT_ORIGIN_METHOD = "llm_v1";

export function evaluateHistoricalOrigin(input: {
  origin: string | null;
  confidence: string | null;
  method: string | null;
}) {
  if (input.method !== CURRENT_ORIGIN_METHOD) {
    return { kind: "stale", reason: "origin_not_current_gemini" } as const;
  }
  if (input.origin === "us_western") return { kind: "allow" } as const;
  if (input.origin === "south_asian") {
    return { kind: "block", reason: "audience_south_asian" } as const;
  }
  if (input.origin === "other") return { kind: "block", reason: "audience_other" } as const;
  return { kind: "block", reason: "audience_unknown" } as const;
}
```

Call `normalizeGeminiVerdict()` from `toVerdict()` after response validation. Match contradiction phrases case-insensitively with word boundaries and preserve the evidence string for auditing. Re-export `CURRENT_ORIGIN_METHOD` as `ORIGIN_PROMPT_VERSION` from `originClassifier.ts` to preserve existing callers.

- [ ] **Step 4: Run the focused tests and confirm they pass**

Run: `npx vitest run src/services/historicalRecoveryOriginPolicy.test.ts src/services/originClassifier.test.ts`

Expected: PASS, including positive Western cues that must not be downgraded.

- [ ] **Step 5: Commit**

```bash
git add src/services/historicalRecoveryOriginPolicy.ts src/services/historicalRecoveryOriginPolicy.test.ts src/services/originClassifier.ts src/services/originClassifier.test.ts
git commit -m "feat: normalize Gemini origin decisions"
```

### Task 2: Reclassify stale and legacy users

**Files:**
- Modify: `src/services/originEnrichmentWorker.ts`
- Modify: `src/services/originEnrichmentWorker.test.ts`

**Interfaces:**
- Consumes: `CURRENT_ORIGIN_METHOD` from Task 1.
- Produces: A due query that picks never-classified and stale-method users.

- [ ] **Step 1: Write a failing due-query test**

```ts
expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
  where: {
    OR: [
      { originCheckedAt: null },
      { originMethod: { not: CURRENT_ORIGIN_METHOD } },
    ],
  },
}));
```

Also assert that the worker writes `CURRENT_ORIGIN_METHOD` for classified, no-signal, and omitted-verdict rows.

- [ ] **Step 2: Run the worker test and confirm it fails**

Run: `npx vitest run src/services/originEnrichmentWorker.test.ts`

Expected: FAIL because the query currently selects only `originCheckedAt: null`.

- [ ] **Step 3: Update the due predicate**

Use an explicit OR predicate for `originCheckedAt IS NULL` or `originMethod != CURRENT_ORIGIN_METHOD`. Keep newest-first ordering, batch size, spend accounting, and unreadable-response retry behavior unchanged.

- [ ] **Step 4: Run the worker test and confirm it passes**

Run: `npx vitest run src/services/originEnrichmentWorker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/originEnrichmentWorker.ts src/services/originEnrichmentWorker.test.ts
git commit -m "feat: reclassify stale origin records"
```

### Task 3: Persist origin method in the frozen candidate

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260809210000_add_recovery_candidate_origin_method/migration.sql`
- Create: `src/services/historicalRecoveryOriginMethodMigrationContract.test.ts`

**Interfaces:**
- Produces: Nullable Prisma field `RecoveryCandidate.audienceOriginMethod` mapped to `audience_origin_method`.
- Consumes: No existing data backfill; legacy candidates remain null.

- [ ] **Step 1: Write the migration contract test**

```ts
const rows = await db.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
  SELECT column_name, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'recovery_candidate'
    AND column_name = 'audience_origin_method'
`;
expect(rows).toEqual([{ column_name: "audience_origin_method", is_nullable: "YES" }]);
```

- [ ] **Step 2: Run the contract test and confirm it fails**

Run: `MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/insta_contract" DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/insta_contract" npx vitest run src/services/historicalRecoveryOriginMethodMigrationContract.test.ts`

Expected: FAIL because the column does not exist.

- [ ] **Step 3: Add the additive migration and Prisma field**

```sql
ALTER TABLE "recovery_candidate"
  ADD COLUMN "audience_origin_method" TEXT;
```

```prisma
audienceOriginMethod String? @map("audience_origin_method")
```

- [ ] **Step 4: Generate Prisma and rerun the contract**

Run: `npx prisma generate && MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/insta_contract" DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/insta_contract" npx vitest run src/services/historicalRecoveryOriginMethodMigrationContract.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260809210000_add_recovery_candidate_origin_method/migration.sql src/services/historicalRecoveryOriginMethodMigrationContract.test.ts
git commit -m "feat: snapshot candidate origin method"
```

### Task 4: Fail-closed campaign selection and snapshot hashing

**Files:**
- Modify: `src/services/historicalRecoveryEligibility.ts`
- Modify: `src/services/historicalRecoveryEligibility.test.ts`
- Modify: `src/services/historicalRecoverySelector.ts`
- Modify: `src/services/historicalRecoverySelectorContract.test.ts`
- Modify: `src/services/historicalRecoverySnapshot.ts`
- Modify: `src/services/historicalRecoverySnapshot.test.ts`
- Modify: `scripts/select-historical-recovery.ts`

**Interfaces:**
- Consumes: `evaluateHistoricalOrigin()` and `RecoveryCandidate.audienceOriginMethod`.
- Produces: `EligibilityFacts.audienceOriginMethod`, `SelectionSnapshotInclusion.audienceOriginMethod`, and `SelectionReport.originBreakdown`.

- [ ] **Step 1: Write failing eligibility tests for the complete matrix**

```ts
it.each(["high", "low"])("allows current Gemini Western at %s confidence", (confidence) => {
  expect(decideEligibility(facts({
    audienceOrigin: "us_western",
    audienceOriginConfidence: confidence,
    audienceOriginMethod: CURRENT_ORIGIN_METHOD,
  })).kind).toBe("include");
});

it.each(["high", "low"])("blocks South Asian at %s confidence", (confidence) => {
  expect(decideEligibility(facts({
    audienceOrigin: "south_asian",
    audienceOriginConfidence: confidence,
    audienceOriginMethod: CURRENT_ORIGIN_METHOD,
  }))).toEqual({ kind: "exclude", reason: "audience_south_asian" });
});
```

Add cases for stale/missing method, `unknown`, and `other` with their explicit reasons.

- [ ] **Step 2: Write failing snapshot and selector tests**

Add `audienceOriginMethod: CURRENT_ORIGIN_METHOD` to snapshot fixtures. Assert the decision hash changes when only this method changes. In the real-Postgres selector fixture, seed `originMethod` and assert only current Gemini Western users are persisted while stale, South Asian, unknown, and other users are recorded as exclusions.

- [ ] **Step 3: Run focused tests and confirm they fail**

Run: `npx vitest run src/services/historicalRecoveryEligibility.test.ts src/services/historicalRecoverySnapshot.test.ts src/services/historicalRecoverySelectorContract.test.ts`

Expected: FAIL because the method is not selected, checked, persisted, or hashed.

- [ ] **Step 4: Implement selection and snapshot changes**

Select `u.origin_method AS "audienceOriginMethod"` and pass origin, confidence, and method to `decideEligibility()`. Add the method to snapshot inclusions, persistence, and stored snapshot reconstruction. Add an origin breakdown keyed as `<method>/<origin>/<confidence>` to `SelectionReport` and print it in `scripts/select-historical-recovery.ts` before the exclusion list.

- [ ] **Step 5: Run focused tests and confirm they pass**

Run: `npx vitest run src/services/historicalRecoveryEligibility.test.ts src/services/historicalRecoverySnapshot.test.ts src/services/historicalRecoverySelectorContract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/historicalRecoveryEligibility.ts src/services/historicalRecoveryEligibility.test.ts src/services/historicalRecoverySelector.ts src/services/historicalRecoverySelectorContract.test.ts src/services/historicalRecoverySnapshot.ts src/services/historicalRecoverySnapshot.test.ts scripts/select-historical-recovery.ts
git commit -m "feat: require Gemini origin during selection"
```

### Task 5: Fail closed immediately before provider dispatch

**Files:**
- Modify: `src/services/historicalRecoveryRecheck.ts`
- Modify: `src/services/historicalRecoveryRecheck.test.ts`
- Modify: `src/services/historicalRecoveryWorker.ts`
- Modify: `src/services/historicalRecoveryWorker.test.ts`

**Interfaces:**
- Consumes: Live `inferredOrigin`, `originConfidence`, and `originMethod` plus `evaluateHistoricalOrigin()`.
- Produces: Deferral reason `origin_not_current_gemini` and suppression reasons `audience_south_asian`, `audience_unknown`, and `audience_other`.

- [ ] **Step 1: Write failing recheck tests**

```ts
expect(recheckBeforeSend(facts({ audienceOriginMethod: "name" }))).toEqual({
  kind: "defer", reason: "origin_not_current_gemini",
});
expect(recheckBeforeSend(facts({
  audienceOrigin: "unknown", audienceOriginMethod: CURRENT_ORIGIN_METHOD,
}))).toEqual({ kind: "suppress", reason: "audience_unknown" });
```

Cover both confidence values for current Western and South Asian verdicts.

- [ ] **Step 2: Write failing worker tests proving no provider call**

Mock the live user row with `{ inferredOrigin, originConfidence, originMethod }`. For stale, South Asian, unknown, and other cases, assert `replyToComment`, `reserveHistoricalDispatch`, and `startHistoricalDispatch` are not called. Assert stale is released/deferred and disallowed current verdicts are terminally suppressed with the exact reason.

- [ ] **Step 3: Run focused tests and confirm they fail**

Run: `npx vitest run src/services/historicalRecoveryRecheck.test.ts src/services/historicalRecoveryWorker.test.ts`

Expected: FAIL because the live method and confidence are not read or checked.

- [ ] **Step 4: Implement the live fail-closed gate**

Extend `PreDispatchFacts` and the `igUser.findUnique` select with `originConfidence` and `originMethod`. Pass all three values to `recheckBeforeSend()`. Treat stale methods as retryable deferrals and current disallowed origins as suppressions before the capacity reservation or Graph API call.

- [ ] **Step 5: Run focused tests and confirm they pass**

Run: `npx vitest run src/services/historicalRecoveryRecheck.test.ts src/services/historicalRecoveryWorker.test.ts`

Expected: PASS with no Graph write on every blocked path.

- [ ] **Step 6: Commit**

```bash
git add src/services/historicalRecoveryRecheck.ts src/services/historicalRecoveryRecheck.test.ts src/services/historicalRecoveryWorker.ts src/services/historicalRecoveryWorker.test.ts
git commit -m "feat: gate historical sends on live Gemini origin"
```

### Task 6: Expose origin provenance in review APIs

**Files:**
- Modify: `src/services/historicalRecoveryCandidateDetail.ts`
- Modify: `src/services/historicalRecoveryCandidateDetail.test.ts`
- Modify: `src/api/historicalRecovery.routes.ts`
- Modify: `src/api/historicalRecovery.routes.test.ts`
- Modify: `web/src/components/historical/historicalRecoveryViewModel.ts`
- Modify: `web/src/components/historical/historicalRecoveryViewModel.test.ts`

**Interfaces:**
- Consumes: Frozen `audienceOriginMethod`.
- Produces: Candidate list/detail JSON containing method, origin, and confidence; typed web rows preserve all three.

- [ ] **Step 1: Write failing API/detail/view-model assertions**

```ts
expect(payload.candidate).toMatchObject({
  audienceOrigin: "us_western",
  audienceOriginConfidence: "low",
  audienceOriginMethod: CURRENT_ORIGIN_METHOD,
});
```

- [ ] **Step 2: Run focused tests and confirm they fail**

Run: `npx vitest run src/services/historicalRecoveryCandidateDetail.test.ts src/api/historicalRecovery.routes.test.ts web/src/components/historical/historicalRecoveryViewModel.test.ts`

Expected: FAIL because method provenance is absent.

- [ ] **Step 3: Add the field to selects, serializers, and frontend types**

Expose the frozen value only; do not substitute the live user value in review output.

- [ ] **Step 4: Run focused tests and confirm they pass**

Run: `npx vitest run src/services/historicalRecoveryCandidateDetail.test.ts src/api/historicalRecovery.routes.test.ts web/src/components/historical/historicalRecoveryViewModel.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/historicalRecoveryCandidateDetail.ts src/services/historicalRecoveryCandidateDetail.test.ts src/api/historicalRecovery.routes.ts src/api/historicalRecovery.routes.test.ts web/src/components/historical/historicalRecoveryViewModel.ts web/src/components/historical/historicalRecoveryViewModel.test.ts
git commit -m "feat: expose historical origin provenance"
```

### Task 7: Full verification and production-safe rollout

**Files:**
- Modify only if verification reveals a defect.

**Interfaces:**
- Consumes: All prior tasks.
- Produces: Verified build, deployed migration/code, reclassified cohort, cancelled old campaign, and a clean replacement draft.

- [ ] **Step 1: Run repository verification**

Run:

```bash
npx prisma validate
npm test
npm run build
npm --prefix web test
npm --prefix web run build
git diff --check
```

Expected: Every command exits 0.

- [ ] **Step 2: Review the complete diff against the design**

Confirm the Graph provider call is reachable only after the current Gemini-Western decision, the method is covered by the frozen decision hash, migration is additive, and unrelated working-tree changes are absent.

- [ ] **Step 3: Deploy code while historical recovery remains paused**

Deploy the tested commit to Railway, allow `prisma migrate deploy` to add the nullable column, and confirm service health, migration status, and `DM_RECOVERY_HISTORICAL_ENABLED=true`. Do not change the old campaign from `paused`.

- [ ] **Step 4: Reclassify legacy users and audit completion**

Run paced enrichment until the target historical pool has zero legacy or missing methods. Query counts by method/origin/confidence and inspect the generic/no-cue rows to confirm they are normalized to `unknown`.

- [ ] **Step 5: Cancel the old campaign and create the replacement draft**

Cancel campaign `0579a02d-d688-499b-a79b-ab23d762818d`. Create a new `unknown_read_pilot` campaign with 50% holdout, batch size 1, hourly cap 10, and daily cap 1,000. Verify every candidate has current method `llm_v1` and origin `us_western` before approval.

- [ ] **Step 6: Approve and verify one controlled send**

Approve the replacement as the authenticated owner, start it, and observe one successful provider result. Confirm the exact Instagram comment is visible, there are zero uncertain/failed outcomes, and the remaining scheduler rate is 10 per hour.

- [ ] **Step 7: Commit any verification-only fixes, then record rollout evidence**

```bash
git status --short
git log --oneline --decorate -8
```

Expected: Implementation commits are present, no unrelated files are staged, and the production campaign evidence is recorded in the handoff.
