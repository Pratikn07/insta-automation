# Guide Access V2 Production Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Strict Follower Gate V2 enabled while removing every known silent dead end, aligning the application with Supabase, making stale Instagram controls recoverable, exposing blocked journeys to the creator, and safely repairing parents already affected in production.

**Architecture:** Preserve the existing strict fresh-follow authorization and durable guide-delivery ledger. Expand the database before changing runtime behavior, make each real Instagram action a durable event distinct from webhook redelivery, and route every accepted action through one result-and-recovery boundary. Add a read model and explicit owner actions for access attempts, then use the same tested services in a dry-run-first production repair command.

**Tech Stack:** TypeScript, Node.js 22+, Meta Instagram Graph API/webhooks, Prisma, PostgreSQL on Supabase, Express, React, TanStack Query, Vitest, Testing Library, disposable PostgreSQL migration contracts, Railway, Vercel.

**Specs:** [TinySoho guide covers and follower gate design](../specs/2026-08-22-tinysoho-guide-covers-and-follower-gate-design.md), [The follow re-ask card](../specs/2026-08-24-follow-reask-card-design.md), and the corrective decisions below, which supersede the older requirements that a replay is a silent no-op and that action tokens are merely “short-lived.”

## Global Constraints

- V2 remains enabled. This is a fix-forward release, not a rollback to V1.
- Automated guide delivery still requires a fresh Meta result with `source === "meta_live"` and `isFollower === true` for the current parent action.
- A confirmed non-follower never receives the guide; recovery restores a valid follow-check path but never relaxes the follower gate.
- The application and PostgreSQL constraint both permit exactly five follow checks and three follow responses per attempt.
- `request_guide` and `check_follow` controls remain valid through the complete current messaging window; there is no independent ten-minute parent-action TTL.
- A genuine new inbound quick reply or postback refreshes the internal messaging window to at least `eventAt + 24 hours`. A duplicated delivery of the same Meta webhook does not.
- A visible control may never resolve to silence. Expired, stale, already-completed, and review-required actions receive a truthful response or an owner-visible recovery record.
- Exact duplicate webhooks remain idempotent and produce no second parent message, follow check, cover, or guide.
- A distinct second tap of a persistent Instagram card is not treated as a duplicate webhook merely because it carries the same token.
- At most one durable guide delivery is started for a parent action. Existing delivery-ledger trigger and unit idempotency remain authoritative.
- No database transaction spans a Meta Graph read or outbound send.
- Do not edit the already-applied `20260822020000_add_guide_access_attempts` migration. Every schema correction is a new additive/forward migration.
- Apply remote Supabase schema changes only through committed Prisma migrations; never use the production Dashboard SQL editor for this repair.
- New server-owned tables have RLS enabled and no `anon` or general `authenticated` table privileges.
- No API response, browser DTO, metric, event, log, or repair report contains a parent ID, username, DM body, guide body, token, provider payload, signed URL, Supabase credential, or raw exception.
- Every production repair command defaults to read-only. Any external Instagram send requires a separate explicit flag and an exact reviewed candidate count.
- No production migration, repair write, Meta send, merge, or deployment occurs merely because this plan exists.

## Corrective Decisions

1. **Action lifetime follows the user promise.** Both opening and follow controls use the attempt's current messaging-window expiry. The ten-minute constant is removed.
2. **Webhook delivery and parent intent are separate identities.** A durable action-event receipt distinguishes Meta retrying one webhook from a parent tapping the same persistent card again.
3. **A stale control recovers; it does not authorize.** The new action event reopens or refreshes the attempt, then performs the same fresh follow check as any other request.
4. **Terminal outcomes are presented centrally.** Handlers do not inspect outcomes independently or return before the recovery presenter runs.
5. **Owner review is operable.** The Conversations drawer shows blocked access attempts and offers either a non-sending release or, while the messaging window is open, an explicitly acknowledged fresh-action resend.
6. **Production repair reuses runtime services.** It does not update attempt states with ad hoc SQL or call Meta outside the same fences used by live traffic.

## File Map

### New files

- `src/services/guideAccessPolicy.ts` — one application source for the 24-hour window and five/three limits.
- `src/services/guideAccessPolicy.test.ts` — exact policy contract.
- `prisma/migrations/20260825010000_repair_guide_access_limits/migration.sql` — forward-only constraint correction.
- `prisma/migrations/20260825020000_add_guide_action_event_receipts/migration.sql` — durable action-event idempotency.
- `src/services/guideActionEventIdentity.ts` — deterministic UUID identity for postback `mid` values.
- `src/services/guideActionEventIdentity.test.ts` — stability and non-leakage tests.
- `src/services/guideActionOutcomeService.ts` — one recovery/presentation boundary for routed controls.
- `src/services/guideActionOutcomeService.test.ts` — parent-visible outcome matrix.
- `src/services/guideAccessReviewService.ts` — owner read model and acknowledged recovery actions.
- `src/services/guideAccessReviewService.test.ts` — review/recovery service tests.
- `web/src/components/conversations/GuideAccessReviewCard.tsx` — creator-console access-recovery card.
- `web/src/components/conversations/GuideAccessReviewCard.test.tsx` — UI state and mutation tests.
- `scripts/guide-access-recovery-core.ts` — pure candidate classification and redacted summary generation.
- `scripts/guide-access-recovery.ts` — dry-run-first production audit/repair command.
- `scripts/guide-access-recovery.test.ts` — CLI argument, classification, and idempotency tests.
- `docs/qa/2026-08-24-guide-access-v2-production-recovery-qa.md` — verification evidence and release verdict.

### Existing files changed

