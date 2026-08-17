# DM Recovery Timing Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a safe 45/45/10 experiment comparing public DM recovery reminders at two hours, six hours, and no reminder, then report unique-follower guide completion within 48 hours through a date-based dashboard.

**Architecture:** Add a versioned timing assignment beside the existing recovery state machine. Qualifying followers receive a deterministic persisted arm before scheduling, while legacy v1 rows and the immediate settings-blocked path retain their current behavior. A pure reporting layer selects one index journey per follower, applies one server-owned Pacific date window and `asOf` boundary, calculates arm metrics and the approved decision rule, and feeds the existing recovery API and React lens. The existing worker, dispatch ledger, cooldowns, evidence suppressions, capacity limits, and circuit remain the only send path.

**Tech Stack:** Node.js 22, TypeScript 5.7, Prisma 5.22, PostgreSQL on Supabase, Express, Zod, Vitest, React 19, TanStack Query, Vite, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-dm-recovery-timing-experiment-design.md`

## Global Constraints

- Use experiment version `read-recovery-timing-v2` exactly.
- Assign 45% to `two_hour`, 45% to `six_hour`, and 10% to `no_reminder` with SHA-256 over `(version, igUserId)`.
- Assign and analyze by unique Instagram follower. Repeated journeys use the same arm, and only the earliest qualifying journey in a selected range is the primary index journey.
- Anchor 24-hour and 48-hour outcomes at the original `acceptedAt`, never at `eligibleAt`.
- Exclude immature followers from outcome-rate denominators while showing them as still collecting results.
- Keep the public reply copy and template version identical across both treatment arms.
- Preserve v1 rows, their frozen ten-hour eligibility, and their current lifecycle.
- Keep `settings_blocked`, tracking-unavailable, out-of-market pre-assignment exclusions, and rows outside the v2 window out of v2 denominators.
- A no-reminder row is a terminal experiment control. It cannot be claimed, sent, cancelled, or converted to treatment.
- Keep every existing final-send authorization, person cooldown, dispatch reservation, rate cap, uncertain-send rule, and circuit-breaker behavior.
- Preserve `send_uncertain` as terminal and never retry it automatically.
- Use `7d`, `14d`, `30d`, `All`, and custom dates. Default to the latest 30 days of v2 coverage.
- The metrics response owns `asOf` and the effective date range. List and counts must reuse that exact scope.
- Partial date ranges are exploratory and never declare a winner.
- Do not automatically roll out a winner.
- Preserve unrelated user changes already present in the checkout.

## Exact File Map

### Create

- `prisma/migrations/20260817030000_add_dm_recovery_timing_experiment/migration.sql`: nullable v2 assignment columns, enum, index, consistency constraint, and immutability trigger.
- `src/services/dmRecoveryTimingExperiment.ts` and `src/services/dmRecoveryTimingExperiment.test.ts`: version constant, deterministic 45/45/10 assignment, and fixed arm schedules.
- `src/services/dmRecoveryReportingWindow.ts` and `src/services/dmRecoveryReportingWindow.test.ts`: Pacific coverage, date selection, maturity cutoff, and SQL bounds.
- `src/api/recoveryRemindersCursor.ts` and `src/api/recoveryRemindersCursor.test.ts`: validated opaque cursor bound to the date and time scope.
- `src/services/dmRecoveryTimingMetrics.ts` and `src/services/dmRecoveryTimingMetrics.test.ts`: unique-follower aggregation, statistical comparison, safety guardrails, and final decision.
- `web/src/components/conversations/DmRecoveryTimingSummary.tsx` and `web/src/components/conversations/DmRecoveryTimingSummary.test.tsx`: three timing cards and API-owned result language.
- `docs/dm-recovery-timing-experiment-runbook.md`: cutover, monitoring, blinded sample checks, final analysis, and rollback.

### Modify

- `prisma/schema.prisma`: v2 timing enum, assignment snapshot fields, and report index.
- `src/config/env.ts` and `src/config/env.test.ts`: v2 enrollment-window and post-experiment validation.
- `src/services/dmRecoveryDatabaseContract.test.ts`: real-Postgres enum, column, constraint, trigger, index, and legacy-compatibility contracts.
- `src/services/dmRecoveryService.ts` and `src/services/dmRecoveryService.test.ts`: pre-assignment eligibility and immutable v2 creation.
- `src/services/dmRecoveryPolicy.ts` and `src/services/dmRecoveryPolicy.test.ts`: final persisted arm/cohort authorization.
- `src/services/dmRecoveryRepository.ts` and `src/services/dmRecoveryRepository.test.ts`: due selection, claim, and lifecycle protection for v2 controls.
- `src/api/recoveryReminders.routes.ts` and `src/api/recoveryReminders.routes.test.ts`: date-scoped list, counts, metrics, detail, and immutable-control action contract.
- `src/services/analyticsDay.test.ts`: Pacific daylight-saving boundaries used by recovery reporting.
- `web/src/lib/types.ts`, `web/src/lib/api.ts`, and `web/src/lib/dateRange.test.ts`: typed timing responses and scoped API calls.
- `web/src/components/conversations/DmRecoveryList.tsx` and `web/src/components/conversations/DmRecoveryList.test.tsx`: metrics-first date ownership, timing filter, scoped rows, and scoped badges.
- `web/src/components/conversations/DmRecoveryDrawer.tsx` and `web/src/components/conversations/DmRecoveryDrawer.test.tsx`: persisted arm detail and no-reminder action restrictions.
- `web/src/components/conversations/dmRecoveryViewModel.ts` and `web/src/components/conversations/dmRecoveryViewModel.test.ts`: timing labels and dynamic cancellation rules.
- `web/e2e/main.tsx` and `web/e2e/recovery-reminders.spec.ts`: scoped API fixtures and full browser scenarios.
- `.env.example`, `README.md`, and `docs/meta-verification.md`: v1/v2 configuration distinction and production procedure.

---

### Task 1: Define the Versioned Timing Domain and Configuration Guardrails

**Files:**
- Create: `src/services/dmRecoveryTimingExperiment.ts`
- Create: `src/services/dmRecoveryTimingExperiment.test.ts`
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`

