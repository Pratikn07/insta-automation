# Instagram Read-Recovery Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically post one safe, auditable public reply on the original Instagram comment when an accepted gate DM still has no confirmed read or engagement after ten hours, or immediately when Meta returns an allowlisted message-settings rejection.

**Architecture:** Persist one `DmRecoveryReminder` state-machine row per prospective comment-origin recovery. Correlate accepted gate DMs with Meta message IDs, ingest positive read and engagement webhooks, evaluate a pure decision policy, and let a leased/paced worker send public replies only after a final transactional recheck. Expose the state, experiment metrics, and owner controls in a dedicated Conversations dashboard lens.

**Tech Stack:** TypeScript, Node.js/Express, Prisma 5, PostgreSQL/Supabase, React 19, React Router 7, Vite 8, Vitest, Testing Library, Playwright

**Approved Design:** `docs/superpowers/specs/2026-08-06-instagram-read-recovery-reminders-design.md`

## Global Constraints

- Implement only prospective comment-origin keyword journeys. Do not backfill historical `No reply` rows.
- Treat `messaging_seen` and engagement as positive suppression evidence. Absence of those signals means **No confirmed read**, never proof of unread delivery.
- Use the exact approved copy:
  - No confirmed read: `I sent your guide 💛 Check your DMs/Requests. If you don’t see it, DM @tinysoho “{KEYWORD}”.`
  - Verified settings blocked: `I couldn’t send your DM 💛 Your message-request settings blocked it. DM @tinysoho “{KEYWORD}”.`
- Replace `{KEYWORD}` only with the snapshotted configured keyword. Never interpolate user-authored text.
- The ten-hour clock begins at Meta acceptance, not comment creation. Overdue reminders do not expire because a worker was offline.
- Enforce at most one automated public recovery reply per Instagram user in any rolling 24-hour period. The most recently eligible record wins.
- Use deterministic per-user 90/10 treatment/control assignment for the two-week experiment. Settings-blocked fallbacks are always treatment and excluded from that experiment.
- Never auto-retry an ambiguous public-comment send. Put it in `send_uncertain` for review.
- Keep Graph access tokens, raw provider responses, raw provider error bodies, and private DM content out of recovery rows and logs.
- Never perform a network call while holding a database transaction.
- Keep all background worker entrypoints non-throwing so one bad record cannot stop the interval.
- New Supabase-facing tables must have row-level security enabled and no anonymous/authenticated Data API policies. The backend continues to use its trusted database connection.
- Preserve existing business-account self-comment protection, conversation behavior, gate retry pacing, and all unrelated dashboard workflows.

---

## Exact File Map

### Create

- `prisma/migrations/20260806210000_add_dm_recovery_reminders/migration.sql` — enums, recovery/control tables, outbound/read fields, queue safety fields, indexes, foreign keys, checks, and RLS.
- `src/services/dmRecoveryPolicy.ts` and `src/services/dmRecoveryPolicy.test.ts` — approved copy, deterministic cohorting, and pure eligibility decisions.
- `src/services/graphErrorClassifier.ts` and `src/services/graphErrorClassifier.test.ts` — allowlisted private-DM and public-reply error classification.
- `src/services/dmRecoveryService.ts` and `src/services/dmRecoveryService.test.ts` — create/upsert recovery rows and apply positive evidence.
- `src/services/dmRecoveryRepository.ts` and `src/services/dmRecoveryRepository.test.ts` — due-record selection, atomic leases, per-person winner/cooldown enforcement, and final state transitions.
- `src/services/dmRecoveryHealth.ts` and `src/services/dmRecoveryHealth.test.ts` — persistent circuit breaker and sampled failure-rate protection.
- `src/services/dmRecoveryWorker.ts` and `src/services/dmRecoveryWorker.test.ts` — paced send orchestration and safe retry/failure handling.
- `src/services/dmRecoveryDatabaseContract.test.ts` — optional real-Postgres migration, RLS, uniqueness, and claim-concurrency contract tests.
- `src/config/env.test.ts` — recovery configuration defaults and experiment-window validation.
- `src/meta/replyToComment.test.ts` — confirmed public-reply identifier behavior.
- `src/services/gateQueueService.test.ts` and `src/services/keywordBackfillService.test.ts` — source metadata persistence across retry/backfill paths.
- `src/handlers/seenHandler.ts`, `src/handlers/reactionHandler.ts`, `src/handlers/postbackHandler.ts`, and focused tests beside them — Meta status/engagement ingestion.
- `src/api/recoveryReminders.routes.ts` and `src/api/recoveryReminders.routes.test.ts` — list, counts, metrics, detail, cancel, and review endpoints.
- `src/api/conversations.routes.test.ts` — prospective recovery summary and pre-tracking journey language contract.
- `web/src/components/conversations/DmRecoveryList.tsx` and `DmRecoveryList.test.tsx` — recovery filters, counts, rows, and pagination.
- `web/src/components/conversations/DmRecoveryDrawer.tsx` and `DmRecoveryDrawer.test.tsx` — evidence timeline and owner actions.
- `web/src/components/conversations/dmRecoveryViewModel.ts` and `dmRecoveryViewModel.test.ts` — uncertainty-aware labels and badges.
- `web/src/pages/Conversations.test.tsx` — lens integration and legacy-language regression coverage.
- `web/e2e/recovery-reminders.spec.ts` — full recovery dashboard browser scenarios.

### Modify

- `prisma/schema.prisma` — new enums/models/relations plus `DmMessage.seenAt`, `DmMessage.deletedAt`, and `GateQueue` send-claim fields.
- `src/config/env.ts`, `.env.example` — disabled-by-default worker, timing, pacing, cohort, classifier, and health controls.
- `src/types/meta.ts` — `read`, `reaction`, `postback`, quick-reply, deletion, and public-comment result shapes.
- `src/meta/replyToComment.ts` — return the public reply ID when Meta supplies it.
- `src/services/dmThreadService.ts`, `src/services/dmDeliveryService.ts`, and tests — return local and Meta outbound identifiers without making tracking failure look like delivery failure.
- `src/handlers/commentHandler.ts` and tests — schedule accepted-DM recovery after the Meta success boundary.
- `src/services/gateQueueService.ts`, `src/services/gateQueueWorker.ts`, and tests — retain `mediaId`, use a send lease, classify verified settings blocks, and avoid private-DM duplicates after ambiguous outcomes.
- `src/handlers/webhookRouter.ts`, `src/handlers/webhookRouter.test.ts` — route each supported messaging event to one focused handler.
- `src/handlers/messageHandler.ts`, `src/handlers/messageHandler.test.ts` — suppress on every captured inbound engagement and preserve deleted-message semantics.
- `src/services/conversationService.ts`, `src/services/conversationService.test.ts` — suppress matching unfinished recovery rows transactionally on completion.
- `src/services/keywordBackfillService.ts` and tests — preserve `mediaId` when reconstructing a pending gate send.
- `src/server.ts`, `src/server.test.ts` — start the non-overlapping recovery worker only when enabled.
- `src/api/router.ts` — mount the admin-only recovery router.
- `src/api/conversations.routes.ts` — attach a bounded recovery summary/read-tracking marker to journey rows.
- `web/src/lib/types.ts`, `web/src/lib/api.ts` — typed recovery API contracts and calls.
- `web/package.json`, `web/package-lock.json` — DOM component-test dependencies for the new interactive lens.
- `web/src/pages/Conversations.tsx`, `web/src/pages/Conversations.test.tsx` — add the `DM recovery` lens without changing the existing lens defaults.
- `web/e2e/main.tsx` — deterministic API fixtures for recovery E2E tests.
- `README.md`, `docs/meta-verification.md` — subscriptions, rollout, verification, rollback, and incident checks.

---