- `prisma/schema.prisma` — action-event receipt model and relations.
- `src/services/guideAccessRepository.ts` and tests/contracts — shared limits, inbound-window refresh, event claiming, stale-action classification.
- `src/services/guideAccessMigrationContract.test.ts` — exact five/three catalog contract plus action-event security/index contract.
- `src/services/guideAccessActionService.ts` and tests — full-window tokens, recovery entry points, stable outcomes.
- `src/handlers/guideActionRouter.ts` and tests — action event identity, one outcome presenter, complete metrics.
- `src/handlers/messageHandler.ts` and tests — pass quick-reply event identity; never return before presentation.
- `src/handlers/postbackHandler.ts` and tests — pass deterministic postback identity; distinguish duplicate webhook from another tap.
- `src/services/guideAccessCopy.ts` and tests — reviewed recovery copy with control-aware text fallbacks.
- `src/services/guideAccessMetrics.ts` and tests — real expired/replayed/recovered counts and backlog health.
- `src/api/dmThreads.routes.ts` and tests — access-review DTO and list count.
- `src/api/guideDeliveries.routes.ts` and tests — owner resend route in addition to the existing release route.
- `web/src/lib/types.ts` — `GuideAccessReview` DTO.
- `web/src/components/conversations/DmThreadDrawer.tsx` — render the access-review card.
- `web/src/components/conversations/DmThreadList.tsx` — show access-review attention count.
- `web/src/pages/Conversations.test.tsx` — integration coverage for the recovery surface.
- `web/src/pages/Funnels.tsx` and tests — backlog health alert.
- `docs/guide-delivery-operations.md` — access-attempt recovery and rollout procedure.
- `package.json` — `audit:guide-access-recovery` script.

---

### Task 1: Establish one policy source and repair the production counter constraint

**Files:**

- Create: `src/services/guideAccessPolicy.ts`
- Create: `src/services/guideAccessPolicy.test.ts`
- Create: `prisma/migrations/20260825010000_repair_guide_access_limits/migration.sql`
- Modify: `src/services/guideAccessRepository.ts:26-40`
- Modify: `src/services/guideAccessMigrationContract.test.ts:300-325`
- Test: `src/services/guideAccessRepository.test.ts`
- Test: `src/services/guideAccessRepositoryContract.test.ts`

**Interfaces:**

```ts
export const GUIDE_ACCESS_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const GUIDE_ACCESS_MAX_FOLLOW_CHECKS = 5;
export const GUIDE_ACCESS_MAX_FOLLOW_RESPONSES = 3;
```

- `guideAccessRepository` imports these values instead of declaring private constants.
- PostgreSQL keeps the constraint name `guide_access_attempt_follow_counts_check`, so runtime diagnostics and existing catalog queries remain stable.
- The migration expands valid data only; the currently deployed code, which uses lower values on some paths, remains compatible while the new deployment starts.

- [ ] **Step 1: Add failing policy and repository tests**

```ts
it("pins the reviewed guide-access budgets", () => {
  expect(GUIDE_ACCESS_WINDOW_MS).toBe(86_400_000);
  expect(GUIDE_ACCESS_MAX_FOLLOW_CHECKS).toBe(5);
  expect(GUIDE_ACCESS_MAX_FOLLOW_RESPONSES).toBe(3);
});

it("permits the fourth and fifth checks and rejects the sixth", async () => {
  await seedAttempt({ followCheckCount: 3, followResponseCount: 2 });
  await expect(repository.claimDirectInbound(event(4))).resolves.toMatchObject({ kind: "consumed" });
  await resetAttempt({ followCheckCount: 4, followResponseCount: 3 });
  await expect(repository.claimDirectInbound(event(5))).resolves.toMatchObject({ kind: "consumed" });
  await resetAttempt({ followCheckCount: 5, followResponseCount: 3 });
  await expect(repository.claimDirectInbound(event(6))).resolves.toEqual({ kind: "check_limit_reached" });
});
```

- [ ] **Step 2: Run the focused tests and observe the current mismatch**

Run:

```bash
npm test -- src/services/guideAccessPolicy.test.ts src/services/guideAccessRepository.test.ts
```

Expected: FAIL because `guideAccessPolicy.ts` does not exist and the repository owns private constants.

- [ ] **Step 3: Update the migration contract to require five/three**

```ts
expect(byName.get("guide_access_attempt_follow_counts_check")).toMatch(
  /follow_check_count >= 0.*follow_check_count <= 5.*follow_response_count >= 0.*follow_response_count <= 3/,
);
expect(byName.has("guide_access_attempt_follow_counts_check_v2")).toBe(false);
```

- [ ] **Step 4: Create a forward-only, low-lock migration**

Use a new constraint name while validating so the existing guard remains active:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "guide_access_attempt"
  ADD CONSTRAINT "guide_access_attempt_follow_counts_check_v2"
  CHECK (
    "follow_check_count" >= 0
    AND "follow_check_count" <= 5
    AND "follow_response_count" >= 0
    AND "follow_response_count" <= 3
  ) NOT VALID;

ALTER TABLE "guide_access_attempt"
  VALIDATE CONSTRAINT "guide_access_attempt_follow_counts_check_v2";

ALTER TABLE "guide_access_attempt"
  DROP CONSTRAINT "guide_access_attempt_follow_counts_check";
ALTER TABLE "guide_access_attempt"
  RENAME CONSTRAINT "guide_access_attempt_follow_counts_check_v2"
  TO "guide_access_attempt_follow_counts_check";
COMMIT;
```

- [ ] **Step 5: Replace private constants with the shared policy**

```ts
import {
  GUIDE_ACCESS_MAX_FOLLOW_CHECKS,
  GUIDE_ACCESS_MAX_FOLLOW_RESPONSES,
} from "./guideAccessPolicy.js";
```

Use the exported constants in every count comparison and conditional update.

- [ ] **Step 6: Verify pristine and upgrade migration paths**

Run against a disposable loopback PostgreSQL database only:

```bash
DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npx prisma migrate deploy
npm test -- src/services/guideAccessMigrationContract.test.ts src/services/guideAccessRepositoryContract.test.ts
npx prisma validate
```

Expected: migrations apply in order; the catalog reports one five/three constraint; repository contracts pass.

- [ ] **Step 7: Commit the independently deployable schema repair**

```bash
git add src/services/guideAccessPolicy.ts src/services/guideAccessPolicy.test.ts \
  src/services/guideAccessRepository.ts src/services/guideAccessRepository.test.ts \
  src/services/guideAccessRepositoryContract.test.ts \
  src/services/guideAccessMigrationContract.test.ts \
  prisma/migrations/20260825010000_repair_guide_access_limits/migration.sql
