# Guide Message Limits and Resumable Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Instagram guide messages above 1,000 UTF-16 code units from being saved or partially delivered, and make multi-message guide delivery resumable without automatically duplicating units whose provider outcome is ambiguous.

**Architecture:** A single shared TypeScript policy defines the authoring/API limit. Before any Graph call, a pure compiler turns authored resource steps into immutable outbound units and validates the whole plan. PostgreSQL stores one idempotent delivery per trigger plus one row per actual Meta call; short, fenced transactions claim and checkpoint each unit, while every Meta call runs outside the transaction. Definite transient rejections may resume through a bounded worker; ambiguous outcomes stop in `needs_review` until the owner resolves them from the Conversations UI.

**Tech Stack:** TypeScript, Node.js 22, Express, Zod, Prisma 5, PostgreSQL/Supabase, React 19, TanStack Query, Vitest, Testing Library, Vite.

## Global Constraints

- The approved design is authoritative: [guide message limits and resumable delivery design](../specs/2026-08-09-guide-message-limits-and-resumable-delivery-design.md).
- Do not automatically split, truncate, normalize, or rewrite an author's text. The author owns every DM boundary.
- Count JavaScript UTF-16 code units with `value.length` everywhere. Exactly 1,000 is valid; 1,001 is not. An emoji represented by a surrogate pair counts as two.
- Validate the complete compiled delivery before the first Graph call. One invalid later unit means zero units are sent.
- A persisted unit is one external Meta call. Image/PDF plus caption is two units and must be checkpointed separately.
- Use one delivery row per `(trigger_kind, trigger_id)`. Webhook replay must load the existing snapshot, never create or send a second plan.
- Never keep a database transaction open across `sendTrackedText` or `sendTrackedMedia`.
- Lock in this order everywhere: `guide_delivery`, then its `guide_delivery_unit` rows in ascending `position`. Queue claims use `FOR UPDATE SKIP LOCKED`.
- A stale `sending` unit becomes `uncertain`; it never becomes `pending` automatically.
- Only provider-confirmed or owner-confirmed units count as `sent`. Complete the conversation only after every persisted unit is `sent`.
- Redelivery intro copy is part of the durable plan, not a best-effort send before it. The existing follow-aware closing line remains outside the guide plan and best-effort after confirmed completion.
- Store snapshotted guide text/media URLs in the delivery ledger, but never place them in application logs or `event_log` payloads. Logs may contain IDs, unit kind/position, code-unit length, fingerprints, allowlisted Graph metadata, and timestamps.
- Enable RLS on both new backend-only tables and revoke `anon`/`authenticated` privileges, matching existing Supabase migrations.
- Follow-gate rechecking is not implemented by this plan. A future `follow_recovery` trigger must call the same delivery service rather than reintroduce a direct sequence sender.
- Preserve the user's existing untracked `.claude/` directory and `probe-tmp.mjs`; do not stage or modify them.

---

## Planned File Structure

### Create

- `shared/guideMessagePolicy.ts` — one limit/counting/error contract consumed by backend and web.
- `src/api/messages.routes.test.ts` — exact boundary and stable error tests.
- `src/api/resources.routes.test.ts` — invalid-content summaries and history-safe deletion tests.
- `scripts/audit-guide-message-lengths.ts` — read-only ID/length audit; never prints bodies.
- `web/src/pages/Sequences.test.tsx` — sequence-list attention badge tests.
- `prisma/migrations/20260809052000_add_guide_delivery_ledger/migration.sql` — enums, tables, constraints, indexes, RLS, grants.
- `src/services/guideDeliveryMigrationContract.test.ts` — catalog-level schema/security contract.
- `src/services/guideDeliveryPlanner.ts` — pure authored-step-to-unit compiler and full preflight.
- `src/services/guideDeliveryPlanner.test.ts` — ordering, captions, invalid legacy content, fingerprints.
- `src/services/guideDeliveryRepository.ts` — idempotent planning, claims, checkpoints, reconciliation, audited owner transitions.
- `src/services/guideDeliveryRepository.test.ts` — fast unit tests for transition guards and safe persisted metadata.
- `src/services/guideDeliveryRepositoryContract.test.ts` — concurrent trigger/claim and lease behavior against the disposable PostgreSQL contract database.
- `src/services/guideDeliveryCompletion.ts` — idempotent conversation/follow-up/thread finalization.
- `src/services/guideDeliveryCompletion.test.ts` — all-sent gate and repeat-finalization tests.
- `src/services/guideDeliveryService.ts` — orchestration around the repository and tracked Meta senders.
- `src/services/guideDeliveryService.test.ts` — partial failure, resume, uncertainty, privacy, and completion tests.
- `src/services/guideDeliveryWorker.ts` — stale-claim reconciliation, completion recovery, and bounded definite retries.
- `src/services/guideDeliveryWorker.test.ts` — retry/window/uncertainty behavior.
- `src/services/guideDeliveryScheduler.ts` — non-overlapping scheduler wrapper.
- `src/services/guideDeliveryScheduler.test.ts` — overlap and rejection containment tests.
- `src/services/guideDeliveryReviewService.ts` — owner-confirm, explicit-risk retry, and cancellation transitions.
- `src/services/guideDeliveryReviewService.test.ts` — review state/window/audit contracts.
- `src/api/guideDeliveries.routes.ts` — authenticated owner review actions.
- `src/api/guideDeliveries.routes.test.ts` — request and stable error contracts.
- `web/src/components/conversations/GuideDeliveryReviewCard.tsx` — owner review UI.
- `web/src/components/conversations/GuideDeliveryReviewCard.test.tsx` — counts, disabled actions, confirmations, and mutations.
- `docs/guide-delivery-operations.md` — rollout, audit, review, and monitoring runbook.

### Modify

- `tsconfig.json`, `web/tsconfig.json`, `web/tsconfig.app.json`, `web/vite.config.ts` — make `@shared/guideMessagePolicy` resolve in both builds.
- `src/api/messages.routes.ts` — stable 1,000-unit API enforcement.
- `src/api/resources.routes.ts` — invalid-message summaries; protect delivery history on delete.
- `package.json` — expose the read-only audit command.
- `web/src/lib/api.ts`, `web/src/lib/types.ts` — typed stable errors, invalid counts, and review DTOs.
- `web/src/components/SaveStatus.tsx` — add `needs_attention` state.
- `web/src/pages/SequenceEditor.tsx`, `web/src/pages/SequenceEditor.test.tsx` — counter, inline validation, retained draft, blocked blur-save.
- `web/src/pages/Sequences.tsx` — show guides requiring author attention.
- `prisma/schema.prisma` — add delivery enums/models and relations.
- `src/services/graphErrorClassifier.ts`, `src/services/graphErrorClassifier.test.ts` — generic direct-message send disposition.
- `src/config/env.ts`, `src/config/env.test.ts` — worker batch, lease, attempt, retry, and interval limits.
- `src/handlers/messageHandler.ts`, `src/handlers/messageHandler.test.ts` — route all three guide paths through the durable service.
- `src/api/dmThreads.routes.ts`, `src/api/dmThreads.routes.test.ts` — return safe delivery-review summaries for Conversations.
- `src/api/router.ts` — mount owner review routes.
- `src/server.ts` — start the delivery recovery/retry scheduler.
- `web/src/components/conversations/DmThreadList.tsx`, `web/src/components/conversations/DmThreadDrawer.tsx` — surface `Delivery needs review` and render the action card.

### Remove after migration is complete

- `src/services/sequenceSender.ts`
- `src/services/sequenceSender.test.ts`

The legacy sender must not remain as an attractive bypass. Remove it only after `rg 'sendSequence' src` shows that every production call site and test has moved to `guideDeliveryService`.

---

### Task 1: Establish one shared 1,000-code-unit policy and enforce it in the messages API

**Files:**