### Task 1: Add the Durable Recovery Schema and Migration Contract

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260806210000_add_dm_recovery_reminders/migration.sql`
- Create: `src/services/dmRecoveryDatabaseContract.test.ts`

**Interfaces:**
- Consumes: existing `Conversation`, `Keyword`, `IgUser`, `DmMessage`, and `GateQueue` rows.
- Produces: `DmRecoveryReminder`, singleton `DmRecoveryControl`, typed Prisma relations, exact-message correlation, send leases, and required database constraints.

- [ ] **Step 1: Write the failing migration contract test**

Use the same `MIGRATION_TEST_DATABASE_URL` guard and localhost-only protection as `src/services/replyDraftDatabaseContract.test.ts`. Apply all migrations to a temporary local database, then assert the new database contract with raw SQL:

```ts
it.runIf(process.env.MIGRATION_TEST_DATABASE_URL)(
  "creates the recovery state machine with RLS and idempotency constraints",
  async () => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('dm_recovery_reminder', 'dm_recovery_control')
      ORDER BY table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual([
      "dm_recovery_control",
      "dm_recovery_reminder",
    ]);

    const rls = await prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN ('dm_recovery_reminder', 'dm_recovery_control')
      ORDER BY relname
    `;
    expect(rls).toEqual([
      { relname: "dm_recovery_control", relrowsecurity: true },
      { relname: "dm_recovery_reminder", relrowsecurity: true },
    ]);
  },
);
```

Add contract cases that prove:

```ts
await expect(
  prisma.dmRecoveryReminder.create({ data: makeReminder({ commentId: "same-comment" }) }),
).resolves.toBeDefined();
await expect(
  prisma.dmRecoveryReminder.create({ data: makeReminder({ commentId: "same-comment" }) }),
).rejects.toMatchObject({ code: "P2002" });
```

Also assert that `DmMessage.seen_at`, `DmMessage.deleted_at`, `GateQueue.claim_expires_at`, and `GateQueue.media_id` exist; all recovery/event/lease timestamps use PostgreSQL `timestamp with time zone`; the partial one-`sending`-row-per-user unique index exists; and no permissive RLS policy was added for either recovery table.

- [ ] **Step 2: Run the database contract and verify RED**

Run:

```bash
MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npm test -- --run src/services/dmRecoveryDatabaseContract.test.ts
```

Expected with the local migration-test database configured: FAIL because the recovery tables and added columns do not exist. If that variable is unavailable, record the test as skipped and run `npx prisma validate`; it must still show that the planned model is absent before implementation.

- [ ] **Step 3: Add the Prisma enums, models, and relations**

Add these enums:

```prisma
enum DmRecoveryTriggerKind {
  no_confirmed_read
  settings_blocked

  @@map("dm_recovery_trigger_kind")
}

enum DmRecoveryStatus {
  waiting
  control
  suppressed
  sending
  sent
  send_failed
  send_uncertain
  tracking_unavailable
  cancelled

  @@map("dm_recovery_status")
}

enum DmRecoveryCohort {
  treatment
  control
  not_applicable

  @@map("dm_recovery_cohort")
}
```

Add `seenAt DateTime? @map("seen_at") @db.Timestamptz(3)` and `deletedAt DateTime? @map("deleted_at") @db.Timestamptz(3)` to `DmMessage`. Add `mediaId String? @map("media_id")`, `claimedAt DateTime? @map("claimed_at") @db.Timestamptz(3)`, and `claimExpiresAt DateTime? @map("claim_expires_at") @db.Timestamptz(3)` to `GateQueue`.

Add the state-machine model with inverse relations on `Conversation`, `Keyword`, `IgUser`, and `DmMessage`:

```prisma
model DmRecoveryReminder {
  id                     String                @id @default(uuid()) @db.Uuid
  conversationId         String                @map("conversation_id") @db.Uuid
  igUserId               String                @map("ig_user_id")
  keywordId              String                @map("keyword_id") @db.Uuid
  keywordSnapshot        String                @map("keyword_snapshot")
  templateVersion        String                @map("template_version")
  publicReplyText        String                @map("public_reply_text")
  commentId              String                @unique @map("comment_id")
  mediaId                String?               @map("media_id")
  gateDmMessageId        String?               @map("gate_dm_message_id") @db.Uuid
  instagramGateMessageId String?               @unique @map("instagram_gate_message_id")
  triggerKind            DmRecoveryTriggerKind @map("trigger_kind")
  status                 DmRecoveryStatus
  cohort                 DmRecoveryCohort
  acceptedAt             DateTime?             @map("accepted_at") @db.Timestamptz(3)
  eligibleAt             DateTime              @map("eligible_at") @db.Timestamptz(3)
  seenAt                 DateTime?             @map("seen_at") @db.Timestamptz(3)
  seenReceivedAt         DateTime?             @map("seen_received_at") @db.Timestamptz(3)
  engagedAt              DateTime?             @map("engaged_at") @db.Timestamptz(3)
  engagedReceivedAt      DateTime?             @map("engaged_received_at") @db.Timestamptz(3)
  firstEngagementKind    String?               @map("first_engagement_kind")
  repliedAt              DateTime?             @map("replied_at") @db.Timestamptz(3)
  repliedReceivedAt      DateTime?             @map("replied_received_at") @db.Timestamptz(3)
  reactedAt              DateTime?             @map("reacted_at") @db.Timestamptz(3)
  postbackAt             DateTime?             @map("postback_at") @db.Timestamptz(3)
  suppressedAt           DateTime?             @map("suppressed_at") @db.Timestamptz(3)
  suppressionReason      String?               @map("suppression_reason")
  claimedAt              DateTime?             @map("claimed_at") @db.Timestamptz(3)
  claimExpiresAt         DateTime?             @map("claim_expires_at") @db.Timestamptz(3)
  nextAttemptAt          DateTime?             @map("next_attempt_at") @db.Timestamptz(3)
  attempts               Int                   @default(0)
  lastAttemptAt          DateTime?             @map("last_attempt_at") @db.Timestamptz(3)
  publicReplyId          String?               @map("public_reply_id")
  sentAt                 DateTime?             @map("sent_at") @db.Timestamptz(3)
  lastErrorCategory      String?               @map("last_error_category")
  reviewedAt             DateTime?             @map("reviewed_at") @db.Timestamptz(3)
  cancelledAt            DateTime?             @map("cancelled_at") @db.Timestamptz(3)
  createdAt              DateTime              @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt              DateTime              @updatedAt @map("updated_at") @db.Timestamptz(3)

  conversation  Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  igUser        IgUser       @relation(fields: [igUserId], references: [id], onDelete: Cascade)
  keyword       Keyword      @relation(fields: [keywordId], references: [id], onDelete: Restrict)
  gateDmMessage DmMessage?   @relation(fields: [gateDmMessageId], references: [id], onDelete: SetNull)

  @@index([status, eligibleAt, nextAttemptAt])
  @@index([igUserId, sentAt])
  @@index([igUserId, keywordId, status])
  @@index([cohort, eligibleAt])
  @@map("dm_recovery_reminder")
}

model DmRecoveryControl {
  id          Int      @id @default(1)
  circuitOpen Boolean  @default(false) @map("circuit_open")
  reason      String?
  openedAt    DateTime? @map("opened_at") @db.Timestamptz(3)
  resetAt     DateTime? @map("reset_at") @db.Timestamptz(3)
  resetBy     String?   @map("reset_by")
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@map("dm_recovery_control")
}
```

- [ ] **Step 4: Write the SQL migration explicitly**

Create the enum types, timestamptz columns, snake_case tables, indexes, and foreign keys represented by the Prisma schema. Add database checks that `attempts >= 0`, singleton control `id = 1`, and terminal state timestamps are internally consistent where practical. Add a partial unique index on `ig_user_id WHERE status = 'sending'` so the database cannot hold two concurrent public-send claims for one person. Seed the control row with `INSERT INTO "dm_recovery_control" ("id", "circuit_open", "updated_at") VALUES (1, false, NOW()) ON CONFLICT ("id") DO NOTHING`.

Finish the migration with:

```sql
ALTER TABLE "dm_recovery_reminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dm_recovery_control" ENABLE ROW LEVEL SECURITY;
```

Do not create `anon` or `authenticated` policies.

- [ ] **Step 5: Generate Prisma and verify GREEN**

Run:

```bash
npx prisma format
npx prisma validate
npx prisma generate
npm test -- --run src/services/dmRecoveryDatabaseContract.test.ts
```

Expected: schema validation and generation succeed; database contract passes when configured or skips only because the optional local database variable is absent.

- [ ] **Step 6: Commit the schema slice**

```bash
git add prisma/schema.prisma \
  prisma/migrations/20260806210000_add_dm_recovery_reminders/migration.sql \
  src/services/dmRecoveryDatabaseContract.test.ts
git commit -m "feat: add dm recovery state schema"
```

---

### Task 2: Add Configuration, Approved Copy, and the Pure Decision Policy

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Create: `src/config/env.test.ts`
- Create: `src/services/dmRecoveryPolicy.ts`
- Create: `src/services/dmRecoveryPolicy.test.ts`

**Interfaces:**
- Consumes: recovery row snapshot, current time, person cooldown evidence, experiment dates/version, and configured thresholds.
- Produces: deterministic cohort assignment, exact rendered public text, and one of `wait`, `holdout`, `suppress`, `send_settings_fallback`, or `send_no_confirmed_read_reminder`.

- [ ] **Step 1: Write failing copy and policy tests**

Create table-driven tests that pin exact punctuation and all approved policy branches:

```ts
expect(renderRecoveryCopy("no_confirmed_read", "PROTEIN")).toBe(
  "I sent your guide 💛 Check your DMs/Requests. If you don’t see it, DM @tinysoho “PROTEIN”.",
);
expect(renderRecoveryCopy("settings_blocked", "SLEEP")).toBe(
  "I couldn’t send your DM 💛 Your message-request settings blocked it. DM @tinysoho “SLEEP”.",
);

it.each([
  ["seen", { seenAt: now }],
  ["inbound_reply", { engagedAt: now, firstEngagementKind: "inbound_reply" }],
  ["reaction", { engagedAt: now, firstEngagementKind: "reaction" }],
  ["postback", { engagedAt: now, firstEngagementKind: "postback" }],
  ["completed", { conversationCompletedAt: now }],
  ["cancelled", { cancelledAt: now }],
])("suppresses for %s", (reason, evidence) => {
  expect(decideRecovery(baseInput(evidence))).toEqual({ kind: "suppress", reason });
});

expect(decideRecovery(baseInput({ now: hour(9, 59) }))).toEqual({ kind: "wait" });
expect(decideRecovery(baseInput({ now: hour(10), cohort: "control" }))).toEqual({ kind: "holdout" });
expect(decideRecovery(baseInput({ now: hour(10), cohort: "treatment" }))).toEqual({
  kind: "send_no_confirmed_read_reminder",
});
expect(decideRecovery(settingsBlockedInput())).toEqual({ kind: "send_settings_fallback" });
```

Add cases for: tracking unavailable; terminal status; another confirmed or outcome-uncertain public reminder attempt within 24 hours; a settings-blocked fallback also respecting that same person cooldown; a more recent eligible candidate for the same person; overdue by 29 hours after worker recovery; delayed seen/engagement received after eligibility but with an event timestamp before the final send; public comment activity not counting as DM read/engagement; missing source comment; DM-origin records being impossible to create; pre-experiment withholding; post-experiment withholding before review; and new post-review treatment without releasing a previously stored control row.

Pin cohort stability:

```ts
expect(assignRecoveryCohort("ig-123", "read-recovery-v1", 10)).toBe(
  assignRecoveryCohort("ig-123", "read-recovery-v1", 10),
);
expect(
  Array.from({ length: 10_000 }, (_, i) => assignRecoveryCohort(`ig-${i}`, "read-recovery-v1", 10))
    .filter((cohort) => cohort === "control").length,
).toBeGreaterThanOrEqual(900);
```

In `src/config/env.test.ts`, reuse a complete schema-valid environment object and pin defaults/cross-field validation:

```ts
expect(envSchema.parse(baseEnv)).toMatchObject({
  DM_RECOVERY_ENABLED: false,
  DM_RECOVERY_DELAY_HOURS: 10,
  DM_RECOVERY_COOLDOWN_HOURS: 24,
  DM_RECOVERY_HOLDOUT_PERCENT: 10,
  DM_RECOVERY_MAX_ATTEMPTS: 3,
  DM_RECOVERY_POST_EXPERIMENT_ENABLED: false,
});
expect(
  envSchema.safeParse({ ...baseEnv, DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-06T08:00:00Z" })
    .success,
).toBe(false);
expect(
  envSchema.safeParse({
    ...baseEnv,
    DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-20T08:00:00Z",
    DM_RECOVERY_EXPERIMENT_END_AT: "2026-08-06T08:00:00Z",
  }).success,
).toBe(false);
expect(
  envSchema.safeParse({ ...baseEnv, DM_RECOVERY_ENABLED: "true" }).success,
).toBe(false);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --run src/services/dmRecoveryPolicy.test.ts`

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement the policy types and fixed templates**

Use closed unions so callers cannot invent states or suppression reasons:

```ts
export const RECOVERY_TEMPLATE_VERSION = "v1";

export type RecoverySuppressionReason =
  | "seen"
  | "inbound_reply"
  | "quick_reply"
  | "attachment"
  | "reaction"
  | "postback"
  | "completed"
  | "completed_elsewhere"
  | "person_cooldown"
  | "newer_candidate"
  | "source_unavailable"
  | "owner_cancelled";

export type RecoveryDecision =
  | { kind: "wait" }
  | { kind: "holdout" }
  | { kind: "suppress"; reason: RecoverySuppressionReason }
  | { kind: "send_settings_fallback" }
  | { kind: "send_no_confirmed_read_reminder" };

export function renderRecoveryCopy(
  trigger: "no_confirmed_read" | "settings_blocked",
  keywordSnapshot: string,
): string {
  return trigger === "settings_blocked"
    ? `I couldn’t send your DM 💛 Your message-request settings blocked it. DM @tinysoho “${keywordSnapshot}”.`
    : `I sent your guide 💛 Check your DMs/Requests. If you don’t see it, DM @tinysoho “${keywordSnapshot}”.`;
}
```

Normalize the configured keyword to its already-validated stored form; reject an empty snapshot instead of falling back to comment text.

- [ ] **Step 4: Implement deterministic cohorting and policy precedence**

Hash `${experimentVersion}:${igUserId}` with Node's `createHash("sha256")`, take an unsigned 32-bit prefix, and assign `control` when `bucket < holdoutPercent`. Policy precedence must be exactly:

1. terminal/cancelled -> no send;
2. positive read/engagement/completion -> suppress;
3. unavailable source comment -> suppress;
4. tracking unavailable -> no automatic send;
5. recent confirmed or outcome-uncertain reminder attempt for the person -> suppress by cooldown;
6. newer currently eligible candidate exists -> suppress as superseded;
7. settings blocked -> immediate fallback;
8. before `eligibleAt` -> wait;
9. control -> holdout;
10. otherwise send the no-confirmed-read reminder.

The pure function must not read environment variables or call Prisma.

- [ ] **Step 5: Add validated environment controls**

Extend the Zod schema with these disabled-by-default settings and cross-field checks:

```ts
DM_RECOVERY_ENABLED: booleanFlag(false),
DM_RECOVERY_DELAY_HOURS: z.coerce.number().int().min(1).max(168).default(10),
DM_RECOVERY_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(168).default(24),
DM_RECOVERY_WORKER_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
DM_RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(5),
DM_RECOVERY_HOURLY_CAP: z.coerce.number().int().min(1).max(200).default(30),
DM_RECOVERY_LEASE_MS: z.coerce.number().int().min(60_000).default(900_000),
DM_RECOVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
DM_RECOVERY_RETRY_BASE_MS: z.coerce.number().int().min(60_000).default(300_000),
DM_RECOVERY_HOLDOUT_PERCENT: z.coerce.number().int().min(0).max(50).default(10),
DM_RECOVERY_EXPERIMENT_VERSION: z.string().min(1).default("read-recovery-v1"),
DM_RECOVERY_EXPERIMENT_START_AT: z.string().datetime().optional(),
DM_RECOVERY_EXPERIMENT_END_AT: z.string().datetime().optional(),
DM_RECOVERY_POST_EXPERIMENT_ENABLED: booleanFlag(false),
DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES: z.string().default(""),
DM_RECOVERY_HEALTH_SAMPLE_SIZE: z.coerce.number().int().min(10).max(500).default(50),
DM_RECOVERY_FAILURE_RATE_PERCENT: z.coerce.number().int().min(1).max(100).default(50),
DM_RECOVERY_BACKLOG_ALERT_THRESHOLD: z.coerce.number().int().min(1).default(500),
DM_RECOVERY_DB_FAILURE_THRESHOLD: z.coerce.number().int().min(2).max(20).default(3),
DM_RECOVERY_MIN_ACCEPTED_HEALTH_SAMPLE: z.coerce.number().int().min(5).max(500).default(20),
```

Require experiment start/end to be both absent or both present, with end strictly after start; `DM_RECOVERY_ENABLED=true` requires both timestamps. When no window is configured, candidates are recorded as control with reason `experiment_not_configured` and cannot send. With a configured window, pre-window candidates are withheld, in-window candidates use deterministic 90/10 assignment, and post-window candidates are withheld until `DM_RECOVERY_POST_EXPERIMENT_ENABLED=true`. That flag applies only to newly created post-review records; previously stored controls are never released retroactively. Parse signatures later as exact `code:subcode` pairs. Add each variable and purpose to `.env.example`, leaving the signature allowlist empty until a real structured Meta response is verified.

- [ ] **Step 6: Run focused and configuration tests and verify GREEN**

Run:

```bash
npm test -- --run src/services/dmRecoveryPolicy.test.ts src/config/env.test.ts
npm run build
```

Expected: policy/configuration tests pass and TypeScript compiles.

- [ ] **Step 7: Commit the policy slice**

```bash
git add src/config/env.ts src/config/env.test.ts .env.example \
  src/services/dmRecoveryPolicy.ts src/services/dmRecoveryPolicy.test.ts
git commit -m "feat: define dm recovery policy"
```

---

### Task 3: Classify Graph Failures Without Guessing From Error Text

**Files:**
- Create: `src/services/graphErrorClassifier.ts`
- Create: `src/services/graphErrorClassifier.test.ts`

**Interfaces:**
- Consumes: `GraphErrorMetadata` from the existing safe error parser plus configured exact `code:subcode` signatures.
- Produces: private-gate classification and public-comment classification that never depend on localized message text.

- [ ] **Step 1: Write the failing classifier matrix**

```ts
it.each([
  [graphMetadata({ graphCode: 10, graphSubcode: 12345 }), ["10:12345"], "settings_blocked"],
  [graphMetadata({ graphCode: 10, graphSubcode: 99999 }), ["10:12345"], "permission_or_auth"],
  [graphMetadata({ graphCode: 4, graphSubcode: 2534025 }), ["4:2534025"], "rate_limited"],
  [graphMetadata({ graphCode: 4 }), [], "rate_limited"],
  [graphMetadata({ httpStatus: 503 }), [], "retryable_transport"],
  [graphMetadata({ httpStatus: 400, graphCode: 100 }), [], "permanent"],
])("classifies private gate failures", (metadata, allowlist, expected) => {
  expect(classifyPrivateGateFailure(metadata, allowlist)).toBe(expected);
});

expect(
  classifyPrivateGateFailure(graphMetadata({ httpStatus: 400 }), []),
).not.toBe("settings_blocked");
expect(
  classifyPrivateGateFailure(
    graphMetadata({ graphCode: 4, graphSubcode: 2534025 }),
    ["4:2534025"],
  ),
)
  .toBe("rate_limited");
```

Define `graphMetadata(overrides)` in the test to return a complete `GraphErrorMetadata` with `category`, `httpStatus`, `graphCode`, `graphSubcode`, and `traceId`. Error-message text is not an input to the classifier at all.

Add public-reply cases for: 429/rate limit -> `safe_retry`; auth/permission -> `open_circuit`; deleted/hidden comment or invalid object -> `permanent`; HTTP timeout/network reset/response without an ID -> `uncertain`; success with an ID handled outside the classifier.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/services/graphErrorClassifier.test.ts`

Expected: FAIL because the classifier is not implemented.

- [ ] **Step 3: Implement exact signature parsing and precedence**

```ts
export type PrivateGateFailure =
  | "settings_blocked"
  | "rate_limited"
  | "permission_or_auth"
  | "retryable_transport"
  | "permanent"
  | "uncertain";

export function parseGraphSignatures(value: string): ReadonlySet<string> {
  return new Set(
    value.split(",").map((part) => part.trim()).filter((part) => /^\d+:\d+$/.test(part)),
  );
}
```

Check known rate-limit signatures—including subcode `2534025`—before checking the settings allowlist, so a bad configuration cannot turn a rate limit into a public fallback. Do not inspect `safeMessage` or raw error text for settings-blocked classification.

For public replies, distinguish failures known to occur before acceptance from ambiguous transport failures. The classifier returns only the stable category; the caller owns transitions.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- --run src/services/graphErrorClassifier.test.ts src/services/eventLogger.test.ts
npm run build
```

Expected: all focused tests pass and no sensitive provider data enters logged metadata.

- [ ] **Step 5: Commit the classifier slice**

```bash
git add src/services/graphErrorClassifier.ts src/services/graphErrorClassifier.test.ts
git commit -m "feat: classify dm recovery graph failures"
```

---

### Task 4: Return Exact Outbound and Public-Reply Identifiers

**Files:**
- Modify: `src/types/meta.ts`
- Modify: `src/meta/replyToComment.ts`
- Create: `src/meta/replyToComment.test.ts`
- Modify: `src/services/dmThreadService.ts`
- Modify: `src/services/dmThreadService.test.ts`
- Modify: `src/services/dmDeliveryService.ts`
- Modify: `src/services/dmDeliveryService.test.ts`

**Interfaces:**
- Consumes: Meta's private-reply `{ message_id }`/recipient response and public-comment reply response.
- Produces: `{ instagramMessageId, dmMessageId, acceptedAt }` for accepted gate DMs and `{ replyId }` for confirmed public replies. A local tracking failure is represented explicitly and never reclassified as a Meta send failure.

- [ ] **Step 1: Write failing return-value tests**

Pin the service boundary:

```ts
it("returns the Meta and local identifiers after an accepted private reply", async () => {
  sendPrivateReply.mockResolvedValue({ messageId: "mid.accepted" });
  recordOutboundMessage.mockResolvedValue({ threadId: "thread-1", messageId: "dm-1" });

  await expect(sendTrackedPrivateReply(input)).resolves.toEqual({
    instagramMessageId: "mid.accepted",
    dmMessageId: "dm-1",
    acceptedAt: expect.any(Date),
  });
});

it("does not throw after Meta accepted when local outbound capture fails", async () => {
  sendPrivateReply.mockResolvedValue({ messageId: "mid.accepted" });
  recordOutboundMessage.mockResolvedValue(null);

  await expect(sendTrackedPrivateReply(input)).resolves.toEqual({
    instagramMessageId: "mid.accepted",
    dmMessageId: null,
    acceptedAt: expect.any(Date),
  });
});
```

For `replyToComment`, mock a Graph result with `id: "reply-1"` and assert `{ replyId: "reply-1" }`; mock a 2xx result without an ID and assert `{ replyId: null }`. The second case is intentionally ambiguous and must not be converted to success by this client.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- --run src/meta/replyToComment.test.ts \
  src/services/dmThreadService.test.ts src/services/dmDeliveryService.test.ts
```

Expected: FAIL because the current tracking methods return `void` and the public reply client discards its response.

- [ ] **Step 3: Return the local outbound capture result**

Change `recordOutboundMessage` to return:

```ts
export type RecordedOutboundMessage = {
  threadId: string;
  messageId: string;
};

export async function recordOutboundMessage(
  input: RecordOutboundInput,
): Promise<RecordedOutboundMessage | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const thread = await tx.dmThread.upsert({
        where: {
          igAccountId_igUserId: {
            igAccountId: input.igAccountId,
            igUserId: input.igUserId,
          },
        },
        create: {
          igAccountId: input.igAccountId,
          igUserId: input.igUserId,
          lastMessageAt: input.instagramTimestamp,
        },
        update: {},
        select: { id: true },
      });
      const message = await tx.dmMessage.create({
        data: {
          threadId: thread.id,
          instagramMessageId: input.instagramMessageId,
          direction: "outbound",
          type: input.messageType,
          source: input.source,
          text: input.text,
          mediaUrl: input.mediaUrl,
          instagramTimestamp: input.instagramTimestamp,
        },
        select: { id: true },
      });
      await tx.dmThread.update({
        where: { id: thread.id },
        data: {
          lastOutboundAt: input.instagramTimestamp,
          lastMessageAt: input.instagramTimestamp,
        },
      });
      return { threadId: thread.id, messageId: message.id };
    });
  } catch {
    logger.error(
      {
        errorCode: "dm_history_write_failed",
        igUserId: input.igUserId,
        instagramMessageId: input.instagramMessageId,
        source: input.source,
        length: input.text?.length ?? 0,
      },
      "Failed to record outbound DM (message was already delivered)",
    );
    return null;
  }
}
```

Do not stop swallowing the existing local capture exception: once Meta has accepted a send, the service must return the provider success to its caller. Existing callers may ignore the additive return value.

- [ ] **Step 4: Return a stable private-send receipt**

Make `recordDelivered` return the nullable local record while preserving its non-throwing contract. Capture `acceptedAt` immediately after `sendPrivateReply` resolves, then pass that same timestamp to local history:

```ts
export type TrackedPrivateReplyReceipt = {
  instagramMessageId: string | null;
  dmMessageId: string | null;
  acceptedAt: Date;
};