git commit -m "fix: align guide access limits with production workflow"
```

---

### Task 2: Make action lifetime match the complete messaging window

**Files:**

- Modify: `src/services/guideAccessActionService.ts:35-36, 431-475, 1234-1290`
- Modify: `src/services/guideAccessActionService.test.ts`
- Modify: `src/services/guideAccessRepository.ts`
- Modify: `src/services/guideAccessRepository.test.ts`
- Test: `src/services/guideAccessRepositoryContract.test.ts`

**Interfaces:**

```ts
function actionExpiresAt(attempt: GuideAccessAttempt): Date {
  return attempt.messagingWindowExpiresAt;
}
```

- `request_guide` and `check_follow` token creation both use `attempt.messagingWindowExpiresAt`.
- Existing token consumption receives both `eventAt` and `now`. The signed provider event time decides whether the parent acted inside the promised window; the server time controls row timestamps and lease safety.
- Extending a window from a distinct genuine event belongs to Task 3, after durable event identity can prove the webhook is not a duplicate.

- [ ] **Step 1: Add delayed-opening regression tests**

```ts
it.each([
  ["eleven minutes", 11 * 60_000],
  ["two hours", 2 * 60 * 60_000],
  ["twenty-three hours", 23 * 60 * 60_000],
] as const)("accepts the opening after %s", async (_label, delay) => {
  const test = createHarness({ now: new Date(EVENT_AT.getTime() + delay) });
  await expect(request(test)).resolves.toBe("guide_delivery_started");
});

it("rejects an opening after the full action window when no new inbound recovery exists", async () => {
  const test = createHarness({ now: new Date(EVENT_AT.getTime() + GUIDE_ACCESS_WINDOW_MS + 1) });
  await expect(request(test)).resolves.toBe("action_expired");
});
```

- [ ] **Step 2: Add a provider-event-time repository contract**

```ts
it("accepts an in-window action even when webhook processing is delayed", async () => {
  const eventAt = new Date(WINDOW_EXPIRES_AT.getTime() - 1);
  const processingAt = new Date(WINDOW_EXPIRES_AT.getTime() + 60_000);
  const claimed = await repository.consumeToken({
    tokenId,
    action: "request_guide",
    senderId,
    eventAt,
    now: processingAt,
  });
  expect(claimed).toMatchObject({ kind: "consumed" });
});
```

- [ ] **Step 3: Run focused tests and confirm the ten-minute cases fail**

```bash
npm test -- src/services/guideAccessActionService.test.ts src/services/guideAccessRepositoryContract.test.ts
```

Expected: the 11-minute, two-hour, and 23-hour opening cases return `action_expired` before implementation.

- [ ] **Step 4: Remove the independent ten-minute TTL**

Delete `ACTION_TOKEN_TTL_MS`, remove `actionTokenTtlMs` from `GuideAccessActionDependencies`, and issue both action types with:

```ts
expiresAt: attempt.messagingWindowExpiresAt
```

- [ ] **Step 5: Validate against signed event time without extending from an unclassified replay**

Inside the existing short transaction, validate the token and current attempt window against `input.eventAt`. Keep `input.now` for `consumedAt`, update timestamps, and database leases. Do not refresh the attempt window in this task; Task 3 does that only after claiming a unique action-event receipt.

```ts
if (token.expiresAt <= input.eventAt || attempt.messagingWindowExpiresAt <= input.eventAt) {
  return { kind: "expired" as const };
}
```

Do not refresh from an outbound send, database retry, duplicate event, or server receipt time alone.

- [ ] **Step 6: Re-run focused tests and build**

```bash
npm test -- src/services/guideAccessActionService.test.ts src/services/guideAccessRepository.test.ts src/services/guideAccessRepositoryContract.test.ts
npm run build
```

Expected: all delayed-action and boundary cases pass; Prisma and TypeScript build cleanly.

- [ ] **Step 7: Commit**

```bash
git add src/services/guideAccessActionService.ts src/services/guideAccessActionService.test.ts \
  src/services/guideAccessRepository.ts src/services/guideAccessRepository.test.ts \
  src/services/guideAccessRepositoryContract.test.ts
git commit -m "fix: keep guide actions valid for the messaging window"
```

---

### Task 3: Distinguish duplicate webhooks from distinct taps of a persistent card

**Files:**

- Create: `prisma/migrations/20260825020000_add_guide_action_event_receipts/migration.sql`
- Modify: `prisma/schema.prisma`
- Create: `src/services/guideActionEventIdentity.ts`
- Create: `src/services/guideActionEventIdentity.test.ts`
- Modify: `src/services/guideAccessRepository.ts`
- Modify: `src/services/guideAccessRepository.test.ts`
- Modify: `src/services/guideAccessRepositoryContract.test.ts`
- Modify: `src/services/guideAccessMigrationContract.test.ts`

**Interfaces:**

```ts
export type GuideActionEventSource = "quick_reply" | "postback";

export interface ClaimGuideActionEventInput {
  eventId: string;       // UUID; DmMessage.id or deterministic UUID from postback mid
  tokenId: string;
  source: GuideActionEventSource;
  senderId: string;
  action: "request_guide" | "check_follow";
  eventAt: Date;
  now: Date;
}

export type ClaimGuideActionEventResult =
  | { kind: "claimed"; attempt: GuideAccessAttempt; tokenWas: "active" | "consumed" | "expired" }
  | { kind: "duplicate_event" }
  | { kind: "wrong_sender" | "wrong_action" | "not_found" }
  | { kind: "check_limit_reached"; attempt: GuideAccessAttempt };
```

For every claimed distinct action event, compute and persist the refreshed internal window with the fenced action transition:

```ts
const refreshedExpiry = new Date(input.eventAt.getTime() + GUIDE_ACCESS_WINDOW_MS);
const effectiveExpiry =
  refreshedExpiry > attempt.messagingWindowExpiresAt
    ? refreshedExpiry
    : attempt.messagingWindowExpiresAt;
```

This is the only action-control path that extends the internal messaging window.

`GuideActionEventReceipt` fields:

- `id UUID PRIMARY KEY` — event identity, not the token;
- `token_id UUID NOT NULL` with indexed `ON DELETE CASCADE` foreign key;
- `source guide_action_event_source NOT NULL`;
- `received_at TIMESTAMPTZ(3) NOT NULL`;
- `event_at TIMESTAMPTZ(3) NOT NULL`;
- `created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()`.

The table contains no sender, copy, provider `mid`, or payload.

- [ ] **Step 1: Write event-identity tests**

```ts
it("derives the same UUID for the same postback mid", () => {
  expect(guidePostbackEventId("mid-123")).toBe(guidePostbackEventId("mid-123"));
  expect(guidePostbackEventId("mid-123")).toMatch(UUID_RE);
});

