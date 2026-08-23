# TinySoho Guide Covers and Follower Gate Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the approved TinySoho cover and strict follower-gate feature in dependency order, with clear stops before controlled Meta contact or production parent contact.

**Architecture:** Five independently verifiable implementation plans form one release train. Meta capability evidence determines only rich presentation; deterministic cover authoring can advance without it. Strict authorization ships behind its own outbound fence. Ordinary image-cover delivery joins the existing durable ledger only after authoring, follow authorization, and controlled-account journeys pass.

**Tech Stack:** TypeScript, Node.js 22, Meta Instagram Graph API, Prisma/PostgreSQL/Supabase, React 19, Gemini, Resvg, Vitest, Testing Library, Playwright.

**Spec:** [TinySoho reusable guide covers and follower gate design](../specs/2026-08-22-tinysoho-guide-covers-and-follower-gate-design.md).

## Global Constraints

- The approved spec is authoritative. A plan may add implementation detail but may not relax fresh-true authorization, creator approval, idempotency, deterministic rendering, or fallback behavior.
- No controlled Meta send occurs without explicit owner authorization and a controlled test account.
- No production parent-facing flag is enabled merely because code/tests pass.
- Each plan lands in small commits and completes its own verification gate before its dependent plan enables behavior.
- Schema migrations are additive and are never rolled back to stop behavior; feature flags are the rollback mechanism.
- Preserve the current text path and existing durable guide-delivery owner throughout controlled rollout.

## Plan Set and Dependencies

| Order | Plan | Depends on | Produces | Parent contact |
| ---: | --- | --- | --- | --- |
| 1 | [Meta rich guide gate capability spike](2026-08-22-meta-rich-guide-gate-capability-spike.md) | Approved spec | Proven payload/webhook/crop capability matrix | Controlled account only, after explicit authorization |
| 2 | [Guide cover rendering and publishing](2026-08-22-guide-cover-rendering-and-publishing.md) | Approved visual directions | Shared renderer, schema, Storage publication, authenticated APIs | None |
| 3 | [Guide cover creator console](2026-08-22-guide-cover-creator-console.md) | Rendering/publishing APIs | Category picker, exact editor, AI suggestions, reviewed backfill | None |
| 4 | [Strict follower gate V2](2026-08-22-strict-follower-gate-v2.md) | Capability payload builder; existing durable delivery | Fresh-only verifier, attempts/tokens, unified actions, strict routing | Flagged off; controlled journeys only after authorization |
| 5 | [Guide cover parent delivery and rollout](2026-08-22-guide-cover-parent-delivery-rollout.md) | Published covers, creator approval, strict gate, durable ledger | One-cover exposure, delivery integration, metrics, phased rollout | Controlled then explicitly approved cohort |

The capability harness/payload tests and deterministic cover foundation may be developed independently. Live capability execution is a human-authorized gate; an unavailable/unsupported rich result does not block ordinary text plus image-cover delivery.

---

### Task 1: Establish provider facts without changing production behavior

- [ ] Execute Tasks 1–4 of the capability plan and keep all rich/outbound flags false.
- [ ] Review the harness privacy/safety boundary and obtain explicit authorization before Task 5.
- [ ] Complete the controlled matrix, or mark unrun rows `not_verified`; do not infer support.
- [ ] Freeze one reviewed capability result used by later flag decisions.

**Exit gate:** Text fallback is proven, every rich case has an explicit decision, and no production parent was contacted.

### Task 2: Build and approve the hidden cover foundation

- [ ] Execute the rendering/publishing plan through schema, renderer, Storage, publication, APIs, cleanup, and the assistive flag.
- [ ] Verify the four original-resolution PNG snapshots against the approved visual directions.
- [ ] Keep authoring off until database/security/font/determinism checks pass.
- [ ] Enable authoring for the owner only after the foundation review.

**Exit gate:** Four deterministic approved snapshots pass, server-owned tables/storage are secure, and publication replay/concurrency is proven.

### Task 3: Give the creator a complete review workflow

- [ ] Execute the creator-console plan through exact preview, category management, explicit draft/publish, bounded AI suggestions, and backfill review.
- [ ] Publish one owner-approved representative guide in each category.
- [ ] Compare browser preview with stored PNG and retain redacted QA artifacts.
- [ ] Leave unreviewed guides unassigned/unpublished and unavailable for cover delivery.

**Exit gate:** The creator can complete the workflow without design-system fields, AI is optional/non-authoritative, and four representative covers are approved.

### Task 4: Prove strict authorization before adding cover delivery

- [ ] Execute the strict follower-gate plan with both outbound flags false.
- [ ] Run automated cached-state/fresh-state/replay/unknown/redelivery matrices.
- [ ] After authorization, run controlled follower, non-follower, unknown, follow-lag, quick-reply/postback, and desktop fallback journeys.
- [ ] Do not enable rich mode for any capability row not marked `supported`.

**Exit gate:** Every automated delivery/redelivery call site requires current live true, unknown fails neutral/closed, and duplicate actions start at most one delivery.

### Task 5: Add one-cover delivery and expand cautiously

- [ ] Execute the parent-delivery plan through ledger integration, exposure reconciliation, flags, metrics, and owner review UI.
- [ ] Start with ordinary image-cover delivery; keep generic templates independently off.
- [ ] Audit an allowlisted controlled guide/account before any production cohort.
- [ ] Obtain explicit owner authorization for each production phase and record dated cohort/threshold decisions.
- [ ] Stop expansion and use flag rollback when any release threshold fails.

**Exit gate:** One immutable cover and one guide are delivered without duplication, metrics reconcile to the real inbox, and the owner has approved expansion.

## Cross-Plan Final Verification

- [ ] Run clean backend/frontend installs, complete tests/builds, disposable-PostgreSQL contracts, Playwright, visual hashes, bypass scans, and bundle secret scans.
- [ ] Verify no current or historical cached follower state can authorize a new guide or redelivery.
- [ ] Verify no draft/unapproved cover can appear in Storage or a parent delivery plan.
- [ ] Verify unsupported rich controls fall back to text and never trap a parent.
- [ ] Verify flag-off behavior stops the next outbound operation without deleting evidence or reversing migrations.
- [ ] Request final whole-release code, security, data, design, and product review before broad production rollout.