export type TrackedPrivateReplyInput = {
  recipientIgUserId: string;
  commentId: string;
  text: string;
  source: DmMessageSource;
};

async function recordDelivered(
  input: RecordOutboundInput,
): Promise<RecordedOutboundMessage | null> {
  try {
    return await recordOutboundMessage(input);
  } catch {
    logger.error(
      {
        errorCode: "dm_history_write_failed",
        igUserId: input.igUserId,
        instagramMessageId: input.instagramMessageId,
        source: input.source,
        length: input.text?.length ?? 0,
      },
      "Outbound DM was delivered but could not be recorded",
    );
    return null;
  }
}

export async function sendTrackedPrivateReply(
  input: TrackedPrivateReplyInput,
): Promise<TrackedPrivateReplyReceipt> {
  const result = await sendPrivateReply(input.commentId, input.text);
  const acceptedAt = new Date();
  const recorded = await recordDelivered({
    igAccountId: env.IG_USER_ID,
    igUserId: input.recipientIgUserId,
    instagramMessageId: result.messageId,
    text: input.text,
    messageType: "text",
    mediaUrl: null,
    source: input.source,
    instagramTimestamp: acceptedAt,
  });
  return {
    instagramMessageId: result.messageId,
    dmMessageId: recorded?.messageId ?? null,
    acceptedAt,
  };
}
```

The network rejection must still throw before a receipt is returned.

- [ ] **Step 5: Return the confirmed public-reply ID**

Extend the Meta result type and client:

```ts
export type MetaPublicReplyResult = { replyId: string | null };

export async function replyToComment(
  commentId: string,
  message: string,
): Promise<MetaPublicReplyResult> {
  const response = await graph.post<{ id?: unknown }>(`/${commentId}/replies`, { message });
  const id = response.data.id;
  logger.debug({ commentId }, "Posted public reply");
  return { replyId: typeof id === "string" && id.length > 0 ? id : null };
}
```

Do not synthesize an ID from `commentId`, and do not treat missing `id` as a confirmed send.

- [ ] **Step 6: Verify GREEN and run all existing delivery tests**

Run:

```bash
npm test -- --run src/meta/replyToComment.test.ts \
  src/services/dmThreadService.test.ts src/services/dmDeliveryService.test.ts \
  src/handlers/commentHandler.test.ts src/services/gateQueueWorker.test.ts
npm run build
```

Expected: focused tests pass; existing gate paths compile with the richer result.

- [ ] **Step 7: Commit the identifier boundary**

```bash
git add src/types/meta.ts src/meta/replyToComment.ts src/meta/replyToComment.test.ts \
  src/services/dmThreadService.ts src/services/dmThreadService.test.ts \
  src/services/dmDeliveryService.ts src/services/dmDeliveryService.test.ts
git commit -m "feat: retain recovery correlation identifiers"
```

---

### Task 5: Create Recovery Rows and Apply Positive Evidence Idempotently

**Files:**
- Create: `src/services/dmRecoveryService.ts`
- Create: `src/services/dmRecoveryService.test.ts`

**Interfaces:**
- Consumes: accepted gate receipt or verified settings-blocked rejection, source conversation/comment/media, configured delay/cohort, and read/engagement signals.
- Produces: one idempotent recovery record per source comment plus evidence updates that suppress an eligible treatment row without erasing history.

- [ ] **Step 1: Write failing creation tests**

Pin accepted-DM creation:

```ts
assignRecoveryCohort.mockReturnValue("treatment");
await scheduleAcceptedGateRecovery({
  conversationId: "conversation-1",
  igUserId: "ig-1",
  keywordId: "keyword-1",
  keywordSnapshot: "PROTEIN",
  commentId: "comment-1",
  mediaId: "media-1",
  gateDmMessageId: "dm-1",
  instagramGateMessageId: "mid-1",
  acceptedAt: new Date("2026-08-06T08:00:00Z"),
});

expect(prisma.dmRecoveryReminder.upsert).toHaveBeenCalledWith(
  expect.objectContaining({
    where: { commentId: "comment-1" },
    create: expect.objectContaining({
      triggerKind: "no_confirmed_read",
      status: "waiting",
      cohort: "treatment",
      eligibleAt: new Date("2026-08-06T18:00:00Z"),
      instagramGateMessageId: "mid-1",
      publicReplyText:
        "I sent your guide 💛 Check your DMs/Requests. If you don’t see it, DM @tinysoho “PROTEIN”.",
    }),
  }),
);
```

Add cases that prove:

- a replay of the same comment returns the existing row and does not mutate its cohort/template;
- a deterministically assigned holdout is created with `status = control`, not `waiting`;
- a missing experiment window is created as `control/experiment_not_configured`;
- accepted success without a Meta message ID creates `tracking_unavailable`, not `waiting`;
- an ambiguous private-send outcome creates `tracking_unavailable` with no fake `acceptedAt`;
- settings blocked creates `not_applicable`, immediate `eligibleAt`, and the settings copy;
- a DM-origin request is rejected because `commentId` is required;
- control assignment is stable for the same user and experiment version;
- a settings fallback never enters control.

- [ ] **Step 2: Write failing evidence tests**

```ts
await recordRecoverySeen({
  instagramMessageId: "mid-1",
  eventAt: new Date("2026-08-06T09:00:00Z"),
  receivedAt: new Date("2026-08-06T09:00:03Z"),
});

expect(prisma.dmRecoveryReminder.updateMany).toHaveBeenCalledWith({
  where: { instagramGateMessageId: "mid-1" },
  data: expect.objectContaining({
    seenAt: new Date("2026-08-06T09:00:00Z"),
    seenReceivedAt: new Date("2026-08-06T09:00:03Z"),
  }),
});
```

Add inbound reply, attachment, quick reply, reaction, and postback cases. Inbound message/attachment/quick reply also populate `repliedAt`/`repliedReceivedAt`; reactions populate `reactedAt`; postbacks populate `postbackAt`. These signal-specific fields preserve experiment denominators even if a different engagement kind arrived first. For `waiting`, evidence changes status to `suppressed`; for `control`, `sent`, or `sending`, retain status and record evidence timestamps for accuracy/late-signal measurement. Replayed evidence keeps the earliest event time and earliest receipt time.

- [ ] **Step 3: Run the service test and verify RED**

Run: `npm test -- --run src/services/dmRecoveryService.test.ts`

Expected: FAIL because the recovery service does not exist.

- [ ] **Step 4: Implement creation through one internal upsert**

Expose only these creation functions:

```ts
export async function scheduleAcceptedGateRecovery(
  input: AcceptedGateRecoveryInput,
): Promise<{ id: string; status: DmRecoveryStatus }>;

export async function scheduleSettingsBlockedRecovery(
  input: SettingsBlockedRecoveryInput,
): Promise<{ id: string; status: DmRecoveryStatus }>;

export async function scheduleTrackingUnavailableRecovery(
  input: TrackingUnavailableRecoveryInput,
): Promise<{ id: string; status: "tracking_unavailable" }>;
```

`scheduleAcceptedGateRecovery` sets `acceptedAt`, `eligibleAt = acceptedAt + delay`, the exact message IDs, snapshotted copy, template version, and cohort. Without a configured experiment window, store `control/experiment_not_configured`. With a configured window: events before `start` are stored as `control` with reason `experiment_not_started`; events inside `[start, end)` use deterministic 90/10 assignment; events at/after `end` are stored as `control` with reason `experiment_awaiting_review` until `DM_RECOVERY_POST_EXPERIMENT_ENABLED=true`, after which only newly created rows enter treatment. Never convert an already stored control row later.

`scheduleSettingsBlockedRecovery` stores no fake `acceptedAt` or Meta message ID, sets `eligibleAt` to the verified error time, `cohort = not_applicable`, and `status = waiting`.

`scheduleTrackingUnavailableRecovery` stores the source identity/copy for dashboard attention, `acceptedAt = null`, `cohort = not_applicable`, `status = tracking_unavailable`, and `lastErrorCategory = private_send_outcome_unknown`. It is never selected by the automatic worker.

- [ ] **Step 5: Implement evidence updates without overwriting history**

Expose:

```ts
recordRecoverySeen(input: MessageCorrelatedEvidence): Promise<void>;
recordRecoveryReaction(input: MessageCorrelatedEvidence): Promise<void>;
recordRecoveryPostback(input: MessageCorrelatedEvidence): Promise<void>;
recordRecoveryInbound(input: PersonEvidence & { kind: "inbound_reply" | "quick_reply" | "attachment" }): Promise<void>;
```

Use a short Prisma transaction for read-modify-write when preserving the earliest timestamps. Only `waiting` rows transition to `suppressed`; `sending` and `sent` keep their status so late webhook evidence can be measured. Never broaden an exact `mid` read/reaction/postback into a person-wide suppression. Inbound user engagement may suppress all unfinished recovery rows for that `igUserId` because it proves the user opened a conversation with the business.

Log `dm_recovery_created`, `dm_recovery_control_assigned`, `dm_seen_received`, `dm_recovery_evidence_recorded`, and `dm_recovery_tracking_unavailable` with IDs, trigger, status, and timing only.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npm test -- --run src/services/dmRecoveryService.test.ts src/services/dmRecoveryPolicy.test.ts
npm run build
```

Expected: all creation/evidence branches pass and generated Prisma types agree with the service.

- [ ] **Step 7: Commit the persistence service**

```bash
git add src/services/dmRecoveryService.ts src/services/dmRecoveryService.test.ts
git commit -m "feat: persist dm recovery candidates"
```

---

### Task 6: Schedule Recovery After a Live Comment Gate Send

**Files:**
- Modify: `src/handlers/commentHandler.ts`
- Modify: `src/handlers/commentHandler.test.ts`
- Modify: `src/services/gateQueueService.ts`
- Create: `src/services/gateQueueService.test.ts`

**Interfaces:**
- Consumes: the tracked private-reply receipt from Task 4 and the recovery scheduler from Task 5.
- Produces: a prospective recovery row only after Meta accepts a comment-origin gate DM, an immediate candidate for a verified settings rejection, and a safe queued classification for other failures without converting post-acceptance local failures into a duplicate gate retry.

- [ ] **Step 1: Write the failing handler tests**

```ts
it("schedules recovery from the exact accepted gate receipt", async () => {
  sendTrackedPrivateReply.mockResolvedValue({
    instagramMessageId: "mid-1",
    dmMessageId: "dm-1",
    acceptedAt: new Date("2026-08-06T08:00:00Z"),
  });

  await handleComment(commentEvent({ id: "comment-1", media: { id: "media-1" } }));

  expect(scheduleAcceptedGateRecovery).toHaveBeenCalledWith(
    expect.objectContaining({
      commentId: "comment-1",
      mediaId: "media-1",
      instagramGateMessageId: "mid-1",
      gateDmMessageId: "dm-1",
    }),
  );
});
```

Add boundary tests:

```ts
it("does not enqueue a private-DM retry when recovery persistence fails after Meta success", async () => {
  sendTrackedPrivateReply.mockResolvedValue(acceptedReceipt);
  scheduleAcceptedGateRecovery.mockRejectedValue(new Error("database unavailable"));

  await expect(handleComment(commentEvent())).resolves.toBeUndefined();

  expect(enqueueGate).not.toHaveBeenCalled();
  expect(logEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: "dm_recovery_schedule_failed" }),
  );
});
```