**Interfaces:**
- Produces `DM_RECOVERY_TIMING_EXPERIMENT_VERSION`, `RECOVERY_TIMING_ARMS`, `RecoveryTimingArm`, `assignRecoveryTimingArm()`, and `timingScheduleForArm()`.
- Keeps the v2 45/45/10 split and two/six-hour delays as code constants, not environment values.
- Rejects v2 startup when post-experiment assignment is enabled or the configured enrollment window is shorter than 28 days or longer than 42 days.

- [ ] **Step 1: Write failing deterministic assignment and schedule tests**

Add fixed fixtures so a hashing change cannot silently reassign production followers:

```ts
it.each([
  ["fixture-2", "two_hour", 1709],
  ["fixture-0", "six_hour", 5490],
  ["fixture-7", "no_reminder", 9505],
] as const)("assigns %s to %s", (igUserId, arm, bucket) => {
  expect(recoveryTimingBucket(igUserId)).toBe(bucket);
  expect(assignRecoveryTimingArm(igUserId)).toBe(arm);
});

it("freezes eligibility from acceptance", () => {
  const acceptedAt = new Date("2026-08-16T20:00:00.000Z");
  expect(timingScheduleForArm("two_hour", acceptedAt)).toMatchObject({
    status: "waiting",
    cohort: "treatment",
    eligibleAt: new Date("2026-08-16T22:00:00.000Z"),
  });
  expect(timingScheduleForArm("six_hour", acceptedAt).eligibleAt).toEqual(
    new Date("2026-08-17T02:00:00.000Z"),
  );
  expect(timingScheduleForArm("no_reminder", acceptedAt)).toMatchObject({
    status: "control",
    cohort: "control",
    eligibleAt: acceptedAt,
  });
});
```

Add a deterministic 100,000-follower distribution test with a tolerance of 0.75 percentage points per arm.

- [ ] **Step 2: Write failing v2 configuration tests**

Extend `src/config/env.test.ts` with these cases:

```ts
const validV2 = {
  ...baseEnv,
  DM_RECOVERY_ENABLED: "true",
  DM_RECOVERY_EXPERIMENT_VERSION: "read-recovery-timing-v2",
  DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-17T07:00:00.000Z",
  DM_RECOVERY_EXPERIMENT_END_AT: "2026-09-28T07:00:00.000Z",
  DM_RECOVERY_POST_EXPERIMENT_ENABLED: "false",
};

expect(envSchema.safeParse(validV2).success).toBe(true);
expect(envSchema.safeParse({
  ...validV2,
  DM_RECOVERY_POST_EXPERIMENT_ENABLED: "true",
}).success).toBe(false);
```

Also reject 27-day and 43-day v2 windows, accept 28-day and 42-day windows, and prove legacy v1 retains its existing window rules.

- [ ] **Step 3: Run focused tests and confirm red**

Run: `npx vitest run src/services/dmRecoveryTimingExperiment.test.ts src/config/env.test.ts`

Expected: failure because the timing module and v2-specific configuration refinements do not exist.

- [ ] **Step 4: Implement the pure timing domain**

Use an unsigned 32-bit SHA-256 prefix and integer buckets:

```ts
export const DM_RECOVERY_TIMING_EXPERIMENT_VERSION = "read-recovery-timing-v2" as const;
export const RECOVERY_TIMING_ARMS = ["two_hour", "six_hour", "no_reminder"] as const;
export type RecoveryTimingArm = (typeof RECOVERY_TIMING_ARMS)[number];

export function recoveryTimingBucket(igUserId: string): number {
  const uint32 = createHash("sha256")
    .update(`${DM_RECOVERY_TIMING_EXPERIMENT_VERSION}:${igUserId}`)
    .digest()
    .readUInt32BE(0);
  return Math.floor((uint32 / 0x1_0000_0000) * 10_000);
}

export function assignRecoveryTimingArm(igUserId: string): RecoveryTimingArm {
  const bucket = recoveryTimingBucket(igUserId);
  return bucket < 4_500 ? "two_hour" : bucket < 9_000 ? "six_hour" : "no_reminder";
}
```

`timingScheduleForArm()` must return the status, existing cohort, and frozen eligibility timestamp as one value. It must not read `DM_RECOVERY_DELAY_HOURS` or `DM_RECOVERY_HOLDOUT_PERCENT`.

- [ ] **Step 5: Add v2-only environment validation**

In `envSchema.superRefine`, compare the exact version string, require `DM_RECOVERY_POST_EXPERIMENT_ENABLED=false`, and validate a duration from 28 through 42 complete 24-hour periods. Do not change validation for v1.

- [ ] **Step 6: Run focused tests and confirm green**

Run: `npx vitest run src/services/dmRecoveryTimingExperiment.test.ts src/config/env.test.ts`

Expected: all focused tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/dmRecoveryTimingExperiment.ts src/services/dmRecoveryTimingExperiment.test.ts src/config/env.ts src/config/env.test.ts
git commit -m "feat: define recovery timing experiment"
```

---

### Task 2: Persist Immutable Experiment Assignment

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260817030000_add_dm_recovery_timing_experiment/migration.sql`
- Modify: `src/services/dmRecoveryDatabaseContract.test.ts`

**Interfaces:**
- Produces PostgreSQL enum `dm_recovery_timing_arm`.
- Adds nullable `experiment_version_snapshot` and `timing_arm` columns for backward compatibility.
- Enforces the v2 arm/cohort/status relationship and immutable assignment timestamps in PostgreSQL.
- Adds the reporting index `(experiment_version_snapshot, accepted_at)`.

- [ ] **Step 1: Extend the failing real-Postgres contract**

Use the existing localhost-only `MIGRATION_TEST_DATABASE_URL` harness. Assert:

```ts
expect(enumValues).toEqual(["two_hour", "six_hour", "no_reminder"]);
expect(columns).toEqual(expect.arrayContaining([
  expect.objectContaining({ column_name: "experiment_version_snapshot" }),
  expect.objectContaining({ column_name: "timing_arm" }),
]));
expect(indexDefinitions.join("\n")).toContain(
  "experiment_version_snapshot, accepted_at",
);
```

