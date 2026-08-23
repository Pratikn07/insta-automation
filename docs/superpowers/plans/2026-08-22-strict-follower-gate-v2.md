# Strict Follower Gate V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authorize every new guide delivery and redelivery only from a fresh live Meta `true`, while giving followers and non-followers an idempotent one-tap path and failing closed when Meta cannot verify.

**Architecture:** A dedicated live-only verifier separates authorization from cached profile enrichment. Durable access attempts and opaque action tokens own one parent request. Quick replies, postbacks, and ordinary replies converge on one action service that atomically consumes intent, performs a fresh check, and starts at most one durable guide delivery.

**Tech Stack:** TypeScript, Meta Instagram Graph API, Prisma/PostgreSQL/Supabase, Express webhooks, Zod, Vitest, disposable PostgreSQL contracts.

**Spec:** [TinySoho reusable guide covers and follower gate design](../specs/2026-08-22-tinysoho-guide-covers-and-follower-gate-design.md), Parent Instagram experience and access-attempt state.

## Global Constraints

- Automated delivery requires `{ source: "meta_live", isFollower: true }` from the current action. Nothing else authorizes.
- `resolveUsername`, `getFollowState`, `IgUser.isFollower`, and an earlier access-attempt result are never authorization inputs.
- Meta success plus a database cache-write failure returns `unavailable`; authorization does not proceed on partially persisted evidence.
- Confirmed `false` receives the approved follower gate. Unknown/error receives neutral retry wording and no claim that the person is or is not following.
- Comment webhooks still send at most one private reply per journey.
- Direct-DM keyword messages skip the redundant opening because the inbound already opens messaging context.
- Redelivery requires the same fresh-true rule.
- Action payloads contain only `ts:guide:<uuid>`; sender/resource/conversation/action are loaded from the token row.
- Token consumption and attempt transition are atomic. Replays, wrong sender, expired token, incompatible state, and unknown payload fail closed.
- At most two gentle automatic follow-lag responses per attempt; thereafter mark owner review and send nothing automatically.
- Every permitted retry response expires the old token and issues a new opaque token; replaying an older button can never spend a newer retry allowance.
- People who followed outside this automation are reached only after they comment or DM. This feature does not enumerate followers or send proactive cold DMs.
- No database transaction spans a Graph read or send.
- The feature defaults off and has an immediate text/current-flow fallback.

---

### Task 1: Add the live-only follow verifier

**Files:**

- Create: `src/services/freshFollowVerifier.ts`
- Create: `src/services/freshFollowVerifier.test.ts`
- Modify: `src/services/igUserService.ts`
- Modify: `src/services/igUserService.test.ts`

**Interfaces:**

```ts
type FreshFollowResult =
  | { source: "meta_live"; isFollower: boolean; checkedAt: Date }
  | { source: "unavailable"; isFollower: null; checkedAt: Date; errorCode: string };
```

- `resolveFollowStatusFresh(igUserId)` always reads `is_user_follow_business` from Meta and never loads a cached Boolean as fallback.

- [ ] Write failing tests for live true, live false, omitted flag, consent error, transport error, malformed response, cache-write failure, and an existing cached true/false during every failure.
- [ ] Assert the unavailable error code is allowlisted and raw Axios/config/token data never reaches logs/results.
- [ ] Run `npm test -- src/services/freshFollowVerifier.test.ts` and confirm missing-module failure.
- [ ] Implement the isolated verifier over `graph.get`, validate the Boolean, update `IgUser` metadata, and return unavailable on any read/parse/write failure.
- [ ] Leave `resolveUsername` intact for display enrichment but document/test that callers cannot mistake it for authorization.
- [ ] Rerun focused tests and build.
- [ ] Commit with `feat: add live-only follow authorization`.

### Task 2: Add access-attempt and opaque action-token schema

**Files:**

- Create: `prisma/migrations/20260822020000_add_guide_access_attempts/migration.sql`
- Modify: `prisma/schema.prisma`
- Create: `src/services/guideAccessMigrationContract.test.ts`

**Interfaces:**

- Add `GuideAccessAttempt` with the exact states/results/exposure fields from the spec.
- Add `GuideActionToken` with `request_guide | check_follow`, `active | consumed | expired | cancelled`, opaque UUID PK, attempt FK, expiry, consumed timestamp, and created timestamp. Sender/resource/conversation truth comes through the attempt and conversation, not duplicate token fields.
- One nonterminal active attempt per conversation uses a partial unique index.