Also prove: an allowlisted structured settings rejection calls `scheduleSettingsBlockedRecovery` immediately and does **not** enter the gate queue; rate-limit/temporary failures enter the existing gate queue; an ambiguous transport failure enters the queue tagged `transport_uncertain` and creates `scheduleTrackingUnavailableRecovery` for dashboard attention without another send; a non-allowlisted error never uses settings-specific copy; initial public acknowledgement failure does not prevent the private gate send or later recovery scheduling; a replayed comment remains idempotent; ignored business-authored comments create nothing.

- [ ] **Step 2: Run the handler tests and verify RED**

Run: `npm test -- --run src/handlers/commentHandler.test.ts`

Expected: FAIL because the handler discards the receipt and has no recovery scheduling boundary.

- [ ] **Step 3: Separate the Meta send boundary from local follow-up work**

Use this control-flow shape:

```ts
let receipt: TrackedPrivateReplyReceipt;
try {
  receipt = await sendTrackedPrivateReply({
    recipientIgUserId: senderId,
    commentId: comment.id,
    text: keyword.gateMessage,
    source: "keyword_automation",
  });
} catch (error) {
  const metadata = describeGraphError(error);
  const classification = classifyPrivateGateFailure(
    metadata,
    parseGraphSignatures(env.DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES),
  );
  await logEvent("dm_failed", {
    conversationId: convo.id,
    stage: "gate_private_reply",
    commentId: comment.id,
    parentId: comment.parent_id ?? null,
    classification,
    ...metadata,
  });
  if (classification === "settings_blocked") {
    try {
      await scheduleSettingsBlockedRecovery({
        conversationId: convo.id,
        igUserId: senderId,
        keywordId: keyword.id,
        keywordSnapshot: keyword.keyword,
        commentId: comment.id,
        mediaId: comment.media?.id ?? null,
        rejectedAt: new Date(),
      });
    } catch {
      await logEvent("dm_recovery_schedule_failed", {
        conversationId: convo.id,
        commentId: comment.id,
        triggerKind: "settings_blocked",
      });
    }
    return;
  }
  await enqueueGate({
    conversationId: convo.id,
    igUserId: senderId,
    commentId: comment.id,
    mediaId: comment.media?.id ?? null,
    gateMessage: keyword.gateMessage,
    initialErrorCategory: classification,
  });
  if (classification === "transport_uncertain" || classification === "uncertain") {
    try {
      await scheduleTrackingUnavailableRecovery({
        conversationId: convo.id,
        igUserId: senderId,
        keywordId: keyword.id,
        keywordSnapshot: keyword.keyword,
        commentId: comment.id,
        mediaId: comment.media?.id ?? null,
        observedAt: new Date(),
      });
    } catch {
      await logEvent("dm_recovery_schedule_failed", {
        conversationId: convo.id,
        commentId: comment.id,
        triggerKind: "tracking_unavailable",
      });
    }
  }
  return;
}

await logEvent("dm_sent", { conversationId: convo.id, kind: "gate" });

const [gateStateResult, recoveryResult] = await Promise.allSettled([
  markGated(convo.id),
  scheduleAcceptedGateRecovery({
    conversationId: convo.id,
    igUserId: senderId,
    keywordId: keyword.id,
    keywordSnapshot: keyword.keyword,
    commentId: comment.id,
    mediaId: comment.media?.id ?? null,
    ...receipt,
  }),
]);
if (gateStateResult.status === "rejected") {
  await logEvent("gate_state_reconciliation_failed", {
    conversationId: convo.id,
    commentId: comment.id,
  });
}
if (recoveryResult.status === "rejected") {
  await logEvent("dm_recovery_schedule_failed", {
    conversationId: convo.id,
    commentId: comment.id,
    triggerKind: "no_confirmed_read",
  });
}
```

If `markGated` or event logging fails after Meta acceptance, record a local reconciliation error but never enqueue or resend the private DM. Keep recovery scheduling independently attempted when the required IDs remain available. If settings-fallback persistence itself fails, log `dm_recovery_schedule_failed`; do not enqueue a private retry because the verified rejection is permanent under the current recipient settings.

Extend `enqueueGate` with `mediaId` and `initialErrorCategory`. Persist the safe category in the existing `lastError` field. Create new rows as `send_uncertain` instead of `pending` when the initial category is `transport_uncertain` or `uncertain`; those rows are never selected by the retry worker, and their paired recovery row supplies the owner-visible attention state.

- [ ] **Step 4: Verify GREEN and regression coverage**

Run:

```bash
npm test -- --run src/handlers/commentHandler.test.ts \
  src/services/gateQueueService.test.ts src/services/dmDeliveryService.test.ts \
  src/services/dmRecoveryService.test.ts
npm run build
```

Expected: accepted sends create exactly one recovery candidate; only pre-acceptance failures enter the queue.

- [ ] **Step 5: Commit the live-send integration**

```bash
git add src/handlers/commentHandler.ts src/handlers/commentHandler.test.ts \
  src/services/gateQueueService.ts src/services/gateQueueService.test.ts
git commit -m "feat: schedule recovery for accepted comment gates"
```

---

### Task 7: Make Retried Gate Sends Safe and Schedule Their Recovery

**Files:**
- Modify: `src/services/gateQueueService.ts`
- Modify: `src/services/gateQueueService.test.ts`
- Modify: `src/services/gateQueueWorker.ts`
- Modify: `src/services/gateQueueWorker.test.ts`
- Modify: `src/services/keywordBackfillService.ts`
- Create: `src/services/keywordBackfillService.test.ts`

**Interfaces:**
- Consumes: queued source metadata, tracked Meta receipt, exact error classifier, send lease, and recovery scheduler.
- Produces: safe private-gate retry outcomes: accepted + scheduled recovery, verified settings-blocked + immediate fallback candidate, definitely retryable, exhausted/permanent, or ambiguous/manual review.

- [ ] **Step 1: Write failing queue metadata and claim tests**

Assert `enqueueGate` persists `mediaId` and starts in `pending`. Pin conditional claims:

```ts
expect(prisma.gateQueue.updateMany).toHaveBeenCalledWith({
  where: {
    id: "queue-1",
    status: "pending",
    nextAttemptAt: { lte: now },
  },
  data: {
    status: "sending",
    claimedAt: now,
    claimExpiresAt: leaseUntil,
  },
});
```

Two concurrent worker calls must produce one successful claim and one no-op. A stale `sending` row must become `send_uncertain`, not `pending`, because Meta may have accepted the private reply before the process died; reconciliation also idempotently creates the paired `tracking_unavailable` recovery attention row.

- [ ] **Step 2: Write the failing retry outcome matrix**

Cover these exact outcomes:

```ts
it("schedules accepted-DM recovery after a queued send succeeds", async () => {
  sendTrackedPrivateReply.mockResolvedValue(acceptedReceipt);
  await processGateQueueItem(queueItem);
  expect(scheduleAcceptedGateRecovery).toHaveBeenCalledWith(
    expect.objectContaining({ commentId: queueItem.commentId, mediaId: queueItem.mediaId }),
  );
  expect(markQueueSent).toHaveBeenCalledOnce();
});

it("creates an immediate fallback only for an allowlisted settings rejection", async () => {
  sendTrackedPrivateReply.mockRejectedValue(graphError({ code: 10, subcode: 12345 }));
  await processGateQueueItem(queueItem, { settingsSignatures: new Set(["10:12345"]) });
  expect(scheduleSettingsBlockedRecovery).toHaveBeenCalledOnce();
  expect(retryQueueItem).not.toHaveBeenCalled();
});
```

Add cases for `2534025` remaining rate-limited even if configured in the settings list; non-allowlisted permission errors opening no public fallback; timeout/network ambiguity -> queue `send_uncertain` plus recovery `tracking_unavailable`; stale sending-lease reconciliation creating the same attention record idempotently; recovery persistence failure after accepted send -> queue remains `sent` and logs a reconciliation error; and an initial public acknowledgement failure having no effect on the later gate retry.

- [ ] **Step 3: Run the queue tests and verify RED**

Run:

```bash
npm test -- --run src/services/gateQueueService.test.ts \
  src/services/gateQueueWorker.test.ts src/services/keywordBackfillService.test.ts
```

Expected: FAIL because queue rows lack source media/leases and the worker does not schedule recovery.

- [ ] **Step 4: Preserve source media through every enqueue path**

Extend `GateQueueInput` and all live/backfill call sites with `mediaId: string | null`. Update `keywordBackfillService` candidate selection to select the event's stored `mediaId` and pass it to the queue. Keep existing rows nullable for migration compatibility.

- [ ] **Step 5: Add claim and stale-outcome transitions**

Claim `pending -> sending` with `updateMany` and a lease before calling Meta. Only the claimant can send. On startup/interval, move expired `sending` claims to `send_uncertain` with `lastErrorCategory = "private_send_outcome_unknown"`; do not auto-retry them.

For known failures before acceptance:

- rate limit / retryable provider response: `sending -> pending`, increment attempts, and set `nextAttemptAt` to `min(15 minutes * 2^(attempts - 1), 2 hours)`; subcode `2534025` also stops the rest of the tick;
- attempt cap, closed seven-day window, or definite permanent rejection: `sending -> exhausted`;
- verified settings blocked: `sending -> abandoned`, then schedule the immediate settings recovery exactly once;
- auth/permission not allowlisted: terminal queue failure and operational log, no public recovery;
- transport timeout/reset after request dispatch: `sending -> send_uncertain`, idempotently create `tracking_unavailable` recovery attention from the loaded source, and perform no automatic private resend.

- [ ] **Step 6: Finalize accepted sends before ancillary work**

Batch-load each due row's conversation with `keyword: { select: { id: true, keyword: true } }`; a missing source conversation/keyword becomes a permanent queue failure rather than a send. Immediately after an accepted receipt, persist queue `sent`, conversation `gated`, and the safe `dm_sent` record. Then call `scheduleAcceptedGateRecovery` with the queue's comment/media IDs, loaded keyword snapshot, and receipt's acceptance/Meta/local IDs in a separate guarded block. A recovery database failure must not mutate queue status back to retryable.

For a verified settings rejection, use the same loaded source data to call `scheduleSettingsBlockedRecovery`, mark the queue `abandoned/settings_blocked`, and never private-retry it. Log the safe numeric code/subcode and classification for classifier audits.

- [ ] **Step 7: Verify GREEN and retry invariants**

Run:

```bash
npm test -- --run src/services/gateQueueService.test.ts \
  src/services/gateQueueWorker.test.ts src/services/keywordBackfillService.test.ts \
  src/handlers/commentHandler.test.ts
npm run build
```

Expected: every test passes; a single queue item can make at most one automatic ambiguous private-send attempt.

- [ ] **Step 8: Commit the retry integration**

```bash
git add src/services/gateQueueService.ts src/services/gateQueueService.test.ts \
  src/services/gateQueueWorker.ts src/services/gateQueueWorker.test.ts \
  src/services/keywordBackfillService.ts src/services/keywordBackfillService.test.ts
git commit -m "feat: recover retried comment gate sends"
```

---

### Task 8: Ingest Read, Reaction, Postback, Inbound, and Deletion Signals

**Files:**
- Modify: `src/types/meta.ts`
- Modify: `src/handlers/webhookRouter.ts`
- Modify: `src/handlers/webhookRouter.test.ts`
- Create: `src/handlers/seenHandler.ts`
- Create: `src/handlers/seenHandler.test.ts`
- Create: `src/handlers/reactionHandler.ts`
- Create: `src/handlers/reactionHandler.test.ts`
- Create: `src/handlers/postbackHandler.ts`
- Create: `src/handlers/postbackHandler.test.ts`
- Modify: `src/handlers/messageHandler.ts`
- Modify: `src/handlers/messageHandler.test.ts`
- Modify: `src/services/dmThreadService.ts`
- Modify: `src/services/dmThreadService.test.ts`

**Interfaces:**
- Consumes: Meta messaging entries carrying `message`, `read`, `reaction`, or `postback` and their provider timestamps.
- Produces: exactly correlated seen/reaction/postback evidence, person-wide inbound engagement, idempotent deletion capture, and safe unknown-event observability.

- [ ] **Step 1: Add the failing router dispatch matrix**

Use complete fixtures rather than casting partial objects:

```ts
it.each([
  ["message", { message: { mid: "in-1", text: "DONE" } }, handleMessage],
  ["seen", { read: { mid: "out-1" } }, handleSeen],
  ["reaction", { reaction: { mid: "out-1", action: "react", reaction: "love" } }, handleReaction],
  ["postback", { postback: { mid: "out-1", payload: "OPEN_GUIDE" } }, handlePostback],
])("routes one %s entry once", async (_name, payload, expectedHandler) => {
  await routeMessagingEntry(messagingEntry(payload));
  expect(expectedHandler).toHaveBeenCalledOnce();
  expect(allOtherHandlers(expectedHandler)).not.toHaveBeenCalled();
});
```

Add malformed/no-recognized-payload coverage that logs and returns 200, plus a precedence case ensuring an ordinary `message` with `quick_reply` remains a message event rather than a postback event.

- [ ] **Step 2: Add failing seen/reaction/postback handler tests**

Seen:

```ts
await handleSeen(messagingEntry({ read: { mid: "out-1" }, timestamp: 1_786_003_200_000 }));
expect(markOutboundSeen).toHaveBeenCalledWith("out-1", new Date(1_786_003_200_000));
expect(recordRecoverySeen).toHaveBeenCalledWith({
  instagramMessageId: "out-1",
  eventAt: new Date(1_786_003_200_000),
  receivedAt: expect.any(Date),
});
```

Reaction/postback:

- `reaction.action === "react"` records engagement for that exact `mid`;
- `unreact` never reverses a suppression and only logs the event safely;
- a postback with `mid` records exact-message engagement;
- missing/unknown `mid` is acknowledged and logged but does not broaden suppression to the person;
- replaying the same event is idempotent.

- [ ] **Step 3: Add failing inbound and deletion tests**

For every newly captured non-echo inbound message, call `recordRecoveryInbound` even when `becameLatest` is false:

```ts
it("suppresses recovery for a captured delayed inbound that is not the latest thread message", async () => {
  recordInboundMessage.mockResolvedValue({
    duplicate: false,
    becameLatest: false,
    threadId: "thread-1",
    messageId: "dm-in-1",
  });

  await handleMessage(inbound({ mid: "in-1", text: "hello" }));

  expect(recordRecoveryInbound).toHaveBeenCalledWith(
    expect.objectContaining({ igUserId: "ig-1", kind: "inbound_reply" }),
  );
});
```

Add attachment-only -> `attachment`, quick-reply payload -> `quick_reply`, duplicate replay -> no second evidence write, and `is_echo: true` -> no inbound/evidence write. For a deletion webhook:

```ts
await handleMessage(inbound({ mid: "in-1", is_deleted: true }));
expect(markInboundDeleted).toHaveBeenCalledWith("in-1", expect.any(Date));
expect(recordRecoveryInbound).not.toHaveBeenCalled();
```

Deleting a previously captured inbound message must retain its historical `engagedAt`; an unmatched deletion is not proof of engagement.