Insert valid treatment and control fixtures. Assert an invalid `two_hour/control`, `six_hour/control`, or `no_reminder/waiting` row is rejected. Update a valid v2 row and assert changing `experimentVersionSnapshot`, `timingArm`, `acceptedAt`, or `eligibleAt` is rejected, while writing `seenAt` or `repliedAt` remains allowed. Assert a pre-existing legacy fixture with both new columns null remains readable and mutable through its current lifecycle.

Also prove a legacy row cannot be retrofitted into v2 with an update. V2 assignment is insertion-only.

- [ ] **Step 2: Run the database contract and confirm red or explicit skip**

Run: `npx vitest run src/services/dmRecoveryDatabaseContract.test.ts`

Expected with `MIGRATION_TEST_DATABASE_URL`: failures for the absent enum, columns, constraint, trigger, and index.

Expected without it: the suite reports skipped. Record that the real database contract still needs an enabled local PostgreSQL run before production activation.

- [ ] **Step 3: Add the Prisma enum and fields**

Use this schema shape:

```prisma
enum DmRecoveryTimingArm {
  two_hour
  six_hour
  no_reminder

  @@map("dm_recovery_timing_arm")
}

model DmRecoveryReminder {
  experimentVersionSnapshot String?              @map("experiment_version_snapshot")
  timingArm                  DmRecoveryTimingArm? @map("timing_arm")

  @@index([experimentVersionSnapshot, acceptedAt])
}
```

- [ ] **Step 4: Add the additive SQL migration**

The migration must create the enum, add both nullable columns, add the index, and install these two protections:

```sql
ALTER TABLE "dm_recovery_reminder"
  ADD CONSTRAINT "dm_recovery_reminder_v2_assignment_check"
  CHECK (
    "experiment_version_snapshot" IS DISTINCT FROM 'read-recovery-timing-v2'
    OR (
      "accepted_at" IS NOT NULL
      AND (
        (
          "timing_arm" IN ('two_hour', 'six_hour')
          AND "cohort" = 'treatment'
          AND "status" <> 'control'
        )
        OR (
          "timing_arm" = 'no_reminder'
          AND "cohort" = 'control'
          AND "status" = 'control'
        )
      )
    )
  ) NOT VALID;

ALTER TABLE "dm_recovery_reminder"
  VALIDATE CONSTRAINT "dm_recovery_reminder_v2_assignment_check";
```

Add a `BEFORE UPDATE` trigger that raises `v2_assignment_is_immutable` when either the old or new version is `read-recovery-timing-v2` and the update changes the version, arm, accepted time, or eligible time. This also prevents retrofitting a legacy row into v2. Keep RLS enabled on the existing table and add no Data API policy.

- [ ] **Step 5: Generate Prisma and rerun the contract**

Run: `npx prisma generate && npx vitest run src/services/dmRecoveryDatabaseContract.test.ts`

Expected: Prisma generation succeeds. The full contract passes when the local migration database is configured; otherwise it remains explicitly skipped.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260817030000_add_dm_recovery_timing_experiment/migration.sql src/services/dmRecoveryDatabaseContract.test.ts
git commit -m "feat: persist recovery timing assignment"
```

---

### Task 3: Schedule V2 Rows Without Changing V1 or Settings-Blocked Behavior

**Files:**
- Modify: `src/services/dmRecoveryService.ts`
- Modify: `src/services/dmRecoveryService.test.ts`

**Interfaces:**
- Qualifying in-window v2 accepted DMs persist version, arm, status, cohort, accepted time, and frozen eligibility in the existing idempotent upsert.
- V2 pre-assignment exclusions persist operational evidence without a timing arm and never enter v2 analysis.
- V1, tracking-unavailable, and settings-blocked paths retain null version and arm fields.

- [ ] **Step 1: Write failing scheduling tests for all three arms**

Mock `assignRecoveryTimingArm()` and assert the exact create payload:

```ts
expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
  create: expect.objectContaining({
    experimentVersionSnapshot: "read-recovery-timing-v2",
    timingArm: "two_hour",
    cohort: "treatment",
    status: "waiting",
    acceptedAt,
    eligibleAt: new Date(acceptedAt.getTime() + 2 * 60 * 60 * 1000),
  }),
  update: {},
}));
```

Repeat for `six_hour`. For `no_reminder`, assert `status: "control"`, `cohort: "control"`, and `eligibleAt` exactly equals `acceptedAt`.

- [ ] **Step 2: Write failing exclusion and compatibility tests**

Cover these exact cases:

- trusted Instagram message ID absent routes to `tracking_unavailable` with null version and arm;
- `DM_RECOVERY_WESTERN_ONLY=true` plus snapshotted `south_asian` origin creates a terminal `suppressed` operational row with `cohort: not_applicable`, `suppressionReason: audience_out_of_market`, and no v2 arm;
- accepted before start or at/after end creates no v2 arm and no sendable v2 row;
- a v1 treatment still uses `DM_RECOVERY_DELAY_HOURS=10` and `assignRecoveryCohort()`;
- `scheduleSettingsBlockedRecovery()` never calls the timing assigner;
- duplicate scheduling for the same comment keeps `update: {}` and the first assignment;
- a null `mediaId` still qualifies when the original `commentId` is present.

- [ ] **Step 3: Run focused tests and confirm red**

Run: `npx vitest run src/services/dmRecoveryService.test.ts`

Expected: failures because accepted scheduling does not persist v2 version or timing arm and still computes one global delay.

- [ ] **Step 4: Integrate assignment after pre-assignment eligibility is known**

Keep this sequence inside `scheduleAcceptedGateRecovery()`:

```ts
const commentId = requireCommentOrigin(input.commentId);
if (!input.instagramGateMessageId) {
  return scheduleTrackingUnavailableRecovery({
    conversationId: input.conversationId,
    igUserId: input.igUserId,
    keywordId: input.keywordId,
    keywordSnapshot: input.keywordSnapshot,
    commentId,
    mediaId: input.mediaId,
    observedAt: input.acceptedAt,
  });
}

