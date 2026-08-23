# Meta Rich Guide Gate Capability Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove exactly which Instagram private-reply, quick-reply, generic-template, profile-link, image, and postback combinations TinySoho's current production login supports before any rich parent flow is enabled.

**Architecture:** A pure payload builder defines the finite test matrix. A deliberately armed, one-case-at-a-time CLI sends only to an owner-controlled test account and emits a sanitized result. The ordinary webhook receiver records the resulting quick-reply/postback shapes in tests, while the final human run captures redacted screenshots and produces one explicit support decision per capability.

**Tech Stack:** TypeScript, Node.js 22, Axios, Meta Instagram Graph API v21.0, Vitest, Markdown evidence records.

**Spec:** [TinySoho reusable guide covers and follower gate design](../specs/2026-08-22-tinysoho-guide-covers-and-follower-gate-design.md), especially Phase 0 and Live Meta verification.

## Global Constraints

- Ordinary automated tests make zero Meta calls.
- A live case requires a controlled recipient, a fresh controlled comment where applicable, an explicit `--confirm-controlled-send` argument, and owner authorization for that test window.
- Run one case at a time. Do not add an `--all` mode.
- Never print or persist access tokens, request URLs, raw Axios errors, message copy, account IDs, usernames, comment IDs, provider trace IDs, or unredacted response bodies.
- Never use a production parent's comment or inbox as a test target.
- The text-only private reply remains the fallback regardless of rich-case results.
- An unsupported initial-rich case is recorded once and not retried against the same comment; Meta permits at most one private reply per comment.
- No rich parent-facing flag may be enabled by this plan.

---

### Task 1: Define the bounded payload matrix

**Files:**

- Create: `src/meta/guideGatePayloads.ts`
- Create: `src/meta/guideGatePayloads.test.ts`

**Interfaces:**

- Export `GuideGateCapabilityCase` as `private_text | private_quick_reply | private_generic | dm_quick_reply | dm_generic_gate`.
- Export `buildGuideGateCapabilityPayload(input)` returning only the JSON body for `POST /{ig-user-id}/messages`.
- Keep the approved button labels as constants: `Yes, send it`, `Visit profile`, and `I'm following ✓`.
- Accept only validated recipient/comment IDs, an HTTPS profile URL, an HTTPS controlled cover URL, and an opaque UUID action token.

- [ ] Write failing unit tests for the exact request shape of all five cases, button-title limits, HTTPS-only links, and UUID-only action tokens.
- [ ] Add injection tests proving guide names and URLs are data, not keys or arbitrary template fragments.
- [ ] Run `npm test -- src/meta/guideGatePayloads.test.ts` and confirm failure because the module does not exist.
- [ ] Implement the smallest pure builder using discriminated Zod input schemas and no Graph/client imports.
- [ ] Confirm `private_text` and initial rich cases address `{ recipient: { comment_id } }`, while post-response cases address `{ recipient: { id } }`.
- [ ] Rerun the focused test and `npm run build`; both must pass.
- [ ] Commit with `test: define Meta guide gate capability payloads`.

### Task 2: Add a fail-closed controlled-send harness

**Files:**

- Create: `src/meta/guideGateCapabilitySpike.ts`
- Create: `src/meta/guideGateCapabilitySpike.test.ts`
- Create: `scripts/meta-guide-gate-capability-spike.ts`
- Modify: `package.json`

**Interfaces:**

- Export `runGuideGateCapabilityCase(dependencies, input): Promise<SanitizedCapabilityResult>`.
- `SanitizedCapabilityResult` contains only case name, Graph version, HTTP acceptance, numeric HTTP/Graph code and subcode, whether a provider message ID was present, and an ISO timestamp.
- CLI command: `npm run verify:meta-guide-gate -- --case <case> --confirm-controlled-send`.
- Read controlled IDs/URLs from `META_SPIKE_*` environment variables that are not part of normal application boot configuration.

- [ ] Write failing tests proving missing confirmation, missing controlled inputs, an unknown case, non-HTTPS URLs, and a non-UUID token stop before the injected Graph sender is called.
- [ ] Add success/error tests proving the harness sanitizes accepted and rejected responses and never serializes the raw error or payload.
- [ ] Run `npm test -- src/meta/guideGateCapabilitySpike.test.ts` and confirm the expected missing-module failure.
- [ ] Implement the injectable runner over the existing `graph` client; use `describeGraphError` for the allowlisted numeric failure shape.
- [ ] Implement the CLI with one mandatory `--case`, one mandatory confirmation switch, no batch mode, and a single JSON result on stdout.
- [ ] Add `verify:meta-guide-gate` to `package.json`; do not add spike environment variables to `envSchema`, because normal application boot must not depend on test credentials.
- [ ] Rerun the focused tests, complete backend tests, and build.
- [ ] Inspect stdout fixtures and prove no request body, token, ID, URL, username, or message text is present.
- [ ] Commit with `feat: add controlled Meta capability harness`.