- [ ] **Step 4: Run all webhook tests and verify RED**

Run:

```bash
npm test -- --run src/handlers/webhookRouter.test.ts \
  src/handlers/seenHandler.test.ts src/handlers/reactionHandler.test.ts \
  src/handlers/postbackHandler.test.ts src/handlers/messageHandler.test.ts \
  src/services/dmThreadService.test.ts
```

Expected: FAIL because the event shapes and focused handlers are missing.

- [ ] **Step 5: Extend the Meta event types precisely**

Model optional payloads without making malformed events type-safe by accident:

```ts
export interface MessagingEntry {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    quick_reply?: { payload?: string };
    attachments?: Array<{
      type?: string;
      payload?: { url?: string; [key: string]: unknown };
    }>;
  };
  read?: { mid: string };
  reaction?: {
    mid: string;
    action?: "react" | "unreact" | string;
    reaction?: string;
    emoji?: string;
  };
  postback?: { mid?: string; title?: string; payload?: string };
}
```

Even though Meta documents the required IDs, handlers must still runtime-check each `mid` because webhook JSON is untrusted. Keep provider timestamp conversion in one validated helper: finite milliseconds only; otherwise use receipt time and log `provider_timestamp_invalid`.

- [ ] **Step 6: Implement single-dispatch routing and focused handlers**

Route in this order: `read`, `reaction`, `postback`, `message`, unknown. Each focused handler validates `mid`, calls its local-thread updater where relevant, applies the corresponding recovery evidence, and catches/logs internal errors so the webhook request is still acknowledged. In `seenHandler`, run local `DmMessage` update and recovery correlation independently with `Promise.allSettled`: a missing/local-history write must not prevent suppression through `instagramGateMessageId`, and a recovery write failure must not erase the local seen timestamp.

`markOutboundSeen(mid, eventAt)` updates only `direction = outbound` `DmMessage` rows matching `instagramMessageId = mid` and preserves the earliest `seenAt`.

- [ ] **Step 7: Integrate inbound evidence before conversation routing**

After `recordInboundMessage` returns nonduplicate, record recovery engagement before any `becameLatest`, active-conversation, DONE, keyword, or draft-routing early return. Choose kind using:

```ts
const kind = message.quick_reply?.payload
  ? "quick_reply"
  : message.attachments?.length
    ? "attachment"
    : "inbound_reply";
```

For `is_deleted`, call `markInboundDeleted(mid, deletedAt)`, which updates only `direction = inbound`, and return without creating a new inbound message or new engagement. If the matching message already supplied engagement earlier, do not clear it.

- [ ] **Step 8: Verify GREEN and replay safety**

Run:

```bash
npm test -- --run src/handlers/webhookRouter.test.ts \
  src/handlers/seenHandler.test.ts src/handlers/reactionHandler.test.ts \
  src/handlers/postbackHandler.test.ts src/handlers/messageHandler.test.ts \
  src/services/dmThreadService.test.ts src/services/dmRecoveryService.test.ts
npm run build
```

Expected: all signal kinds route once, duplicates are no-ops, and no missing receipt is interpreted as unread.

- [ ] **Step 9: Commit webhook ingestion**

```bash
git add src/types/meta.ts src/handlers/webhookRouter.ts src/handlers/webhookRouter.test.ts \
  src/handlers/seenHandler.ts src/handlers/seenHandler.test.ts \
  src/handlers/reactionHandler.ts src/handlers/reactionHandler.test.ts \
  src/handlers/postbackHandler.ts src/handlers/postbackHandler.test.ts \
  src/handlers/messageHandler.ts src/handlers/messageHandler.test.ts \
  src/services/dmThreadService.ts src/services/dmThreadService.test.ts
git commit -m "feat: ingest instagram recovery evidence"
```

---

### Task 9: Suppress Recovery When a Journey Completes

**Files:**
- Modify: `src/services/conversationService.ts`
- Modify: `src/services/conversationService.test.ts`
- Modify: `src/services/dmRecoveryService.ts`
- Modify: `src/services/dmRecoveryService.test.ts`

**Interfaces:**
- Consumes: a conversation completion and its person/keyword identity.
- Produces: transactional suppression of the source recovery and matching unfinished same-person/same-keyword recoveries, while retaining control rows for experiment analysis.

- [ ] **Step 1: Write the failing same-journey and cross-journey tests**

```ts
it("completes the journey and suppresses its waiting recovery atomically", async () => {
  await markCompleted("conversation-1");

  expect(transaction.conversation.update).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "conversation-1" }, data: expect.objectContaining({ state: "completed" }) }),
  );
  expect(transaction.dmRecoveryReminder.updateMany).toHaveBeenCalledWith({
    where: {
      igUserId: "ig-1",
      keywordId: "keyword-1",
      status: "waiting",
    },
    data: expect.objectContaining({
      status: "suppressed",
      suppressionReason: "completed_elsewhere",
      suppressedAt: expect.any(Date),
    }),
  });
});
```

Add cases that set source conversation reason to `completed`, matching other journey reason to `completed_elsewhere`, leave unrelated keywords/people untouched, and retain `control` status while setting its completion evidence fields. A completion racing a worker claim must either win before send or be observed by the worker's final recheck.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- --run src/services/conversationService.test.ts src/services/dmRecoveryService.test.ts
```

Expected: FAIL because completion currently updates conversation/gate state only.

- [ ] **Step 3: Add a transaction-scoped suppression helper**

Expose an internal helper that accepts a Prisma transaction client:

```ts
export async function suppressRecoveriesForCompletion(
  tx: Prisma.TransactionClient,
  input: { conversationId: string; igUserId: string; keywordId: string; completedAt: Date },
): Promise<void>;
```

Load the completing conversation's `igUserId` and `keywordId` inside the existing `markCompleted` transaction. Update `waiting` source/matching rows to `suppressed`. For `control`, write `suppressedAt`/`suppressionReason` as observed counterfactual evidence but keep `status = control`. For `sending`, do not force a terminal transition; the worker's final pre-send transaction must see the completed conversation.

- [ ] **Step 4: Verify GREEN across completion call sites**

Run:

```bash
npm test -- --run src/services/conversationService.test.ts \
  src/handlers/messageHandler.test.ts src/services/dmRecoveryService.test.ts
npm run build
```

Expected: existing completion paths pass and every future completion records suppression evidence.

- [ ] **Step 5: Commit completion suppression**

```bash
git add src/services/conversationService.ts src/services/conversationService.test.ts \
  src/services/dmRecoveryService.ts src/services/dmRecoveryService.test.ts
git commit -m "feat: suppress recovery on journey completion"
```

---

### Task 10: Claim Due Records Atomically and Enforce the Person Cooldown

**Files:**
- Create: `src/services/dmRecoveryRepository.ts`
- Create: `src/services/dmRecoveryRepository.test.ts`
- Extend: `src/services/dmRecoveryDatabaseContract.test.ts`

**Interfaces:**
- Consumes: waiting due rows, current database evidence, lease duration, hourly capacity, and last sent reminder per person.
- Produces: one leased `sending` record at a time with all send predicate evidence rechecked and competing person records suppressed.

- [ ] **Step 1: Write failing repository state-transition tests**

Pin claims and rechecks:

```ts
it("claims an eligible treatment record with a compare-and-set transition", async () => {
  prisma.dmRecoveryReminder.updateMany.mockResolvedValue({ count: 1 });
  await expect(claimRecovery("recovery-1", now, leaseUntil)).resolves.toMatchObject({
    id: "recovery-1",
    status: "sending",
  });
  expect(prisma.dmRecoveryReminder.updateMany).toHaveBeenCalledWith({
    where: {
      id: "recovery-1",
      status: "waiting",
      eligibleAt: { lte: now },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    data: expect.objectContaining({ status: "sending", claimedAt: now, claimExpiresAt: leaseUntil }),
  });
});
```

Add unit tests for:

- two claimants, one `updateMany.count === 1`, one `0`;
- rows with `seenAt`, `engagedAt`, cancellation, or completed conversation suppressed before claim;
- a sent reminder for the user inside 24 hours suppresses the candidate;
- a `send_uncertain` reminder whose `lastAttemptAt` is inside 24 hours also suppresses the candidate conservatively;
- at exactly 24 hours the candidate is eligible;
- two eligible keywords choose highest `eligibleAt`, then newest `createdAt`, then stable `id` tie-breaker;
- losing same-person candidates become `suppressed/newer_candidate` or `person_cooldown`;
- overdue candidates remain selectable regardless of age;
- hourly confirmed-sent count at cap returns no candidate;
- `control`, `tracking_unavailable`, `send_uncertain`, and terminal rows are never claimed.

- [ ] **Step 2: Add a failing real-Postgres concurrency contract**

With two separate Prisma clients and `Promise.all`, attempt to claim the same due row and assert exactly one succeeds. Add two different due rows for the same user and assert the transactional winner selection permits at most one `sending` row. This test runs only with `MIGRATION_TEST_DATABASE_URL`.

- [ ] **Step 3: Run repository tests and verify RED**

Run:

```bash
npm test -- --run src/services/dmRecoveryRepository.test.ts \
  src/services/dmRecoveryDatabaseContract.test.ts
```

Expected: FAIL because claim/finalization functions do not exist.

- [ ] **Step 4: Implement due selection and a serializable claim**

Expose:

```ts
export async function listDueRecoveryIds(now: Date, limit: number): Promise<string[]>;
export async function claimRecovery(
  id: string,
  now: Date,
  leaseUntil: Date,
): Promise<ClaimedRecovery | null>;
export type FinalRecoveryCheck =
  | RecoveryDecision
  | { kind: "pause"; reason: "circuit_open" | "hourly_cap" };
export async function authorizeClaimForSend(id: string, now: Date): Promise<FinalRecoveryCheck>;
```

`listDueRecoveryIds` fetches only IDs ordered by `eligibleAt ASC, createdAt ASC`, bounded above the worker batch so skipped rows do not starve later people.

In a short `Serializable` transaction, load the candidate's `igUserId`, then serialize all decisions for that person with a parameterized row lock:

```ts
await tx.$queryRaw<Array<{ id: string }>>`
  SELECT "id" FROM "ig_users" WHERE "id" = ${candidate.igUserId} FOR UPDATE
`;
```

Load completion/evidence/recent-send/newer-eligible-candidate data, invoke `decideRecovery`, persist all suppress/holdout decisions, and compare-and-set the winner to `sending`. The migration's partial unique index is a second line of defense. Retry only Prisma `P2034` serialization failures a bounded three times with jitter; do not retry arbitrary errors.

After the transaction commits, log `dm_recovery_ready` and `dm_recovery_claimed` for the successful claim; log `dm_recovery_cooldown_suppressed` for that terminal policy result. Reprocessing or a failed transaction must not emit a false claim event.

- [ ] **Step 5: Implement final pre-network authorization and capacity reservation**

Immediately before the worker calls Meta, run another short transaction. Lock the singleton `DmRecoveryControl` row with `FOR UPDATE` so circuit state, hourly capacity, and attempt reservation are serialized across processes. Confirm:

```ts
await tx.$queryRaw<Array<{ id: number }>>`
  SELECT "id" FROM "dm_recovery_control" WHERE "id" = 1 FOR UPDATE
`;
```

```text
status = sending
claim lease is still owned and unexpired
source comment still present in the row
no seen evidence
no engagement evidence
conversation not completed
owner not cancelled
no confirmed or outcome-uncertain public recovery attempt for person in rolling 24h
candidate remains the most recent eligible candidate for person
circuit still closed
hourly cap still has capacity after confirmed sends and reserved attempts
```

When all predicates hold, atomically stamp `lastAttemptAt = now` and increment `attempts` in this transaction before returning `send_*`; this durable reservation prevents another process from overrunning the hourly cap. Return `pause` for circuit/cap gates so the worker releases `sending -> waiting` without suppressing the user; persist terminal/suppression decisions for all evidence-based no-send results. A caller must never call Meta unless `authorizeClaimForSend` returned a send decision.

- [ ] **Step 6: Add repository finalizers**

Provide conditional transitions that require `status = sending`:

```ts
markRecoverySent(id, { replyId, sentAt }): Promise<boolean>;
markRecoveryRetryable(id, { category, nextAttemptAt }): Promise<boolean>;
markRecoveryFailed(id, { category }): Promise<boolean>;
markRecoveryUncertain(id, { category }): Promise<boolean>;
releaseOrSuppressClaim(id, decision, now): Promise<boolean>;
```

Every finalizer clears claim timestamps but preserves `lastAttemptAt`. `markRecoverySent` requires a nonempty Meta reply ID. Person cooldown queries consider both confirmed `sentAt` and uncertain `lastAttemptAt`; a safe known-not-accepted retryable failure does not enter cooldown because its status returns to `waiting`.

- [ ] **Step 7: Verify GREEN including database concurrency**

Run:

```bash
npm test -- --run src/services/dmRecoveryRepository.test.ts \
  src/services/dmRecoveryDatabaseContract.test.ts src/services/dmRecoveryPolicy.test.ts
npm run build
```

Expected: unit tests pass; configured real-Postgres run proves single claim and person-level exclusion.

- [ ] **Step 8: Commit the repository**

```bash
git add src/services/dmRecoveryRepository.ts src/services/dmRecoveryRepository.test.ts \
  src/services/dmRecoveryDatabaseContract.test.ts
git commit -m "feat: claim dm recovery work atomically"
```

---

### Task 11: Add a Persistent Recovery Circuit Breaker and Health Snapshot

**Files:**
- Create: `src/services/dmRecoveryHealth.ts`
- Create: `src/services/dmRecoveryHealth.test.ts`

**Interfaces:**
- Consumes: singleton control row, accepted/read/engaged samples, due backlog, recent public-send outcomes, hourly confirmed sends, and recent recovery database failures.
- Produces: `closed` or `open(reason)` send permission plus a dashboard-ready health snapshot. Opening the circuit never expires or discards pending work.

- [ ] **Step 1: Write the failing health matrix**

```ts
it.each([
  ["auth_or_permission", { forcedReason: "auth_or_permission" }],
  ["webhook_signal_gap", { acceptedCount: 20, seenOrEngagedCount: 0 }],
  ["backlog_anomaly", { dueCount: 501 }],
  ["public_failure_rate", { outcomeCount: 50, publicFailureCount: 25 }],
  ["hourly_cap", { sentLastHour: 30 }],
  ["database_failures", { recentDatabaseFailures: 3 }],
])("opens the circuit for %s", async (reason, observations) => {
  await evaluateRecoveryHealth(healthInput(observations));
  expect(prisma.dmRecoveryControl.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      update: expect.objectContaining({ circuitOpen: true, reason, openedAt: expect.any(Date) }),
    }),
  );
});
```

Add cases that prove low-volume zero-read data does not open the circuit, `waiting` records remain unchanged, a closed/healthy snapshot allows work, already-open auth/permission stays latched, and auto-recoverable anomaly reasons clear only after three consecutive healthy evaluations. Because the schema intentionally stores no raw errors, only the stable reason may be persisted.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --run src/services/dmRecoveryHealth.test.ts`