- Create: `shared/guideMessagePolicy.ts`
- Create: `src/api/messages.routes.test.ts`
- Modify: `tsconfig.json`
- Modify: `web/tsconfig.json`
- Modify: `web/tsconfig.app.json`
- Modify: `web/vite.config.ts`
- Modify: `src/api/messages.routes.ts`
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: Write the failing backend boundary tests**

Mock `prisma.resourceMessage` in `src/api/messages.routes.test.ts`, mount `messagesRouter` under an Express test app, and cover both `POST /api/messages` and `PATCH /api/messages/:id`:

```ts
it.each(["POST", "PATCH"])("%s accepts exactly 1,000 code units", async (method) => {
  const body = "a".repeat(1_000);
  const response = await sendMessageRequest(method, body);
  expect(response.status).toBe(method === "POST" ? 201 : 200);
});

it.each(["POST", "PATCH"])("%s rejects 1,001 code units without echoing text", async (method) => {
  const sentinel = `${"a".repeat(999)}😀`; // 1,001 UTF-16 code units
  const response = await sendMessageRequest(method, sentinel);
  expect(response.status).toBe(400);
  expect(response.body).toEqual({
    error: "message_body_too_long",
    limit: 1_000,
    actual: 1_001,
  });
  expect(JSON.stringify(response.body)).not.toContain(sentinel);
});
```

Also assert that image and PDF captions go through the same check and that exactly 500 emoji (1,000 code units) is accepted.

- [ ] **Step 2: Run the focused test and verify the existing 2,000 limit fails it**

Run:

```bash
npm test -- src/api/messages.routes.test.ts
```

Expected: failures show 1,001-unit bodies are accepted or return Zod's generic flattened error instead of `message_body_too_long`.

- [ ] **Step 3: Add the shared policy module**

Create `shared/guideMessagePolicy.ts` with no React, Node, Prisma, or Zod imports:

```ts
export const INSTAGRAM_GUIDE_TEXT_LIMIT = 1_000;
export const INSTAGRAM_GUIDE_WARNING_AT = 900;
export const MESSAGE_BODY_TOO_LONG_ERROR = "message_body_too_long" as const;

export function countInstagramCodeUnits(value: string): number {
  return value.length;
}

export function isInstagramGuideTextTooLong(value: string): boolean {
  return countInstagramCodeUnits(value) > INSTAGRAM_GUIDE_TEXT_LIMIT;
}

export const GUIDE_MESSAGE_LIMIT_GUIDANCE =
  "Instagram allows 1,000 characters per message. Shorten this message or add another Text step.";
```

Add `shared/**/*` to the backend `tsconfig.json` include. Add an `@shared/*` path pointing to `../shared/*` in both web TypeScript configs and a matching Vite alias:

```ts
"@shared": path.resolve(__dirname, "../shared")
```

Because the shared source sits one directory above Vite's `web` root, also set `server.fs.allow` to the explicit repository root (`path.resolve(__dirname, "..")`) so development and test servers may load only this intended parent workspace.

Backend imports must use the NodeNext `.js` suffix, for example:

```ts
import {
  INSTAGRAM_GUIDE_TEXT_LIMIT,
  countInstagramCodeUnits,
} from "../../shared/guideMessagePolicy.js";
```

- [ ] **Step 4: Return the stable API error before generic Zod handling**

In `messages.routes.ts`, check only when `req.body.body` is a string, before `safeParse`, so the response is stable and does not contain the submitted body:

```ts
function rejectLongBody(body: unknown, res: Response): boolean {
  if (typeof body !== "string") return false;
  const actual = countInstagramCodeUnits(body);
  if (actual <= INSTAGRAM_GUIDE_TEXT_LIMIT) return false;
  res.status(400).json({
    error: MESSAGE_BODY_TOO_LONG_ERROR,
    limit: INSTAGRAM_GUIDE_TEXT_LIMIT,
    actual,
  });
  return true;
}
```

Keep `.max(INSTAGRAM_GUIDE_TEXT_LIMIT)` on both Zod schemas as a second line of defense. Do not trim or truncate the value.

Add an exported `apiErrorCode(error: unknown): string | null` helper in `web/src/lib/api.ts` so the editor and review UI can map stable server errors without parsing error messages.

- [ ] **Step 5: Run API, type, and build checks**

Run:

```bash
npm test -- src/api/messages.routes.test.ts
npm run build
npm --prefix web run build
```

Expected: all pass; the backend emits `dist/shared/guideMessagePolicy.js`, and Vite resolves the same source module.

- [ ] **Step 6: Commit the policy/API slice**

```bash
git add shared/guideMessagePolicy.ts tsconfig.json web/tsconfig.json web/tsconfig.app.json web/vite.config.ts src/api/messages.routes.ts src/api/messages.routes.test.ts web/src/lib/api.ts
git commit -m "fix: enforce Instagram guide message limit"
```

---

### Task 2: Audit and visibly flag legacy over-limit guide content

**Files:**

