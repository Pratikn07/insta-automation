# Guide Cover Parent Delivery and Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved published cover exactly once per parent access attempt, then send the existing guide through the durable ledger, with safe fallbacks and a measured phased rollout.

**Architecture:** Access-attempt creation snapshots the published cover version. The existing guide-delivery planner optionally prepends one `generated_cover` image unit; the same lease/checkpoint/retry/uncertainty system sends it and the authored guide. A non-follower gate can mark the same cover as already exposed so later verification starts at the guide without duplication.

**Tech Stack:** TypeScript, Prisma/PostgreSQL/Supabase, existing durable guide-delivery ledger, Meta media messaging, Vitest, React metrics surfaces, controlled live QA.

**Spec:** [TinySoho reusable guide covers and follower gate design](../specs/2026-08-22-tinysoho-guide-covers-and-follower-gate-design.md), Cover exposure and durable delivery through rollout.

## Global Constraints

- The existing `guideDeliveryService` remains the sole owner of multi-unit guide sending.
- A cover is eligible only when its snapshotted cover version is published, render-ready, and has an immutable DM path/public URL.
- A non-follower who already received an accepted cover never receives the same cover again after follow confirmation.
- An uncertain cover send is never automatically retried; the attempt and delivery move to owner review.
- If no published cover exists, preserve strict fresh-follow authorization and use the current guide path without a cover.
- A later creator publication never changes an in-progress access attempt or delivery snapshot.
- Normal image-cover delivery can roll out without generic templates. Rich generic delivery remains separately gated by the Meta capability result.
- All outbound flags default off; the page may stop them but may not casually enable them.
- Do not remove the legacy/text fallback during controlled rollout.

---

### Task 1: Extend the ledger origin enum safely

**Files:**

- Create: `prisma/migrations/20260822030000_add_generated_cover_delivery_origin/migration.sql`
- Modify: `prisma/schema.prisma`
- Modify: `src/services/guideDeliveryMigrationContract.test.ts`
- Modify: `src/services/guideDeliveryRepositoryContract.test.ts`

**Interfaces:**

- Append `generated_cover` to `GuideDeliveryUnitOrigin` without recreating/reordering existing enum values.
- Preserve all current worker indexes, policies, grants, checks, and delivery rows.

- [ ] Change the migration-contract expected enum list first and run it against disposable PostgreSQL to confirm failure.
- [ ] Add the minimal additive `ALTER TYPE ... ADD VALUE IF NOT EXISTS` migration and Prisma enum value.
- [ ] Run migrate/contract/Prisma drift checks; prove existing `resource_step` and `redelivery_intro` rows remain readable.
- [ ] Run full backend tests/build.
- [ ] Commit with `feat: add generated cover delivery unit origin`.

### Task 2: Snapshot published cover selection on access attempts

**Files:**

- Modify: `src/services/guideAccessRepository.ts`
- Modify: `src/services/guideAccessRepository.test.ts`
- Modify: `src/services/guideAccessRepositoryContract.test.ts`
- Modify: `src/services/guideCoverRepository.ts`
- Modify: `src/services/guideCoverRepository.test.ts`

**Interfaces:**

- Creating an access attempt performs one explicit published-cover lookup and stores `coverVersionId`; absence stores null.
- Lookup returns version ID and immutable DM URL/path only for `published + ready` rows.
- Attempt replay returns the original snapshot even if a newer cover publishes.

- [ ] Write failing tests for published selection, no cover, draft/failed exclusion, attempt replay after new publication, and deleted/retired-category history.
- [ ] Add concurrent contract coverage proving two attempt creators resolve to one stored cover snapshot.
- [ ] Run focused tests and confirm failures.
- [ ] Implement snapshot selection in the attempt repository transaction without reading Storage.
- [ ] Rerun focused tests/build.
- [ ] Commit with `feat: snapshot guide cover per access attempt`.

### Task 3: Compile an optional generated-cover unit

**Files:**

- Modify: `src/services/guideDeliveryPlanner.ts`
- Modify: `src/services/guideDeliveryPlanner.test.ts`
- Modify: `src/services/guideDeliveryService.ts`
- Modify: `src/services/guideDeliveryService.test.ts`

