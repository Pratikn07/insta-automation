# Owner-Approved DM Drafts and Engagement Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reactive DM drafts safe to approve and send, and add one owner-approved engagement follow-up 12 hours after successful guide delivery while always refusing automatic, stale, duplicate, legacy-prompt, or out-of-window sends.

**Architecture:** Extend the existing `ReplyDraft` state machine with a draft kind, timing fields, prompt-policy version, and terminal expiration. Successful guide delivery schedules a follow-up through the same bounded Codex generation worker and owner-only approval route used by reactive replies. The isolated runtime can only return structured text; the API remains the only Instagram credential boundary and performs every safety check again in the atomic send claim.

**Tech Stack:** Node.js 22, TypeScript, Express 4, Prisma/PostgreSQL, React 19, TanStack Query, Vitest, Playwright, Railway, Vercel, `@openai/codex` exactly `0.146.0`.

## Global Constraints

- Keep `@openai/codex` pinned to exactly `0.146.0`.
- Keep `AI_SEND_ENABLED=false` through Tasks 1–9 and through production shadow verification.
- No background worker may import or call `sendTrackedText` for AI-generated content.
- Codex receives no Instagram, database, Supabase, owner-session, or OpenAI API-key credential.
- Every AI-generated Instagram send requires the authenticated owner to click **Approve & Send**.
- The exact trimmed editor text is the only AI-generated text passed to Instagram.
- Follow-up eligibility is guide delivery plus 12 hours.
- Follow-up expiration is the latest genuine inbound timestamp plus 23 hours 30 minutes.
- A new genuine inbound supersedes a pending follow-up; a delayed older webhook does not.
- Existing keyword, follow-gate, guide-delivery, and advisor behavior must remain unchanged.
- General logs and `EventLog` must not duplicate DM bodies, prompt text, or model output.
- Use stable browser-safe error codes; do not expose raw Codex, Graph, token, prompt, or account errors.
- Design source: `docs/superpowers/specs/2026-08-05-owner-approved-drafts-and-follow-ups-design.md`.

---

### Task 1: Correct the Codex drafting protocol and version the safety policy

**Files:**
- Modify: `codex-runtime/src/schemas.ts`
- Modify: `codex-runtime/src/prompts.ts`
- Modify: `codex-runtime/src/draftService.ts`
- Modify: `codex-runtime/src/schemas.test.ts`
- Modify: `codex-runtime/src/draftService.test.ts`
- Modify: `codex-runtime/src/appServerContract.test.ts`

**Interfaces:**
- Consumes: pinned app-server `thread/start` field `developerInstructions`.
- Produces: runtime request fields `kind`, `promptVersion`, and `guideDeliveredAt`; `developerInstructionsFor(kind)`; a real-binary contract that rejects reintroduction of `developerMessage`.

- [ ] **Step 1: Add failing schema and request-shape tests**

Add cases equivalent to:

```ts
expect(
  dmDraftRequestSchema.parse({
    ...VALID_REQUEST,
    kind: "reply",
    promptVersion: 2,
    guideDeliveredAt: null,
  }),
).toMatchObject({ kind: "reply", promptVersion: 2, guideDeliveredAt: null });

expect(() =>
  dmDraftRequestSchema.parse({
    ...VALID_REQUEST,
    kind: "engagement_follow_up",
    promptVersion: 1,
    guideDeliveredAt: new Date().toISOString(),
  }),
).toThrow();

expect(request).toHaveBeenCalledWith(
  "thread/start",
  expect.objectContaining({
    developerInstructions: expect.stringContaining("owner to review"),
  }),
  30_000,
);
expect(request.mock.calls[0]![1]).not.toHaveProperty("developerMessage");
```

Extend the pinned-binary contract test to generate the experimental TypeScript schema into a temporary directory and assert `ThreadStartParams.ts` contains `developerInstructions` and not `developerMessage`. Do not perform a model turn.

- [ ] **Step 2: Run the focused runtime tests and verify failure**

Run:

```bash
cd codex-runtime
npm test -- src/schemas.test.ts src/draftService.test.ts src/appServerContract.test.ts
```

Expected: FAIL because the request schema lacks the new fields and `draftService` still sends `developerMessage`.

- [ ] **Step 3: Implement the strict request contract and prompt selector**

In `schemas.ts`, make the object strict and add:

```ts
kind: z.enum(["reply", "engagement_follow_up"]),
promptVersion: z.literal(2),
guideDeliveredAt: z.string().datetime().nullable(),
```

In `prompts.ts`, keep separate instruction constants and export:

```ts
export function developerInstructionsFor(
  kind: DmDraftRequest["kind"],
): string {
  return kind === "engagement_follow_up"
    ? ENGAGEMENT_FOLLOW_UP_DEVELOPER_INSTRUCTIONS
    : DM_REPLY_DEVELOPER_INSTRUCTIONS;
}
```

The follow-up instructions must require one or two short sentences, one easy question, no repeated link by default, no follow request, no sale, no diagnosis, no urgency or guilt, and no claim that anything was sent.

In `draftService.ts`, replace the invalid field exactly:

```ts
developerInstructions: developerInstructionsFor(input.kind),
```

Keep `approvalPolicy: "never"`, `sandbox: "read-only"`, empty roots/environments, no tools, untrusted transcript context, and structured output unchanged.

- [ ] **Step 4: Run runtime verification**

Run:

```bash
cd codex-runtime
npm test
npm run build
```

Expected: all runtime tests pass and TypeScript builds.

- [ ] **Step 5: Commit the protocol safety fix**