- Create: `scripts/audit-guide-message-lengths.ts`
- Create: `src/api/resources.routes.test.ts`
- Create: `web/src/pages/Sequences.test.tsx`
- Modify: `src/api/resources.routes.ts`
- Modify: `package.json`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/pages/Sequences.tsx`

- [ ] **Step 1: Write failing API tests for invalid-message summaries**

Have the mocked resource query return message bodies, including a 1,001-unit sentinel, then assert the list response exposes only a count:

```ts
expect(response.body[0]).toMatchObject({
  id: "resource-1",
  invalidMessageCount: 1,
});
expect(JSON.stringify(response.body)).not.toContain("PRIVATE-GUIDE-SENTINEL");
expect(response.body[0]).not.toHaveProperty("messages");
```

For `GET /resources/:id`, keep returning the existing authored messages and add `invalidMessageCount`; the editor needs the bodies it already receives.

- [ ] **Step 2: Run the route test and verify it fails**

```bash
npm test -- src/api/resources.routes.test.ts
```

Expected: `invalidMessageCount` is absent.

- [ ] **Step 3: Compute the summary with the shared policy**

Extend the existing resource queries with `messages: { select: { body: true } }`, calculate over-limit counts in application code with `isInstagramGuideTextTooLong`, and strip the temporary `messages` array from the list response. Do not use PostgreSQL `length()` here because PostgreSQL counts Unicode characters while the product contract is JavaScript UTF-16 code units.

Add to `Resource` in `web/src/lib/types.ts`:

```ts
invalidMessageCount?: number;
```

- [ ] **Step 4: Add the read-only audit script**

The script queries `ResourceMessage` rows with their resource ID/name and prints only:

```text
resourceId=10000000-0000-4000-8000-000000000001 resource="Guide name" messageId=20000000-0000-4000-8000-000000000001 order=3 type=text codeUnits=1434 overBy=434 activeKeywords=1
```

It must not print `body`, `mediaUrl`, tokens, or provider data. Sort active guides first, then resource name/order. Report every invalid row, but return exit code `1` only while at least one invalid row belongs to a resource with an active keyword; inactive/unlinked drafts remain visible warnings without blocking live delivery rollout. Return `0` when every active guide is valid.

Add:

```json
"audit:guide-message-lengths": "tsx scripts/audit-guide-message-lengths.ts"
```

Do not add a mutation mode. The known 1,434-unit active step remains author-owned work.

- [ ] **Step 5: Write the failing sequence-card UI test**

In `web/src/pages/Sequences.test.tsx`, mock `/resources` with one clean resource and one `{ invalidMessageCount: 2 }`. Assert the affected card contains `2 messages need attention`, links to its editor, and the clean card has no warning.

Run:

```bash
npm --prefix web test -- src/pages/Sequences.test.tsx
```

Expected: the attention text is absent.

- [ ] **Step 6: Add the sequence-card attention badge**

Use an amber `CircleAlert` badge inside `SequenceCard`. Keep it informational and make the existing card link the route to correction; do not add an automatic fix.

- [ ] **Step 7: Re-run focused tests and the audit locally**

```bash
npm test -- src/api/resources.routes.test.ts
npm --prefix web test -- src/pages/Sequences.test.tsx
npm run audit:guide-message-lengths
```

Expected: tests pass. Against the current production-shaped data, the audit should report the known active 1,434-unit step (and may also report unlinked legacy rows) using IDs and lengths only, then exit `1`.

- [ ] **Step 8: Commit the audit/indicator slice**

```bash
git add scripts/audit-guide-message-lengths.ts src/api/resources.routes.ts src/api/resources.routes.test.ts package.json web/src/lib/types.ts web/src/pages/Sequences.tsx web/src/pages/Sequences.test.tsx
git commit -m "feat: flag guides over Instagram message limit"
```

---

### Task 3: Add the editor counter, blocked blur-save, and needs-attention state

**Files:**

- Modify: `web/src/components/SaveStatus.tsx`
- Modify: `web/src/pages/SequenceEditor.tsx`
- Modify: `web/src/pages/SequenceEditor.test.tsx`

- [ ] **Step 1: Add failing editor tests for every boundary**

Expand `SequenceEditor.test.tsx` to cover:

- 899 units: normal counter.
- 900 units: warning treatment begins.
- 1,000 units: valid and blur triggers `PATCH /messages/:id`.
- 1,001 units: error treatment and guidance; blur sends no PATCH.
- 500 emoji: valid; 501 emoji: invalid.
- Image and PDF captions use the same validation.
- The complete invalid draft remains visible after blur and query refetch.
- Save status says `Needs attention — message too long` and never `All changes saved` while any row is invalid.
- Phone preview renders the single authored step, not two synthetic bubbles.

Use one helper that finds the body textarea and reads calls where the first API argument is `/messages/message-1`.

- [ ] **Step 2: Run the editor tests and verify they fail**

```bash
npm --prefix web test -- src/pages/SequenceEditor.test.tsx
```

Expected: no counter/guidance is rendered, and the 1,001-unit body issues a PATCH.

- [ ] **Step 3: Add an explicit SaveStatus attention input**

Change the component contract to:

```ts
export function SaveStatus({
  sequenceId,
  needsAttention = false,
}: {
  sequenceId: string;
  needsAttention?: boolean;
})
```

Add a `needs_attention` state with `CircleAlert` and `Needs attention — message too long`. `saving` may temporarily take visual priority, but `saved` must never be selected while `needsAttention` is true.

- [ ] **Step 4: Implement counter and inline validation in SortableStep**

Derive these values from the complete local `step.body`, not from the last saved body:

```ts
const body = step.body ?? "";
const codeUnits = countInstagramCodeUnits(body);
const overLimit = codeUnits > INSTAGRAM_GUIDE_TEXT_LIMIT;
const warning = codeUnits >= INSTAGRAM_GUIDE_WARNING_AT && !overLimit;
```

Render `current / 1,000`, apply warning/error styles, set `aria-invalid`, and render `GUIDE_MESSAGE_LIMIT_GUIDANCE` above 1,000. On body change, clear any matching server-side length error but retain the draft. On blur:

```ts
if (overLimit) return;
const next = body.trim() ? body : null;
if (next !== savedBody.current) patchMutation.mutate({ body: next });
```

When the API still returns `message_body_too_long` (for example, during a mixed-version deployment), show the same inline guidance using `apiErrorCode`; do not replace it with a generic toast.

At the form level, compute `items.some(message => body is over limit)` and pass it to `SaveStatus`.

- [ ] **Step 5: Preserve authored preview semantics**

Continue passing `items` directly to `PhoneMockup`. Do not add a split function to the preview. Add an assertion that one over-limit authored Text step produces one `StepBubble`.

- [ ] **Step 6: Run web tests, lint, and build**

```bash
npm --prefix web test -- src/pages/SequenceEditor.test.tsx
npm --prefix web run lint
npm --prefix web run build
```

Expected: all pass; exactly 1,000 remains saveable.

- [ ] **Step 7: Commit the editor slice**

```bash
git add web/src/components/SaveStatus.tsx web/src/pages/SequenceEditor.tsx web/src/pages/SequenceEditor.test.tsx
git commit -m "feat: show Instagram guide message limits in editor"
```

---

### Task 4: Add the durable delivery ledger migration and Prisma models

**Files:**

- Create: `prisma/migrations/20260809052000_add_guide_delivery_ledger/migration.sql`
- Create: `src/services/guideDeliveryMigrationContract.test.ts`
- Modify: `prisma/schema.prisma`
- Modify: `src/api/resources.routes.ts`
- Modify: `src/api/resources.routes.test.ts`

- [ ] **Step 1: Write the failing catalog contract**

Following `publicRecoveryDispatchMigrationContract.test.ts`, assert:

- Both tables exist, have RLS enabled, and grant nothing to `anon` or `authenticated`.
- Every FK column has an index.
- `(trigger_kind, trigger_id)` and `(delivery_id, position)` are unique.
- Partial due, expired-claim, and thread-review indexes exist.
- Claim completeness/order, payload shape, attempt count, and terminal timestamp checks exist.
- `text_snapshot`/`media_url_snapshot` and owner confirmation fields have the expected types.

Run the test once against the designated disposable localhost migration database. The test already guards that the hostname is `localhost`, `127.0.0.1`, or `::1`.

```bash
npm test -- src/services/guideDeliveryMigrationContract.test.ts
```

Expected: skipped when `MIGRATION_TEST_DATABASE_URL` is absent, or fails because the tables do not exist when the disposable database is configured.

- [ ] **Step 2: Add Prisma enums and relations**

Use these enum values exactly:

```prisma
enum GuideDeliveryTriggerKind {
  inbound_reply
  explicit_redelivery
  follow_recovery
  @@map("guide_delivery_trigger_kind")
}

enum GuideDeliveryStatus {
  planned
  sending
  failed
  needs_review
  completed
  cancelled
  @@map("guide_delivery_status")
}

enum GuideDeliveryUnitOrigin {
  resource_step
  redelivery_intro
  @@map("guide_delivery_unit_origin")
}

enum GuideDeliveryUnitKind {
  text
  image
  file
  @@map("guide_delivery_unit_kind")
}

enum GuideDeliveryUnitStatus {
  pending
  sending
  sent
  failed
  uncertain
  @@map("guide_delivery_unit_status")
}

enum GuideDeliveryFailureDisposition {
  transient
  permanent
  @@map("guide_delivery_failure_disposition")
}
```

Define `GuideDelivery` with:

- UUID `id`, `triggerId`, and nullable unique UUID `claimToken`.
- Indexed FKs to `Conversation` and `Resource`; nullable indexed FK to `DmThread` with `onDelete: SetNull`.
- Trigger kind/ID, `triggeredAt`, `sendWindowExpiresAt`, and nullable `followerAtTrigger`.
- Status, `failureCode`, `nextAttemptAt`, complete claim triplet, and started/completed/cancelled timestamps.
- `DateTime @db.Timestamptz(3)` for every new timestamp.
- `@@unique([triggerKind, triggerId])` and queue/review indexes matching the SQL names.

Define `GuideDeliveryUnit` with:

- Indexed delivery FK with `onDelete: Cascade`.
- Nullable indexed resource-message FK with `onDelete: SetNull` so an immutable snapshot survives later step deletion.
- Stable `position`, origin, kind, mutually exclusive `textSnapshot`/`mediaUrlSnapshot`, and `contentFingerprint @db.Char(64)`.
- Status, nullable failure disposition, provider ID, attempts, sending/sent/owner-confirmed timestamps.
- Nullable `ownerRetryAuthorizedAt` and `ownerRetryConsumedAt` timestamps so one explicit duplicate-risk acknowledgement can authorize exactly one attempt even after the automatic attempt cap.
- Only allowlisted error columns: category, HTTP status, Graph code/subcode, trace ID, and transport code.
- `@@unique([deliveryId, position])` and `@@index([deliveryId, status, position])`.

Add reverse relations to `Conversation`, `Resource`, `ResourceMessage`, and `DmThread`. Do not add a polymorphic FK for `triggerId`; `follow_recovery` is deliberately future-compatible.

- [ ] **Step 3: Write the SQL migration by hand**

Use lowercase mapped identifiers, `TIMESTAMPTZ(3)`, the repository's existing `gen_random_uuid()` UUID convention, explicit named FKs, and explicit indexes. Include partial indexes shaped to the actual worker queries:

```sql
CREATE INDEX "guide_delivery_due_idx"
  ON "guide_delivery" ("next_attempt_at", "created_at", "id")
  WHERE "status" IN ('planned', 'failed') AND "claim_token" IS NULL;