const audience = await readAudienceOriginSnapshot(input.igUserId);
const isV2 = env.DM_RECOVERY_EXPERIMENT_VERSION === DM_RECOVERY_TIMING_EXPERIMENT_VERSION;
const insideWindow = acceptedInsideConfiguredWindow(input.acceptedAt);
const inMarket = !env.DM_RECOVERY_WESTERN_ONLY || audience.origin !== "south_asian";
```

Only when all v2 pre-assignment facts pass should the service call `assignRecoveryTimingArm()` and `timingScheduleForArm()`. Continue rendering the current `RECOVERY_TEMPLATE_VERSION` and exact current copy once, before the upsert. Do not make a network call here.

For v1, retain the existing `decideExperimentCohort()` behavior and ten-hour environment delay. For v2 exclusions, use existing terminal statuses and reasons without attaching `experimentVersionSnapshot`, so the v2 version index contains only randomized followers.

- [ ] **Step 5: Add safe structured creation logs**

Extend `dm_recovery_created` and `dm_recovery_control_assigned` fields with version and timing arm. Keep follower IDs, handles, copy, and raw provider data out of new logs.

- [ ] **Step 6: Run focused tests and confirm green**

Run: `npx vitest run src/services/dmRecoveryTimingExperiment.test.ts src/services/dmRecoveryService.test.ts`

Expected: all timing and scheduling tests pass, including v1 and settings-blocked regressions.

- [ ] **Step 7: Commit**

```bash
git add src/services/dmRecoveryService.ts src/services/dmRecoveryService.test.ts
git commit -m "feat: schedule versioned recovery timing arms"
```

---

### Task 4: Enforce V2 Send and Control Invariants at Every Boundary

**Files:**
- Modify: `src/services/dmRecoveryPolicy.ts`
- Modify: `src/services/dmRecoveryPolicy.test.ts`
- Modify: `src/services/dmRecoveryRepository.ts`
- Modify: `src/services/dmRecoveryRepository.test.ts`
- Modify: `src/api/recoveryReminders.routes.ts`
- Modify: `src/api/recoveryReminders.routes.test.ts`

**Interfaces:**
- V2 sends require version `read-recovery-timing-v2`, treatment cohort, and timing arm `two_hour` or `six_hour` at claim and final authorization.
- V2 no-reminder controls cannot be selected, claimed, cancelled, released to waiting, or sent.
- Legacy null-arm rows keep the current policy.

- [ ] **Step 1: Write failing policy and repository tests**

Add `experimentVersionSnapshot` and `timingArm` to policy fixtures. Assert:

```ts
expect(decideRecovery({
  ...readyInput,
  experimentVersionSnapshot: "read-recovery-timing-v2",
  timingArm: "no_reminder",
  cohort: "control",
})).not.toEqual({ kind: "send_no_confirmed_read_reminder" });
```

Also assert a v2 waiting row with a null arm or mismatched cohort is suppressed as `experiment_assignment_invalid`, both valid treatment arms can send only after their persisted `eligibleAt`, and a legacy v1 null-arm treatment still follows the current policy.

In repository tests, prove due selection and compare-and-set claiming include the v2 treatment guard. Prove no-reminder control remains untouched through evidence updates and lease reconciliation.

- [ ] **Step 2: Write failing cancellation API tests**

Mock a v2 `no_reminder` control and expect:

```ts
expect(response.status).toBe(409);
expect(response.body).toEqual({ error: "experiment_control_immutable" });
expect(updateMany).not.toHaveBeenCalled();
```

Keep the existing legacy control-cancellation behavior covered so this hardening is version-specific.

- [ ] **Step 3: Run focused tests and confirm red**

Run: `npx vitest run src/services/dmRecoveryPolicy.test.ts src/services/dmRecoveryRepository.test.ts src/api/recoveryReminders.routes.test.ts`

Expected: failures because the current final policy sees only cohort and the cancellation API allows every control row.

- [ ] **Step 4: Add final policy consistency checks**

Extend `RecoveryPolicyInput` with nullable version and arm. Immediately before a no-confirmed-read send, require this consistency for v2:

```ts
const validV2Treatment =
  input.cohort === "treatment" &&
  (input.timingArm === "two_hour" || input.timingArm === "six_hour");