it("does not embed the provider mid", () => {
  expect(guidePostbackEventId("private-provider-mid")).not.toContain("private-provider-mid");
});
```

Use SHA-256 over the namespaced string `tinysoho:guide-action-postback:v1:${mid}`, set RFC 4122 version/variant bits, and format the first 16 bytes as a UUID. No new dependency is required.

- [ ] **Step 2: Write receipt and concurrency contracts**

```ts
it("deduplicates one webhook but accepts another tap carrying the same token", async () => {
  const first = await repository.claimActionEvent(actionEvent({ eventId: EVENT_1, tokenId }));
  const duplicate = await repository.claimActionEvent(actionEvent({ eventId: EVENT_1, tokenId }));
  const secondTap = await repository.claimActionEvent(actionEvent({ eventId: EVENT_2, tokenId }));

  expect(first.kind).toBe("claimed");
  expect(duplicate).toEqual({ kind: "duplicate_event" });
  expect(secondTap).toMatchObject({ kind: "claimed", tokenWas: "consumed" });
});
```

Run the first and duplicate calls concurrently with two Prisma clients and assert one receipt row.

- [ ] **Step 3: Add the migration contract before the migration**

Assert:

- exact enum values `quick_reply`, `postback`;
- UUID/timestamptz column types;
- primary key on `id`;
- index on `token_id`;
- cascade only from token to receipt;
- RLS enabled;
- zero `anon`/`authenticated` grants.

- [ ] **Step 4: Run focused tests and observe failure**

```bash
npm test -- src/services/guideActionEventIdentity.test.ts src/services/guideAccessMigrationContract.test.ts src/services/guideAccessRepositoryContract.test.ts
```

Expected: missing helper/model/table failures.

- [ ] **Step 5: Add the forward migration and Prisma model**

Use lowercase SQL identifiers, an indexed foreign key, and no browser grants. Add the enum/model to `schema.prisma` using `@@map("guide_action_event_receipt")`.

- [ ] **Step 6: Implement `claimActionEvent` with fixed lock order**

Within one short transaction:

1. load token identity without trusting payload metadata;
2. lock the attempt;
3. verify sender and action before allowing the event to reserve anything;
4. insert/claim the event receipt;
5. lock the token;
6. classify its prior status;
7. refresh the genuine inbound window and claim the next state only when permitted.

If receipt insertion finds the same `eventId`, return `duplicate_event` without changing counts, state, token, or window.

- [ ] **Step 7: Verify migration, concurrency, and build**

```bash
DATABASE_URL="$MIGRATION_TEST_DATABASE_URL" npx prisma migrate deploy
npm test -- src/services/guideActionEventIdentity.test.ts src/services/guideAccessMigrationContract.test.ts src/services/guideAccessRepositoryContract.test.ts
npx prisma validate
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma \
  prisma/migrations/20260825020000_add_guide_action_event_receipts/migration.sql \
  src/services/guideActionEventIdentity.ts src/services/guideActionEventIdentity.test.ts \
  src/services/guideAccessRepository.ts src/services/guideAccessRepository.test.ts \
  src/services/guideAccessRepositoryContract.test.ts \
  src/services/guideAccessMigrationContract.test.ts
git commit -m "fix: separate parent taps from webhook replays"
```

---

### Task 4: Add one parent-visible action outcome and recovery service

**Files:**

- Create: `src/services/guideActionOutcomeService.ts`
- Create: `src/services/guideActionOutcomeService.test.ts`
- Modify: `src/services/guideAccessActionService.ts`
- Modify: `src/services/guideAccessActionService.test.ts`
- Modify: `src/services/guideAccessCopy.ts`
- Modify: `src/services/guideAccessCopy.test.ts`
- Modify: `src/meta/sendGuideAction.ts`
- Modify: `src/meta/sendGuideAction.test.ts`

**Interfaces:**

```ts
export type GuideActionOutcomePresentation =
  | "none_duplicate_webhook"
  | "guide_flow_continued"
  | "fresh_opening_sent"
  | "fresh_follow_action_sent"
  | "already_delivered_notice_sent"
  | "review_notice_sent"
  | "needs_review";

export async function presentGuideActionOutcome(input: {
  eventId: string;
  tokenId: string;
  senderId: string;
  action: "request_guide" | "check_follow";
  outcome: GuideAccessActionOutcome | "duplicate_event" | "stale_action";
  eventAt: Date;
}): Promise<GuideActionOutcomePresentation>;
```

Reviewed recovery copy:

```ts
expiredOpening: "That button had gone out of date, so I refreshed it for you 💛 Tap below and I'll check access now."
alreadyDelivered: "I've already sent this guide above 💛"
reviewRequired: "I couldn't complete that automatically, but I've flagged it for TinySoho to review 💛"
```

Rich recovery uses a fresh native control. Text fallback asks for `YES` on an opening and `DONE` on a follow check; it never names a button that is absent.

- [ ] **Step 1: Write the full outcome table before implementation**

```ts
it.each([
  ["duplicate_event", "none_duplicate_webhook"],
  ["guide_delivery_started", "guide_flow_continued"],
  ["guide_delivery_already_started", "already_delivered_notice_sent"],
  ["action_expired", "fresh_opening_sent"],
  ["action_replayed", "fresh_follow_action_sent"],
  ["access_attempt_needs_review", "review_notice_sent"],
] as const)("presents %s as %s", async (outcome, expected) => {
  await expect(present(outcome)).resolves.toBe(expected);
});
```

Split expired/replayed expectations by action and current attempt state so the service cannot send an opening when a follow action is required.

- [ ] **Step 2: Add safety tests**

Assert:

- duplicate webhook sends nothing;
- a different stale tap gets exactly one fresh action;
- delivered state never starts a second delivery;
- `needs_review` sends at most one notice per action-event receipt;
- fresh action send uncertainty returns `needs_review` and is not automatically repeated;
- wrong sender and unknown token disclose nothing and send nothing;
- no recovery branch authorizes without a fresh follow check.

- [ ] **Step 3: Run focused tests and confirm current silence**

```bash
npm test -- src/services/guideActionOutcomeService.test.ts src/services/guideAccessActionService.test.ts src/meta/sendGuideAction.test.ts
```

Expected: missing service and recovery-copy failures.

- [ ] **Step 4: Implement state-aware recovery methods**

Add service methods that return stable outcomes rather than allowing handlers to improvise:

```ts
refreshExpiredRequestAction(input): Promise<"fresh_opening_sent" | "needs_review">;
refreshStaleFollowAction(input): Promise<"fresh_follow_action_sent" | "needs_review">;
```

Each method loads token identity and sender-bound attempt context, uses the new action event as fresh intent, issues a new token through the repository, and sends through the existing rich/text capability boundary. It never directly updates Prisma rows outside the repository.

- [ ] **Step 5: Implement reviewed copy and fallbacks**

Keep strings in `guideAccessCopy.ts`, validate Meta title/subtitle limits in code points, and assert text fallbacks contain neither “tap” nor a missing control label.

- [ ] **Step 6: Verify all action outcomes are non-silent**

```bash
npm test -- src/services/guideActionOutcomeService.test.ts src/services/guideAccessActionService.test.ts src/services/guideAccessCopy.test.ts src/meta/sendGuideAction.test.ts
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/services/guideActionOutcomeService.ts src/services/guideActionOutcomeService.test.ts \
  src/services/guideAccessActionService.ts src/services/guideAccessActionService.test.ts \
  src/services/guideAccessCopy.ts src/services/guideAccessCopy.test.ts \
  src/meta/sendGuideAction.ts src/meta/sendGuideAction.test.ts