CREATE INDEX "guide_delivery_expired_claim_idx"
  ON "guide_delivery" ("claim_expires_at", "id")
  WHERE "claim_token" IS NOT NULL;

CREATE INDEX "guide_delivery_thread_review_idx"
  ON "guide_delivery" ("thread_id", "created_at" DESC)
  WHERE "status" = 'needs_review';
```

Add named checks, at minimum:

```sql
CONSTRAINT "guide_delivery_claim_complete_check" CHECK (
  ("claim_token" IS NULL AND "claimed_at" IS NULL AND "claim_expires_at" IS NULL)
  OR
  ("claim_token" IS NOT NULL AND "claimed_at" IS NOT NULL
    AND "claim_expires_at" IS NOT NULL AND "claim_expires_at" > "claimed_at")
),
CONSTRAINT "guide_delivery_unit_payload_shape_check" CHECK (
  ("kind" = 'text' AND "text_snapshot" IS NOT NULL AND "media_url_snapshot" IS NULL)
  OR
  ("kind" IN ('image', 'file') AND "text_snapshot" IS NULL AND "media_url_snapshot" IS NOT NULL)
),
CONSTRAINT "guide_delivery_unit_attempts_check" CHECK ("attempts" >= 0)
```

The sent-state check must allow either a provider receipt or `owner_confirmed_at`, because the owner can confirm an ambiguous unit that Meta accepted without returning a locally persisted message ID.

Finish with:

```sql
ALTER TABLE "guide_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guide_delivery_unit" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "guide_delivery" FROM anon, authenticated;
REVOKE ALL ON TABLE "guide_delivery_unit" FROM anon, authenticated;
```

Use the same conditional-role block as recent migrations if either role may not exist in the disposable database.

- [ ] **Step 4: Protect immutable delivery history from resource deletion**

Before the existing transaction in `DELETE /resources/:id`, count delivery rows for the resource. Return `409 { error: "resource_has_delivery_history" }` when nonzero. Add a route test. This makes the `Restrict` FKs intentional and avoids a generic 500.

- [ ] **Step 5: Validate Prisma and run migration contracts**

```bash
npx prisma format
npx prisma validate
npx prisma generate
npm test -- src/services/guideDeliveryMigrationContract.test.ts src/api/resources.routes.test.ts
npm run build
```

Expected: all configured tests pass; without a migration database the catalog suite is explicitly skipped, not reported as a pass.

- [ ] **Step 6: Commit the schema slice**

```bash
git add prisma/schema.prisma prisma/migrations/20260809052000_add_guide_delivery_ledger/migration.sql src/services/guideDeliveryMigrationContract.test.ts src/api/resources.routes.ts src/api/resources.routes.test.ts
git commit -m "feat: add durable guide delivery ledger"
```

---

### Task 5: Compile and preflight every actual Meta send unit

**Files:**

- Create: `src/services/guideDeliveryPlanner.ts`
- Create: `src/services/guideDeliveryPlanner.test.ts`

- [ ] **Step 1: Write failing pure compiler tests**

Cover this authored input and exact output order:

```ts
[
  textStep({ id: "text-1", order: 2, body: "Third" }),
  imageStep({ id: "image-1", order: 0, mediaUrl: "https://cdn/image.jpg", body: "Caption" }),
  pdfStep({ id: "pdf-1", order: 1, mediaUrl: "https://cdn/file.pdf", body: null }),
]
```

Expected units:

```ts
[
  { position: 0, kind: "image", resourceMessageId: "image-1" },
  { position: 1, kind: "text", resourceMessageId: "image-1" },
  { position: 2, kind: "file", resourceMessageId: "pdf-1" },
  { position: 3, kind: "text", resourceMessageId: "text-1" },
]
```

Also test:

- `explicit_redelivery` prepends one text unit with origin `redelivery_intro` and no resource-message ID.
- A 1,001-unit later caption rejects the entire plan.
- Missing image/PDF URL rejects the entire plan.
- Missing required Text body rejects the entire plan.
- Exactly 1,000 units is valid.
- Fingerprints are stable for identical kind/content and change when either changes.
- Error objects contain IDs, position/type, and measured length but not text or media URL.

- [ ] **Step 2: Run the compiler test and verify it fails**

```bash
npm test -- src/services/guideDeliveryPlanner.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Define the pure planning contracts**

Use discriminated results:

```ts
export type GuideDeliveryPlanResult =
  | { ok: true; units: PlannedGuideDeliveryUnit[] }
  | { ok: false; error: GuidePreflightError };

export type GuidePreflightError = {
  code: "text_missing" | "text_too_long" | "media_url_missing";
  resourceMessageId: string | null;
  authoredOrder: number | null;
  unitKind: "text" | "image" | "file";
  actualLength: number | null;
  limit: number | null;
};
```

`PlannedGuideDeliveryUnit` must contain the exact snapshot fields needed by the database and no Prisma model dependency.

- [ ] **Step 4: Implement compile-then-validate, never streaming validation**

Sort a copy of messages by authored `order`, compile all units, then validate the complete array. Never call a sender from this module. Hash the exact outbound payload with Node's SHA-256:

```ts
createHash("sha256")
  .update(unit.kind)
  .update("\0")
  .update(unit.textSnapshot ?? unit.mediaUrlSnapshot ?? "")
  .digest("hex");
```

Do not trim content before hashing or snapshotting. Optional captions are absent only when `body` is `null` or the empty string; preserve current nonempty whitespace behavior.

- [ ] **Step 5: Run the focused and type checks**

```bash
npm test -- src/services/guideDeliveryPlanner.test.ts
npm run build
```

Expected: all pass.

- [ ] **Step 6: Commit the planner**

```bash
git add src/services/guideDeliveryPlanner.ts src/services/guideDeliveryPlanner.test.ts
git commit -m "feat: preflight compiled guide delivery units"
```

---

### Task 6: Implement atomic planning, fenced claims, and per-unit checkpoints

**Files:**

- Create: `src/services/guideDeliveryRepository.ts`
- Create: `src/services/guideDeliveryRepository.test.ts`
- Create: `src/services/guideDeliveryRepositoryContract.test.ts`

- [ ] **Step 1: Write failing repository unit tests for transition guards**

Test the public repository contract, not Prisma implementation details:

```ts
export interface GuideDeliveryRepository {
  createOrLoadPlan(input: CreateGuideDeliveryPlanInput): Promise<PlannedDeliveryRecord>;
  claimById(input: ClaimGuideDeliveryInput): Promise<ClaimedGuideDelivery | null>;
  claimDueBatch(input: ClaimDueGuideDeliveriesInput): Promise<ClaimedGuideDelivery[]>;
  beginUnit(input: BeginGuideUnitInput): Promise<GuideDeliveryUnitRecord | null>;
  markUnitSent(input: MarkGuideUnitSentInput): Promise<boolean>;
  markUnitFailed(input: MarkGuideUnitFailedInput): Promise<boolean>;
  markUnitUncertain(input: MarkGuideUnitUncertainInput): Promise<boolean>;
  releaseClaim(input: ReleaseGuideDeliveryClaimInput): Promise<boolean>;
  reconcileExpiredClaims(now: Date): Promise<ExpiredClaimReconciliation>;
}
```