Expected: FAIL because the health service does not exist.

- [ ] **Step 3: Implement typed reasons and the persistent control API**

```ts
export type RecoveryCircuitReason =
  | "auth_or_permission"
  | "webhook_signal_gap"
  | "backlog_anomaly"
  | "public_failure_rate"
  | "hourly_cap"
  | "database_failures";

export type RecoveryHealthSnapshot = {
  circuitOpen: boolean;
  reason: RecoveryCircuitReason | null;
  openedAt: Date | null;
  dueCount: number;
  sentLastHour: number;
  recentOutcomeCount: number;
  recentFailureRate: number | null;
  acceptedSignalSample: number;
  positiveSignalSample: number;
};

export async function getRecoveryHealthSnapshot(now: Date): Promise<RecoveryHealthSnapshot>;
export async function openRecoveryCircuit(reason: RecoveryCircuitReason, now: Date): Promise<void>;
export async function evaluateRecoveryHealth(now: Date): Promise<RecoveryHealthSnapshot>;
```

Calculate the failure rate only when the configured sample size is met. Count `sent` plus terminal public outcomes as the denominator; exclude control/suppressed/tracking-unavailable. Detect the signal gap only when accepted records reach `DM_RECOVERY_MIN_ACCEPTED_HEALTH_SAMPLE` inside the evaluation window and none has `seenAt` or `engagedAt`.

- [ ] **Step 4: Make circuit recovery explicit and conservative**

Maintain the three-consecutive-healthy counter in memory only for auto-recoverable reasons; a restart restarts the proof window, never force-closes the database row. `auth_or_permission` is latched and must be reset operationally after credentials/subscriptions are verified, using the documented owner-only database runbook. Store `resetAt` and `resetBy = "health_auto_recovery"` when an anomaly auto-closes. Emit `dm_recovery_circuit_opened` or `dm_recovery_circuit_closed` only when the persisted circuit state actually changes.

The worker consults the stored row on every final pre-send recheck. Health evaluation must never change individual recovery rows.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm test -- --run src/services/dmRecoveryHealth.test.ts
npm run build
```

Expected: threshold, latching, recovery, and privacy tests pass.

- [ ] **Step 6: Commit the health guard**

```bash
git add src/services/dmRecoveryHealth.ts src/services/dmRecoveryHealth.test.ts
git commit -m "feat: guard dm recovery sends with circuit breaker"
```

---

### Task 12: Implement the Paced Public-Recovery Worker

**Files:**
- Create: `src/services/dmRecoveryWorker.ts`
- Create: `src/services/dmRecoveryWorker.test.ts`

**Interfaces:**
- Consumes: due IDs, atomic repository claims, final policy recheck, circuit health, `replyToComment`, safe Graph classifications, batch/hourly limits, and backoff settings.
- Produces: confirmed `sent`, safe retry, permanent `send_failed`, ambiguous `send_uncertain`, or suppression/control outcomes. The exported tick is non-throwing and non-overlapping.

- [ ] **Step 1: Write the failing happy-path and outage tests**

```ts
it("posts the exact snapshotted copy and confirms the reply ID", async () => {
  listDueRecoveryIds.mockResolvedValue(["recovery-1"]);
  const claimed = claimedRecovery({
    commentId: "comment-1",
    publicReplyText:
      "I sent your guide 💛 Check your DMs/Requests. If you don’t see it, DM @tinysoho “PROTEIN”.",
  });
  claimRecovery.mockResolvedValue(claimed);
  authorizeClaimForSend.mockResolvedValue({ kind: "send_no_confirmed_read_reminder" });
  replyToComment.mockResolvedValue({ replyId: "public-reply-1" });

  await runDmRecoveryTick();

  expect(replyToComment).toHaveBeenCalledWith("comment-1", claimed.publicReplyText);
  expect(markRecoverySent).toHaveBeenCalledWith("recovery-1", {
    replyId: "public-reply-1",
    sentAt: expect.any(Date),
  });
});

it("sends an overdue reminder after a 29-hour outage", async () => {
  claimRecovery.mockResolvedValue(claimedRecovery({ eligibleAt: hoursAgo(19) }));
  await runDmRecoveryTick();
  expect(replyToComment).toHaveBeenCalledOnce();
});
```

Add a paced backlog case: 100 overdue records, batch 5, results in at most 5 claims and 5 public calls in one tick.

- [ ] **Step 2: Write the failing suppression-race tests**

For each final recheck result (`seen`, inbound, reaction, postback, completed, cancellation, person cooldown, newer candidate, circuit open), assert `replyToComment` is never called and the repository receives the matching persisted decision. Add a test where evidence arrives after claim but before final recheck.

- [ ] **Step 3: Write the failing public outcome matrix**

```ts
it.each([
  ["success_without_id", { result: { replyId: null } }, "markRecoveryUncertain"],
  ["timeout", { error: transportTimeout() }, "markRecoveryUncertain"],
  ["connection_reset", { error: connectionReset() }, "markRecoveryUncertain"],
  ["deleted_comment", { error: graphError({ code: 100, subcode: 33 }) }, "markRecoveryFailed"],
  ["rate_limit", { error: graphError({ status: 429, code: 4 }) }, "markRecoveryRetryable"],
  ["auth", { error: graphError({ status: 401, code: 190 }) }, "openRecoveryCircuit"],
])("handles %s without an unsafe duplicate", async (_name, outcome, expectedFinalizer) => {
  arrangeSend(outcome);
  await runDmRecoveryTick();
  expect(mocks[expectedFinalizer]).toHaveBeenCalledOnce();
});
```

Add: bounded exponential retry reaches `DM_RECOVERY_MAX_ATTEMPTS` then `send_failed`; unknown responses -> uncertain; one record failure does not stop later records; stale `sending` lease -> uncertain and no public call; simultaneous tick invocation -> second tick returns `{ skipped: "already_running" }`.

Add a post-acceptance persistence failure case: Meta returns `public-reply-1`, `markRecoverySent` throws, the worker logs a safe reconciliation failure and performs no retry. The row remains leased `sending`; stale-lease reconciliation later moves it to `send_uncertain`.

- [ ] **Step 4: Run the worker tests and verify RED**

Run: `npm test -- --run src/services/dmRecoveryWorker.test.ts`

Expected: FAIL because the worker does not exist.

- [ ] **Step 5: Implement one non-overlapping, non-throwing tick**

Use module-local reentrancy protection and dependency injection for time in tests:

```ts
export type DmRecoveryTickResult = {
  examined: number;
  sent: number;
  suppressed: number;
  failed: number;
  uncertain: number;
  skipped?: "disabled" | "already_running" | "circuit_open" | "hourly_cap";
};

export async function runDmRecoveryTick(): Promise<DmRecoveryTickResult> {
  if (!env.DM_RECOVERY_ENABLED) return emptyResult("disabled");
  if (running) return emptyResult("already_running");
  running = true;
  try {
    return await runTickBody();
  } catch (error) {
    await recordSafeWorkerFailure(error);
    return emptyFailedResult();
  } finally {
    running = false;
  }
}
```

At tick start, reconcile expired `sending` leases to `send_uncertain`, evaluate health, and stop if open/capped. Process the bounded candidate IDs sequentially to preserve pacing and make each item's failure isolated.

- [ ] **Step 6: Implement the exact per-item send order**

For each ID:

1. atomically claim;
2. final transactional evidence/circuit/cap authorization, which durably reserves the attempt;
3. if no-send, persist that decision and continue;
4. call `replyToComment` outside transactions;
5. only a nonempty `replyId` becomes `sent`; if that final database write fails, never call Meta again and let the lease reconcile to `send_uncertain`;
6. classify a thrown error and invoke exactly one finalizer;
7. on auth/permission, return the record to waiting with safe backoff, open the circuit, and stop the batch;
8. on 429, calculate `base * 2^(attempts - 1)` with a bounded jitter and never exceed max attempts;
9. on timeout/reset/unknown/missing ID, set `send_uncertain` and never retry automatically.

Write safe events `dm_recovery_sent`, `dm_recovery_sent_late`, `dm_recovery_suppressed`, `dm_recovery_send_failed`, and `dm_recovery_send_uncertain`. Emit `sent_late` in addition to `sent` when `sentAt` exceeds the one-minute worker allowance after `eligibleAt`. Include recovery/conversation/user IDs, keyword ID, trigger, cohort, attempt, timing, and stable category—never the public text or provider body.

- [ ] **Step 7: Verify GREEN and run the state-machine suite**

Run:

```bash
npm test -- --run src/services/dmRecoveryWorker.test.ts \
  src/services/dmRecoveryRepository.test.ts src/services/dmRecoveryHealth.test.ts \
  src/services/dmRecoveryPolicy.test.ts
npm run build
```

Expected: happy path, all races, outage recovery, failure classes, and reentrancy pass.

- [ ] **Step 8: Commit the worker**

```bash
git add src/services/dmRecoveryWorker.ts src/services/dmRecoveryWorker.test.ts
git commit -m "feat: send paced instagram recovery comments"
```

---

### Task 13: Register the Worker Behind the Kill Switch

**Files:**
- Create: `src/services/dmRecoveryScheduler.ts`
- Create: `src/services/dmRecoveryScheduler.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `DM_RECOVERY_ENABLED`, worker interval, timer implementation, and `runDmRecoveryTick`.
- Produces: an immediate startup tick plus one non-overlapping interval when enabled; no timer or network work when disabled.

- [ ] **Step 1: Write the failing scheduler tests**

```ts
it("does not register or run when recovery is disabled", () => {
  const timer = vi.fn();
  startDmRecoveryScheduler({ enabled: false, intervalMs: 60_000, setInterval: timer, runTick });
  expect(timer).not.toHaveBeenCalled();
  expect(runTick).not.toHaveBeenCalled();
});

it("runs once immediately and registers the configured interval", async () => {
  const timer = vi.fn();
  startDmRecoveryScheduler({ enabled: true, intervalMs: 60_000, setInterval: timer, runTick });
  expect(runTick).toHaveBeenCalledOnce();
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 60_000);
});
```

Also prove a rejected injected tick is caught/logged and does not become an unhandled rejection.

- [ ] **Step 2: Run the scheduler test and verify RED**

Run: `npm test -- --run src/services/dmRecoveryScheduler.test.ts`

Expected: FAIL because the scheduler does not exist.

- [ ] **Step 3: Implement and register the scheduler**

Keep the helper synchronous and return a stop function for tests/process shutdown:

```ts
export function startDmRecoveryScheduler(options: SchedulerOptions): () => void {
  if (!options.enabled) return () => undefined;
  const run = () => void options.runTick().catch(() => {
    logger.error({ errorCode: "dm_recovery_tick_rejected" }, "DM recovery tick rejected");
  });
  run();
  const handle = options.setInterval(run, options.intervalMs);
  return () => options.clearInterval(handle);
}
```

Call it once in `src/server.ts` with `env.DM_RECOVERY_ENABLED`, `env.DM_RECOVERY_WORKER_INTERVAL_MS`, and `runDmRecoveryTick`. Do not start it inside webhook handling.

- [ ] **Step 4: Verify GREEN and server compilation**

Run:

```bash
npm test -- --run src/services/dmRecoveryScheduler.test.ts src/services/dmRecoveryWorker.test.ts
npm run build
```

Expected: disabled/enabled timer tests pass and server compiles.

- [ ] **Step 5: Commit worker registration**

```bash
git add src/services/dmRecoveryScheduler.ts src/services/dmRecoveryScheduler.test.ts src/server.ts
git commit -m "feat: schedule dm recovery worker"
```

---

### Task 14: Add the Admin Recovery API and Experiment Metrics

**Files:**
- Create: `src/api/recoveryReminders.routes.ts`
- Create: `src/api/recoveryReminders.routes.test.ts`
- Modify: `src/api/conversations.routes.ts`
- Create: `src/api/conversations.routes.test.ts`
- Modify: `src/api/router.ts`

**Interfaces:**
- Consumes: recovery rows, related conversation/keyword/user metadata, health snapshot, validated cursor/filter input, and owner action requests.
- Produces: cursor-paginated rows, record/unique-person counts, experiment/accuracy metrics, a detail timeline, safe cancellation, and attention review.

- [ ] **Step 1: Write failing list validation and response tests**

Pin the query contract:

```ts
const recoveryListQuery = z.object({
  view: z.enum(["all", "scheduled", "ready", "sent", "suppressed", "control", "attention"])
    .default("all"),
  keywordId: z.string().uuid().optional(),
  cohort: z.enum(["treatment", "control", "not_applicable"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});
```

Test each view mapping:

```text
scheduled -> status waiting and eligibleAt > now
ready -> status waiting and eligibleAt <= now
sent -> status sent
suppressed -> status suppressed
control -> status control
attention -> status in send_failed, send_uncertain, tracking_unavailable
all -> no status filter
```

Assert `limit + 1` cursor pagination, one batched `getIgUsers` call, no N+1 relation lookups, and this stable row shape:

```ts
type RecoveryReminderRow = {
  id: string;
  conversationId: string;
  igUserId: string;
  username: string | null;
  name: string | null;
  keyword: { id: string; keyword: string };
  media: { id: string | null; permalink: string | null; caption: string | null };
  triggerKind: "no_confirmed_read" | "settings_blocked";
  status: RecoveryStatus;
  cohort: RecoveryCohort;
  acceptedAt: string | null;
  eligibleAt: string;
  seenAt: string | null;
  engagedAt: string | null;
  firstEngagementKind: string | null;
  suppressionReason: string | null;
  sentAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastErrorCategory: string | null;
  reviewedAt: string | null;
  createdAt: string;
};
```

In `src/api/conversations.routes.test.ts`, pin the bounded journey summary: the existing conversation query selects at most the newest recovery row per conversation and returns:

```ts
type ConversationRecoverySummary = {
  id: string;
  status: RecoveryStatus;
  triggerKind: RecoveryTriggerKind;
  eligibleAt: string;
  sentAt: string | null;
} | null;

type ReadTrackingAvailability = "tracked" | "predates_tracking" | "not_available";
```

When a recovery row exists, availability is `tracked`. With no row and a configured experiment/tracking start, conversations created before that timestamp are `predates_tracking`; later rows are `not_available` (including DM-origin/noneligible paths). Never infer tracking history from the current conversation state.

- [ ] **Step 2: Write failing counts and metrics tests**

Counts return both automation records and unique people for every view:

```ts
expect(response.body).toEqual({
  all: { records: 21, people: 18 },
  scheduled: { records: 6, people: 6 },
  ready: { records: 3, people: 2 },
  sent: { records: 5, people: 5 },
  suppressed: { records: 4, people: 3 },
  control: { records: 2, people: 2 },
  attention: { records: 1, people: 1 },
});
```

Metrics must exclude `settings_blocked` and records outside the configured experiment window from treatment/control comparison. Pin this response:

```ts
type RecoveryMetrics = {
  experiment: {
    version: string;
    startAt: string | null;
    endAt: string | null;
    treatment: {
      eligiblePeople: number;
      eligibleJourneys: number;
      sent: number;
      repliedWithin24h: number;
      repliedWithin48h: number;
      completedWithin24h: number;
      completedWithin48h: number;
      completionRate48h: number | null;
    };
    control: {
      eligiblePeople: number;
      eligibleJourneys: number;
      withheld: number;
      repliedWithin24h: number;
      repliedWithin48h: number;
      completedWithin24h: number;
      completedWithin48h: number;
      completionRate48h: number | null;
    };
    absoluteLiftPercentagePoints: number | null;
    relativeLiftPercent: number | null;
    medianReminderToReplyMinutes: number | null;
    byKeyword: Array<{
      keywordId: string;
      keyword: string;
      treatmentEligiblePeople: number;
      treatmentCompletedWithin48h: number;
      controlEligiblePeople: number;
      controlCompletedWithin48h: number;
    }>;
  };
  accuracy: {
    eventualRepliers: number;
    eventualRepliersWithPriorSeen: number;
    readEventCoverage: number | null;
    sent: number;
    laterSeen: number;
    laterEngaged: number;
    laterCompleted: number;
    delayedPreSendSignalFalsePositives: number;
    withoutLaterPositiveEvidence: number;
    uncertain: number;
    duplicateAttempts: number;
    cooldownSuppressions: number;
    staleLeases: number;
    failed: number;
    settingsClassifierMatches: number;
  };
  health: RecoveryHealthSnapshot;
};
```

Define replies/completions relative to `eligibleAt`, using identical 24-hour and 48-hour windows for both cohorts. Count treatment assignment by unique user for the primary comparison—one user is successful if any eligible journey completes—and retain journey counts beside it. `absoluteLiftPercentagePoints = treatmentRate - controlRate`; `relativeLiftPercent = (treatmentRate - controlRate) / controlRate`, or `null` when either denominator is unavailable or control rate is zero. Compute median reminder-to-reply only from treatment rows with both `sentAt` and a later `repliedAt`. `laterSeen`/`laterEngaged` count evidence received after `sentAt`; `delayedPreSendSignalFalsePositives` is the stricter subset whose provider event timestamp is before `sentAt`. This measures comments that may have been unnecessary because telemetry arrived late. Compute read-event coverage among eventual repliers only, where prior seen means `seenAt <= repliedAt`, and expose raw numerators beside every percentage.

- [ ] **Step 3: Write failing detail and owner-action tests**

Detail returns the recovery row, related journey/media, the original comment event when available, and an ordered typed timeline built from stored timestamps—not raw Graph responses.

Cancellation matrix:

```ts
it.each(["waiting", "control", "tracking_unavailable", "send_failed"])(
  "cancels an unsent %s item",
  async (_status) => {
    prisma.dmRecoveryReminder.updateMany.mockResolvedValue({ count: 1 });
    const response = await adminRequest.post(`/api/recovery-reminders/recovery-1/cancel`);
    expect(response.status).toBe(204);
    expect(prisma.dmRecoveryReminder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "recovery-1",
          status: { in: ["waiting", "control", "tracking_unavailable", "send_failed"] },
        }),
      }),
    );
  },
);
it.each(["sending", "sent", "send_uncertain", "cancelled"])(
  "returns 409 for %s",
  async (status) => {
    prisma.dmRecoveryReminder.updateMany.mockResolvedValue({ count: 0 });
    prisma.dmRecoveryReminder.findUnique.mockResolvedValue({ id: "recovery-1", status });
    const response = await adminRequest.post(`/api/recovery-reminders/recovery-1/cancel`);
    expect(response.status).toBe(409);
  },
);
```

`mark-reviewed` is allowed only for `send_failed`, `send_uncertain`, or `tracking_unavailable`; it stamps `reviewedAt` but never changes send status. Missing IDs return 404; invalid body/query returns 400. All routes inherit `requireAdmin` from `apiRouter`.

- [ ] **Step 4: Run route tests and verify RED**

Run: `npm test -- --run src/api/recoveryReminders.routes.test.ts`

Expected: FAIL because the router is not implemented or mounted.

- [ ] **Step 5: Implement reusable view predicates and batched queries**

Register `/counts` and `/metrics` before `/:id`. Keep the server's `viewWhere(view, now)` helper pure and tested. Use Prisma aggregate/distinct queries or one parameterized `$queryRaw` for counts; never interpolate user-supplied SQL. Use relation selects to avoid returning `publicReplyText`, raw event payloads, or private DMs in list responses.

For `/metrics`, calculate numerators and denominators on the server with explicit zero-denominator `null` rates. Round displayed percentages only in the frontend; return raw ratios or consistent one-decimal values, not formatted strings.

- [ ] **Step 6: Implement race-safe actions**

Cancellation uses one conditional `updateMany`:

```ts
const result = await prisma.dmRecoveryReminder.updateMany({
  where: {
    id: req.params.id,
    status: { in: ["waiting", "control", "tracking_unavailable", "send_failed"] },
    sentAt: null,
    publicReplyId: null,
  },
  data: { status: "cancelled", cancelledAt: now, suppressionReason: "owner_cancelled" },
});
```

When `count === 0`, distinguish not found (404) from a state race (409) with one follow-up select. `mark-reviewed` follows the same pattern. Emit `dm_recovery_cancelled` only after a successful cancellation. Log owner email, recovery ID, action, and old/new status only.

- [ ] **Step 7: Mount and verify GREEN**

Mount `apiRouter.use("/recovery-reminders", recoveryRemindersRouter)` after admin authentication and before the common error handler.

Run:

```bash
npm test -- --run src/api/recoveryReminders.routes.test.ts \
  src/api/conversations.routes.test.ts src/api/dmThreads.routes.test.ts \
  src/services/dmRecoveryHealth.test.ts
npm run build
```

Expected: API validation, filters, metrics, auth inheritance, and action races pass.

- [ ] **Step 8: Commit the API slice**

```bash
git add src/api/recoveryReminders.routes.ts src/api/recoveryReminders.routes.test.ts \
  src/api/conversations.routes.ts src/api/conversations.routes.test.ts src/api/router.ts
git commit -m "feat: expose dm recovery dashboard api"
```

---

### Task 15: Define Uncertainty-Aware Frontend Types and Labels

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/api.ts`
- Create: `web/src/components/conversations/dmRecoveryViewModel.ts`
- Create: `web/src/components/conversations/dmRecoveryViewModel.test.ts`

**Interfaces:**
- Consumes: API row/count/metric/detail types and current time.
- Produces: exact labels, descriptions, tones, filter categories, lateness text, and action eligibility without ever calling absent telemetry `Unread`.

- [ ] **Step 1: Write the failing label matrix**

```ts
it.each([
  [row({ status: "waiting", eligibleAt: hoursFromNow(2) }), "Waiting for read confirmation"],
  [row({ status: "waiting", eligibleAt: hoursAgo(1) }), "No confirmed read"],
  [row({ status: "suppressed", suppressionReason: "seen" }), "Seen—reminder not needed"],
  [row({ status: "suppressed", suppressionReason: "inbound_reply" }), "Replied—reminder not needed"],
  [row({ status: "suppressed", suppressionReason: "reaction" }), "Reacted—reminder not needed"],
  [row({ status: "suppressed", suppressionReason: "completed" }), "Completed—reminder not needed"],
  [row({ status: "suppressed", suppressionReason: "person_cooldown" }), "Another reminder was recently sent"],
  [row({ status: "sent", sentAt: onTime }), "Reminder sent"],
  [row({ status: "sent", sentAt: hoursAfterEligible(19) }), "Reminder sent late after worker delay"],
  [row({ triggerKind: "settings_blocked", status: "waiting" }), "Settings blocked"],
  [row({ status: "control" }), "Control group—reminder intentionally withheld"],
  [row({ status: "tracking_unavailable" }), "Tracking unavailable"],
  [row({ status: "cancelled" }), "Cancelled by owner"],
  [row({ status: "send_failed" }), "Couldn’t post public reminder"],
  [row({ status: "send_uncertain" }), "Send outcome uncertain—check Instagram"],
])("maps recovery evidence to %s", (input, expected) => {
  expect(recoveryStatusView(input, now).label).toBe(expected);
});
```

Assert no label/tooltip contains the standalone claim `Unread`. Pin the tooltip exactly:

```text
Meta accepted the DM, but we received no read confirmation. It may be unread, in Requests or Hidden Requests, blocked after acceptance, or read without an available receipt.
```

- [ ] **Step 2: Run the view-model test and verify RED**

Run: `cd web && npm test -- --run src/components/conversations/dmRecoveryViewModel.test.ts`

Expected: FAIL because the frontend recovery model does not exist.

- [ ] **Step 3: Add API types and calls**

Mirror the backend's closed unions in `web/src/lib/types.ts`: `RecoveryStatus`, `RecoveryCohort`, `RecoveryTriggerKind`, `RecoveryView`, `RecoveryReminderRow`, `RecoveryReminderDetail`, `RecoveryCounts`, `RecoveryMetrics`, and `RecoveryHealthSnapshot`. Extend `Conversation` with `recovery: ConversationRecoverySummary` and `readTrackingAvailability: "tracked" | "predates_tracking" | "not_available"` from Task 14.

Add these typed helpers to `web/src/lib/api.ts`:

```ts
export const recoveryApi = {
  list: (query: string) => api<Paginated<RecoveryReminderRow>>(`/recovery-reminders?${query}`),
  counts: () => api<RecoveryCounts>("/recovery-reminders/counts"),
  metrics: () => api<RecoveryMetrics>("/recovery-reminders/metrics"),
  detail: (id: string) => api<RecoveryReminderDetail>(`/recovery-reminders/${id}`),
  cancel: (id: string) => api<void>(`/recovery-reminders/${id}/cancel`, { method: "POST" }),
  markReviewed: (id: string) =>
    api<void>(`/recovery-reminders/${id}/mark-reviewed`, { method: "POST" }),
};
```

- [ ] **Step 4: Implement the pure view model**

Return `{ label, description, tone, attention, canCancel, canMarkReviewed }`. Treat a due `waiting` treatment item as `No confirmed read` in evidence language and `Reminder ready` in its secondary action/state text. `settings_blocked` always takes trigger-specific precedence. Define late as `sentAt > eligibleAt + workerIntervalAllowance`, not merely one millisecond after eligibility; use a fixed one-minute display allowance consistent with the default tick.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
cd web
npm test -- --run src/components/conversations/dmRecoveryViewModel.test.ts
npm run build
```

Expected: all labels/actions are deterministic and the production frontend builds.

- [ ] **Step 6: Commit frontend contracts**

```bash
git add web/src/lib/types.ts web/src/lib/api.ts \
  web/src/components/conversations/dmRecoveryViewModel.ts \
  web/src/components/conversations/dmRecoveryViewModel.test.ts
git commit -m "feat: define dm recovery dashboard states"
```

---

### Task 16: Build the DM Recovery List, Drawer, and Owner Actions

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Create: `web/src/components/conversations/DmRecoveryList.tsx`
- Create: `web/src/components/conversations/DmRecoveryList.test.tsx`
- Create: `web/src/components/conversations/DmRecoveryDrawer.tsx`
- Create: `web/src/components/conversations/DmRecoveryDrawer.test.tsx`
- Modify: `web/src/pages/Conversations.tsx`
- Create: `web/src/pages/Conversations.test.tsx`

**Interfaces:**
- Consumes: typed recovery list/counts/metrics/detail APIs, view model, query cache, and existing Drawer/UserLineage patterns.
- Produces: a separate `DM recovery` lens with filters, counts, health/experiment summaries, timeline, cancel/review controls, and links to the original post/user journey.

- [ ] **Step 1: Install the interactive component-test dependencies**

Run:

```bash
cd web
npm install --save-dev @testing-library/react @testing-library/user-event \
  @testing-library/jest-dom jsdom
```

Expected: `web/package.json` and `web/package-lock.json` change only by adding the four test-only packages and their resolved transitive dependencies. Put `// @vitest-environment jsdom` plus `import "@testing-library/jest-dom/vitest";` at the top of each new interactive `.test.tsx` file so existing Node/static-render tests keep their current environment.

- [ ] **Step 2: Write failing page/lens tests**

Render the page with mocked query responses and assert:

```ts
const user = userEvent.setup();
renderConversations({ recoveryCounts, recoveryRows });
expect(screen.getByRole("button", { name: "DM recovery" })).toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "DM recovery" }));
expect(screen.getByRole("button", { name: /Scheduled/ })).toBeInTheDocument();
expect(screen.getByRole("button", { name: /Ready/ })).toBeInTheDocument();
expect(screen.getByRole("button", { name: /Attention/ })).toBeInTheDocument();
expect(screen.getByText("18 people · 21 journeys")).toBeInTheDocument();
```

Prove the default remains `Needs reply`, selecting recovery does not fetch legacy journey pages unnecessarily, and existing `Needs reply`, `DMs`, and journey filters still render.

- [ ] **Step 3: Write failing list state tests**

Cover loading skeleton, empty state, API error/retry, cursor `Load more`, keyword/media/time/status rows, missing username/media, and health banner. Pin the circuit language:

```text
Public recovery is paused. Pending reminders are safe and will be re-evaluated after the issue is resolved.
```

The banner shows the safe reason and backlog but no raw provider message. Ready rows say `No confirmed read`; they do not say `Unread`.

- [ ] **Step 4: Write failing drawer/action tests**

Assert the timeline renders in this order when evidence exists:

1. original keyword comment;
2. initial public acknowledgement;
3. gate DM accepted/correlation status;
4. ten-hour monitoring window;
5. seen/engagement evidence or `No read confirmation received`;
6. policy decision;
7. public result;
8. later response/completion.

Pin owner controls:

```ts
const user = userEvent.setup();
renderRecoveryDrawer({ id: "recovery-1", status: "waiting" });
await user.click(screen.getByRole("button", { name: "Cancel reminder" }));
expect(recoveryApi.cancel).toHaveBeenCalledWith("recovery-1");
expect(queryClient.invalidateQueries).toHaveBeenCalledWith(
  expect.objectContaining({ queryKey: ["recovery-reminders"] }),
);
```

Cancellation needs one confirmation dialog explaining that it prevents a future comment and cannot remove an already posted comment. `Mark reviewed` appears only for attention states. There is no `Send now` control.

- [ ] **Step 5: Run component tests and verify RED**

Run:

```bash
cd web
npm test -- --run src/pages/Conversations.test.tsx \
  src/components/conversations/DmRecoveryList.test.tsx \
  src/components/conversations/DmRecoveryDrawer.test.tsx
```

Expected: FAIL because the recovery lens/components are absent.

- [ ] **Step 6: Implement the list with isolated React Query keys**

Use:

```ts
["recovery-reminders", view, keywordId, cohort]
["recovery-reminder-counts"]
["recovery-reminder-metrics"]
["recovery-reminder", selectedId]
```