### Task 3: Prove webhook shapes without changing product routing

**Files:**

- Modify: `src/types/meta.ts`
- Modify: `src/handlers/webhookRouter.test.ts`
- Modify: `src/handlers/messageHandler.test.ts`
- Modify: `src/handlers/postbackHandler.test.ts`
- Create: `src/test/fixtures/metaGuideGateEvents.ts`

**Interfaces:**

- Fixtures produce redacted `MessagingEntry` values for a quick reply, postback, duplicate postback, and unknown payload.
- Existing quick replies continue through `handleMessage`; existing postbacks continue through `handlePostback` and recovery-evidence recording.
- This task does not add guide-action routing; that belongs to the strict follower-gate plan after capability decisions exist.

- [ ] Add failing type/test fixtures for exact provider fields: sender, recipient, timestamp, `message.mid`, `message.quick_reply.payload`, and `postback.mid/title/payload`.
- [ ] Run the three focused suites and confirm any current shape/dispatch gaps.
- [ ] Make only additive typing and fixture changes needed to represent the observed documented shapes.
- [ ] Prove duplicate postback delivery still records idempotent recovery evidence and unknown payloads remain acknowledged.
- [ ] Rerun focused suites and `npm run build`.
- [ ] Commit with `test: cover guide action webhook shapes`.

### Task 4: Add the operator evidence template and decision gate

**Files:**

- Create: `docs/meta-guide-gate-capability-runbook.md`
- Create: `docs/meta-verification/guide-gate-capability-results.template.json`
- Modify: `docs/meta-verification.md`

**Interfaces:**

- The template records Graph version, login type, permissions, case name, sanitized result, webhook type, mobile result, desktop result, crop/safe-area result, follow-lag observations, reviewer, and decision.
- Decision is one of `supported`, `unsupported`, or `not_verified`; only `supported` can later enable a corresponding code path.

- [ ] Write the runbook's prerequisites, one-case execution sequence, screenshot-redaction rules, comment freshness rules, and cleanup steps.
- [ ] Add an explicit checklist for mobile Instagram, desktop Instagram, profile-return behavior, duplicate action delivery, and follow flag immediately/after delay.
- [ ] Add a hard release rule: no result file or `not_verified` result means the relevant rich path remains off.
- [ ] Link the new runbook from `docs/meta-verification.md` without changing its existing recovery guidance.
- [ ] Validate the template JSON with `node -e "JSON.parse(require('fs').readFileSync('docs/meta-verification/guide-gate-capability-results.template.json','utf8'))"`.
- [ ] Run the repository secret scan or, if none exists, `rg -n '(access_token|IG_ACCESS_TOKEN|META_APP_SECRET|recipient.*[0-9]{8})' docs/meta-* docs/meta-verification` and inspect every match.
- [ ] Commit with `docs: add Meta rich guide gate verification runbook`.

### Task 5: Execute the controlled matrix only after explicit authorization

**Files:**

- Create after the run: `docs/meta-verification/2026-08-22-guide-gate-capability-results.json`
- Create after redaction: `docs/qa/artifacts/2026-08-22-meta-guide-gate/README.md`
- Add only sanitized/redacted screenshots under: `docs/qa/artifacts/2026-08-22-meta-guide-gate/`

- [ ] Stop and obtain explicit owner authorization, controlled recipient identity, fresh controlled comment IDs, and an approved test window.
- [ ] Run `private_text` once and confirm the baseline result.
- [ ] Run each initial private-reply rich case against a different fresh controlled comment; never reuse a comment after a private reply attempt.
- [ ] Have the controlled recipient respond, then run post-response quick-reply and generic-gate cases.
- [ ] Capture the webhook event type and sanitized shape, then replay the controlled action once to observe provider duplicate behavior without triggering product delivery.
- [ ] Capture redacted mobile/desktop screenshots and generic image crop/safe-area observations.
- [ ] Follow from the controlled account, check the flag immediately and at recorded later intervals, and record only Boolean/latency observations.
- [ ] Mark every matrix row `supported`, `unsupported`, or `not_verified`; no inference from documentation alone.
- [ ] Keep `GUIDE_RICH_GATE_ENABLED=false`; this plan supplies evidence, not rollout authority.
- [ ] Commit only sanitized evidence with `docs: record Meta guide gate capability results`.

## Final Verification

- [ ] Run `npm test -- src/meta/guideGatePayloads.test.ts src/meta/guideGateCapabilitySpike.test.ts src/handlers/webhookRouter.test.ts src/handlers/messageHandler.test.ts src/handlers/postbackHandler.test.ts`.
- [ ] Run `npm test` and `npm run build`.
- [ ] Confirm no test made a network call and no ordinary startup path reads `META_SPIKE_*`.
- [ ] Confirm result decisions are explicit and every unsupported/not-verified capability maps to the text fallback.
- [ ] Request whole-plan/code review before using any result to change a parent-facing flag.