```bash
git add codex-runtime/src
git commit -m "fix(ai): apply versioned DM safety instructions"
```

---

### Task 2: Add follow-up and prompt-policy database invariants

**Files:**
- Create: `prisma/migrations/20260805160000_add_owner_approved_followups/migration.sql`
- Modify: `prisma/schema.prisma`
- Create: `src/services/replyDraftPolicy.ts`
- Create: `src/services/replyDraftPolicy.test.ts`
- Modify: `src/services/replyDraftMachine.ts`
- Modify: `src/services/replyDraftMachine.test.ts`

**Interfaces:**
- Consumes: existing `ReplyDraft`, `Conversation`, and active-draft partial unique index.
- Produces: `ReplyDraftKind`, `expired`, timing/version fields, `CURRENT_DM_PROMPT_VERSION`, `computeFollowUpSchedule()`, and legal expiration transitions.

- [ ] **Step 1: Write failing policy and state-machine tests**

Create tests using fixed timestamps:

```ts
const deliveredAt = new Date("2026-08-05T10:00:00.000Z");
const inboundAt = new Date("2026-08-05T09:45:00.000Z");

expect(computeFollowUpSchedule({ deliveredAt, inboundAt })).toEqual({
  eligibleAt: new Date("2026-08-05T22:00:00.000Z"),
  expiresAt: new Date("2026-08-06T09:15:00.000Z"),
});

expect(
  computeFollowUpSchedule({
    deliveredAt: new Date("2026-08-06T09:00:00.000Z"),
    inboundAt,
  }),
).toBeNull();

expect(isCurrentPromptVersion(2)).toBe(true);
expect(isCurrentPromptVersion(null)).toBe(false);
expect(canTransition("queued", "expired")).toBe(true);
expect(canTransition("pending_approval", "expired")).toBe(true);
expect(canTransition("expired", "sending")).toBe(false);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npm test -- src/services/replyDraftPolicy.test.ts src/services/replyDraftMachine.test.ts
```

Expected: FAIL because the policy module and `expired` status do not exist.

- [ ] **Step 3: Implement policy constants and state transitions**

Create `replyDraftPolicy.ts` with these exact exports:

```ts
export const CURRENT_DM_PROMPT_VERSION = 2;
export const FOLLOW_UP_DELAY_MS = 12 * 60 * 60 * 1000;
export const FOLLOW_UP_WINDOW_MS = 23.5 * 60 * 60 * 1000;

export function computeFollowUpSchedule(input: {
  deliveredAt: Date;
  inboundAt: Date;
}): { eligibleAt: Date; expiresAt: Date } | null {
  const eligibleAt = new Date(input.deliveredAt.getTime() + FOLLOW_UP_DELAY_MS);
  const expiresAt = new Date(input.inboundAt.getTime() + FOLLOW_UP_WINDOW_MS);
  return eligibleAt < expiresAt ? { eligibleAt, expiresAt } : null;
}

export function isCurrentPromptVersion(value: number | null): boolean {
  return value === CURRENT_DM_PROMPT_VERSION;
}
```

Add `expired` transitions from `queued`, `generating`, `pending_approval`, `generation_failed`, and `send_failed`. Keep `expired` terminal and outside `ACTIVE_DRAFT_STATUSES`. Preserve `send_uncertain` as uncertain after the deadline because delivery may already have occurred; deadline checks still prevent its retry.

- [ ] **Step 4: Add the Prisma schema and hand-written migration**

Define:

```prisma
enum ReplyDraftKind {
  reply
  engagement_follow_up

  @@map("reply_draft_kind")
}
```

Add to `Conversation`:

```prisma
engagementFollowUpScheduledAt DateTime?    @map("engagement_follow_up_scheduled_at")
followUpDrafts                 ReplyDraft[] @relation("FollowUpSource")
```

Add to `ReplyDraft`:

```prisma
kind                 ReplyDraftKind @default(reply)
sourceConversationId String?        @map("source_conversation_id") @db.Uuid
eligibleAt           DateTime       @default(now()) @map("eligible_at")
expiresAt            DateTime?      @map("expires_at")
promptVersion        Int?           @map("prompt_version")
sourceConversation   Conversation?  @relation("FollowUpSource", fields: [sourceConversationId], references: [id], onDelete: Restrict)

@@index([sourceConversationId, kind])
```

The SQL migration must:

```sql
CREATE TYPE "reply_draft_kind" AS ENUM ('reply', 'engagement_follow_up');
ALTER TYPE "reply_draft_status" ADD VALUE 'expired';
ALTER TABLE "conversations" ADD COLUMN "engagement_follow_up_scheduled_at" TIMESTAMP(3);
ALTER TABLE "reply_draft"
  ADD COLUMN "kind" "reply_draft_kind" NOT NULL DEFAULT 'reply',
  ADD COLUMN "source_conversation_id" UUID,
  ADD COLUMN "eligible_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "expires_at" TIMESTAMP(3),
  ADD COLUMN "prompt_version" INTEGER;
ALTER TABLE "reply_draft" ADD CONSTRAINT "reply_draft_follow_up_fields_check"
  CHECK (
    "kind" <> 'engagement_follow_up'
    OR ("source_conversation_id" IS NOT NULL AND "expires_at" IS NOT NULL)
  );
ALTER TABLE "reply_draft" ADD CONSTRAINT "reply_draft_source_conversation_id_fkey"
  FOREIGN KEY ("source_conversation_id") REFERENCES "conversations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "reply_draft_source_conversation_id_kind_idx"
  ON "reply_draft"("source_conversation_id", "kind");
UPDATE "reply_draft"
  SET "status" = 'superseded'
  WHERE "prompt_version" IS NULL
    AND "status" IN ('queued', 'generating', 'pending_approval', 'generation_failed');
```