- [ ] Write failing catalog contracts for exact enums, UUID/timestamptz fields, positive bounded check/response counts, exposure/provider-message consistency, and state/result constraints.
- [ ] Assert full indexes on every foreign key plus partial indexes for active attempts and expiring/action lookups.
- [ ] Assert `ON DELETE RESTRICT` for conversation/resource/cover snapshots and `ON DELETE CASCADE` from attempt to tokens only.
- [ ] Assert RLS enabled and no `anon`/`authenticated` privileges.
- [ ] Run against disposable PostgreSQL and confirm failure before the migration.
- [ ] Hand-write the migration and mirror the models/relations in Prisma.
- [ ] Run migration, contract, Prisma validation/generation, drift guard, and build.
- [ ] Commit with `feat: add durable guide access attempts`.

### Task 3: Implement atomic attempt/token repository transitions

**Files:**

- Create: `src/services/guideAccessRepository.ts`
- Create: `src/services/guideAccessRepository.test.ts`
- Create: `src/services/guideAccessRepositoryContract.test.ts`

**Interfaces:**

- Create/load one active attempt per conversation with snapshotted resource/cover/window.
- Issue token only for a compatible attempt state; consume it exactly once after validating sender and expiry.
- Expose fenced transitions for checking, awaiting follow, delivering, delivered, needs review, and expired.

- [ ] Write failing unit tests for create replay, token replay, wrong sender, wrong state/type, expiry, bounded retry responses, and state version conflict.
- [ ] Write concurrent PostgreSQL tests where duplicate webhooks/actions race and only one token/transition wins.
- [ ] Add lock-order tests/documentation: attempt row first, then token row; no path reverses that order.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement short transactions with conditional updates and stable outcomes rather than exception-message parsing.
- [ ] Rerun unit/contract tests and build.
- [ ] Commit with `feat: persist idempotent guide access actions`.

### Task 4: Add neutral opening and gated-action senders behind proven capability

**Files:**

- Create: `src/services/guideAccessCopy.ts`
- Create: `src/services/guideAccessCopy.test.ts`
- Create: `src/meta/sendGuideAction.ts`
- Create: `src/meta/sendGuideAction.test.ts`
- Modify: `src/meta/sendMessage.ts`
- Create: `src/meta/sendMessage.test.ts`

**Interfaces:**

- Reviewed constants produce the exact neutral opening, approved non-follower gate, neutral unavailable response, and gentle lag response.
- Sender supports text fallback, quick reply, and generic gate only when the capability result/flag permits.
- URL is fixed to `https://www.instagram.com/tinysoho/`; action payload is generated from an opaque token only.

- [ ] Write failing copy tests with literal expected text and dynamic guide-name escaping/length behavior.
- [ ] Write failing sender payload tests for text, quick reply, profile URL, check-follow postback, and unsupported-rich fallback.
- [ ] Assert logs contain only IDs, mode, message length, and provider message ID—not copy/payload/token/URL.
- [ ] Run focused tests and confirm failures.
- [ ] Implement reviewed copy and senders using the capability builder proven in the spike; no dynamic model copy.
- [ ] Rerun focused tests/build.
- [ ] Commit with `feat: add guide access action messages`.

### Task 5: Implement the shared access-action service

**Files:**

- Create: `src/services/guideAccessActionService.ts`
- Create: `src/services/guideAccessActionService.test.ts`

**Interfaces:**

- `requestGuideFromAction(tokenId, senderId, inboundMessageId, eventAt)` and `checkFollowFromAction(...)` return stable outcomes from the spec.
- `startDirectDmGuideRequest(conversation, inbound)` skips the opening but uses the same verifier/attempt transitions.
- The service injects the durable guide-delivery starter; it never imports the legacy sequence sender.

- [ ] Write failing table-driven tests for cached true/fresh false, cached true/live unavailable, cached false/fresh true, two-month follower without prior automation, fresh false, fresh unknown, follow lag then true, replay, expiry, wrong sender, and delivery already started.
- [ ] Add tests proving no guide-delivery call occurs for false/unknown and exactly one occurs for a successful true despite duplicate actions.
- [ ] Add error-boundary tests proving a send outcome uncertain moves the attempt to needs review and is never automatically repeated.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement orchestration with Graph calls outside repository transactions and one fenced state transition before each external action.
- [ ] Rerun focused tests/build.
- [ ] Commit with `feat: route guide access through strict follow checks`.

### Task 6: Route quick replies and postbacks through one service

**Files:**

- Create: `src/handlers/guideActionRouter.ts`
- Create: `src/handlers/guideActionRouter.test.ts`
- Modify: `src/handlers/messageHandler.ts`
- Modify: `src/handlers/messageHandler.test.ts`
- Modify: `src/handlers/postbackHandler.ts`
- Modify: `src/handlers/postbackHandler.test.ts`

**Interfaces:**