**Interfaces:**

- Extend planner input with `cover?: { versionId: string; mediaUrl: string }` and `coverAlreadyShown: boolean`.
- Prepend exactly one image unit with `origin: generated_cover`, null resource message ID, and immutable URL when eligible.
- Content fingerprint includes kind, origin, cover version identity, and URL snapshot.

- [ ] Write failing planner tests for prepend ordering, no-cover, already-shown, redelivery intro ordering, invalid URL, and fingerprint changes.
- [ ] Add service tests proving cover and guide use the same durable plan/claim/checkpoints and an invalid later authored unit causes zero sends.
- [ ] Run focused tests and confirm failures.
- [ ] Implement the minimal planner/service input extension; do not add a separate cover sender for confirmed followers.
- [ ] Rerun focused/full delivery suites and build.
- [ ] Commit with `feat: include generated cover in durable guide plan`.

### Task 4: Reconcile gate cover exposure with later guide delivery

**Files:**

- Modify: `src/services/guideAccessActionService.ts`
- Modify: `src/services/guideAccessActionService.test.ts`
- Modify: `src/services/guideAccessRepository.ts`
- Modify: `src/services/guideAccessRepository.test.ts`

**Interfaces:**

- Confirmed non-follower path sends the snapshotted cover through a fenced single-exposure operation before native gate copy/actions.
- Exposure transitions are `not_shown -> accepted | uncertain | failed`; only accepted sets `coverAlreadyShown=true` for later planning.
- Unknown/uncertain external result marks needs review and creates no automatic replay token.

- [ ] Write failing tests for accepted, definite failed, uncertain, duplicate action, process crash before/after checkpoint, and later fresh true.
- [ ] Prove accepted exposure omits the planner cover, failed exposure may include it only after a new explicit parent action, and uncertain never resends automatically.
- [ ] Run focused tests and confirm failures.
- [ ] Implement fenced exposure around the tracked Meta media sender with provider outcome classification matching guide-unit behavior.
- [ ] Keep gate instructions/actions as native text/controls so the image is never the only source of required information.
- [ ] Rerun focused tests/build.
- [ ] Commit with `feat: prevent duplicate guide cover exposure`.

### Task 5: Complete attempt state from durable delivery outcomes

**Files:**

- Modify: `src/services/guideDeliveryCompletion.ts`
- Modify: `src/services/guideDeliveryCompletion.test.ts`
- Modify: `src/services/guideDeliveryReviewService.ts`
- Modify: `src/services/guideDeliveryReviewService.test.ts`
- Modify: `src/services/guideAccessRepository.ts`

**Interfaces:**

- A completed delivery marks its linked access attempt delivered idempotently.
- `needs_review`, owner-confirmed cover, explicit-risk retry, cancellation, and window expiry produce compatible attempt state without inventing a new action token.

- [ ] Write failing tests for all-sent completion, repeat completion, cover-unit uncertainty, authored-unit uncertainty, owner-confirmed send, cancelled delivery, and closed window.
- [ ] Run focused tests and confirm failures.
- [ ] Add the access-attempt completion/review callback after ledger state is durable; never complete the attempt before every required unit is sent/owner-confirmed.
- [ ] Rerun focused/full guide-delivery tests and build.
- [ ] Commit with `feat: synchronize guide access and delivery state`.

### Task 6: Add ordinary cover-delivery flag and rollout selector

**Files:**

- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `src/config/flagRegistry.ts`
- Modify: `src/config/flagRegistry.test.ts`
- Modify: `src/config/flagCallSites.test.ts`
- Create: `src/services/guideCoverDeliveryRollout.ts`
- Create: `src/services/guideCoverDeliveryRollout.test.ts`

**Interfaces:**

- Add `GUIDE_COVER_DELIVERY_ENABLED=false`, outbound, `pageMayEnable: false`, `pageMayStop: true`.
- Add an allowlisted resource-ID cohort and stable trigger-ID percent only after explicit owner configuration; default selects nobody.
- Selection controls only cover inclusion, not strict follower authorization or the existing guide delivery owner.