Keep `prompt_version` nullable so legacy rows remain identifiable and unapprovable.

- [ ] **Step 5: Generate Prisma types and run tests/build**

Run:

```bash
npm run prisma:generate
npm test -- src/services/replyDraftPolicy.test.ts src/services/replyDraftMachine.test.ts
npm run build
```

Expected: tests and build pass; generated client includes the new enum and fields.

- [ ] **Step 6: Commit the state model**

```bash
git add prisma src/services/replyDraftPolicy.ts src/services/replyDraftPolicy.test.ts src/services/replyDraftMachine.ts src/services/replyDraftMachine.test.ts
git commit -m "feat(dm): model scheduled owner-approved follow-ups"
```

---

### Task 3: Make inbound ordering, history, and logging safe

**Files:**
- Create: `src/services/dmOrdering.ts`
- Create: `src/services/dmOrdering.test.ts`
- Modify: `src/services/dmThreadService.ts`
- Modify: `src/services/dmThreadService.test.ts`
- Modify: `src/handlers/messageHandler.ts`
- Modify: `src/handlers/messageHandler.test.ts`
- Modify: `src/handlers/webhookRouter.ts`
- Create: `src/handlers/webhookRouter.test.ts`
- Modify: `src/api/dmThreads.routes.ts`
- Create: `src/api/dmThreads.routes.test.ts`

**Interfaces:**
- Consumes: Meta `instagramTimestamp` and unique `instagramMessageId`.
- Produces: `RecordInboundResult.becameLatest`; deterministic `compareInboundOrder()`; newest-200 API history; metadata-only event logging.

- [ ] **Step 1: Write failing deterministic-order and handler tests**

Test the comparator and service outcomes:

```ts
expect(compareInboundOrder(
  { at: new Date("2026-08-05T10:00:00Z"), id: "mid-b" },
  { at: new Date("2026-08-05T10:00:00Z"), id: "mid-a" },
)).toBeGreaterThan(0);

expect(await recordInboundMessage(OLDER_INPUT)).toMatchObject({
  duplicate: false,
  becameLatest: false,
});
expect(tx.replyDraft.updateMany).not.toHaveBeenCalled();
expect(tx.dmThread.update).not.toHaveBeenCalled();
```

In `messageHandler.test.ts`, return `{ duplicate: false, becameLatest: false, ... }` and assert profile resolution, keyword lookup, guide delivery, draft queueing, and Instagram sends are all skipped.

In the route test, seed 201 ordered messages and assert the response contains messages 2–201 in ascending display order, not messages 1–200.

In the webhook test, assert `webhook_received`, `message_received`, `done_received`, and `message_unhandled` payloads contain IDs, types, counts, and lengths but no DM `text` or raw webhook `payload` property.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npm test -- src/services/dmOrdering.test.ts src/services/dmThreadService.test.ts src/handlers/messageHandler.test.ts src/handlers/webhookRouter.test.ts src/api/dmThreads.routes.test.ts
```

Expected: FAIL on missing ordering result, stale processing, oldest-history query, and raw-content logs.

- [ ] **Step 3: Implement deterministic latest-inbound selection**

Create:

```ts
export function compareInboundOrder(
  a: { at: Date; id: string },
  b: { at: Date; id: string },
): number {
  const time = a.at.getTime() - b.at.getTime();
  return time !== 0 ? time : a.id.localeCompare(b.id);
}
```

Extend `RecordInboundResult`:

```ts
interface RecordInboundResult {
  duplicate: boolean;
  becameLatest: boolean;
  threadId: string;
  messageId: string;
}
```

Run inbound recording at serializable isolation with bounded retry for Prisma `P2034`. Inside the transaction, always insert a nonduplicate message, load the current latest inbound, and only supersede drafts/update thread latest fields when `compareInboundOrder(new, current) > 0`.

In `handleMessage`, return immediately for duplicates and delayed non-latest events:

```ts
if (inbound.duplicate || !inbound.becameLatest) {
  logger.debug({ senderId, mid: msg.mid, duplicate: inbound.duplicate }, "Inbound webhook ignored");
  return;
}
```

- [ ] **Step 4: Remove private bodies from general logs**

Replace raw payloads with metadata such as:

```ts
await logEvent("message_received", {
  senderId,
  mid: msg.mid,
  messageType,
  textLength: text.length,
});

await logEvent("message_unhandled", {
  senderId,
  mid: msg.mid,
  textLength: text.length,
  hadOpenConversation: false,
});
```

Change `webhook_received` to `{ object, entryCount, messagingCount, changeCount }`. Remove `text` from debug/info logger arguments and from `done_received`. Preserve full content only in `DmMessage` and `ReplyDraft`.

- [ ] **Step 5: Return the newest 200 messages chronologically**

Query nested messages descending with `take: 200`, then reverse only the selected page:

```ts
messages: {
  orderBy: [{ instagramTimestamp: "desc" }, { id: "desc" }],
  take: MESSAGE_LIMIT,
  select: MESSAGE_SELECT,
},