Assert every mutating method includes delivery ID, current `claimToken`, and expected current status in its conditional update. A stale token must return `false`/`null` without altering rows.

- [ ] **Step 2: Write failing PostgreSQL contract tests for concurrency**

Using unique UUID fixtures and the existing disposable database harness, cover:

- Two concurrent `createOrLoadPlan` calls with the same trigger return one delivery ID and one exact set of units.
- A later replay with edited resource content still returns the first immutable snapshot.
- Two concurrent `claimById` calls yield exactly one claim.
- Two concurrent `claimDueBatch` workers claim disjoint rows.
- Starting a unit increments attempts and stores `sendingAt` before any simulated provider call.
- A stale fencing token cannot mark a unit sent.
- Owner-confirmed `sent` is allowed without provider message ID.

- [ ] **Step 3: Run the tests and verify they fail**

```bash
npm test -- src/services/guideDeliveryRepository.test.ts src/services/guideDeliveryRepositoryContract.test.ts
```

Expected: module-not-found failures; the DB suite skips only when the migration-test variable is absent.

- [ ] **Step 4: Implement atomic get-or-create planning**

Inside one short Prisma transaction:

1. Insert the complete delivery header with `ON CONFLICT (trigger_kind, trigger_id) DO NOTHING RETURNING id`.
2. If inserted, create every already-preflighted unit with `createMany` and record a safe `guide_delivery_planned` event in the same transaction.
3. If conflicted, load the existing delivery and its units; do not compare or overwrite snapshots.

For a preflight failure, insert the delivery with `status = failed`, `failure_code = guide_preflight_failed`, no units, and a safe event containing only resource/message IDs, type, and measured length. The same trigger remains terminal; after author correction, a new inbound/recovery trigger creates a new delivery.

- [ ] **Step 5: Implement claims with short SQL transactions**

Generate claim UUIDs in application code. `claimById` atomically updates one unclaimed `planned`/retryable `failed` row. `claimDueBatch` uses a CTE:

```sql
WITH due AS (
  SELECT id
  FROM guide_delivery
  WHERE status IN ('planned', 'failed')
    AND claim_token IS NULL
    AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
  ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE guide_delivery AS delivery
SET status = 'sending',
    claim_token = gen_random_uuid(),
    claimed_at = $1,
    claim_expires_at = $3,
    started_at = COALESCE(delivery.started_at, $1),
    updated_at = $1
FROM due
WHERE delivery.id = due.id
RETURNING delivery.*;
```

The claim predicate may ignore an expired send window only when every unit is already `sent`, because completion bookkeeping performs no Graph call. Otherwise, close the delivery with `messaging_window_closed` instead of claiming it for send.

- [ ] **Step 6: Implement unit checkpoints and failure metadata**

`beginUnit` locks the delivery, then the first non-sent unit by ascending position, and changes only `pending` or transient `failed` to `sending`. It increments attempts and timestamps before returning the snapshot to the caller.

Automatic work must refuse a unit at `GUIDE_DELIVERY_MAX_ATTEMPTS`. An owner-authorized retry may cross that cap exactly once: `beginUnit` atomically consumes a non-null `ownerRetryAuthorizedAt` by setting `ownerRetryConsumedAt` in the same update that changes the unit to `sending`. No worker may infer this authorization from status alone.

`markUnitSent`, `markUnitFailed`, and `markUnitUncertain` each run in their own transaction after the provider call and require:

- matching delivery/claim token;
- unit belongs to delivery;
- unit is currently `sending`;
- attempts match the attempt number returned by `beginUnit`.

Persist only the allowlisted fields from `describeGraphError`. Never accept a raw `Error` object or provider response as a repository input.

- [ ] **Step 7: Implement expired-claim reconciliation**

Lock expired deliveries with `FOR UPDATE SKIP LOCKED`, then lock units by position:

- Any `sending` unit becomes `uncertain`; delivery becomes `needs_review`; claim fields clear.
- All units already `sent` become completion-pending and are returned for bookkeeping; do not send.
- No `sending` unit and remaining pending/definite-failed units means no Graph boundary was crossed after the last checkpoint; clear the claim and make it safely due again.

Insert safe aggregate events in the same transactions.

- [ ] **Step 8: Run repository tests and build**

```bash
npm test -- src/services/guideDeliveryRepository.test.ts src/services/guideDeliveryRepositoryContract.test.ts
npm run build
```

Expected: unit tests pass; configured database contracts pass with one winner per concurrency race.

- [ ] **Step 9: Commit the repository**

```bash
git add src/services/guideDeliveryRepository.ts src/services/guideDeliveryRepository.test.ts src/services/guideDeliveryRepositoryContract.test.ts
git commit -m "feat: checkpoint guide delivery units"
```

---

### Task 7: Orchestrate provider sends and idempotent completion

**Files:**

- Create: `src/services/guideDeliveryCompletion.ts`
- Create: `src/services/guideDeliveryCompletion.test.ts`
- Create: `src/services/guideDeliveryService.ts`
- Create: `src/services/guideDeliveryService.test.ts`
- Modify: `src/services/graphErrorClassifier.ts`
- Modify: `src/services/graphErrorClassifier.test.ts`

- [ ] **Step 1: Write failing direct-message disposition tests**

Add a generic classifier result:

```ts
export type DirectMessageSendDisposition =
  | "definite_transient"
  | "definite_permanent"
  | "uncertain";
```

Reuse the existing closed transport allowlist. Test:

- HTTP 429 and Meta/gateway definite rejection -> `definite_transient`.
- `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN` -> `definite_transient`.
- Timeout/reset/cancel/no response -> `uncertain`.
- Auth/permission and permanent 4xx -> `definite_permanent`.
- Unknown error -> `uncertain`.

Do not weaken existing gate/public-reply classifier tests.

- [ ] **Step 2: Write failing completion-service tests**

The completion service must:

- refuse to call `markCompleted` unless the repository reports all units `sent`;
- call `markCompleted`, optional engagement follow-up scheduling, and `markThreadResolved` in that order;
- tolerate follow-up scheduling failure without making a delivered guide failed;
- atomically mark the delivery completed and create one `sequence_completed` event after idempotent bookkeeping;
- return already-completed without repeating the event;
- work when the send window is closed because finalization makes no Graph call.

Move the current `scheduleFollowUpAfterDelivery` behavior out of `messageHandler.ts` into this module, including the `AI_FOLLOW_UPS_ENABLED` check and safe ID-only error logs.

- [ ] **Step 3: Write failing orchestration tests**

Build the service with injected repository/sender/completion dependencies for unit tests. Cover:

- A later invalid legacy caption causes zero calls to either tracked sender.
- A successful text stores provider ID before the next unit begins.
- If a caption gets a definite transient rejection, its earlier image stays sent and a resume calls only the caption.
- If a text times out, it becomes uncertain, delivery becomes `needs_review`, and no later unit sends.
- A permanent rejection stops with no retry time.
- Bounded attempts turn a repeated definite transient rejection into terminal failed.
- An explicit unconsumed owner retry authorization permits one attempt beyond the automatic cap, then is consumed before the Graph call.
- The window is rechecked immediately before each unit.
- Completion runs only after all units are sent.
- Provider/log sentinels never enter logger/event arguments.

- [ ] **Step 4: Run focused tests and verify failures**

```bash
npm test -- src/services/graphErrorClassifier.test.ts src/services/guideDeliveryCompletion.test.ts src/services/guideDeliveryService.test.ts
```

Expected: new modules/results are absent.

- [ ] **Step 5: Implement the completion service**

Expose:

```ts
export async function finalizeGuideDelivery(
  deliveryId: string,
  claimToken: string,
): Promise<"completed" | "already_completed" | "not_ready" | "lost_claim">;
```

Load the delivery, trigger/thread metadata, and unit counts through the repository. For inbound and explicit-redelivery triggers, `triggerId` is the durable `DmMessage.id`; use persisted `threadId` and `triggeredAt` for follow-up scheduling. `markThreadResolved` already guards against resolving a newer inbound.

Run existing completion operations idempotently, then use one fenced repository transaction to change `sending -> completed`, clear the claim, set `completedAt`, and insert `sequence_completed`. Include delivery/conversation/trigger IDs, trigger kind, unit count, and `followerAtTrigger`; exclude snapshots.

- [ ] **Step 6: Implement the orchestration service**

Expose one entry point for current callers:

```ts
export async function deliverGuideForTrigger(input: {
  conversationId: string;
  resourceId: string;
  igUserId: string;
  threadId: string | null;
  triggerKind: "inbound_reply" | "explicit_redelivery" | "follow_recovery";
  triggerId: string;
  triggeredAt: Date;
  sendWindowExpiresAt: Date;
  followerAtTrigger: boolean | null;
  redeliveryIntro?: string;
}): Promise<GuideDeliveryResult>;
```

The service loads current resource messages only when it is creating the trigger's first plan. A replay reads persisted units and never recompiles from edited guide content.

For each claimed unit:

1. Call `beginUnit` in a short transaction.
2. Call `sendTrackedText` or `sendTrackedMedia` outside any transaction with source `guide_automation`.
3. Convert the result/error to a narrow receipt or allowlisted metadata.
4. Checkpoint sent/failed/uncertain in a new short transaction.
5. Wait the existing 800 ms pacing delay before the next provider call.

If the success checkpoint loses its claim or throws after Meta accepts, do not retry in-process. Leave `sending`; lease reconciliation will make it uncertain.

- [ ] **Step 7: Run focused tests and full backend build**

```bash
npm test -- src/services/graphErrorClassifier.test.ts src/services/guideDeliveryCompletion.test.ts src/services/guideDeliveryService.test.ts
npm run build
```

Expected: all pass.

- [ ] **Step 8: Commit the send/completion slice**

```bash
git add src/services/graphErrorClassifier.ts src/services/graphErrorClassifier.test.ts src/services/guideDeliveryCompletion.ts src/services/guideDeliveryCompletion.test.ts src/services/guideDeliveryService.ts src/services/guideDeliveryService.test.ts
git commit -m "feat: resume confirmed guide delivery units"
```

---

### Task 8: Add bounded retries and stale-send reconciliation

**Files:**

- Create: `src/services/guideDeliveryWorker.ts`
- Create: `src/services/guideDeliveryWorker.test.ts`
- Create: `src/services/guideDeliveryScheduler.ts`
- Create: `src/services/guideDeliveryScheduler.test.ts`
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Add failing environment tests**

Add these defaults and bounds:

```ts
GUIDE_DELIVERY_BATCH_SIZE: 10                 // 1..50
GUIDE_DELIVERY_LEASE_MS: 5 * 60 * 1000       // minimum 60s
GUIDE_DELIVERY_MAX_ATTEMPTS: 3                // 1..10
GUIDE_DELIVERY_RETRY_BASE_MS: 60 * 1000       // minimum 10s
GUIDE_DELIVERY_WORKER_INTERVAL_MS: 60 * 1000  // minimum 10s
```

Use `z.coerce.number().int()` with the listed bounds. There is no feature flag: this worker is part of the safety contract, and without it stale sends remain invisible.

- [ ] **Step 2: Write failing worker tests**

The tick order must be:

1. Reconcile expired claims.
2. Finalize all-sent deliveries returned by reconciliation without calling Meta.
3. Claim due planned/definite-transient deliveries.
4. Process each claimed delivery with per-delivery error isolation.

Test that:

- stale `sending` -> uncertain/review and no send;
- expired claim with no begun unit becomes safely due;
- all-sent incomplete delivery runs bookkeeping only;
- definite transient failure uses capped exponential backoff;
- max attempts stop retries;
- a closed window is marked failed and skipped;
- one delivery throwing does not stop the rest of the batch.

- [ ] **Step 3: Write failing scheduler tests**

Use the same injected timer shape as `dmRecoveryScheduler`. Assert it runs immediately, never overlaps a slow tick, catches synchronous and asynchronous failures with a stable error code, and returns a stop function.

- [ ] **Step 4: Run focused tests and verify failures**

```bash
npm test -- src/config/env.test.ts src/services/guideDeliveryWorker.test.ts src/services/guideDeliveryScheduler.test.ts
```

Expected: missing configuration and modules.

- [ ] **Step 5: Implement the worker and scheduler**

Backoff is:

```ts
const delayMs = env.GUIDE_DELIVERY_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
```

Cap it at the remaining send-window duration. If the computed next attempt is at or after `sendWindowExpiresAt`, store `messaging_window_closed` and do not queue it.

The worker never changes `uncertain` automatically and never interprets a missing provider ID as safe to retry.

- [ ] **Step 6: Start the worker from server startup**

Call `startGuideDeliveryScheduler` once with the environment interval and `runGuideDeliveryTick`. The scheduler runs an immediate startup reconciliation before its interval. Its log entries contain only stable error codes/counts.

- [ ] **Step 7: Run worker tests and build**

```bash
npm test -- src/config/env.test.ts src/services/guideDeliveryWorker.test.ts src/services/guideDeliveryScheduler.test.ts
npm run build
```

Expected: all pass.

- [ ] **Step 8: Commit the worker slice**

```bash
git add src/config/env.ts src/config/env.test.ts src/services/guideDeliveryWorker.ts src/services/guideDeliveryWorker.test.ts src/services/guideDeliveryScheduler.ts src/services/guideDeliveryScheduler.test.ts src/server.ts
git commit -m "feat: reconcile interrupted guide deliveries"
```

---

### Task 9: Route every live guide path through the durable service

**Files:**

- Modify: `src/handlers/messageHandler.ts`
- Modify: `src/handlers/messageHandler.test.ts`
- Remove: `src/services/sequenceSender.ts`
- Remove: `src/services/sequenceSender.test.ts`

- [ ] **Step 1: Replace handler test mocks before production code**

Mock `deliverGuideForTrigger` and remove `sendSequence`, direct `markCompleted`, and direct follow-up scheduling expectations from guide-path tests. Add assertions for all three paths:

1. Instant keyword delivery for a follower -> `inbound_reply`.
2. Already-completed keyword -> `explicit_redelivery` with the existing intro copy.
3. Open-gate reply, including recovered expired DONE -> `inbound_reply`.

Each call must carry:

```ts
{
  conversationId,
  resourceId,
  igUserId: senderId,
  threadId: inbound.threadId,
  triggerId: inbound.messageId,
  triggeredAt: parseProviderTimestamp(entry.timestamp),
  sendWindowExpiresAt: new Date(triggeredAt.getTime() + 24 * 60 * 60 * 1000),
  followerAtTrigger: profile.isFollower,
}
```

Assert duplicate webhook processing with the same inbound message reuses the same trigger ID. Retain existing tests showing a confirmed non-follower receives only the follow gate and does not create a guide delivery.

- [ ] **Step 2: Run handler tests and verify they fail**

```bash
npm test -- src/handlers/messageHandler.test.ts
```

Expected: handler still calls `sendSequence` and performs completion itself.

- [ ] **Step 3: Add one small handler helper for inbound-triggered delivery**

Use a constant for the 24-hour standard-DM window and centralize argument construction to prevent the three branches from drifting. The helper must return the typed `GuideDeliveryResult` so each branch can decide whether to run its existing best-effort closing nudge.