- [ ] Write failing env/registry/call-site tests and selector tests for off, allowlist, 0%, 100%, stable bucketing, invalid IDs, and kill switch between attempt and delivery.
- [ ] Prove cover-off still delivers the authored guide after fresh true; it never relaxes the gate.
- [ ] Run focused tests and confirm failures.
- [ ] Implement selection through `flagService` and a single call site before plan compilation.
- [ ] Rerun full backend tests/build.
- [ ] Commit with `feat: gate guide cover parent delivery`.

### Task 7: Add observability and operator review surfaces

**Files:**

- Modify: `src/services/guideAccessMetrics.ts`
- Modify: `src/services/guideAccessMetrics.test.ts`
- Modify: `src/api/funnels.routes.ts`
- Modify: `src/api/funnels.routes.test.ts`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/pages/Funnels.tsx`
- Create: `web/src/pages/Funnels.test.tsx`
- Modify: `web/src/components/conversations/GuideDeliveryReviewCard.tsx`
- Modify: `web/src/components/conversations/GuideDeliveryReviewCard.test.tsx`
- Modify: `docs/guide-delivery-operations.md`

**Interfaces:**

- Add aggregate-safe counts/rates for cover selected, accepted, failed, uncertain, omitted/already-shown, duplicate attempts, completion, and review.
- Review UI distinguishes a generated-cover unit from authored guide units without displaying a mutable/signed URL.

- [ ] Write failing metrics tests for each exposure outcome, unique-attempt denominators, no double count on replay, and suppression of low-volume identity-bearing breakdowns.
- [ ] Write failing review-card tests for cover uncertainty, owner-confirmed delivery, explicit retry warning, and immutable cover-version label.
- [ ] Run focused tests and confirm failures.
- [ ] Implement safe API/UI fields and update the operational runbook with stop, inspect, reconcile, and rollback procedures.
- [ ] Rerun backend/web focused/full tests and builds.
- [ ] Commit with `feat: measure and review guide cover delivery`.

### Task 8: Run phased test-account and production rollout

**Files:**

- Create: `docs/qa/2026-08-22-guide-cover-parent-journey-qa.md`
- Add sanitized screenshots under: `docs/qa/artifacts/2026-08-22-guide-cover-parent-journey/`
- Modify after each phase: `docs/guide-delivery-operations.md`

- [ ] Confirm the Meta capability result is approved and the authoring, strict follower gate, and cover-delivery plans have passed their release gates.
- [ ] Phase A: keep rich templates off; test ordinary image cover with controlled follower, non-follower, unknown, follow-lag, replay, desktop fallback, send failure, uncertainty, and window expiry.
- [ ] Verify no cover or guide duplicates in Instagram and the database ledger.
- [ ] Phase B: enable a single allowlisted published guide/test account; audit every attempt and compare stored metrics to the actual inbox.
- [ ] Phase C: enable a small production guide/cohort only after explicit owner authorization; ordinary image delivery comes before generic templates.
- [ ] Hold expansion if follow-check unavailable rate, duplicate rate, send uncertainty, or owner-review rate exceeds the thresholds recorded in the runbook.
- [ ] Roll back by stopping `GUIDE_COVER_DELIVERY_ENABLED` and/or `GUIDE_FOLLOW_GATE_V2_ENABLED`; preserve evidence and published covers, and do not reverse migrations.
- [ ] Enable `GUIDE_RICH_GATE_ENABLED` only if its exact capability rows are `supported` and mobile/desktop crop/actions passed.
- [ ] Record the dated owner decision and cohort at every phase.

## Final Verification

- [ ] Run complete backend/web tests and builds plus disposable-PostgreSQL contracts.
- [ ] Run bypass scans proving no confirmed-follower path sends a cover outside the durable ledger and no guide path bypasses fresh true.
- [ ] Verify access attempt, guide delivery, and provider message IDs reconcile one-to-one for the controlled cohort.
- [ ] Verify published cover path/hash/version snapshots stay immutable across a creator republish during an in-progress attempt.
- [ ] Verify flag-off behavior preserves the text/current guide fallback and stops new cover sends on the next operation.
- [ ] Request final whole-branch code/security/product review before expanding production rollout.
