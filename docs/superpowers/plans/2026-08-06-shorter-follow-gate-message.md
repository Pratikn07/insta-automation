# Shorter Follow-Gate Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the follow-required Instagram DM with the exact shorter copy approved in the design.

**Architecture:** Preserve the existing message-handler flow and change only the `FOLLOW_GATE` string constant. Strengthen the existing non-follower test so it verifies the exact outbound message text.

**Tech Stack:** TypeScript, Vitest, Node.js

## Global Constraints

- The outbound message must be exactly: `You're one step away! 💛 Follow @tinysoho, then reply DONE here and I'll send it right over.`
- The initial keyword-specific gate message and all automation behavior must remain unchanged.
- Do not change follower detection, conversation state transitions, guide delivery, or analytics events.

---

### Task 1: Shorten the Follow-Required Reply

**Files:**
- Modify: `src/handlers/messageHandler.test.ts:269`
- Modify: `src/handlers/messageHandler.ts:39`

**Interfaces:**
- Consumes: the existing `handleMessage(entry: MessagingEntry): Promise<void>` handler and mocked `sendTrackedText` service.
- Produces: no new interface; the existing handler sends the approved shorter `FOLLOW_GATE` text.

- [ ] **Step 1: Write the failing exact-copy assertion**

In the test named `recovers an expired DONE and asks a confirmed non-follower to follow`, require the approved message text:

```ts
expect(sendTrackedText).toHaveBeenCalledWith(
  expect.objectContaining({
    recipientIgUserId: "ig-user-1",
    text: "You're one step away! 💛 Follow @tinysoho, then reply DONE here and I'll send it right over.",
    source: "keyword_automation",
  }),
);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npm test -- src/handlers/messageHandler.test.ts -t "recovers an expired DONE and asks a confirmed non-follower to follow"
```

Expected: FAIL because `sendTrackedText` still receives the old parenthetical sentence.

- [ ] **Step 3: Replace the production constant with the approved copy**

Update `FOLLOW_GATE` in `src/handlers/messageHandler.ts`:

```ts
const FOLLOW_GATE =
  "You're one step away! 💛 Follow @tinysoho, then reply DONE here and I'll send it right over.";
```

Update the nearby comment so it no longer claims that a parenthetical follow-flag-lag explanation is present.

- [ ] **Step 4: Verify the focused behavior**

Run:

```bash
npm test -- src/handlers/messageHandler.test.ts -t "recovers an expired DONE and asks a confirmed non-follower to follow"
```

Expected: PASS.

- [ ] **Step 5: Verify the repository**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: the full test suite passes, the TypeScript build exits successfully, and `git diff --check` reports no whitespace errors.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/handlers/messageHandler.ts src/handlers/messageHandler.test.ts
git commit -m "fix: shorten follow gate message"
```