const { drafts, messages, ...rest } = thread;
res.json({ ...rest, messages: messages.reverse(), draft: drafts[0] ?? null });
```

- [ ] **Step 6: Run focused and full backend tests**

```bash
npm test -- src/services/dmOrdering.test.ts src/services/dmThreadService.test.ts src/handlers/messageHandler.test.ts src/handlers/webhookRouter.test.ts src/api/dmThreads.routes.test.ts
npm test
npm run build
```

Expected: all backend tests and build pass.

- [ ] **Step 7: Commit inbound safety**

```bash
git add src/services/dmOrdering* src/services/dmThreadService* src/handlers/messageHandler* src/handlers/webhookRouter* src/api/dmThreads.routes*
git commit -m "fix(dm): preserve true inbound order and private content"
```

---

### Task 4: Queue follow-ups idempotently after successful guide delivery

**Files:**
- Create: `src/services/engagementFollowUpService.ts`
- Create: `src/services/engagementFollowUpService.test.ts`
- Modify: `src/services/replyDraftService.ts`
- Modify: `src/services/replyDraftService.test.ts`
- Modify: `src/handlers/messageHandler.ts`
- Modify: `src/handlers/messageHandler.test.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `computeFollowUpSchedule()`, successful `markCompleted()` result, latest inbound ID/timestamp, `AI_FOLLOW_UPS_ENABLED`.
- Produces: `queueReplyDraft(input)` with kind/timing/source/version; `scheduleEngagementFollowUp(input)` returning `{ scheduled, draftId }`; transaction-safe duplicate convergence.

- [ ] **Step 1: Write failing queue concurrency and scheduling tests**

Update ordinary queue expectations:

```ts
expect(tx.replyDraft.create).toHaveBeenCalledWith({
  data: expect.objectContaining({
    kind: "reply",
    eligibleAt: expect.any(Date),
    expiresAt: null,
    promptVersion: CURRENT_DM_PROMPT_VERSION,
    sourceConversationId: null,
  }),
});
```

Test that a Prisma `P2002` thrown inside the transaction is caught outside it and the winner lookup uses the root Prisma client only after rollback.

Test scheduling:

```ts
await expect(scheduleEngagementFollowUp({
  conversationId: "conversation-1",
  threadId: "thread-1",
  inboundMessageId: "message-1",
  inboundAt: new Date("2026-08-05T09:45:00Z"),
  deliveredAt: new Date("2026-08-05T10:00:00Z"),
})).resolves.toMatchObject({ scheduled: true });

expect(tx.conversation.updateMany).toHaveBeenCalledWith({
  where: { id: "conversation-1", engagementFollowUpScheduledAt: null },
  data: { engagementFollowUpScheduledAt: expect.any(Date) },
});
expect(tx.replyDraft.create).toHaveBeenCalledWith({
  data: expect.objectContaining({
    kind: "engagement_follow_up",
    sourceConversationId: "conversation-1",
    nextAttemptAt: new Date("2026-08-05T22:00:00Z"),
    expiresAt: new Date("2026-08-06T09:15:00Z"),
  }),
});
```

Also test disabled flag, insufficient time, duplicate scheduling (`updateMany.count === 0`), and all three successful guide-delivery branches.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npm test -- src/services/replyDraftService.test.ts src/services/engagementFollowUpService.test.ts src/handlers/messageHandler.test.ts
```

Expected: FAIL because typed queue inputs, scheduling service, and feature flag are absent.

- [ ] **Step 3: Fix ordinary queue transaction recovery**

Change the public input to:

```ts
export interface QueueReplyDraftInput {
  threadId: string;
  inboundMessageId: string;
  kind?: "reply" | "engagement_follow_up";
  sourceConversationId?: string | null;
  eligibleAt?: Date;
  expiresAt?: Date | null;
}
```

Perform revision allocation, supersession, and creation in one transaction. Catch `P2002` around the whole `$transaction` call, then run `prisma.replyDraft.findFirst(...)` outside the failed transaction. Every created row receives `CURRENT_DM_PROMPT_VERSION`.

- [ ] **Step 4: Implement idempotent follow-up scheduling**

In `engagementFollowUpService.ts`, export:

```ts
export async function scheduleEngagementFollowUp(input: {
  conversationId: string;
  threadId: string;
  inboundMessageId: string;
  inboundAt: Date;
  deliveredAt: Date;
}): Promise<{ scheduled: boolean; draftId: string | null }>;
```

Use one transaction to conditionally set `engagementFollowUpScheduledAt`, supersede any active draft for the now-handled inbound, allocate the next thread revision, and create the queued follow-up. If the schedule computation returns null or the conditional conversation update affects zero rows, return `{ scheduled: false, draftId: null }` without creating a draft.

- [ ] **Step 5: Hook scheduling to successful guide delivery only**

Add:

```ts
AI_FOLLOW_UPS_ENABLED: booleanFlag(false),
```

Add a schema-level refinement that rejects `AI_FOLLOW_UPS_ENABLED=true` while `AI_DRAFTS_ENABLED=false`, because scheduling work for a disabled worker would leave follow-ups queued until they expire.

After each successful `sendSequence` and `markCompleted`, call the scheduling service only when the flag is true. Pass the completed timestamp as `deliveredAt`, `entry.timestamp` as `inboundAt`, and the recorded inbound IDs. Catch scheduling failure after delivery and log only IDs plus the safe error category; never turn a delivered guide into a failed webhook.

Do not schedule after `sequence_failed`, a gate-only send, or a follow nudge.

- [ ] **Step 6: Run tests and build**

```bash
npm test -- src/services/replyDraftService.test.ts src/services/engagementFollowUpService.test.ts src/handlers/messageHandler.test.ts src/config/booleanFlag.test.ts
npm test
npm run build
```

Expected: all backend tests and build pass.

- [ ] **Step 7: Commit follow-up scheduling**

```bash
git add src/services/replyDraftService* src/services/engagementFollowUpService* src/handlers/messageHandler* src/config/env.ts .env.example
git commit -m "feat(dm): schedule one follow-up after guide delivery"
```

---

### Task 5: Generate due follow-ups with bounded guide context

**Files:**
- Modify: `src/services/codexRuntimeClient.ts`
- Modify: `src/services/codexRuntimeClient.test.ts`
- Modify: `src/services/replyDraftService.ts`
- Modify: `src/services/replyDraftService.test.ts`
- Modify: `src/services/replyDraftWorker.ts`
- Modify: `src/services/replyDraftWorker.test.ts`
- Modify: `codex-runtime/src/prompts.test.ts`

**Interfaces:**
- Consumes: queued draft `kind`, `sourceConversationId`, `eligibleAt`, `expiresAt`, and runtime Task 1 schema.
- Produces: `expireDueFollowUps(now)`, kind-aware `DraftContext`, exact `DmDraftRequest` fields, safe generation completion at the current prompt version.

- [ ] **Step 1: Write failing worker/context tests**

Cover these cases:

```ts
expect(prisma.replyDraft.findFirst).toHaveBeenCalledWith(
  expect.objectContaining({
    where: expect.objectContaining({
      status: "queued",
      nextAttemptAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    }),
  }),
);