if (
  input.experimentVersionSnapshot === DM_RECOVERY_TIMING_EXPERIMENT_VERSION &&
  !validV2Treatment
) {
  return { kind: "suppress", reason: "experiment_assignment_invalid" };
}
```

Pass both persisted fields through `toPolicyInput()`. Never recompute an arm or eligible time during claim or authorization.

- [ ] **Step 5: Narrow repository selection and cancellation**

Keep `status: waiting` and `eligibleAt <= now` as the main due predicate. Add an explicit version/arm condition that allows legacy null-version rows and valid v2 treatment rows, but excludes malformed v2 rows even before the pure policy runs.

In the cancel handler, select `experimentVersionSnapshot` and `timingArm` with status. Return the version-specific 409 before the compare-and-set update for `no_reminder`.

- [ ] **Step 6: Run focused worker safety regressions**

Run: `npx vitest run src/services/dmRecoveryPolicy.test.ts src/services/dmRecoveryRepository.test.ts src/services/dmRecoveryWorker.test.ts src/api/recoveryReminders.routes.test.ts`

Expected: all focused tests pass, including uncertain-send, finalizer failure, lease fencing, cooldown, alias, and circuit tests.

- [ ] **Step 7: Commit**

```bash
git add src/services/dmRecoveryPolicy.ts src/services/dmRecoveryPolicy.test.ts src/services/dmRecoveryRepository.ts src/services/dmRecoveryRepository.test.ts src/api/recoveryReminders.routes.ts src/api/recoveryReminders.routes.test.ts
git commit -m "fix: enforce recovery timing send invariants"
```

---

### Task 5: Define One Pacific Reporting Window and Scoped Cursor Contract

**Files:**
- Create: `src/services/dmRecoveryReportingWindow.ts`
- Create: `src/services/dmRecoveryReportingWindow.test.ts`
- Create: `src/api/recoveryRemindersCursor.ts`
- Create: `src/api/recoveryRemindersCursor.test.ts`
- Modify: `src/services/analyticsDay.test.ts`

**Interfaces:**
- Resolves v2 data coverage, default 30-day range, presets, custom range, `asOf`, maturity cutoff, and half-open UTC bounds.
- Produces opaque list cursors bound to `{ id, from, to, asOf }`.
- Uses `America/Los_Angeles` through the existing `analyticsDay` service.

- [ ] **Step 1: Write failing Pacific range tests**

Cover normal dates and both daylight-saving transitions:

```ts
expect(resolveRecoveryReportingWindow({
  coverage: { from: "2026-07-01", to: "2026-08-16" },
  requested: null,
  asOf: new Date("2026-08-17T03:00:00.000Z"),
})).toMatchObject({
  effectiveRange: { from: "2026-07-18", to: "2026-08-16" },
  resultsCompleteThrough: "2026-08-13",
});
```

Assert an overlapping custom range is clamped, a non-overlapping range fails with `range_outside_coverage`, reversed dates fail with `invalid_date_range`, malformed days fail, a future `asOf` fails, and empty coverage returns an empty report rather than inventing dates.

Assert `analyticsDayBounds("2026-03-08")` spans 23 hours and `analyticsDayBounds("2026-11-01")` spans 25 hours.

- [ ] **Step 2: Write failing cursor-scope tests**

Use a versioned payload:

```ts
const scope = {
  id: "10000000-0000-4000-8000-000000000001",
  from: "2026-08-01",
  to: "2026-08-16",
  asOf: "2026-08-17T03:00:00.000Z",
};
expect(decodeRecoveryCursor(encodeRecoveryCursor(scope), scope)).toEqual(scope);
```

Reject malformed base64, invalid JSON, invalid UUID/date values, unsupported cursor versions, and a token reused with a different range or `asOf` as `invalid_cursor_scope`.

- [ ] **Step 3: Run focused tests and confirm red**

Run: `npx vitest run src/services/dmRecoveryReportingWindow.test.ts src/api/recoveryRemindersCursor.test.ts src/services/analyticsDay.test.ts`

Expected: failure because reporting-window and cursor helpers do not exist.

- [ ] **Step 4: Implement the pure reporting window**

Reuse `isDayKey()`, `analyticsDayBounds()`, `toAnalyticsDayKey()`, and `shiftDayKey()`. The effective SQL predicate must be:

```ts
acceptedAt: {
  gte: analyticsDayBounds(effectiveRange.from).start,
  lt: analyticsDayBounds(effectiveRange.to).endExclusive,
}
```

Compute `resultsCompleteThrough` as the last full Pacific day whose end plus 48 hours is at or before `asOf`. Never add a fixed 24-hour duration to a local calendar boundary.

- [ ] **Step 5: Implement bounded opaque cursors**

Encode a small JSON payload with `v: 1` as base64url. Validate decoded content with Zod and cap the input token length before decoding. Compare all scope fields to the current effective request. This is an admin read cursor, so it does not need a cryptographic signature, but it must not accept an unvalidated ID or scope.

- [ ] **Step 6: Run focused tests and confirm green**

Run: `npx vitest run src/services/dmRecoveryReportingWindow.test.ts src/api/recoveryRemindersCursor.test.ts src/services/analyticsDay.test.ts`

Expected: all range, DST, and cursor tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/dmRecoveryReportingWindow.ts src/services/dmRecoveryReportingWindow.test.ts src/api/recoveryRemindersCursor.ts src/api/recoveryRemindersCursor.test.ts src/services/analyticsDay.test.ts
git commit -m "feat: define recovery reporting windows"
```

---

### Task 6: Build the Unique-Follower Metrics and Decision Engine

**Files:**
- Create: `src/services/dmRecoveryTimingMetrics.ts`
- Create: `src/services/dmRecoveryTimingMetrics.test.ts`

**Interfaces:**
- Consumes already-scoped qualifying v2 rows plus a fixed `asOf` and final-analysis context.
- Produces three arm summaries, allocation, two-hour versus six-hour statistics, control harm guardrails, operational safety guardrails, and a decision state.
- Uses no new statistics dependency.

- [ ] **Step 1: Write failing index-journey and maturity tests**

Build fixtures with two journeys for one follower and assert only the earliest accepted journey counts. Cover exact inclusive boundaries:

```ts
expect(isMatured(acceptedAt, new Date(acceptedAt.getTime() + 48 * HOUR_MS))).toBe(true);
expect(completedWithin(acceptedAt, new Date(acceptedAt.getTime() + 48 * HOUR_MS), 48)).toBe(true);
expect(completedWithin(acceptedAt, new Date(acceptedAt.getTime() + 48 * HOUR_MS + 1), 48)).toBe(false);
```

Prove a completion five hours after a six-hour arm's acceptance counts even though it precedes reminder eligibility, and prove using `eligibleAt` would fail the test.

- [ ] **Step 2: Write failing arm summary and safety tests**

For each arm, assert assigned, matured, immature, completions and replies within 24/48 hours, seen-before-eligibility, sent, suppression reasons, failure, uncertain, lateness p50/p95/max, cooldown, and duplicate-attempt counts.

Also assert median reminder-to-reply time, read-event coverage, and allocation percentage. Detect a follower persisted under more than one v2 arm as `assignmentDriftFollowers`; any nonzero drift forces safety review rather than silently choosing one arm.

Define rates exactly:

```ts
const sendExceptionRate = attempted === 0
  ? null
  : ((sendFailed + sendUncertain) / attempted) * 100;
const delayedSignalFalsePositiveRate = attempted === 0
  ? null
  : (delayedSignalFalsePositives / attempted) * 100;
```

An arm is materially worse when either rate exceeds the other timing arm by more than 2.0 percentage points. Any confirmed duplicate public send makes `duplicateSafetyEvent=true`.

- [ ] **Step 3: Write failing statistical and decision tests**

Implement table-driven cases for:

- two-hour winner, at least 2.0 points better, `p < 0.05`, confidence interval excludes zero, and no safety guardrail;
- six-hour winner under the same rule;
- statistically significant difference smaller than 2.0 points remains inconclusive;
- practical difference with `p >= 0.05` remains inconclusive;
- either material safety-rate difference blocks that arm;
- any confirmed duplicate blocks rollout pending review;
- both timing point estimates at least 2.0 points below control triggers control harm review;
- a treatment-versus-control 95% confidence interval wholly below zero triggers harm review;
- partial range returns `exploratory` even if its numbers look significant;
- open enrollment, immature final outcomes, fewer than 1,700 matured followers in a timing arm at day 42, and full valid winner cases.

- [ ] **Step 4: Run focused tests and confirm red**

Run: `npx vitest run src/services/dmRecoveryTimingMetrics.test.ts`

