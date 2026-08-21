# Follower-Aware Comment Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Follow strict TDD for behavior changes.

**Goal:** Give known followers a warm comment-triggered gate DM while standardizing active automation public replies and preserving the existing live follow recheck and guide delivery.

**Architecture:** Select the private gate from cached `IgUser.isFollower` only after a new journey earns the one private reply. Keep the selected text on the existing tracked-send and retry paths, and update persisted public copy through an explicit dry-run-first operator script rather than hard-coding it in the handler.

**Tech Stack:** TypeScript, Prisma, Vitest, React, Testing Library.

## Global Constraints

- Known-follower DM copy is exactly: `So lovely to see you again 💛 Reply DONE and I’ll send your guide right over.`
- Approved public reply is exactly: `It’s waiting for you 💛 Check your DMs (and Requests)!`
- Any latest cached `isFollower = true` is trusted regardless of age; `false`, `null`, or lookup failure uses the keyword’s existing gate message.
- The comment handler makes no new Instagram Graph request.
- The live follower recheck and full-guide delivery after any genuine inbound reply remain unchanged.
- Initial private replies and queued retries use the same selected text.
- No database migration, public API change, feature flag, or direct-DM behavior change.

---

### Task 1: Follower-aware comment gate selection

**Files:**
- Create: `src/services/commentGateCopy.ts`
- Create: `src/services/commentGateCopy.test.ts`
- Modify: `src/handlers/commentHandler.ts`
- Modify: `src/handlers/commentHandler.test.ts`

**Interfaces:**
- Produce `selectCommentGate(input: { isFollower: boolean | null; defaultMessage: string }): { variant: "known_follower" | "default"; text: string }`.
- Consume the existing cached `getFollowState(igUserId)` service; never call `resolveUsername` from the comment handler.

- [ ] Write failing selector tests for cached `true`, `false`, and `null` using literal expected text.
- [ ] Run the selector tests and confirm they fail because the selector does not exist.
- [ ] Implement the minimal pure selector and rerun its tests.
- [ ] Add failing handler tests proving cached `true` sends the warm DM, cache failure falls back safely, a failed send queues the selected warm text, and duplicate/reused journeys do not read follower state.
- [ ] Run the focused handler tests and confirm expected failures.
- [ ] Integrate cached lookup only after `journey.maySendGate`; on lookup failure log a safe diagnostic without the raw error and select `default`.
- [ ] Pass the selected text to `sendTrackedPrivateReply` and `enqueueGate`; add `gateVariant` to the existing `dm_sent` event.
- [ ] Run selector and handler tests, then the full backend suite and build.
- [ ] Commit the task.

### Task 2: Approved public-reply defaults

**Files:**
- Create: `web/src/lib/automationCopy.ts`
- Modify: `web/src/components/KeywordForm.tsx`
- Modify: `web/src/components/UpcomingAutomations.tsx`
- Test: focused component tests covering both creation flows

**Interfaces:**
- Produce `DEFAULT_PUBLIC_REPLY` with the approved exact text for both frontend creation flows.

- [ ] Write failing UI tests proving a new keyword and a new upcoming setup begin with the approved public reply.
- [ ] Run the focused tests and confirm they fail on the old/empty defaults.
- [ ] Add the shared frontend constant and use it in both initial form states and relevant placeholders.
- [ ] Rerun focused UI tests, then the full frontend suite and build.
- [ ] Commit the task.

### Task 3: Idempotent public-copy rollout script

**Files:**
- Create: `scripts/standardize-public-replies.ts`
- Create: `scripts/standardize-public-replies.test.ts`
- Modify: `scripts/seed-keywords.ts`
- Modify: `package.json`

**Interfaces:**
- Produce a script that defaults to preview and mutates only when `--write` is present.
- Update active `Keyword` rows and active `UpcomingAutomation` rows whose status is `waiting` or `needs_attention`.

- [ ] Write failing tests against a stubbed Prisma boundary proving preview performs no writes, write mode updates only eligible rows, and repeated write mode reports zero remaining changes.
- [ ] Run the script tests and confirm they fail because the script does not exist.
- [ ] Implement the smallest injectable rollout function plus a CLI wrapper; use one transaction for write mode and print counts only.
- [ ] Update seed/default script copy and add an npm command for the operator workflow.
- [ ] Rerun script tests, then the full backend suite and build.
- [ ] Run the real script in preview mode only and record eligible counts; do not pass `--write` during implementation.
- [ ] Commit the task.

## Final Verification

- [ ] Run complete backend tests and build with the parent checkout’s ignored environment loaded without printing secrets.
- [ ] Run complete frontend tests and build with the parent checkout’s ignored frontend environment loaded.
- [ ] Confirm git diff contains no schema migration, feature flag, Graph call, or direct-DM change.
- [ ] Request whole-branch code review and resolve all Critical/Important findings.