expect(runtimeClient.generateDmDraft).toHaveBeenCalledWith(
  expect.objectContaining({
    kind: "engagement_follow_up",
    promptVersion: CURRENT_DM_PROMPT_VERSION,
    guideDeliveredAt: "2026-08-05T10:00:00.000Z",
    guideContext: {
      keyword: "SLEEP",
      resourceName: "Sleep Guide",
      description: "A practical bedtime guide",
    },
  }),
);

expect(expireDueFollowUps(now)).resolves.toBe(1);
expect(runtimeClient.generateDmDraft).not.toHaveBeenCalled();
```

Assert the transcript is the newest 20 messages, oldest-to-newest within that window, and within the 8,000-character budget.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npm test -- src/services/codexRuntimeClient.test.ts src/services/replyDraftService.test.ts src/services/replyDraftWorker.test.ts
cd codex-runtime && npm test -- src/prompts.test.ts
```

Expected: FAIL because the API contract and worker are not kind/deadline aware.

- [ ] **Step 3: Extend the API-to-runtime request type and validator**

Add to `DmDraftRequest` and its Zod request body:

```ts
kind: "reply" | "engagement_follow_up";
promptVersion: 2;
guideDeliveredAt: string | null;
```

Keep every existing participant, message, brand, and guide bound. Do not add credentials, arbitrary tool definitions, or arbitrary context keys.

- [ ] **Step 4: Load kind-aware context and expire overdue work**

Make `loadDraftContext` accept `{ id, threadId, kind, sourceConversationId, expiresAt }`. For follow-ups, load the exact source conversation with `keyword.resource`, not a catalog search. Return its `completedAt`, keyword, resource name, and resource description.

Export:

```ts
export async function expireDueFollowUps(now = new Date()): Promise<number> {
  const result = await prisma.replyDraft.updateMany({
    where: {
      kind: "engagement_follow_up",
      status: { in: ["queued", "generating", "generation_failed", "pending_approval", "send_failed"] },
      expiresAt: { lte: now },
    },
    data: { status: "expired", errorCode: "follow_up_window_closed" },
  });
  return result.count;
}
```

Call expiration before claiming work. The claim query excludes expired rows. `completeGeneration` rechecks the current time and changes an elapsed follow-up to `expired` instead of `pending_approval`.

- [ ] **Step 5: Send the exact kind-aware request from the worker**

```ts
await runtimeClient.generateDmDraft({
  requestId: newRequestId(),
  kind: context.kind,
  promptVersion: CURRENT_DM_PROMPT_VERSION,
  guideDeliveredAt: context.guideDeliveredAt,
  participant: context.participant,
  messages: context.messages,
  brandVoice: env.AI_BRAND_VOICE,
  guideContext: context.guideContext,
});
```

No worker code may import `dmDeliveryService` or `sendTrackedText`.

- [ ] **Step 6: Run backend/runtime tests and builds**

```bash
npm test -- src/services/codexRuntimeClient.test.ts src/services/replyDraftService.test.ts src/services/replyDraftWorker.test.ts
npm test
npm run build
cd codex-runtime
npm test
npm run build
```

Expected: all tests and builds pass.

- [ ] **Step 7: Commit kind-aware generation**

```bash
git add src/services/codexRuntimeClient* src/services/replyDraftService* src/services/replyDraftWorker* codex-runtime/src/prompts.test.ts
git commit -m "feat(ai): generate bounded engagement follow-ups"
```

---

### Task 6: Enforce policy, freshness, deadline, and crash recovery on sends