Expected: failure because the metrics engine does not exist.

- [ ] **Step 5: Implement pure aggregation and two-proportion comparison**

Use these public result shapes:

```ts
export type TimingDecision =
  | "collecting"
  | "exploratory"
  | "inconclusive"
  | "two_hour_wins"
  | "six_hour_wins"
  | "safety_review";

export interface ProportionComparison {
  differencePercentagePoints: number | null;
  confidenceInterval95: { low: number; high: number } | null;
  zScore: number | null;
  pValue: number | null;
}
```

Use the pooled standard error for the two-sided null-hypothesis z test, the unpooled standard error for the 95% confidence interval of the difference, and a tested normal-CDF approximation. Return null statistics when either denominator is zero.

Select one index row per `igUserId` by `acceptedAt ASC, id ASC`. Calculate rates only from matured index rows. Operational send metrics still describe the index rows assigned to that arm so the unit remains one follower.

The completion timestamp supplied for an index row must be the earliest trustworthy same-person, same-keyword completion after its acceptance. It may come from the source conversation, canonical intent, a linked/sibling conversation, or a `completed`/`completed_elsewhere` suppression stamp. Tests must prove a sibling completion counts once and an unrelated keyword completion does not count.

- [ ] **Step 6: Run focused tests and confirm green**

Run: `npx vitest run src/services/dmRecoveryTimingMetrics.test.ts`

Expected: all aggregation, boundary, statistics, safety, and decision tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/dmRecoveryTimingMetrics.ts src/services/dmRecoveryTimingMetrics.test.ts
git commit -m "feat: calculate recovery timing outcomes"
```

---

### Task 7: Extend the Recovery API With Date-Scoped V2 Reporting

**Files:**
- Modify: `src/api/recoveryReminders.routes.ts`
- Modify: `src/api/recoveryReminders.routes.test.ts`

**Interfaces:**
- Adds optional `from`, `to`, `asOf`, and `timingArm` query parameters.
- Metrics establishes canonical v2 coverage, effective range, and `asOf`.
- List and counts use the returned scope and internally restrict date-filtered requests to `read-recovery-timing-v2`.
- Preserves the existing legacy experiment block for the deployment interval before the first v2 row exists.

- [ ] **Step 1: Write failing metrics API tests**

Assert a no-query metrics request uses the latest 30 days of available v2 coverage and returns:

```ts
expect(response.body.timingExperiment).toMatchObject({
  version: "read-recovery-timing-v2",
  reporting: {
    asOf: expect.any(String),
    coverage: { from: "2026-07-01", to: "2026-08-16" },
    range: { from: "2026-07-18", to: "2026-08-16" },
    resultsCompleteThrough: expect.any(String),
  },
  arms: {
    twoHour: expect.any(Object),
    sixHour: expect.any(Object),
    noReminder: expect.any(Object),
  },
  timingComparison: expect.any(Object),
  decision: expect.any(Object),
});
```

Also assert rows with null arm, v1 version, settings-blocked trigger, and accepted time outside the effective range do not reach the timing engine. Require `from` and `to` together. When v2 coverage is empty, return `timingExperiment: null`, existing health/settings data, and the existing legacy experiment response.

- [ ] **Step 2: Write failing list, count, and cursor API tests**

Use the `asOf`, `from`, and `to` returned by metrics. Assert all list and count queries contain the same half-open `acceptedAt` predicate and `experimentVersionSnapshot: read-recovery-timing-v2`.

Assert list rows serialize:

```ts
{
  experimentVersion: "read-recovery-timing-v2",
  timingArm: "two_hour",
  timingLabel: "2-hour reminder",
}
```

Test `timingArm=no_reminder`, filtered badges, accepted-time ordering, second-page cursor continuity, cursor scope mismatch, future `asOf`, malformed/reversed dates, and clamped overlapping dates.

- [ ] **Step 3: Run focused API tests and confirm red**

Run: `npx vitest run src/api/recoveryReminders.routes.test.ts src/api/recoveryRemindersCursor.test.ts`

Expected: failures because current metrics are v1 cohort-based, counts are global, list has no date scope, and the cursor is a bare UUID.

- [ ] **Step 4: Extract v2 rows and call the pure metrics engine**

Add `acceptedAt`, `experimentVersionSnapshot`, `timingArm`, `lastAttemptAt`, `suppressedAt`, received timestamps, canonical-intent completion, and the needed dispatch evidence to the explicit metrics select. Query v2 coverage with `_min.acceptedAt` and `_max.acceptedAt`, resolve the reporting window, then fetch only qualifying v2 rows in that range.

For correctness when completion suppression bookkeeping failed or the completion landed on an unreconciled sibling, query completed conversations for the participating person and keyword sets inside the report's possible outcome interval. Match the exact `(igUserId, keywordId)` pair in memory, then pass the earliest completion at or after each index acceptance to the pure engine. Do not count a different keyword.

Query confirmed duplicate sends from `public_recovery_dispatch` by prospective `sourceId`, where more than one dispatch is confirmed `sent`. Pass only aggregate booleans/counts to the pure timing engine. Do not return provider payloads or follower identity in aggregate responses.

- [ ] **Step 5: Apply one reusable scoped `where` to list and counts**

Build one helper that combines:

```ts
{
  experimentVersionSnapshot: DM_RECOVERY_TIMING_EXPERIMENT_VERSION,
  acceptedAt: { gte: rangeStart, lt: rangeEndExclusive },
  ...(timingArm ? { timingArm } : {}),
}
```

Merge it with `viewWhere()` and keyword filtering for list. Merge the same scope with every grouped count. Use accepted-time descending plus ID descending for date-scoped pagination, and return the opaque cursor generated from the last row and exact scope.

- [ ] **Step 6: Preserve transition compatibility**

Keep the current `experiment` response as the legacy cohort summary while v1 is active. Add `timingExperiment` rather than silently changing the old shape. Date-scoped list/count requests are v2-only; unscoped requests retain their legacy behavior for the pre-cutover deployment check.

- [ ] **Step 7: Run focused API tests and confirm green**

Run: `npx vitest run src/api/recoveryReminders.routes.test.ts src/api/recoveryActionStatuses.test.ts src/services/dmRecoveryTimingMetrics.test.ts`

Expected: all date, cursor, metrics, cancellation, settings-verification, and legacy response tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/api/recoveryReminders.routes.ts src/api/recoveryReminders.routes.test.ts
git commit -m "feat: expose date-scoped recovery timing metrics"
```