Enable these queries only while `lens === "recovery"` (detail only while the drawer is open). Display each filter's `people · journeys` counts and preserve server cursor order. Open media permalink with `target="_blank" rel="noreferrer"` and fall back to `Original post unavailable`.

- [ ] **Step 7: Implement the drawer and mutation races**

Disable actions while their mutation is pending. On 409, show `This reminder changed before your action. Refreshing…`, close/refresh the drawer, and invalidate list/counts/metrics/detail. On success, invalidate the same caches. On general error, keep the drawer open and show a retryable inline error.

Use existing `UserLineage` for `View user journey`. Do not render the stored public text in list rows; the drawer may show the fixed rendered copy for audit.

- [ ] **Step 8: Update legacy journey language**

Change:

```ts
`${who} never replied, so the ${freebie} wasn’t sent.`
```

to:

```ts
`No reply completed this journey before it expired, so the ${freebie} wasn’t sent.`
```

For conversations whose server marker is `predates_tracking`, show secondary text `Read status unavailable—journey predates read tracking.` Prospective rows with a recovery summary show the corresponding secondary recovery badge; `not_available` rows make no read-status claim. Do not modify any automation state or enroll historical rows in recovery.

- [ ] **Step 9: Verify GREEN and accessibility basics**

Run:

```bash
cd web
npm test -- --run src/pages/Conversations.test.tsx \
  src/components/conversations/DmRecoveryList.test.tsx \
  src/components/conversations/DmRecoveryDrawer.test.tsx \
  src/components/conversations/dmRecoveryViewModel.test.ts
npm run lint
npm run build
```

Expected: focused tests pass; every filter/action is keyboard reachable; icons have adjacent text or accessible names; lint/build succeed.

- [ ] **Step 10: Commit the dashboard**

```bash
git add web/src/components/conversations/DmRecoveryList.tsx \
  web/src/components/conversations/DmRecoveryList.test.tsx \
  web/src/components/conversations/DmRecoveryDrawer.tsx \
  web/src/components/conversations/DmRecoveryDrawer.test.tsx \
  web/src/pages/Conversations.tsx web/src/pages/Conversations.test.tsx \
  web/package.json web/package-lock.json
git commit -m "feat: add dm recovery dashboard lens"
```

---

### Task 17: Add Browser Coverage for the Recovery Workflow

**Files:**
- Modify: `web/e2e/main.tsx`
- Create: `web/e2e/recovery-reminders.spec.ts`

**Interfaces:**
- Consumes: deterministic mocked `/api/recovery-reminders*` responses in the existing Playwright harness.
- Produces: browser-level proof of filters, evidence language, timeline, circuit warning, action mutations, cache refresh, and unchanged legacy lenses.

- [ ] **Step 1: Add failing E2E scenarios against the current page**

Create tests with accessible selectors, not CSS implementation details:

```ts
test("reviews a ready no-confirmed-read reminder", async ({ page }) => {
  await page.goto("/conversations?scenario=recovery-ready");
  await page.getByRole("button", { name: "DM recovery" }).click();
  await page.getByRole("button", { name: /Ready/ }).click();
  await expect(page.getByText("No confirmed read")).toBeVisible();
  await expect(page.getByText(/It may be unread, in Requests or Hidden Requests/)).toBeVisible();
  await expect(page.getByText(/^Unread$/)).toHaveCount(0);
});
```

Add browser cases for:

1. accepted -> seen -> suppressed label/timeline;
2. accepted -> inbound reply/completion -> no reminder needed;
3. accepted -> ready/sent no-confirmed-read reminder;
4. overdue after outage -> sent-late label;
5. control -> intentionally withheld;
6. verified settings block -> settings copy/status;
7. accepted without ID -> attention/tracking unavailable;
8. public timeout -> uncertain plus mark-reviewed;
9. multiple same-person keywords -> one sent, another cooldown/superseded;
10. delayed pre-send read timestamp -> accuracy metric increment;
11. circuit open -> banner and pending rows retained;
12. cancel waiting item -> POST, success state, refreshed counts;
13. legacy journey -> revised uncertainty language;
14. Needs reply and DMs lenses still work after visiting recovery.

- [ ] **Step 2: Run the E2E file and verify RED**

Run:

```bash
cd web
npm run test:e2e -- recovery-reminders.spec.ts
```

Expected: FAIL because the harness has no recovery fixtures and the page has no lens.

- [ ] **Step 3: Extend the API fixture router**

In `web/e2e/main.tsx`, branch on the `scenario` query parameter and mock all six API paths. Return stable ISO timestamps relative to a fixed test clock. Record POST calls in harness state so cancellation/review changes subsequent GET responses.

Do not bypass the real React Query/page components. Only the HTTP boundary is mocked.

- [ ] **Step 4: Implement all browser assertions**

Use exact fixture IDs and text. For mutations, assert both the POST request and the new rendered status/count. For the original post link, assert `href` and `target="_blank"`. For the drawer, verify timeline order by comparing locator positions.

- [ ] **Step 5: Verify GREEN and run the existing browser suite**

Run:

```bash
cd web
npm run test:e2e -- recovery-reminders.spec.ts
npm run test:e2e
```

Expected: all recovery scenarios and pre-existing Playwright scenarios pass.

- [ ] **Step 6: Commit browser coverage**

```bash
git add web/e2e/main.tsx web/e2e/recovery-reminders.spec.ts
git commit -m "test: cover dm recovery dashboard flows"
```

---

### Task 18: Document Meta Setup, Controlled Launch, Monitoring, and Rollback

**Files:**
- Modify: `README.md`
- Modify: `docs/meta-verification.md`

**Interfaces:**
- Consumes: deployed migration/code, Meta app settings, Railway/environment configuration, recovery dashboard health, and safe structured Graph metadata.
- Produces: a reproducible launch/runbook that starts automatic behavior on launch day without guessing settings errors or losing overdue users during worker downtime.

- [ ] **Step 1: Write the documentation acceptance checklist before editing prose**

Add this checklist to `docs/meta-verification.md` and leave each box unchecked for the deploy owner:

```md
- [ ] Add `messaging_seen`, `message_reactions`, and `messaging_postbacks` beside `comments` and `messages`.
- [ ] Receive one real signed webhook fixture for each new field.
- [ ] Match a real `read.mid` to the accepted gate's stored `instagramGateMessageId`.
- [ ] Confirm duplicate delivery leaves one evidence update.
- [ ] Confirm the settings-blocked signature allowlist is empty unless code/subcode was verified.
- [ ] Confirm the recovery circuit is closed and the hourly cap is conservative.
- [ ] Confirm the two-week experiment start/end/version are fixed before launch.
- [ ] Audit the first ready treatment row before and after its public comment.
```

- [ ] **Step 2: Document webhook setup and verification**

Update README's subscription line from only `comments`/`messages` to all required fields. In `docs/meta-verification.md`, document:

- how to enable the fields in the Meta app/dashboard;
- a redacted fixture shape for `read.mid`, `reaction.mid/action`, `postback.mid/payload`, ordinary text, attachment, quick reply, and deletion;
- the exact local correlation checks (`DmMessage.instagramMessageId`, `DmMessage.seenAt`, recovery evidence timestamps);
- that Business Suite's gray warning is unavailable as an API event;
- that no event means `No confirmed read`, not `Unread`;
- how to verify webhook signature handling and replay idempotency.

- [ ] **Step 3: Document safe settings-error activation**

State that `DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES` begins empty. To add `code:subcode`:

1. reproduce the blocked-settings case with a controlled Instagram account;
2. confirm Meta rejected the private-reply request rather than accepting it;
3. capture only numeric `graphCode` and `graphSubcode` through `describeGraphError`;
4. ensure it is not a rate-limit signature, especially subcode `2534025`;
5. add the exact pair to the environment variable;
6. redeploy and audit the first immediate fallback row.

Explicitly forbid classifying by error message text or the Business Suite gray warning.

- [ ] **Step 4: Document the launch sequence**

Use this exact order:

1. apply additive migration;
2. deploy ingestion/persistence/UI/worker with `DM_RECOVERY_ENABLED=false`;
3. subscribe and verify real new webhook signals immediately;
4. set experiment version plus a two-week `[start, end)` window beginning on launch day;
5. keep settings allowlist empty unless already verified;
6. set batch/hourly cap and health thresholds conservatively;
7. enable `DM_RECOVERY_ENABLED=true` on that same launch day, before the first ten-hour row is due;
8. audit the first ten treatment sends, all control assignments, all settings matches, and every attention item;
9. compare treatment/control after two full weeks by unique people and keyword;
10. after owner review, set `DM_RECOVERY_POST_EXPERIMENT_ENABLED=true` so only newly created records move to 100% treatment; previously stored controls remain withheld.

Mention that settings-blocked fallbacks can become eligible immediately; if their allowlist is enabled at launch, audit them from the first minute rather than waiting ten hours.

- [ ] **Step 5: Document incident and rollback procedures**

Kill switch rollback: set `DM_RECOVERY_ENABLED=false` and redeploy/restart. Ingestion and persistence continue; no new public sends occur; pending rows do not expire; existing Instagram comments are untouched; do not reverse the additive migration.

For a latched auth/permission breaker, first validate/rotate the token and confirm permissions with the existing Meta verification steps. Then reset only the singleton row through the trusted database console:

```sql
UPDATE "dm_recovery_control"
SET "circuit_open" = false,
    "reason" = NULL,
    "reset_at" = NOW(),
    "reset_by" = 'owner_after_meta_verification'
WHERE "id" = 1 AND "circuit_open" = true;
```

After recovery, leave batching/caps in place: the worker re-evaluates every overdue row and sends gradually. Document checks for queue depth, oldest eligibility, duplicate attempts, cooldown suppressions, stale leases, public failures, uncertain outcomes, delayed webhooks, and event-signal coverage.

- [ ] **Step 6: Verify docs contain the exact required language**

Run:

```bash
rg -n "messaging_seen|message_reactions|messaging_postbacks|No confirmed read|2534025|DM_RECOVERY_ENABLED|90/10|two-week|send_uncertain" README.md docs/meta-verification.md
rg -n "infer.*unread|gray warning.*webhook" README.md docs/meta-verification.md
```

Expected: the first scan finds every required setup/safety concept; the second scan finds only explicit warnings that these inferences/events are unavailable.

- [ ] **Step 7: Commit the launch runbook**

```bash
git add README.md docs/meta-verification.md
git commit -m "docs: add dm recovery launch runbook"
```

---

### Task 19: Run Full Verification and Perform a Requirements Audit

**Files:**
- Review: all files changed by Tasks 1–18
- Review: `docs/superpowers/specs/2026-08-06-instagram-read-recovery-reminders-design.md`
- Review: `docs/superpowers/plans/2026-08-06-instagram-read-recovery-reminders.md`

**Interfaces:**
- Consumes: completed implementation, approved design, migration, tests, docs, and worktree diff.
- Produces: evidence that the feature is correct, scoped, reviewable, and ready for a controlled deploy.

- [ ] **Step 1: Run schema and migration verification**

```bash
npx prisma format
npx prisma validate
npx prisma generate
```

With a safe local Postgres migration database:

```bash
MIGRATION_TEST_DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" \
  npm test -- --run src/services/dmRecoveryDatabaseContract.test.ts
```

Expected: schema/generation pass; the migration contract proves RLS, constraints, and concurrent exclusion. Never point the contract test at production or a non-local host.

- [ ] **Step 2: Run the complete backend suite and build**

Use either the worktree's ignored `.env` or non-secret schema-valid placeholders:

```bash
NODE_ENV=test \
META_APP_SECRET=test-secret \
META_VERIFY_TOKEN=test-verify \
IG_ACCESS_TOKEN=test-token \
IG_USER_ID=test-user \
DATABASE_URL=postgresql://test:test@127.0.0.1:5432/test \
SUPABASE_URL=https://example.supabase.co \
SUPABASE_SERVICE_KEY=test-service-key \
npm test
npm run build
```

Expected: no regression from the baseline `43 passed / 1 skipped` files and `514 passed / 9 skipped` tests; new recovery tests add to the pass total. Any new skip must be the documented optional local-Postgres contract only.

- [ ] **Step 3: Run the complete frontend suite**

```bash
cd web
npm test
npm run lint
npm run build
npm run test:e2e
```

Expected: Vitest, ESLint, Vite/TypeScript, recovery Playwright, and all existing browser scenarios pass.

- [ ] **Step 4: Run explicit safety searches**

```bash
rg -n 'Unread|never replied' web/src src docs/meta-verification.md README.md
rg -n 'raw.*error|error\.message|response\.data|access_token' \
  src/services/dmRecovery* src/handlers/seenHandler.ts \
  src/handlers/reactionHandler.ts src/handlers/postbackHandler.ts
```

Expected: `Unread` appears only inside the approved uncertainty tooltip sentence if capitalization happens to match; `never replied` is removed from journey outcome copy; and no recovery logger exposes raw provider/token data.

- [ ] **Step 5: Audit every approved behavior against live code**

Check off this matrix with a test/file reference for each row:

```text
accepted gate -> exact Meta/local IDs -> 10h candidate
accepted without Meta ID -> tracking unavailable
allowlisted settings rejection -> immediate fixed fallback
unknown/transient/rate-limit error -> never settings copy
seen/reply/attachment/quick reply/reaction/postback -> suppression evidence
unmatched deletion -> no new suppression
same-keyword completion elsewhere -> suppression
90/10 deterministic two-week cohort
control never sent retroactively
one person / 24h; newest eligible keyword wins
outage backlog has no maximum age and remains paced
claim race and final evidence recheck
ambiguous public outcome -> uncertain, no retry
auth/permission -> circuit; pending preserved
DM-origin and historical journeys excluded
dashboard uses No confirmed read and people/journey counts
cancel/review actions are conditional and admin-only
experiment, accuracy, per-keyword, and operational metrics present
kill switch and rollback documented
```

- [ ] **Step 6: Review the diff and request code review**

Run:

```bash
git status --short
git diff --check
git diff --stat HEAD~18..HEAD
git log --oneline --decorate -20
```

Then use `superpowers:requesting-code-review` against the complete branch. Resolve every correctness/security issue, rerun the affected focused tests, then rerun Steps 1–4 if any production code or schema changed.

- [ ] **Step 7: Commit only audit-driven fixes, if any**

```bash
git add prisma/schema.prisma \
  prisma/migrations/20260806210000_add_dm_recovery_reminders/migration.sql \
  src web/src web/e2e README.md docs/meta-verification.md
git commit -m "fix: address dm recovery verification findings"
```

Skip this commit when the audit produces no changes. The worktree must finish clean.

- [ ] **Step 8: Hand off the completed branch without deploying**

Summarize:

- final backend/frontend/E2E test totals;
- optional database-contract skip status;
- migration name and RLS result;
- experiment window/version and launch variables still requiring production values;
- settings allowlist state;
- any open attention/operational risks;
- exact branch and worktree path.

Do not enable the production worker, change Meta subscriptions, reset the circuit, deploy, merge, or post any real Instagram comment without a separate explicit user request.