**Files:**
- Create: `src/services/replyDraftRecoveryWorker.ts`
- Create: `src/services/replyDraftRecoveryWorker.test.ts`
- Modify: `src/services/replyDraftService.ts`
- Modify: `src/services/replyDraftService.test.ts`
- Modify: `src/api/ai.routes.ts`
- Modify: `src/api/aiDrafts.routes.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `CURRENT_DM_PROMPT_VERSION`, draft kind/timing/status, authenticated owner identity, existing `classifySendError()`.
- Produces: atomic `claimApprovedDraft(input, now)`, atomic `claimRetryDraft(input, now)`, stable safety errors, stale-`sending` reconciliation.

- [ ] **Step 1: Write failing approval, retry, and recovery tests**

Add exact failure cases:

```ts
await expect(claimApprovedDraft(INPUT, NOW)).rejects.toMatchObject({
  code: "prompt_policy_outdated",
});
await expect(claimApprovedDraft(INPUT, AFTER_EXPIRY)).rejects.toMatchObject({
  code: "follow_up_window_closed",
});
await expect(claimApprovedDraft(INPUT, BEFORE_ELIGIBILITY)).rejects.toMatchObject({
  code: "follow_up_not_ready",
});
await expect(claimRetryDraft(RETRY_INPUT, AFTER_EXPIRY)).rejects.toMatchObject({
  code: "follow_up_window_closed",
});
expect(sendTrackedText).not.toHaveBeenCalled();
```

Test that two parallel claims produce one `sending` transition and one `draft_not_pending`. Test that `runReplyDraftRecoveryTick()` changes `sending` rows older than 15 minutes to `send_uncertain` and never calls Instagram.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npm test -- src/services/replyDraftService.test.ts src/services/replyDraftRecoveryWorker.test.ts src/api/aiDrafts.routes.test.ts
```

Expected: FAIL on missing policy/deadline errors, raw retry update, and recovery worker.

- [ ] **Step 3: Centralize atomic send claims**

Extend `DraftActionCode` with:

```ts
| "prompt_policy_outdated"
| "follow_up_not_ready"
| "follow_up_window_closed"
| "draft_not_retryable";
```

Inside both approval and retry transactions, load `kind`, `promptVersion`, `eligibleAt`, `expiresAt`, `inboundMessageId`, and status. Reject unless prompt version equals `CURRENT_DM_PROMPT_VERSION`. For follow-ups, reject before `eligibleAt` and at or after `expiresAt`. Recheck `latestInboundMessageId`. Then conditionally update to `sending` in the same transaction.

Export:

```ts
export async function claimRetryDraft(input: {
  threadId: string;
  draftId: string;
  confirmedNotDelivered: true;
}, now = new Date()): Promise<{ approvedText: string; inboundMessageId: string }>;
```

Remove the direct retry `updateMany` from `ai.routes.ts`.

- [ ] **Step 4: Make send handlers controlled Express boundaries**

Wrap each async draft mutation in `try/catch` and map:

```ts
const statusByCode: Record<DraftActionCode, number> = {
  draft_not_found: 404,
  stale_draft: 409,
  draft_not_pending: 409,
  draft_not_retryable: 409,
  prompt_policy_outdated: 409,
  follow_up_not_ready: 409,
  follow_up_window_closed: 409,
};
```

After a successful Instagram call, guard `markSent`, thread resolution, and audit writes so a database error does not produce an unhandled route rejection. If final recording cannot be confirmed, return `202 send_uncertain` and let reconciliation preserve the no-duplicate rule.

- [ ] **Step 5: Add non-sending stale-claim recovery**

Implement:

```ts
const STALE_SENDING_MS = 15 * 60 * 1000;

export async function runReplyDraftRecoveryTick(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_SENDING_MS);
  const result = await prisma.replyDraft.updateMany({
    where: { status: "sending", updatedAt: { lte: cutoff } },
    data: {
      status: "send_uncertain",
      errorCode: "send_state_recovered_after_restart",
      failedAt: now,
    },
  });
  return result.count;
}
```

Call it once at API startup and every 15 minutes. It only changes database state and never retries a send.

- [ ] **Step 6: Run send-safety tests and full backend verification**

```bash
npm test -- src/services/replyDraftService.test.ts src/services/replyDraftRecoveryWorker.test.ts src/api/aiDrafts.routes.test.ts
npm test
npm run build
```

Expected: tests and build pass; approval/retry safety tests assert zero send calls on every rejection.

- [ ] **Step 7: Commit send safety and recovery**

```bash
git add src/services/replyDraftService* src/services/replyDraftRecoveryWorker* src/api/ai.routes.ts src/api/aiDrafts.routes.test.ts src/server.ts
git commit -m "fix(dm): enforce owner-approved send boundaries"
```

---

### Task 7: Fail Railway health when the Codex child exits

**Files:**
- Modify: `codex-runtime/src/appServerClient.ts`
- Modify: `codex-runtime/src/appServerClient.test.ts`
- Modify: `codex-runtime/src/server.ts`
- Create: `codex-runtime/src/server.test.ts`

**Interfaces:**
- Consumes: child-process `error`/`exit` and intentional `stop()` state.
- Produces: `onUnexpectedExit(handler)` lifecycle hook; readiness false plus nonzero process termination for Railway restart.

- [ ] **Step 1: Write failing lifecycle tests**

Assert:

```ts
const onUnexpectedExit = vi.fn();
const client = await startAppServerClient(CONFIG, { spawn, onUnexpectedExit });
child.emit("exit", 17, null);
expect(onUnexpectedExit).toHaveBeenCalledOnce();
expect(onUnexpectedExit.mock.calls[0]![0].message).toContain("code 17");

await client.stop();
child.emit("exit", 0, null);
expect(onUnexpectedExit).not.toHaveBeenCalled();
```

In the server harness, simulate the callback and assert `/health` changes from `{ ok: true, appServerReady: true }` to `{ ok: true, appServerReady: false }`, the HTTP server closes, and the injected exit function receives `1`.

- [ ] **Step 2: Run focused runtime tests and verify failure**

```bash
cd codex-runtime
npm test -- src/appServerClient.test.ts src/server.test.ts
```

Expected: FAIL because unexpected exits currently only close the JSON-RPC peer.

- [ ] **Step 3: Implement unexpected-exit propagation and testable startup**