git commit -m "fix: recover every visible guide action outcome"
```

---

### Task 5: Route quick replies and postbacks through the complete outcome boundary

**Files:**

- Modify: `src/handlers/guideActionRouter.ts`
- Modify: `src/handlers/guideActionRouter.test.ts`
- Modify: `src/handlers/messageHandler.ts:449-470`
- Modify: `src/handlers/messageHandler.test.ts`
- Modify: `src/handlers/postbackHandler.ts`
- Modify: `src/handlers/postbackHandler.test.ts`

**Interfaces:**

```ts
export type GuideActionRouteInput = {
  payload: unknown;
  senderId: string;
  eventId: string;
  source: "quick_reply" | "postback";
  eventAt: Date;
};

export type GuideActionRouteResult =
  | { kind: "ignored" }
  | {
      kind: "handled";
      action: "request_guide" | "check_follow";
      outcome: GuideAccessActionOutcome | "duplicate_event";
      presentation: GuideActionOutcomePresentation;
    };
```

- Quick replies pass the captured `DmMessage.id` as `eventId`.
- Postbacks pass `guidePostbackEventId(postback.mid)` as `eventId`.
- The router claims the event, executes/recover the action, presents its outcome, and only then returns.

- [ ] **Step 1: Write handler tests for duplicate versus second tap**

```ts
it("does not present a duplicate quick-reply webhook twice", async () => {
  await handleMessage(quickReplyEvent({ mid: "same-mid" }));
  await handleMessage(quickReplyEvent({ mid: "same-mid" }));
  expect(routeGuideAction).toHaveBeenCalledTimes(1);
});

it("routes two postback taps with distinct mids even when the token is the same", async () => {
  await handlePostback(postback({ mid: "tap-1", payload: TOKEN_PAYLOAD }));
  await handlePostback(postback({ mid: "tap-2", payload: TOKEN_PAYLOAD }));
  expect(routeGuideAction).toHaveBeenCalledTimes(2);
  expect(routeGuideAction.mock.calls[0][0].eventId).not.toBe(routeGuideAction.mock.calls[1][0].eventId);
});
```

- [ ] **Step 2: Write router tests that require presentation**

For every handled `action_expired`, `action_replayed`, `access_attempt_needs_review`, `guide_delivery_already_started`, and successful flow outcome, assert `presentGuideActionOutcome` is called exactly once.

- [ ] **Step 3: Run focused tests and confirm the early-return defect**

```bash
npm test -- src/handlers/guideActionRouter.test.ts src/handlers/messageHandler.test.ts src/handlers/postbackHandler.test.ts
```

Expected: current handlers return after routing and do not satisfy presentation assertions.

- [ ] **Step 4: Pass explicit event identity from both webhook shapes**

Message handler:

```ts
await routeGuideAction({
  payload: msg.quick_reply.payload,
  senderId,
  eventId: inbound.messageId,
  source: "quick_reply",
  eventAt: observedAt,
});
```

Postback handler derives its UUID from `postback.mid`. A missing `mid` remains fail-closed, emits the existing safe diagnostic, and sends nothing because no idempotency identity can be proven.

- [ ] **Step 5: Make the router own result presentation and action metrics**

Remove outcome-specific recording from `recordDirectStrictOutcome`. After the action service returns, the router records the outcome and awaits the presenter before returning. Unknown payloads remain ignored and cannot reach free-text keyword matching.

- [ ] **Step 6: Re-run focused tests and build**

```bash
npm test -- src/handlers/guideActionRouter.test.ts src/handlers/messageHandler.test.ts src/handlers/postbackHandler.test.ts
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/handlers/guideActionRouter.ts src/handlers/guideActionRouter.test.ts \
  src/handlers/messageHandler.ts src/handlers/messageHandler.test.ts \
  src/handlers/postbackHandler.ts src/handlers/postbackHandler.test.ts
git commit -m "fix: finish every routed Instagram guide action"
```

---

### Task 6: Correct metrics and expose live backlog health

**Files:**

- Modify: `src/services/guideAccessMetrics.ts`
- Modify: `src/services/guideAccessMetrics.test.ts`
- Modify: `src/api/funnels.routes.ts`
- Modify: `src/api/funnels.routes.test.ts`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/pages/Funnels.tsx`
- Test: `web/src/pages/Funnels.test.tsx`

**Interfaces:**

Extend the action vocabulary:

```ts
action: ["received", "duplicate", "replayed", "expired", "recovered", "unsupported"]
```

Extend `GuideAccessMetricsResult`:

```ts
health: {
  awaitingRequest: number;
  awaitingFollow: number;
  needsReview: number;
  logicallyExpiredActiveTokens: number;
  oldestNeedsReviewAt: string | null;
};
```

Health queries use state/counts only and never return identities.

- [ ] **Step 1: Add failing metric-writer tests**

Assert that routed actions write:

- one `action/received` for each distinct action event;
- one `action/duplicate` for exact webhook redelivery;
- one `action/expired` before successful refresh;
- one `action/recovered` after a fresh control is sent;
- one `action/replayed` only when no state-changing work is repeated.

- [ ] **Step 2: Add a database-backed health snapshot test**

