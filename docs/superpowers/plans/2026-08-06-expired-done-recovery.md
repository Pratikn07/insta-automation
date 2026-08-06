# Expired DONE Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the latest incomplete Instagram guide request when an exact `DONE` arrives after the internal gate expired, then apply the existing follower gate before delivery.

**Architecture:** Add one read-only conversation-service query for the newest incomplete (`awaiting_done` or `expired`) conversation. In the DM handler, keep the active-gate lookup first and call the recovery query only for exact `DONE` messages when no active gate exists; the recovered row then follows the existing non-follower reminder or guide-delivery branches.

**Tech Stack:** TypeScript, Prisma 5, PostgreSQL/Supabase, Vitest

## Global Constraints

- A confirmed non-follower must receive the existing follow-required reminder and must not receive the guide.
- `isFollower === true` or `null` retains the existing delivery behavior.
- Recovery is allowed only for text matching the existing `DONE_RE`; arbitrary messages and attachments must not recover an old request.
- New keyword matching remains higher priority than gate recovery.
- Do not change database schema or expose private DM content in logs.

---

### Task 1: Query the Latest Incomplete Conversation

**Files:**
- Modify: `src/services/conversationService.ts`
- Test: `src/services/conversationService.test.ts`

**Interfaces:**
- Consumes: `prisma.conversation.findFirst` and the existing keyword/resource/message relation shape.
- Produces: `findLatestIncompleteConversation(igUserId: string)` returning the newest `awaiting_done` or `expired` conversation with its delivery sequence, or `null`.

- [ ] **Step 1: Write the failing service test**

Import `findLatestIncompleteConversation`, then add:

```ts
describe("findLatestIncompleteConversation", () => {
  beforeEach(() => findFirst.mockReset());

  it("selects the newest unfinished conversation without an age cutoff", async () => {
    findFirst.mockResolvedValue({ id: "expired-convo" });

    await findLatestIncompleteConversation("user-1");

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        igUserId: "user-1",
        state: { in: ["awaiting_done", "expired"] },
      },
      orderBy: { createdAt: "desc" },
      include: { keyword: { include: { resource: { include: { messages: true } } } } },
    });
  });
});
```

- [ ] **Step 2: Run the service test and verify RED**

Run: `npm test -- --run src/services/conversationService.test.ts`

Expected: FAIL because `findLatestIncompleteConversation` is not exported.

- [ ] **Step 3: Implement the query**

Add to `src/services/conversationService.ts`:

```ts
export async function findLatestIncompleteConversation(igUserId: string) {
  return prisma.conversation.findFirst({
    where: {
      igUserId,
      state: { in: ["awaiting_done", "expired"] },
    },
    orderBy: { createdAt: "desc" },
    include: { keyword: { include: { resource: { include: { messages: true } } } } },
  });
}
```

- [ ] **Step 4: Run the service test and verify GREEN**

Run: `npm test -- --run src/services/conversationService.test.ts`

Expected: all tests in the file PASS.

### Task 2: Recover Exact DONE Messages in the Handler

**Files:**
- Modify: `src/handlers/messageHandler.ts`
- Test: `src/handlers/messageHandler.test.ts`

**Interfaces:**
- Consumes: `findLatestIncompleteConversation(igUserId: string)` from Task 1 and the existing `DONE_RE` matcher.
- Produces: handler behavior that routes a recovered conversation through the existing completed-keyword guard, follow gate, and guide-delivery paths.

- [ ] **Step 1: Add the mocked dependency and failing handler tests**

Add `findLatestIncompleteConversation` to the test mock with a default `null` result, then add these behavior tests:

```ts
it("recovers an expired DONE and asks a confirmed non-follower to follow", async () => {
  resolveUsername.mockResolvedValue({ isFollower: false, username: "geri", name: "Geri" });
  findLatestIncompleteConversation.mockResolvedValue({
    id: "expired-convo",
    keywordId: "keyword-1",
    state: "expired",
    keyword: { keyword: "SLEEP", resource: { messages: [] } },
  });

  await handleMessage(inbound("Done"));

  expect(findLatestIncompleteConversation).toHaveBeenCalledWith("ig-user-1");
  expect(sendTrackedText).toHaveBeenCalledWith(
    expect.objectContaining({ recipientIgUserId: "ig-user-1" }),
  );
  expect(markGated).toHaveBeenCalledWith("expired-convo");
  expect(sendSequence).not.toHaveBeenCalled();
  expect(queueReplyDraft).not.toHaveBeenCalled();
});

it("recovers an expired DONE and delivers to a follower", async () => {
  findLatestIncompleteConversation.mockResolvedValue({
    id: "expired-convo",
    keywordId: "keyword-1",
    state: "expired",
    keyword: { keyword: "SLEEP", resource: { messages: [] } },
  });

  await handleMessage(inbound("DONE!"));

  expect(sendSequence).toHaveBeenCalledOnce();
  expect(markCompleted).toHaveBeenCalledWith("expired-convo");
  expect(queueReplyDraft).not.toHaveBeenCalled();
});

it("does not recover an expired request for arbitrary text", async () => {
  await handleMessage(inbound("Can you help?"));

  expect(findLatestIncompleteConversation).not.toHaveBeenCalled();
  expect(queueReplyDraft).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the handler test and verify RED**

Run: `npm test -- --run src/handlers/messageHandler.test.ts`

Expected: FAIL because the handler does not import or call the recovery query.

- [ ] **Step 3: Implement exact-DONE recovery**

Import the new function and replace the single active lookup with:

```ts
let convo = await findActiveAwaitingDone(senderId);
let recoveredInactiveGate = false;
if (!convo && DONE_RE.test(text)) {
  convo = await findLatestIncompleteConversation(senderId);
  recoveredInactiveGate = convo !== null;
}
```

Keep the existing `if (convo)` branches unchanged. Add the boolean to structured
`follow_required` and `done_received` event metadata so recovery is auditable
without logging private message text.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --run src/services/conversationService.test.ts src/handlers/messageHandler.test.ts`

Expected: both files PASS.

- [ ] **Step 5: Run full verification**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run build`

Expected: Prisma generation and TypeScript compilation succeed.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/services/conversationService.ts src/services/conversationService.test.ts \
  src/handlers/messageHandler.ts src/handlers/messageHandler.test.ts \
  docs/superpowers/plans/2026-08-06-expired-done-recovery.md
git commit -m "fix: recover expired done replies"
```