Pass `REDELIVERY_INTRO` into the durable service only for `explicit_redelivery`; remove the direct pre-guide `sendTrackedText` calls. This prevents an intro from landing when preflight rejects the guide and prevents it from duplicating on resume.

- [ ] **Step 4: Keep completion and thread resolution inside the delivery finalizer**

Remove guide-path calls to `markCompleted`, `scheduleFollowUpAfterDelivery`, `markThreadResolved`, and `sequence_completed`. Gate-only and follow-required paths keep their existing direct sends/bookkeeping.

Run the follow-aware closing nudge only when `deliverGuideForTrigger` returns `completed` in that invocation. It remains best-effort and is not allowed to change delivery/conversation status.

For `preflight_failed`, `needs_review`, `retry_scheduled`, or `already_processing`, return normally and leave the inbound thread needing attention unless/until the finalizer resolves it.

- [ ] **Step 5: Remove the bypass sender**

Run:

```bash
rg -n 'sendSequence|sequenceSender' src
```

Expected before deletion: only the implementation/test files remain. Delete both with `apply_patch`, then run the search again; expected output is empty.

- [ ] **Step 6: Run handler and backend regression tests**

```bash
npm test -- src/handlers/messageHandler.test.ts src/services/guideDeliveryService.test.ts
npm test
npm run build
```

Expected: all pass. Specifically, expired explicit DONE still creates a delivery because the fresh inbound opens the provider window; arbitrary expired text still does not recover the request.

- [ ] **Step 7: Commit the live-path migration**

```bash
git add src/handlers/messageHandler.ts src/handlers/messageHandler.test.ts src/services/sequenceSender.ts src/services/sequenceSender.test.ts
git commit -m "refactor: route guide sends through delivery ledger"
```

---

### Task 10: Add authenticated owner review actions and safe thread summaries

**Files:**

- Create: `src/services/guideDeliveryReviewService.ts`
- Create: `src/services/guideDeliveryReviewService.test.ts`
- Create: `src/api/guideDeliveries.routes.ts`
- Create: `src/api/guideDeliveries.routes.test.ts`
- Modify: `src/api/dmThreads.routes.ts`
- Modify: `src/api/dmThreads.routes.test.ts`
- Modify: `src/api/router.ts`

- [ ] **Step 1: Write failing review-service state tests**

Define these operations:

```ts
confirmUnitDelivered({ deliveryId, unitId, actor, now })
retryUncertainUnit({ deliveryId, unitId, actor, acknowledgeDuplicateRisk, now })
cancelGuideDelivery({ deliveryId, actor, now })
```

Test:

- Only an `uncertain` unit on a `needs_review` delivery can be confirmed/retried.
- `Already delivered` changes the unit to `sent`, sets `sentAt`/`ownerConfirmedAt`, and writes an audit event.
- If confirmation leaves more unsent units and the window is open, it resumes from the next unit.
- If confirmation makes all units sent, it runs completion even after the window closes because no Graph call remains.
- If confirmation leaves unsent units after window close, it records `messaging_window_closed` and does not send.
- `Retry unit` requires literal `acknowledgeDuplicateRisk: true`, resets only that unit to retryable, and never resets earlier sent units.
- `Retry unit` persists a fresh `ownerRetryAuthorizedAt` with `ownerRetryConsumedAt = null`; beginning that attempt consumes it atomically so a crash/restart cannot turn one acknowledgement into multiple attempts.
- `Retry unit` is rejected after window close.
- `Cancel delivery` is allowed while closed, never marks the conversation complete, and is idempotent.
- Audit payloads contain actor/action/delivery/unit IDs/timestamp and no snapshots.

- [ ] **Step 2: Write failing API contract tests**

Mount these routes under the already-authenticated API router:

```text
POST /guide-deliveries/:deliveryId/units/:unitId/confirm-delivered
POST /guide-deliveries/:deliveryId/units/:unitId/retry
POST /guide-deliveries/:deliveryId/cancel
```

The retry body is `{ "acknowledgeDuplicateRisk": true }`. Use stable errors and statuses:

- `400 duplicate_risk_acknowledgement_required`
- `404 delivery_not_found` / `unit_not_found`
- `409 delivery_state_changed`
- `409 messaging_window_closed`
- `204` for accepted idempotent cancel/confirm; `202` when a resume is queued/started.

Assert `req.adminEmail` becomes the audit actor.

- [ ] **Step 3: Write failing DM-thread summary tests**

Extend list/detail selects through the new `DmThread.guideDeliveries` relation:

- List rows return `deliveryReviewCount` only; no snapshots, provider IDs, or errors.
- Detail returns a bounded newest-first `deliveryReviews` array for `needs_review` and closed-window failed deliveries that still require owner attention.
- Each review DTO contains delivery ID/status, `confirmedUnits`, `totalUnits`, window expiry/open flag, failure code, and unit ID/position/kind/status. It must not contain `textSnapshot`, `mediaUrlSnapshot`, fingerprint, or provider trace ID.

- [ ] **Step 4: Run focused tests and verify failures**

```bash
npm test -- src/services/guideDeliveryReviewService.test.ts src/api/guideDeliveries.routes.test.ts src/api/dmThreads.routes.test.ts
```

Expected: review modules/routes and DTO fields are absent.

- [ ] **Step 5: Implement review transitions in one locked transaction**

Lock delivery, then units by ascending position. Apply the state change and create the audit `event_log` row in the same transaction. Return a narrow directive such as `finalize`, `resume`, or `none`; call the delivery processor only after commit.

Never call Meta from the review transaction. Never accept actor/action data from the request body; actor comes from authenticated request state and action comes from the endpoint.

- [ ] **Step 6: Implement and mount the routes**

Add `guideDeliveriesRouter` to `src/api/router.ts`. Route handlers translate domain errors to the stable response contract and return no private row data.

- [ ] **Step 7: Serialize safe review summaries from DM thread routes**

Keep the existing 200-message cap. Query review relations directly by thread ID rather than inferring them from only those 200 message IDs, so an older delivery needing review remains visible.

- [ ] **Step 8: Run focused tests and backend regression**

```bash
npm test -- src/services/guideDeliveryReviewService.test.ts src/api/guideDeliveries.routes.test.ts src/api/dmThreads.routes.test.ts
npm test
npm run build
```

Expected: all pass.

- [ ] **Step 9: Commit the owner API slice**

```bash
git add src/services/guideDeliveryReviewService.ts src/services/guideDeliveryReviewService.test.ts src/api/guideDeliveries.routes.ts src/api/guideDeliveries.routes.test.ts src/api/dmThreads.routes.ts src/api/dmThreads.routes.test.ts src/api/router.ts
git commit -m "feat: add owner review for uncertain guide sends"
```

---

### Task 11: Surface delivery review and explicit duplicate-risk actions in Conversations

**Files:**

- Create: `web/src/components/conversations/GuideDeliveryReviewCard.tsx`
- Create: `web/src/components/conversations/GuideDeliveryReviewCard.test.tsx`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/components/conversations/DmThreadList.tsx`
- Modify: `web/src/components/conversations/DmThreadDrawer.tsx`
- Modify: `web/src/pages/Conversations.test.tsx`

- [ ] **Step 1: Add the review DTO types**

```ts
export interface GuideDeliveryReviewUnit {
  id: string;
  position: number;
  kind: "text" | "image" | "file";
  status: "pending" | "sending" | "sent" | "failed" | "uncertain";
}