- Parser accepts only exact `ts:guide:<uuid>` payloads.
- Message quick replies and postbacks call the same router/service.
- Postbacks still record existing recovery evidence before guide routing; unknown payloads are acknowledged.

- [ ] Write failing parser/router tests for valid, malformed, unknown-prefix, wrong sender, replay, and expired tokens.
- [ ] Extend message-handler tests proving quick-reply payload is action intent and not treated as an arbitrary keyword/text reply twice.
- [ ] Extend postback tests proving recovery evidence remains idempotent and known guide payloads route once even if Meta redelivers.
- [ ] Run focused tests and confirm failures.
- [ ] Implement the parser/router and integrate it before general message keyword/reply handling.
- [ ] Rerun focused handlers, full backend tests, and build.
- [ ] Commit with `feat: unify Instagram guide action routing`.

### Task 7: Replace comment/direct-DM/redelivery authorization behind the V2 flag

**Files:**

- Modify: `src/handlers/commentHandler.ts`
- Modify: `src/handlers/commentHandler.test.ts`
- Modify: `src/handlers/messageHandler.ts`
- Modify: `src/handlers/messageHandler.test.ts`
- Modify: `src/api/guideDeliveries.routes.ts`
- Modify: `src/api/guideDeliveries.routes.test.ts`
- Modify: `src/services/guideDeliveryReviewService.ts`
- Modify: `src/services/guideDeliveryReviewService.test.ts`

**Interfaces:**

- Comment flow creates/loads an attempt and sends the neutral opening once; rich action only when proven, otherwise text asks for `YES`/any genuine reply.
- Direct-DM keyword flow creates/loads attempt and immediately performs fresh verification.
- Explicit redelivery/review retry must obtain fresh true before `deliverGuideForTrigger`.

- [ ] Add failing comment replay tests for one attempt/one private reply, neutral copy independent of cached state, rich disabled fallback, and rich-send rejection fallback without a second private reply attempt.
- [ ] Add failing direct-DM tests for true/false/unknown with no redundant opening.
- [ ] Add failing redelivery tests proving cached true cannot authorize and live false/unavailable does not start delivery.
- [ ] Run focused tests and confirm current behavior violates strict unknown/redelivery rules.
- [ ] Integrate V2 branches while preserving the entire existing path when the flag is off.
- [ ] Remove no legacy code in this task; prove mutual exclusivity so one webhook cannot enter both V1 and V2.
- [ ] Rerun focused/full backend tests and build.
- [ ] Commit with `feat: enforce strict follower gate v2`.

### Task 8: Add flags, safe events, metrics, and rollout fence

**Files:**

- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `src/config/flagRegistry.ts`
- Modify: `src/config/flagRegistry.test.ts`
- Modify: `src/config/flagCallSites.test.ts`
- Create: `src/services/guideAccessMetrics.ts`
- Create: `src/services/guideAccessMetrics.test.ts`
- Modify: `src/api/funnels.routes.ts`
- Modify: `src/api/funnels.routes.test.ts`
- Modify: `docs/funnels.md`

**Interfaces:**

- Add `GUIDE_FOLLOW_GATE_V2_ENABLED=false` and `GUIDE_RICH_GATE_ENABLED=false` as outbound flags with `pageMayEnable: false`, `pageMayStop: true`.
- Add a stable allowlisted cohort/guide selector before percentage rollout; absence means nobody enters V2.
- Record only aggregate-safe outcomes/latencies from the spec.

- [ ] Write failing env/registry/call-site tests for both flags and kill-switch behavior.
- [ ] Write metrics tests for opening/action/fresh check/gate/recheck/delivery/needs-review counts without IDs, copy, tokens, URLs, or raw errors.
- [ ] Add rollout tests for off, allowlisted guide/account, non-allowlisted fallback, and kill switch between two actions.
- [ ] Run focused tests and confirm failures.
- [ ] Implement flags through `flagService`, safe event logging, metrics endpoint fields, and operational docs.
- [ ] Rerun focused/full backend tests and build.
- [ ] Commit with `feat: gate and measure strict follower flow`.

## Final Verification

- [ ] Run complete backend tests/build and disposable-PostgreSQL migration contracts.
- [ ] Run `rg -n 'resolveUsername|getFollowState|\.isFollower' src/handlers src/services` and inspect every delivery/redelivery authorization call site.
- [ ] Prove with tests that only `FreshFollowResult.source === "meta_live" && isFollower === true` reaches the durable delivery starter.
- [ ] Prove all four parent-facing branches remain inactive with both new flags false.
- [ ] Execute controlled test-account journeys only after the Meta capability plan is approved.
- [ ] Request whole-branch security/reliability review before any production cohort is enabled.