Seed attempts/tokens with known states and expiries, then assert exact aggregate counts. Include an `active` token whose `expires_at` is in the past; it must count as logically expired even before cleanup changes its status.

- [ ] **Step 3: Run focused backend tests and observe the zero-expiry blind spot**

```bash
npm test -- src/services/guideAccessMetrics.test.ts src/api/funnels.routes.test.ts
```

- [ ] **Step 4: Record action outcomes at the shared router boundary**

Do not record expired/replayed only in the ordinary-DM branch. The route that sees quick replies and postbacks writes the same allowlisted metrics.

- [ ] **Step 5: Add the health query and API DTO**

Use one aggregate query over `guide_access_attempt` and `guide_action_token`; do not load rows and count in application memory. Bound the query by current nonterminal states and token status/expiry indexes.

- [ ] **Step 6: Render an operational warning in Funnels**

Show a warning when `needsReview > 0` or `logicallyExpiredActiveTokens > 0`. Copy must say what needs action, for example: “6 guide requests need owner review” and link to Conversations. Do not display parent or resource identity on the aggregate page.

- [ ] **Step 7: Verify backend, frontend, and safety serialization**

```bash
npm test -- src/services/guideAccessMetrics.test.ts src/api/funnels.routes.test.ts
npm --prefix web test -- src/pages/Funnels.test.tsx
npm --prefix web run build
```

Assert serialized metrics contain none of the forbidden identity/copy/token fields.

- [ ] **Step 8: Commit**

```bash
git add src/services/guideAccessMetrics.ts src/services/guideAccessMetrics.test.ts \
  src/api/funnels.routes.ts src/api/funnels.routes.test.ts \
  web/src/lib/types.ts web/src/pages/Funnels.tsx web/src/pages/Funnels.test.tsx
git commit -m "fix: measure expired and blocked guide actions"
```

---

### Task 7: Surface blocked access attempts in the creator console

**Files:**

- Create: `src/services/guideAccessReviewService.ts`
- Create: `src/services/guideAccessReviewService.test.ts`
- Modify: `src/api/dmThreads.routes.ts`
- Modify: `src/api/dmThreads.routes.test.ts`
- Modify: `src/api/guideDeliveries.routes.ts`
- Modify: `src/api/guideDeliveries.routes.test.ts`
- Modify: `web/src/lib/types.ts`
- Create: `web/src/components/conversations/GuideAccessReviewCard.tsx`
- Create: `web/src/components/conversations/GuideAccessReviewCard.test.tsx`
- Modify: `web/src/components/conversations/DmThreadDrawer.tsx`
- Modify: `web/src/components/conversations/DmThreadList.tsx`
- Modify: `web/src/pages/Conversations.test.tsx`

**Interfaces:**

```ts
export interface GuideAccessReview {
  attemptId: string;
  conversationId: string;
  resourceName: string;
  state: "needs_review";
  lastFollowResult: "follower" | "non_follower" | "unknown";
  followCheckCount: number;
  followResponseCount: number;
  messagingWindowExpiresAt: string;
  messagingWindowOpen: boolean;
  canRelease: boolean;
  canResendAction: boolean;
}
```

New owner action:

```text
POST /api/guide-deliveries/access/:conversationId/resend-action
Body: { "acknowledgeDuplicateRisk": true }
```

Stable outcomes: `204`, `access_attempt_not_found` 404, `messaging_window_closed` 409, `access_attempt_delivering` 409, `duplicate_risk_acknowledgement_required` 400, `owner_auth_required` 401.

- [ ] **Step 1: Add failing read-model tests**

Seed one delivery review and one access review in the same thread. Assert `dmThreadsRouter` returns both separately, limits guide names to the existing safe length, and excludes token IDs, cover URLs, provider IDs, messages, error traces, and parent identity beyond the thread's existing fields.

- [ ] **Step 2: Add list-count tests without an N+1 query**

Batch-load active review attempts for the page's `igUserId` values and map counts by thread. Assert one additional query for the page, not one query per thread.

- [ ] **Step 3: Add route/service tests for both remedies**

```ts
it("releases without sending when the owner chooses wait for next reply", ...);
it("sends one fresh action only after duplicate-risk acknowledgement", ...);
it("refuses resend after the messaging window closes", ...);
it("refuses both access actions when a guide delivery owns recovery", ...);
it("records actor, action, conversationId and attemptId without parent data", ...);
```

- [ ] **Step 4: Run backend tests and confirm no current DTO/UI surface exists**

```bash
npm test -- src/services/guideAccessReviewService.test.ts src/api/dmThreads.routes.test.ts src/api/guideDeliveries.routes.test.ts
```

- [ ] **Step 5: Implement the safe batched read model**

Select only attempts in `needs_review`, their conversation ID, bounded resource name, counts/result/window, and whether any delivery makes the access attempt ineligible for release. Compute `messagingWindowOpen`, `canRelease`, and `canResendAction` on the server.

- [ ] **Step 6: Implement acknowledged fresh-action resend**

Reuse `guideActionOutcomeService` and repository fences. The route issues a fresh action; it does not deliver a guide, infer follower status, or reset a delivery-owned attempt. A definite send rejection leaves the attempt recoverable; an uncertain send returns it to `needs_review`.

- [ ] **Step 7: Write the creator card before implementation**

Required UI states:

- title: **Guide access needs review**;
- guide name and “3 checks · 2 follow responses”;
- explanation that the guide is still withheld;
- **Send fresh button** only when `canResendAction`;
- **Release for next reply** when `canRelease`;
- closed-window explanation with no misleading send control;
- confirmation dialog before either duplicate-risk action;
- unknown mutation outcome tells the owner to refresh, not retry automatically.

- [ ] **Step 8: Integrate the card and list badge**

Render access reviews above reply drafts and beside delivery reviews. Invalidate `dm-thread`, `dm-threads`, and `conversation-counts` after a settled owner action.

- [ ] **Step 9: Verify UI behavior and build**

```bash
npm --prefix web test -- src/components/conversations/GuideAccessReviewCard.test.tsx src/pages/Conversations.test.tsx
npm --prefix web run lint
npm --prefix web run build
```

- [ ] **Step 10: Commit**