Extend dependencies:

```ts
export interface AppServerDependencies {
  spawn?: SpawnAppServer;
  codexBin?: string;
  onUnexpectedExit?: (error: Error) => void;
}
```

Invoke it only when `stopping === false`. Refactor server startup into an exported `startRuntime(deps)` that accepts `exit(code)`, allowing tests to verify readiness and shutdown without terminating Vitest.

On unexpected child exit:

```ts
ready = false;
logger.error("Codex app-server exited; terminating runtime for platform restart");
server.close(() => deps.exit(1));
fallbackExitTimer = setTimeout(() => deps.exit(1), 5_000);
fallbackExitTimer.unref();
```

Log only the stable category, not the child error message or stderr.

- [ ] **Step 4: Run runtime verification**

```bash
cd codex-runtime
npm test
npm run build
```

Expected: all runtime tests pass and build succeeds.

- [ ] **Step 5: Commit runtime supervision**

```bash
git add codex-runtime/src/appServerClient* codex-runtime/src/server*
git commit -m "fix(ai): restart runtime when Codex exits"
```

---

### Task 8: Expose real capabilities and render the follow-up workflow

**Files:**
- Modify: `src/api/ai.routes.ts`
- Modify: `src/api/ai.routes.test.ts`
- Modify: `src/api/dmThreads.routes.ts`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/pages/Conversations.tsx`
- Modify: `web/src/components/conversations/DmThreadList.tsx`
- Modify: `web/src/components/conversations/DmThreadDrawer.tsx`
- Modify: `web/src/components/conversations/ReplyDraftCard.tsx`
- Modify: `web/src/components/conversations/replyDraftView.ts`
- Modify: `web/src/components/conversations/replyDraftView.test.ts`
- Modify: `web/e2e/main.tsx`
- Modify: `web/e2e/ai-workflows.spec.ts`

**Interfaces:**
- Consumes: API draft fields `kind`, `eligibleAt`, `expiresAt`, `promptVersion`, `sourceConversationId`; stable send error codes.
- Produces: `GET /api/ai/capabilities`; typed capabilities query; scheduled/ready/expired/cancelled UI; real server-controlled send button state.

- [ ] **Step 1: Write failing capability and view-state tests**

API expectation:

```ts
await request(makeApp(client)).get("/api/ai/capabilities").expect(200, {
  draftsEnabled: true,
  followUpsEnabled: false,
  sendEnabled: false,
});
```

View expectations:

```ts
expect(draftStatusLabel("expired", "engagement_follow_up")).toBe("Follow-up expired");
expect(draftStatusLabel("queued", "engagement_follow_up")).toBe("Follow-up scheduled");
expect(approvalGate({
  thread: THREAD,
  draft: FOLLOW_UP,
  text: "How did bedtime go?",
  sendEnabled: true,
  mutationPending: false,
  now: AFTER_EXPIRY,
})).toEqual({ canApprove: false, reason: "follow_up_window_closed" });
```

Add E2E journeys for scheduled countdown, ready follow-up, expiry after an open editor, disabled sending, exact edited approval payload, and new-inbound cancellation.

- [ ] **Step 2: Run focused API/UI tests and verify failure**

```bash
npm test -- src/api/ai.routes.test.ts src/api/dmThreads.routes.test.ts
cd web
npm test -- src/components/conversations/replyDraftView.test.ts
npm run test:e2e -- --grep "follow-up|edited DM text"
```

Expected: FAIL because capabilities and follow-up states are absent and `Conversations.tsx` hardcodes `sendEnabled=true`.

- [ ] **Step 3: Add the owner-authenticated capabilities response**

Return only booleans:

```ts
router.get("/capabilities", (_req, res) => {
  res.json({
    draftsEnabled: env.AI_DRAFTS_ENABLED,
    followUpsEnabled: env.AI_FOLLOW_UPS_ENABLED,
    sendEnabled: env.AI_SEND_ENABLED,
  });
});
```

Add these fields to `DRAFT_SELECT`: `kind`, `sourceConversationId`, `eligibleAt`, `expiresAt`, and `promptVersion`.

- [ ] **Step 4: Extend browser types and use server capabilities**

Add:

```ts
export type ReplyDraftKind = "reply" | "engagement_follow_up";
export interface AiCapabilities {
  draftsEnabled: boolean;
  followUpsEnabled: boolean;
  sendEnabled: boolean;
}
```

Extend `ReplyDraft` with the five new API fields and `ReplyDraftStatus` with `expired`. Query `/ai/capabilities` in `Conversations.tsx`; pass `capabilities?.sendEnabled === true` rather than the current bare `sendEnabled` prop.

- [ ] **Step 5: Render follow-up states and controlled errors**

Key `ReplyDraftCard` by `draft.id` in `DmThreadDrawer` and remove the synchronous state-reset effect. Render:

```tsx
{draft.kind === "engagement_follow_up" && draft.expiresAt && (
  <p className="text-xs text-muted-foreground">
    Send by {new Date(draft.expiresAt).toLocaleString()}
  </p>
)}
```

Use the approved labels: **Follow-up scheduled**, **Writing follow-up**, **Follow-up ready**, **Follow-up expired**, and **Follow-up cancelled**. Replace `isLiveDraft()` with `isVisibleDraft()`: active drafts remain visible, and terminal `expired` plus `engagement_follow_up/superseded` drafts remain visible when they are the latest revision. When a terminal follow-up is visible alongside `thread.needsReply=true`, also show **Draft a reply** for the new inbound. Disable edit/regenerate/approve/retry after expiry. When a mutation returns `follow_up_window_closed`, invalidate the list/detail queries and show “The Instagram reply window closed before this could be sent.”

Keep one-click **Approve & Send** with the exact editor value and no confirmation dialog.

- [ ] **Step 6: Run frontend/API verification**

```bash
npm test -- src/api/ai.routes.test.ts src/api/dmThreads.routes.test.ts
npm run build
cd web
npm test
npx eslint src/lib/types.ts src/pages/Conversations.tsx src/components/conversations e2e
npm run build
npm run test:e2e
```

Expected: API tests/build, targeted frontend lint, frontend tests/build, and all Playwright journeys pass. Resolve every lint failure in the files touched by this task. Run `npm run lint` once as a non-gating baseline check and report the remaining pre-existing findings in `AiConnectionCard.tsx`, `AppShell.tsx`, `button.tsx`, `Insights.tsx`, and `SequenceEditor.tsx`; do not suppress or refactor those unrelated files in this feature.

- [ ] **Step 7: Commit the owner interface**

```bash
git add src/api/ai.routes* src/api/dmThreads.routes* web/src/lib/types.ts web/src/pages/Conversations.tsx web/src/components/conversations web/e2e
git commit -m "feat(web): review and send scheduled DM follow-ups"
```

---

### Task 9: Verify the complete safety boundary and deployment artifacts

**Files:**
- Modify: `DEPLOY.md`
- Modify: `codex-runtime/README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: all Tasks 1–8 and the approved design acceptance criteria.
- Produces: passing full quality gates, exact staged Railway/Vercel instructions, and a shadow-verification checklist that leaves sending disabled.