---

### Task 8: Add Typed Timing Cards and Date Controls

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/api.ts`
- Create: `web/src/components/conversations/DmRecoveryTimingSummary.tsx`
- Create: `web/src/components/conversations/DmRecoveryTimingSummary.test.tsx`
- Modify: `web/src/lib/dateRange.test.ts`

**Interfaces:**
- Adds typed timing arm, report scope, arm summary, statistical comparison, and decision contracts.
- Reuses the existing `RangeFilter` and Pacific abstract-day helpers.
- Renders three side-by-side arm cards and exploratory/final decision language without deriving statistics in React.

- [ ] **Step 1: Add failing type-backed component tests**

Create a complete `RecoveryTimingExperimentMetrics` fixture and assert these labels and values render:

- `2-hour reminder`, `6-hour reminder`, and `No reminder`;
- matured followers, still collecting, completed guides, and 48-hour completion rate;
- pairwise percentage-point difference and 95% confidence interval;
- the selected guide-request date range and results-complete-through date;
- safety-review and inconclusive explanations;
- no winner label when `decision.state=exploratory`;
- final winner only when the API returns a final winner state.

- [ ] **Step 2: Run the focused component test and confirm red**

Run: `npm --prefix web test -- DmRecoveryTimingSummary.test.tsx`

Expected: failure because timing types and the summary component do not exist.

- [ ] **Step 3: Add exact frontend contracts and API query support**

Add:

```ts
export type RecoveryTimingArm = "two_hour" | "six_hour" | "no_reminder";

export interface RecoveryReportingScope {
  asOf: string;
  coverage: DayRange;
  range: DayRange;
  resultsCompleteThrough: string | null;
}

export interface RecoveryTimingArmSummary {
  assignedFollowers: number;
  maturedFollowers: number;
  immatureFollowers: number;
  completedWithin48h: number;
  completionRate48h: number | null;
  attempted: number;
  sent: number;
  sendFailed: number;
  sendUncertain: number;
}
```

Complete the interfaces with every API field produced in Task 7. Extend `RecoveryReminderRow` with nullable version and timing arm plus `timingLabel`.

Change `recoveryApi.counts()` and `recoveryApi.metrics()` to accept a query string, matching `list()`.

- [ ] **Step 4: Implement presentation-only timing cards**

`DmRecoveryTimingSummary` receives a complete metrics object and renders API decisions. It may format numbers and dates, but it must not recalculate maturity, p-values, confidence intervals, harm, or winner state.

Use clear copy such as:

```text
Showing guide requests received Aug 1 to Aug 16.
Results are complete through Aug 13. 92 followers are still collecting 48-hour outcomes.
```

Treatment cards include attempted/sent/failure details. The no-reminder card says the reminder was intentionally withheld and exposes no send action.

- [ ] **Step 5: Run focused tests and confirm green**

Run: `npm --prefix web test -- DmRecoveryTimingSummary.test.tsx dateRange.test.ts`

Expected: timing summary and date-range tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/types.ts web/src/lib/api.ts web/src/components/conversations/DmRecoveryTimingSummary.tsx web/src/components/conversations/DmRecoveryTimingSummary.test.tsx web/src/lib/dateRange.test.ts
git commit -m "feat: add recovery timing summary cards"
```

---

### Task 9: Integrate the Date-Scoped Recovery Lens, Detail, and Browser Flow

**Files:**
- Modify: `web/src/components/conversations/DmRecoveryList.tsx`
- Modify: `web/src/components/conversations/DmRecoveryList.test.tsx`
- Modify: `web/src/components/conversations/DmRecoveryDrawer.tsx`
- Modify: `web/src/components/conversations/DmRecoveryDrawer.test.tsx`
- Modify: `web/src/components/conversations/dmRecoveryViewModel.ts`
- Modify: `web/src/components/conversations/dmRecoveryViewModel.test.ts`
- Modify: `web/e2e/main.tsx`
- Modify: `web/e2e/recovery-reminders.spec.ts`

**Interfaces:**
- Metrics loads first and establishes `from`, `to`, and server `asOf` for list and counts.
- Date range defaults to `30d`; the same range updates summary cards, tabs, and rows.
- The old cohort select becomes a user-facing timing select for v2: all timings, 2-hour, 6-hour, and no reminder.
- Detail shows persisted experiment version and timing arm. V2 no-reminder controls never show Cancel.

- [ ] **Step 1: Write failing list orchestration tests**

Update API mocks so the initial metrics response supplies coverage and range. Assert list/count queries do not run until the server scope exists, then receive identical parameters:

```ts
expect(metrics).toHaveBeenCalledWith("");
expect(counts).toHaveBeenCalledWith(
  "from=2026-07-18&to=2026-08-16&asOf=2026-08-17T03%3A00%3A00.000Z",
);
expect(list).toHaveBeenCalledWith(expect.stringContaining(
  "from=2026-07-18&to=2026-08-16&asOf=2026-08-17T03%3A00%3A00.000Z",
));
```

Assert `30d` starts selected, preset and custom changes refetch metrics before rows/counts move to the new effective scope, every query key includes the full range and `asOf`, and pagination reuses the opaque cursor without changing scope.

- [ ] **Step 2: Write failing UI behavior tests**

Cover:

- all five date controls are accessible;
- date explanatory copy is visible;
- timing filter sends `timingArm=two_hour`, `six_hour`, or `no_reminder`;
- all three summary cards render;
- current status tabs and keyword filter remain functional;
- empty v2 coverage says the timing experiment has no requests yet and still shows health;
- legacy experiment cards remain visible before v2 coverage begins;
- a row shows `2-hour reminder`, `6-hour reminder`, or `No reminder` rather than Treatment/Control jargon;
- a v2 no-reminder row has `canCancel=false`, while a legacy cancellable control keeps its existing behavior;
- drawer shows version and timing arm and has no send or cancel action for a no-reminder control.

- [ ] **Step 3: Run focused frontend tests and confirm red**