```bash
git add src/services/guideAccessReviewService.ts src/services/guideAccessReviewService.test.ts \
  src/api/dmThreads.routes.ts src/api/dmThreads.routes.test.ts \
  src/api/guideDeliveries.routes.ts src/api/guideDeliveries.routes.test.ts \
  web/src/lib/types.ts \
  web/src/components/conversations/GuideAccessReviewCard.tsx \
  web/src/components/conversations/GuideAccessReviewCard.test.tsx \
  web/src/components/conversations/DmThreadDrawer.tsx \
  web/src/components/conversations/DmThreadList.tsx web/src/pages/Conversations.test.tsx
git commit -m "feat: let creators recover blocked guide access"
```

---

### Task 8: Build a dry-run-first repair command for affected production journeys

**Files:**

- Create: `scripts/guide-access-recovery-core.ts`
- Create: `scripts/guide-access-recovery.ts`
- Create: `scripts/guide-access-recovery.test.ts`
- Modify: `package.json`
- Modify: `docs/guide-delivery-operations.md`

**Interfaces:**

```ts
type RecoveryCandidateKind =
  | "counter_constraint_review"
  | "swallowed_opening_action"
  | "logically_expired_active_token";

type RecoveryMode =
  | "audit"
  | "normalize-token-status"
  | "release-counter-reviews"
  | "replay-swallowed-actions";
```

CLI:

```text
npm run audit:guide-access-recovery
npm run audit:guide-access-recovery -- --mode normalize-token-status --apply --expected-count 92 --actor owner@example.com
npm run audit:guide-access-recovery -- --mode release-counter-reviews --apply --expected-count 6 --actor owner@example.com
npm run audit:guide-access-recovery -- --mode replay-swallowed-actions --apply --send-instagram --expected-count 8 --actor owner@example.com
```

Numbers above are examples from the audit and are never hardcoded; the operator supplies the freshly reviewed count.

- [ ] **Step 1: Write pure classification fixtures**

Include:

- `needs_review`, `non_follower`, exactly three/two, no delivery → counter-constraint candidate;
- same counts with a delivery → exclude and route to delivery review;
- awaiting request + expired request token + later captured inbound + no delivery → swallowed-action candidate;
- active token with past `expiresAt` → normalization candidate;
- delivered/expired/wrong deployment window → exclude.

- [ ] **Step 2: Write CLI safety tests**

Assert:

- no arguments performs reads only;
- `--apply` without exact `--expected-count` fails before opening a write transaction;
- Instagram replay also requires `--send-instagram`;
- actor is required for every write;
- a count drift of one is a hard failure;
- output includes counts/resource names only and never parent IDs, usernames, message text, token values, or provider mids.

- [ ] **Step 3: Run tests and confirm the command is absent**

```bash
npm test -- scripts/guide-access-recovery.test.ts
```

- [ ] **Step 4: Implement audit mode with production-safe queries**

Use Prisma selects that return only fields needed for classification. Report:

- candidate count by kind;
- count by resource name;
- open versus closed messaging windows;
- oldest/newest candidate timestamps;
- excluded count by stable reason.

- [ ] **Step 5: Implement token normalization as database-only maintenance**

Update `guide_action_token.status` from `active` to `expired` only where `expires_at <= now()` and the expected candidate count still matches. Do not change the attempt, send a message, or consume retry allowance.

- [ ] **Step 6: Implement review release through the repository**

Call `releaseAttemptForConversation` for the exact classified candidates. Do not issue raw SQL state updates. Record one existing `guide_access_owner_action` event per release with the supplied actor.

- [ ] **Step 7: Implement swallowed-action replay through runtime services**

For each exact candidate, call the same routed-action service using its already persisted `DmMessage.id` as `eventId`. The action-event receipt prevents a second run from repeating work. Stop immediately on a needs-review or uncertain-send outcome; do not continue a batch after ambiguous external state.

- [ ] **Step 8: Add the package command and operations procedure**

```json
"audit:guide-access-recovery": "tsx scripts/guide-access-recovery.ts"
```

Document audit, owner review, approval, apply, post-check, and rollback behavior. State clearly that `replay-swallowed-actions` contacts real parents.

- [ ] **Step 9: Verify dry-run output against a production-shaped disposable fixture**

```bash
npm test -- scripts/guide-access-recovery.test.ts
npm run audit:guide-access-recovery
```

Expected locally: redacted deterministic report; zero writes without `--apply`.

- [ ] **Step 10: Commit**

```bash
git add scripts/guide-access-recovery-core.ts scripts/guide-access-recovery.ts \
  scripts/guide-access-recovery.test.ts package.json docs/guide-delivery-operations.md
git commit -m "feat: add controlled guide access recovery tooling"
```

---

### Task 9: Add end-to-end regression coverage for the complete parent and creator journeys

**Files:**

- Modify: `src/services/guideAccessActionService.test.ts`
- Modify: `src/services/guideAccessRepositoryContract.test.ts`
- Modify: `src/handlers/guideActionRouter.test.ts`
- Modify: `src/handlers/messageHandler.test.ts`
- Modify: `src/handlers/postbackHandler.test.ts`
- Modify: `src/api/dmThreads.routes.test.ts`
- Modify: `web/src/pages/Conversations.test.tsx`
- Create: `docs/qa/2026-08-24-guide-access-v2-production-recovery-qa.md`

**Interfaces:** No new runtime interface. This task proves the contracts introduced in Tasks 1–8 as complete journeys.

- [ ] **Step 1: Add the follower delayed-tap journey**

Comment → opening → wait two hours → tap → fresh Meta true → one cover/guide delivery → delivered attempt. Assert no follow gate and no expired response.

- [ ] **Step 2: Add the non-follower journey through all reviewed responses**

Comment → opening → false → gate → first re-tap false → re-ask → second false → lag → third false → closing text → typed DONE after following → fresh true → one guide delivery.

Assert five-check/three-response budgets remain consistent in both repository and database.

- [ ] **Step 3: Add stale-card and duplicate-webhook journeys**

- same postback `mid` delivered twice → one action, one response;
- same persistent card tapped again with a different `mid` → a fresh recovery response;
- stale button after guide delivered → “already sent above,” no redelivery;
- expired opening tapped as a genuine new event → fresh action, not silence.

- [ ] **Step 4: Add failure/review journeys**

- Meta unavailable → neutral response, no guide;
- database transition failure → review notice and creator card;
- recovery send uncertain → `needs_review`, no automatic retry;
- messaging window closed → no send, creator sees closed state;
- guide delivery owns the attempt → access recovery refuses and points to delivery review.