- [ ] **Step 1: Run the no-send static boundary checks**

Run:

```bash
rg -n "sendTrackedText|dmDeliveryService" src/services/replyDraftWorker.ts src/services/engagementFollowUpService.ts src/services/replyDraftRecoveryWorker.ts codex-runtime/src
```

Expected: no matches.

Run:

```bash
rg -n "developerMessage" codex-runtime/src
```

Expected: no production-code matches; a negative assertion string in a test is allowed.

- [ ] **Step 2: Run every local quality gate**

```bash
npm test
npm run build
cd codex-runtime && npm test && npm run build
cd ../web && npm test && npx eslint src/lib/types.ts src/pages/Conversations.tsx src/components/conversations e2e && npm run build && npm run test:e2e
```

Expected: every command exits 0. Then run full `npm run lint` as a non-gating baseline check and confirm it introduces no findings beyond the unrelated files named in Task 8. Preserve command totals and the baseline lint report in the implementation handoff.

- [ ] **Step 3: Update deployment documentation with exact safe settings**

Document the runtime variables:

```text
PORT=3001
CODEX_HOME=/data/codex
CODEX_WORKSPACE=/tmp/tinysoho-codex-workspace
RUNTIME_SHARED_SECRET=<64-character secret>
```

Document the initial API flags:

```text
AI_DRAFTS_ENABLED=true
AI_FOLLOW_UPS_ENABLED=false
AI_SEND_ENABLED=false
```

Replace impossible public-runtime `curl` instructions with a private-network health check from the API service or Railway health status. Keep the runtime at one replica, with `/data` mounted, and with no public domain.

- [ ] **Step 4: Add the staged production checklist**

Write these exact gates:

```text
1. Deploy codex-runtime first; existing drafts may fail closed until the API deploy.
2. Deploy API with AI_SEND_ENABLED=false and AI_FOLLOW_UPS_ENABLED=false.
3. Confirm the migration superseded every legacy unapproved draft.
4. Deploy the Vercel interface and verify capabilities show sending disabled.
5. Inspect ordinary shadow drafts for prompt safety and context correctness.
6. Set AI_FOLLOW_UPS_ENABLED=true; keep AI_SEND_ENABLED=false.
7. Deliver a test guide and verify one follow-up appears after the controlled test clock/job run.
8. Verify new inbound cancellation, duplicate delivery dedupe, and deadline expiry.
9. Restart codex-runtime and verify account persistence plus healthy app-server recovery.
10. Stop for owner approval before setting AI_SEND_ENABLED=true.
```

The implementation task is complete at step 10. Enabling production sending and delivering the first real AI-approved DM are separate owner-authorized actions.

- [ ] **Step 5: Re-run doc and repository checks**

```bash
git diff --check
rg -n "AI_FOLLOW_UPS_ENABLED|AI_SEND_ENABLED|CODEX_WORKSPACE" .env.example DEPLOY.md codex-runtime/README.md src/config/env.ts
git status --short
```

Expected: no whitespace errors; every flag/path is documented consistently; only intended files are modified.

- [ ] **Step 6: Commit deployment readiness**

```bash
git add DEPLOY.md codex-runtime/README.md .env.example
git commit -m "docs(ai): stage owner-approved DM rollout"
```

---

## Final implementation review gate

Before presenting the branch as ready:

1. Compare every acceptance criterion in the design spec to at least one passing automated test or an explicit production checklist item.
2. Review the complete diff from commit `15bcf8d` to `HEAD`, excluding unrelated pre-existing work.
3. Confirm Railway still reports no public runtime domain, one runtime replica, and one `/data` volume.
4. Confirm production still has `AI_SEND_ENABLED=false`.
5. Request a code review focused on prompt-policy enforcement, 24-hour deadline arithmetic, atomic claims, duplicate sends, delayed webhooks, private-content logging, and worker imports.
6. Do not enable `AI_SEND_ENABLED` until the owner separately approves the shadow results.