Run: `npm --prefix web test -- DmRecoveryList.test.tsx DmRecoveryDrawer.test.tsx dmRecoveryViewModel.test.ts`

Expected: failures because queries are unscoped, the UI has a cohort selector, and v2 controls are treated like legacy controls.

- [ ] **Step 4: Integrate metrics-first scope ownership**

Keep requested preset/custom range state in `DmRecoveryList`, but use only the server-returned effective range for rows and counts. The flow is:

```text
requested range -> metrics -> effective range plus server asOf -> counts and paginated list
```

On a range change, keep old rows visually marked as loading or clear them until the new metrics scope returns. Never display rows from the old scope under new date buttons.

Reuse `RangeFilter`. Replace the v2 cohort selector with timing labels. Preserve the keyword selector and all current status views.

- [ ] **Step 5: Add timing-aware view and drawer language**

In `recoveryStatusView()` compute cancellation as:

```ts
const immutableExperimentControl =
  row.experimentVersion === "read-recovery-timing-v2" &&
  row.timingArm === "no_reminder";
const canCancel =
  CANCELLABLE.has(row.status) &&
  row.sentAt === null &&
  !immutableExperimentControl;
```

Label v2 control as `No-reminder experiment arm` and explain that it is intentionally held back for measurement. Keep legacy control language unchanged. In the drawer, show `Timing experiment`, the timing label, accepted time, and treatment eligibility when applicable.

- [ ] **Step 6: Update browser fixtures and end-to-end coverage**

Make the E2E metrics fixture establish a fixed server scope. Ensure mocked list/count handlers validate and echo the same scope. Add scenarios for all three arms, an immature follower, and a no-reminder control.

Add browser tests that select `7d`, `14d`, `30d`, `All`, and a custom range; verify summary and row counts change together; open each arm detail; and prove the no-reminder control offers neither Send nor Cancel. Retain existing evidence-language, circuit, cancellation, review, and legacy-lens tests.

- [ ] **Step 7: Run frontend unit and browser tests**

Run:

```bash
npm --prefix web test -- DmRecoveryTimingSummary.test.tsx DmRecoveryList.test.tsx DmRecoveryDrawer.test.tsx dmRecoveryViewModel.test.ts
npm --prefix web run test:e2e -- recovery-reminders.spec.ts
```

Expected: all focused unit and recovery browser scenarios pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/conversations/DmRecoveryList.tsx web/src/components/conversations/DmRecoveryList.test.tsx web/src/components/conversations/DmRecoveryDrawer.tsx web/src/components/conversations/DmRecoveryDrawer.test.tsx web/src/components/conversations/dmRecoveryViewModel.ts web/src/components/conversations/dmRecoveryViewModel.test.ts web/e2e/main.tsx web/e2e/recovery-reminders.spec.ts
git commit -m "feat: add date-based recovery timing dashboard"
```

---

### Task 10: Document Cutover, Verify the Full System, and Prepare Activation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/meta-verification.md`
- Create: `docs/dm-recovery-timing-experiment-runbook.md`

**Interfaces:**
- Documents code deployment before v2 activation, exact version and flag rules, blinded day-28/day-35 checks, mandatory day-42 cutoff, 48-hour maturation wait, monitoring, rollback, and owner-reviewed rollout.
- Does not change production configuration as part of the code commit.

- [ ] **Step 1: Write the runbook and configuration documentation**

Replace the old two-week 90/10 experiment language with the versioned timing experiment. Document:

- deploy schema and compatible code while v1 remains configured;
- confirm the migration and all real-Postgres contracts before activation;
- configure version `read-recovery-timing-v2`, a start instant, a maximum end exactly 42 days later, and post-experiment disabled;
- leave the legacy delay and holdout values documented as v1-only inputs;
- verify the first persisted row in each arm, without logging follower identity;
- audit the first 20 actual treatment comments against stored evidence and Instagram;
- review aggregate allocation after 100 unique followers;
- at day 28 and day 35, inspect only matured assignment counts, not completion outcomes;
- close enrollment at the recorded cutoff when both timing arms reach 1,700 matured followers, or at day 42 regardless;
- wait 48 hours after cutoff before final analysis;
- use the full experiment range for the decision;
- require owner review before any rollout;
- disable `DM_RECOVERY_ENABLED` for emergency rollback without deleting or reassigning rows.

- [ ] **Step 2: Run all root verification**

Run:

```bash
npm test
npm run build
```

Expected: every root Vitest suite passes and TypeScript builds after Prisma generation.

- [ ] **Step 3: Run all web verification**

Run:

```bash
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
npm --prefix web run test:e2e
```

Expected: all frontend unit tests, lint, production build, and Playwright scenarios pass.

- [ ] **Step 4: Run the real migration contract with local PostgreSQL**

Set `DATABASE_URL` and `MIGRATION_TEST_DATABASE_URL` to the same disposable localhost PostgreSQL database, then run:

```bash
npx vitest run src/services/dmRecoveryDatabaseContract.test.ts
```

Expected: no skips, and all migration, RLS, constraint, immutability, control, and claim contracts pass. Do not activate v2 if this suite is skipped.

- [ ] **Step 5: Review the implementation against the approved spec**

Check every acceptance criterion in the spec against a passing automated test or a named runbook verification. Search for stale timing assumptions:

```bash
rg -n "ten-hour|10-hour|two-week|90/10|DM_RECOVERY_DELAY_HOURS|DM_RECOVERY_HOLDOUT_PERCENT" src web docs .env.example
rg -n "read-recovery-timing-v2|two_hour|six_hour|no_reminder" src web prisma docs
```

Expected: remaining ten-hour, two-week, 90/10, delay, and holdout references are explicitly labelled v1 or historical context. Every v2 path names the approved version and arms.

- [ ] **Step 6: Commit documentation and final verification fixes**

```bash
git add .env.example README.md docs/meta-verification.md docs/dm-recovery-timing-experiment-runbook.md
git commit -m "docs: add recovery timing experiment runbook"
```

- [ ] **Step 7: Request code review before activation**

Use `superpowers:requesting-code-review` against the full implementation diff. Resolve findings with `superpowers:receiving-code-review`, rerun the affected focused tests, then repeat the full verification commands above. Activation remains a separate, explicitly authorized production operation.