- [ ] **Step 5: Add creator-console journey tests**

Open thread → see access review → acknowledge fresh-button resend → mutation settles → caches refresh → card disappears or reflects new state. Test unknown mutation outcome requires refresh and does not automatically repeat.

- [ ] **Step 6: Run the complete automated gate**

```bash
npm test
npm run build
npm run check:guide-delivery-bypasses
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
```

Run migration contracts with `MIGRATION_TEST_DATABASE_URL` pointing only to disposable loopback PostgreSQL.

- [ ] **Step 7: Perform mutation checks on the critical regressions**

Temporarily and locally restore each defect, one at a time, and prove the named test fails:

- change five/three back to three/two;
- restore the ten-minute opening TTL;
- skip the outcome presenter;
- treat a distinct second tap as duplicate;
- remove the creator access-review DTO.

Restore the correct implementation after every mutation.

- [ ] **Step 8: Write the QA evidence report**

Record exact commands, pass/fail counts, disposable database identity, migration catalogue output, build results, controlled Meta cases still requiring live verification, and a verdict of either `BLOCKED` or `READY FOR CONTROLLED PRODUCTION REPAIR`.

- [ ] **Step 9: Commit**

```bash
git add src web/src docs/qa/2026-08-24-guide-access-v2-production-recovery-qa.md
git commit -m "test: prove guide access recovery end to end"
```

---

### Task 10: Deploy migration-first, verify controlled accounts, and repair production safely

**Files:**

- Modify after execution evidence: `docs/qa/2026-08-24-guide-access-v2-production-recovery-qa.md`
- Modify after execution evidence: `docs/guide-delivery-operations.md`

**Interfaces:** Operational execution only. This task does not add runtime code.

- [ ] **Step 1: Reconcile Git before release**

Create the implementation branch from the current deployed `main` lineage, preserve unrelated user changes, merge current `origin/main`, and prove the release contains production commit `860c79e` plus Tasks 1–9.

- [ ] **Step 2: Create a pull request with explicit release order**

PR checklist must state:

1. forward migrations first;
2. Railway API deployment second;
3. Vercel console deployment third;
4. controlled test-account verification fourth;
5. production repair only after fresh counts are reviewed.

- [ ] **Step 3: Review Supabase migration safety**

Before merge:

```bash
npx prisma migrate status
npx prisma validate
```

Review the migration diff, verify no applied migration changed, verify RLS/no-browser grants on the receipt table, and run Supabase database advisors. A lock timeout is a deployment failure; do not increase it during the incident without reviewing active locks.

- [ ] **Step 4: Merge and let Railway apply migrations before starting the API**

The production start command already runs `dist/src/migrate.js` before `dist/src/server.js`. Confirm Railway's deployment log shows both new migration names applied and only then shows the server ready.

- [ ] **Step 5: Verify the production schema read-only**

Query `pg_constraint`, `pg_class`, `pg_policy`, and role grants to prove:

- five/three constraint active under the original name;
- no `_v2` temporary constraint remains;
- receipt table/index/FK valid;
- RLS enabled;
- no `anon`/`authenticated` grants.

- [ ] **Step 6: Verify Railway runtime health before contacting Instagram**

Check deployed commit SHA, V2/rich/card flags, boot/migration errors, PostgreSQL `23514` errors, action-handler exceptions, and metrics endpoint shape. Required result: no new `guide_access_attempt_follow_counts_check` violation.

- [ ] **Step 7: Deploy the Vercel creator console**

Verify deployed commit identity, authenticated Conversations load, access-review list badge, drawer card, closed-window state, and owner action confirmation without operating on a real parent.

- [ ] **Step 8: Run controlled Instagram journeys**

With authorized test accounts only:

- follower taps opening after more than ten minutes and receives one guide;
- non-follower follows and completes via persistent button;
- exact duplicate webhook produces nothing twice;
- second genuine tap receives recovery;
- creator sees and resolves a deliberately seeded test review.

Capture sanitized request/result timestamps and screenshots; do not record tokens or provider bodies.

- [ ] **Step 9: Run production recovery audit in read-only mode**

```bash
npm run audit:guide-access-recovery
```

Compare candidate counts with the QA report. If counts drift, review the new report; never reuse an earlier `--expected-count`.

- [ ] **Step 10: Normalize expired token statuses**

After owner reviews the exact count, run `normalize-token-status` with `--apply`, actor, and exact count. Re-run audit and require zero logically expired tokens still marked active.

- [ ] **Step 11: Release counter-constraint reviews**

Review every candidate in the creator console first. Run the exact-count release mode, then verify those attempts are no longer active `needs_review`. Do not touch attempts owned by a guide delivery.

- [ ] **Step 12: Obtain separate authorization before replaying swallowed actions**

The replay mode contacts real parents. Present the exact count, resource breakdown, open-window count, and proposed recovery copy to the owner. Run it only after explicit authorization in that execution turn.

- [ ] **Step 13: Monitor for 24 hours**

At 15 minutes, one hour, six hours, and 24 hours verify:

- zero new counter-constraint violations;
- `action/expired`, `action/replayed`, and `action/recovered` agree with handler logs and test actions;
- zero silently handled actions;
- `needsReview` is stable or falling;
- no duplicate guide deliveries;
- no recovery send uncertainty left without creator visibility.

- [ ] **Step 14: Record the release verdict**

Update the QA and operations documents with migration IDs, Railway/Vercel deployment IDs and commit SHAs, controlled-account evidence, repair counts, unresolved reviews, and the 24-hour verdict. Do not mark complete until every remaining review has an owner and next action.

---

## Completion Criteria

- Production PostgreSQL and application code both enforce five checks/three responses.
- No parent-facing guide action has a ten-minute expiry.
- Every distinct valid Instagram action produces progress, a fresh control, an already-delivered notice, or an owner-visible review.
- Exact duplicate webhooks remain silent and idempotent without being confused with a second parent tap.
- The creator can see and resolve access attempts from Conversations.
- Metrics show actual expired, replayed, duplicate, recovered, and review outcomes plus current backlog health.
- Production repair is count-fenced, audited, idempotent, and read-only by default.
- Previously stuck constraint attempts are released or actively owned; swallowed actions are replayed only with explicit authorization.
- No guide is delivered without a fresh Meta follower confirmation.
- No duplicate cover or guide is sent during automated or owner recovery.