export interface GuideDeliveryReview {
  id: string;
  status: "needs_review" | "failed";
  confirmedUnits: number;
  totalUnits: number;
  sendWindowExpiresAt: string;
  sendWindowOpen: boolean;
  failureCode: string | null;
  units: GuideDeliveryReviewUnit[];
}
```

Add `deliveryReviewCount` to `DmThreadRow` and `deliveryReviews` to `DmThreadDetail`.

- [ ] **Step 2: Write failing card tests**

Cover:

- Heading `Delivery needs review`.
- `2 of 4 messages confirmed` and identification of the uncertain unit by one-based position/kind.
- `Already delivered`, `Retry unit`, and `Cancel delivery` actions.
- Retry opens a confirmation dialog explaining that Instagram may have delivered it and a retry can duplicate it.
- The retry request includes `{ acknowledgeDuplicateRisk: true }` only after confirmation.
- Retry is disabled when `sendWindowOpen` is false.
- Already-delivered is disabled after the window only when unsent units would remain; it stays enabled when confirming the last unit can finish locally.
- Cancel remains enabled after window close.
- Successful actions invalidate `dm-thread`, `dm-threads`, and conversation counts.
- Stable API errors are mapped to inline owner guidance rather than a raw HTTP message.

- [ ] **Step 3: Run the card test and verify it fails**

```bash
npm --prefix web test -- src/components/conversations/GuideDeliveryReviewCard.test.tsx
```

Expected: component-not-found failure.

- [ ] **Step 4: Implement the review card**

Render aggregate status and unit metadata only; never display snapshotted private content. Use `ConfirmDialog` for retry and cancel. Button calls map exactly to the Task 10 endpoints.

Closed-window copy:

```text
Instagram's messaging window has closed. A fresh inbound message is required before any remaining message can be sent.
```

- [ ] **Step 5: Add list and drawer integration**

In `DmThreadList`, render a separate amber `Delivery needs review` badge when `deliveryReviewCount > 0`; do not hide it behind draft status. In `DmThreadDrawer`, render all returned review cards above the draft card so an uncertain automation send is seen before composing another reply.

- [ ] **Step 6: Add Conversations integration assertions**

Extend `Conversations.test.tsx` or a focused `DmThreadList` test to show that a row with a review count opens its thread and exposes the review UI. Keep the existing default Needs reply and lens behavior unchanged.

- [ ] **Step 7: Run web regression checks**

```bash
npm --prefix web test -- src/components/conversations/GuideDeliveryReviewCard.test.tsx src/pages/Conversations.test.tsx
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
```

Expected: all pass.

- [ ] **Step 8: Commit the review UI**

```bash
git add web/src/lib/types.ts web/src/components/conversations/GuideDeliveryReviewCard.tsx web/src/components/conversations/GuideDeliveryReviewCard.test.tsx web/src/components/conversations/DmThreadList.tsx web/src/components/conversations/DmThreadDrawer.tsx web/src/pages/Conversations.test.tsx
git commit -m "feat: review uncertain guide sends in conversations"
```

---

### Task 12: Verify rollout safety, document operations, and close the implementation

**Files:**

- Create: `docs/guide-delivery-operations.md`
- Modify as required only for test-discovered defects in files above.

- [ ] **Step 1: Write the operations runbook**

Document:

- Pre-deploy read-only audit command and why exit `1` means at least one active guide still blocks activation; inactive draft warnings remain listed without blocking live traffic.
- The known active 1,434-unit step requires author correction; no SQL update or auto-split is permitted.
- Migration-first deployment order.
- Controlled text-only test.
- Controlled image-plus-caption test.
- Forced definite rejection after an earlier confirmed unit, verifying resume skips it.
- Forced ambiguous timeout, verifying `Delivery needs review` and no automatic retry.
- Owner `Already delivered`, duplicate-risk retry, and cancellation procedures.
- Safe event names/fields and dashboards for planned, preflight rejected, sent, retryable, uncertain, owner-resolved, and completed.
- Rollback behavior: stop new application sends first; do not delete ledger rows or reset uncertain units.
- Explicit statement that follow-recheck work remains separate and must use `triggerKind = follow_recovery` later.

- [ ] **Step 2: Run privacy and bypass scans**

```bash
rg -n 'sendSequence|sequenceSender' src
rg -n 'logger\.(info|warn|error|debug)\([^\n]*(textSnapshot|mediaUrlSnapshot|body)' src/services/guideDelivery* src/api/guideDeliveries.routes.ts
rg -n 'eventLog\.create|logEvent' src/services/guideDelivery* src/api/guideDeliveries.routes.ts
```

Expected: first two searches return no unsafe hits. Manually inspect every event call from the third search and confirm it passes only the allowlisted fields from Global Constraints.

- [ ] **Step 3: Run the complete automated verification matrix**

```bash
npx prisma format
npx prisma validate
npx prisma generate
npm test
npm run build
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
```

Expected: all commands exit `0`.

With the designated disposable local PostgreSQL migration database configured, additionally run:

```bash
npm test -- src/services/guideDeliveryMigrationContract.test.ts src/services/guideDeliveryRepositoryContract.test.ts
```

Expected: both suites execute (not skip) and pass.

- [ ] **Step 4: Run the read-only content audit**

```bash
npm run audit:guide-message-lengths
```

Expected before author correction: ID/length-only report and exit `1` because the known 1,434-unit row is active. After the author manually rewrites or divides every affected active guide: inactive/unlinked warnings may still be listed, but there is no over-limit active row and the command exits `0`. Do not change content as part of backend deployment unless the author supplies the exact replacement messages.

- [ ] **Step 5: Perform controlled pre-production delivery checks**

Using a controlled Instagram recipient inside an open messaging window:

1. Send a two-text guide and verify two unit rows become `sent`, then one delivery becomes `completed`.
2. Send image plus caption; force the caption's first call to receive a definite rejection, then verify the image provider ID remains unchanged and only the caption attempt increments.
3. Force a post-request timeout; verify the unit becomes/reconciles to `uncertain`, no worker retry occurs, and Conversations shows the three owner actions.
4. Resolve with `Already delivered` and verify remaining units resume without resending earlier confirmed units.

Record only delivery/unit IDs and statuses in the verification note; do not paste guide content or provider tokens.

- [ ] **Step 6: Review success criteria against evidence**

Confirm each statement with a named test or controlled check:

- Supported API rejects every text/caption above 1,000 code units.
- Legacy invalid guide causes zero Graph calls.
- UI never invents message boundaries.
- Confirmed units are not resent automatically.
- Ambiguous units require an explicit owner action.
- Conversation completion occurs only after all units are provider- or owner-confirmed.
- Webhook replay produces one delivery plan.
- No delivery transaction spans a Meta call.

- [ ] **Step 7: Commit the runbook and any verification-only corrections**

```bash
git add docs/guide-delivery-operations.md
git commit -m "docs: add guide delivery rollout runbook"
```

- [ ] **Step 8: Inspect final scope before handoff**

```bash
git status --short
git log --oneline --decorate -12
git diff 2b0cde8..HEAD --stat
```

Expected: only the planned feature files are committed; `.claude/` and `probe-tmp.mjs` remain untouched and untracked.

---

## Final Implementation Review Checklist

- [ ] Every task used red-green-refactor: test failed for the intended reason before production code was added.
- [ ] The shared limit source is imported by both Express and React; there is no second literal `1000` controlling guide bodies.
- [ ] API errors never echo submitted guide text.
- [ ] Preflight completes before the first sender call.
- [ ] Redelivery intro is checkpointed as a unit; follow closing is intentionally best-effort after completion.
- [ ] Trigger replay cannot replace a persisted snapshot.
- [ ] All provider calls are visibly outside Prisma transactions in code review.
- [ ] Claims are fenced by token and queue queries use indexed predicates plus `SKIP LOCKED`.
- [ ] Stale provider-boundary work becomes uncertain, never retryable.
- [ ] Owner actions are authenticated, state-checked, window-aware, and audited without private content.
- [ ] RLS/grants, FK indexes, checks, and partial queue indexes are proven by the migration contract.
- [ ] Existing over-limit prose was not automatically modified.
- [ ] Follow-gate rechecking was not added in this change.
- [ ] Full backend/web tests, builds, lint, Prisma validation, and configured PostgreSQL contracts pass.
