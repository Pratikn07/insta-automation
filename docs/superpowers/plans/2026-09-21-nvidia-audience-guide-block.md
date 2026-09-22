# NVIDIA Audience Guide Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent any *new* guide-related Meta outbound action when a guide-specific NVIDIA name/username proxy returns `south_asian` at either confidence level, while allowing valid `unknown`, `other`, and `us_western` results to retain the existing guide experience.

**Architecture:** Add an NVIDIA-backed classifier behind a narrow, guide-specific authorization service. The service validates an immutable current identity snapshot, persists its safe verdict, and returns only `allow`, `block`, or `defer`. Every new guide entry point consumes that result before it can call a Meta send or create a new delivery plan; `block` and `defer` emit a durable internal audit record and are deliberately non-presentable.

**Tech Stack:** TypeScript/Node.js, Prisma/PostgreSQL, Axios, Zod, Vitest, Railway environment configuration, NVIDIA OpenAI-compatible chat-completions API.

**Spec:** [NVIDIA Audience Guide Block Design](../specs/2026-09-21-nvidia-audience-guide-block-design.md)

## Global Constraints

- `south_asian` is a policy proxy based only on supplied display name and username. Do not claim it is geography, ethnicity, nationality, religion, or a fact about a person.
- Both `south_asian/high` and `south_asian/low` block. Only a schema-valid, current `unknown`, `other`, or `us_western` result permits the old flow.
- NVIDIA timeout, absent key, malformed JSON, unexpected/duplicate/missing IDs, invalid enum, a changed identity snapshot, or persistence failure is `defer`, never allowed `unknown`.
- A `block` or `defer` must issue zero Meta public replies, private messages, quick replies, gate messages, recovery notices, redelivery sends, or new `GuideDelivery` plans. Record internal audit data only.
- Do not cancel, mutate, or reclassify a delivery that was already planned, claimed, or sent. The delivery worker stays out of scope.
- Keep Gemini historical-recovery provenance (`IgUser.inferredOrigin`, `originMethod`, `audienceSegment`) unchanged. This feature has its own tables, provider, method version, and cache key.
- Never log/persist raw NVIDIA response bodies, prompts, chain-of-thought, credentials, or raw inbound message text. Persist only bounded validated evidence and a SHA-256 identity hash. When the database itself is unavailable, fail closed and log a safe error category; no design can durably audit an unavailable database.
- `GUIDE_AUDIENCE_BLOCK_ENABLED` defaults to `false`; a disabled flag changes no existing outbound behavior and does not silently make a live provider call.
- NVIDIA Developer/free access is suitable for development/testing only. Do not activate live enforcement until the owner has a production-eligible serving arrangement and explicitly authorizes that release.

---

## Task 1: Add isolated persistence models and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260921030000_add_guide_audience_authorization/migration.sql`
- Create: `src/services/guideAudienceAuthorizationRepository.ts`
- Create: `src/services/guideAudienceAuthorizationRepository.test.ts`

- [ ] **Step 1: Write repository-contract tests before adding the schema.**

  In `src/services/guideAudienceAuthorizationRepository.test.ts`, mock the Prisma delegates and specify these operations:

  - `findCurrentClassification({ igUserId, identityHash, method })` reads only an exact current `(igUserId, identityHash, method)` match.
  - `createClassification(...)` persists validated origin/confidence/evidence/provider/model/method/input hash, never raw name, username, prompt, or provider body.
  - `createDecision(...)` persists only `block` and `defer`, with action source and optional safe internal identifiers; it never persists message text.
  - Simulate a changed hash and assert the old row is not returned.

  Use an in-memory `vi.fn()` Prisma shape rather than a real database, matching the repository test style already used in `src/services/guideAccessRepository.test.ts`.

- [ ] **Step 2: Run the focused test and confirm it is red because the module/schema does not exist.**

  Run: `npm test -- src/services/guideAudienceAuthorizationRepository.test.ts`

  Expected: module/import or expected-delegate failure, not an unrelated test failure.

- [ ] **Step 3: Define dedicated enums and models in `prisma/schema.prisma`.**

  Add these enums close to the existing guide-access enums:

  ```prisma
  enum GuideAudienceOrigin { south_asian us_western other unknown }
  enum GuideAudienceConfidence { high low }
  enum GuideAudienceDecisionKind { block defer }
  enum GuideAudienceActionSource { comment dm quick_reply postback redelivery }
  enum GuideAudienceDeferReason {
    identity_unavailable
    identity_changed
    provider_unavailable
    provider_timeout
    invalid_provider_response
    persistence_failed
  }
  ```

  Add `GuideAudienceClassification` with a UUID id; `igUserId`; `identityHash`; `origin`; `confidence`; `evidence` (bounded at the application boundary); `provider`; `modelId`; `method`; `classifiedAt`; `createdAt`; an `IgUser` relation; a unique constraint over `[igUserId, identityHash, method]`; and an index suitable for current-cache lookup.

  Add `GuideAudienceDecision` with a UUID id; `igUserId`; `identityHash`; `kind`; `source`; nullable safe reference strings (`conversationId`, `commentId`, `inboundMessageId`, `resourceId`); nullable `classificationId`; nullable `deferReason`; `provider`; `modelId`; `method`; `createdAt`; an `IgUser` relation; an optional classification relation; and indexes on `[igUserId, createdAt]` and `[kind, createdAt]`.

  Add the two reverse relations to `IgUser`. Do not add or repurpose fields on `IgUser` for guide policy.

- [ ] **Step 4: Write an explicit SQL migration.**

  Create `prisma/migrations/20260921030000_add_guide_audience_authorization/migration.sql` that creates the five enums, the two tables, FKs to `ig_users` and `guide_audience_classification`, the unique current-snapshot constraint, and the indexes above. Use `uuid` primary keys and `TIMESTAMPTZ(3)` for event timestamps consistently with guide-access tables. Use `ON DELETE RESTRICT` for the `IgUser` links and `ON DELETE SET NULL` for `classification_id` so audit history remains readable if a classification is removed by a future retention process.

- [ ] **Step 5: Implement the thin repository.**

  `guideAudienceAuthorizationRepository.ts` must expose typed input/output interfaces and translate only between Prisma rows and the authorization service. Its cache lookup must be exact on current hash + method; it must not use a latest-row query. Its create methods must use `select` clauses that do not pull raw data unnecessarily.

- [ ] **Step 6: Generate and validate.**

  Run:

  ```bash
  npx prisma generate
  npm test -- src/services/guideAudienceAuthorizationRepository.test.ts
  npx tsc --noEmit
  ```

  Expected: repository tests pass, Prisma exports compile, and no legacy `IgUser` origin field is modified.

- [ ] **Step 7: Commit this task.**

  ```bash
  git add prisma/schema.prisma prisma/migrations/20260921030000_add_guide_audience_authorization/migration.sql src/services/guideAudienceAuthorizationRepository.ts src/services/guideAudienceAuthorizationRepository.test.ts
  git commit -m "feat: persist guide audience authorization decisions"
  ```

## Task 2: Build the NVIDIA classifier boundary and safe configuration

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/flagRegistry.ts`
- Modify: `.env.example`
- Create: `src/services/nvidiaAudienceClassifier.ts`
- Create: `src/services/nvidiaAudienceClassifier.test.ts`
- Modify: `src/config/env.test.ts`
- Modify: `src/config/flagRegistry.test.ts`

- [ ] **Step 1: Add failing classifier tests.**

  In `nvidiaAudienceClassifier.test.ts`, inject a mocked Axios instance rather than using the network. Cover:

  1. a valid exact one-row response for every origin/confidence pair;
  2. a request body containing `model: "nvidia/nemotron-3.5-lightning-30b-a3b"`, `temperature: 0`, `chat_template_kwargs: { enable_thinking: false }`, JSON-only instruction, and bounded JSON roster;
  3. clean parsing of `choices[0].message.content` as `{ results: [...] }`;
  4. rejected malformed JSON, missing/unknown/duplicate IDs, incomplete rosters, invalid origin/confidence, blank or overlong evidence, and non-string content;
  5. `AbortSignal` timeout and unavailable-key errors mapped to typed safe errors; and
  6. roster sanitation of line breaks/control characters and 80-character maximum for each display name/username.

  Use synthetic names only. Assert that response/error objects are not passed to the logger or error message.

- [ ] **Step 2: Run the focused test to establish the red baseline.**

  Run: `npm test -- src/services/nvidiaAudienceClassifier.test.ts`

- [ ] **Step 3: Define server-only configuration and the stop-safe feature flag.**

  In `src/config/env.ts`, add:

  ```ts
  NVIDIA_API_KEY: z.string().min(1).optional(),
  NVIDIA_AUDIENCE_MODEL: z.string().default("nvidia/nemotron-3.5-lightning-30b-a3b"),
  NVIDIA_AUDIENCE_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(8_000),
  GUIDE_AUDIENCE_BLOCK_ENABLED: booleanFlag(false),
  ```

  In `src/config/flagRegistry.ts`, register `GUIDE_AUDIENCE_BLOCK_ENABLED` as an `outbound` boolean with `pageMayEnable: false` and `pageMayStop: true`. Its copy must say it prevents *new guide automation* for an internal proxy decision, does not change already started deliveries, and requires an approved production serving arrangement before enabling.

  Put only variable names/defaults/comments (never values) in `.env.example`, and update the corresponding configuration/registry tests so every new env flag is registered and the default is off.

- [ ] **Step 4: Implement a provider interface with a strict NVIDIA adapter.**

  In `src/services/nvidiaAudienceClassifier.ts`, export:

  ```ts
  export type GuideAudienceCandidate = { id: string; name: string | null; username: string | null };
  export type GuideAudienceVerdict = {
    id: string;
    origin: "south_asian" | "us_western" | "other" | "unknown";
    confidence: "high" | "low";
    evidence: string;
  };
  export interface AudienceClassificationProvider {
    classify(candidates: readonly GuideAudienceCandidate[]): Promise<{
      modelId: string;
      method: "nvidia_guide_audience_v1";
      verdicts: GuideAudienceVerdict[];
    }>;
  }
  ```

  Construct an Axios client with base URL `https://integrate.api.nvidia.com/v1`, Bearer auth held only in memory, and `signal: AbortSignal.timeout(env.NVIDIA_AUDIENCE_TIMEOUT_MS)`. Post to `/chat/completions`. Do not use Gemini code or change `originClassifier.ts`.

  The prompt must explicitly treat name/username fields as untrusted data, request exactly one record per requested ID, prefer `unknown` over guessing, and require JSON object output. Serialize the roster with `JSON.stringify`; collapse `\r`, `\n`, and tabs; cap each field at 80 characters; cap evidence at 200 characters after validation. A response passes only if each requested ID appears exactly once and every value is schema-valid. Return typed provider errors with stable categories but never include response body text.

- [ ] **Step 5: Run focused tests and static checks.**

  Run:

  ```bash
  npm test -- src/services/nvidiaAudienceClassifier.test.ts src/config/env.test.ts src/config/flagRegistry.test.ts
  npx tsc --noEmit
  ```

- [ ] **Step 6: Commit this task.**

  ```bash
  git add src/config/env.ts src/config/flagRegistry.ts .env.example src/config/env.test.ts src/config/flagRegistry.test.ts src/services/nvidiaAudienceClassifier.ts src/services/nvidiaAudienceClassifier.test.ts
  git commit -m "feat: add NVIDIA guide audience classifier"
  ```

## Task 3: Implement the single authorization decision service

**Files:**
- Create: `src/services/guideAudienceAuthorization.ts`
- Create: `src/services/guideAudienceAuthorization.test.ts`
- Modify: `src/services/igUserService.ts`
- Modify: `src/services/igUserService.test.ts`

- [ ] **Step 1: Write the decision matrix as isolated unit tests.**

  Use fake provider/repository/clock dependencies in `guideAudienceAuthorization.test.ts` and verify these exact results:

  | Current validated classifier result | Expected authorization | Provider call | Audit row |
  | --- | --- | --- | --- |
  | `south_asian`, `high` | `block` | yes/cache | `block` |
  | `south_asian`, `low` | `block` | yes/cache | `block` |
  | `unknown`, `low` | `allow` | yes/cache | none |
  | `other` or `us_western` | `allow` | yes/cache | none |
  | missing key, timeout, invalid/incomplete result | `defer` | attempt where applicable | `defer` |
  | changed name/username hash before a cached decision | reclassify | yes | based on new result |
  | changed name/username hash during the provider request | `defer` | no send | `defer` |
  | flag disabled | `allow` with `enforced: false` | no | none |

  Also assert source/reference metadata is safe, old-hash cached values are never used, classification persistence happens before an `allow`/`block` is returned, and a classification/decision write failure returns `defer` without leaking an error.

- [ ] **Step 2: Run the test and confirm the expected red failure.**

  Run: `npm test -- src/services/guideAudienceAuthorization.test.ts`

- [ ] **Step 3: Implement an explicit discriminated result.**

  Define and export exactly:

  ```ts
  export type GuideAudienceAuthorization =
    | { kind: "allow"; enforced: boolean; classification?: CurrentGuideAudienceClassification }
    | { kind: "block"; auditId: string; classification: CurrentGuideAudienceClassification }
    | { kind: "defer"; auditId: string; reason: GuideAudienceDeferReason };
  ```

  `authorizeNewGuideAction` receives the action source, `igUserId`, and optional safe IDs, then loads the persisted current `{ name, username }` itself. It creates a normalized `name + username` representation with explicit separators, hashes it with SHA-256, rejects an empty snapshot as `identity_unavailable`, resolves only the exact current repository cache entry, calls the NVIDIA provider when needed, reloads the current identity and verifies the hash is unchanged, persists the valid classification, and maps the result to the three-state union. A changed post-provider hash is `identity_changed` and must not be allowed or blocked from stale input.

  Use one method constant, `nvidia_guide_audience_v1`, in the service; do not import `CURRENT_ORIGIN_METHOD`. When logging operational failures, log only category, source, safe IDs, method/model, and audit id.

- [ ] **Step 4: Make identity changes naturally invalidate the new cache.**

  In `igUserService.ts`, leave all legacy-Gemini origin clearing behavior exactly as is. Expose/retain a single profile lookup that can return the latest persisted `{ id, name, username }` for the authorization service. Do not delete guide-audience rows on profile change: the changed hash makes them non-current and preserves audit history. Add a regression test that a username/name refresh still resets only legacy fields as it did before.

- [ ] **Step 5: Add a default service wired to Prisma and environment config.**

  The default export/invocation must use the repository from Task 1, NVIDIA adapter from Task 2, `isFlagEnabled("GUIDE_AUDIENCE_BLOCK_ENABLED")`, and current `IgUser` identity. Keep an injectable factory for all tests. No caller gets direct access to the provider parser.

- [ ] **Step 6: Run the focused service suite.**

  Run:

  ```bash
  npm test -- src/services/guideAudienceAuthorization.test.ts src/services/guideAudienceAuthorizationRepository.test.ts src/services/igUserService.test.ts
  npx tsc --noEmit
  ```

- [ ] **Step 7: Commit this task.**

  ```bash
  git add src/services/guideAudienceAuthorization.ts src/services/guideAudienceAuthorization.test.ts src/services/igUserService.ts src/services/igUserService.test.ts
  git commit -m "feat: centralize guide audience authorization"
  ```

## Task 4: Gate the comment journey before any public acknowledgement

**Files:**
- Modify: `src/handlers/commentHandler.ts`
- Modify: `src/handlers/commentHandler.test.ts`

- [ ] **Step 1: Add handler tests for the pre-send boundary.**

  Mock `authorizeNewGuideAction` in `commentHandler.test.ts`. Add parallel cases for `block`, `defer`, and valid `unknown` after keyword match and successful comment claim. For `block` and `defer`, assert all of the following are not called:

  - `resolveJourneyIntent`;
  - `replyToComment`;
  - `startCommentGuideRequest`;
  - every private gate/recovery scheduling helper; and
  - every direct Meta send mock.

  Assert claim/idempotency handling is preserved, the service receives source `comment` plus `igUserId`, `commentId`, `resourceId`, and any known current identity, and `unknown` reaches the same expected existing V1/V2 branch as before.

- [ ] **Step 2: Run the test to establish the red baseline.**

  Run: `npm test -- src/handlers/commentHandler.test.ts`

- [ ] **Step 3: Insert the gate in the only safe location.**

  In `commentHandler.ts`, keep username remembrance and comment claim intact, then authorize immediately after keyword match/claim and *before* `resolveJourneyIntent`, `replyToComment`, V1 private gate activity, `startCommentGuideRequest`, or recovery scheduling. For `block` and `defer`, return the handled/idempotent path silently. Do not add a user-facing copy string or log raw comment content.

  The authorization service reads the persisted comment username and any already-resolved display name. Do not add a Graph call solely to enrich a blocked comment; lack of a usable current identity must result in the service's `defer` path.

- [ ] **Step 4: Run targeted regression tests.**

  Run:

  ```bash
  npm test -- src/handlers/commentHandler.test.ts src/services/guideAudienceAuthorization.test.ts
  npx tsc --noEmit
  ```

- [ ] **Step 5: Commit this task.**

  ```bash
  git add src/handlers/commentHandler.ts src/handlers/commentHandler.test.ts
  git commit -m "feat: stop guide comments before public reply"
  ```

## Task 5: Gate direct messages, strict access, and redelivery before delivery creation

**Files:**
- Modify: `src/handlers/messageHandler.ts`
- Modify: `src/handlers/messageHandler.test.ts`
- Modify: `src/services/guideAccessActionService.ts`
- Modify: `src/services/guideAccessActionService.test.ts`
- Modify: `src/services/guideDeliveryService.ts`
- Modify: `src/services/guideDeliveryService.test.ts`

- [ ] **Step 1: Write failing direct-DM and action-service tests.**

  In `messageHandler.test.ts`, mock an authorization response for a new keyword DM and an explicit redelivery. For `block` and `defer`, assert no `sendSequence`, `startDirectDmGuideRequest`, `deliverOwnedGuide`, `replyToComment`, or guide-delivery start is called. Assert valid `unknown` has the unchanged expected delivery behavior.

  In `guideAccessActionService.test.ts`, inject `authorizeNewGuideAction` into the dependency factory and test both `requestGuideFromAction` and `checkFollowFromAction` for quick reply and postback contexts. On `block`/`defer`, assert no follow check, token-issued outbound action, text, follower gate, follow-lag message, or `startGuideDelivery` call occurs. Test a valid `unknown` can continue.

  In `guideDeliveryService.test.ts`, cover the final new-plan backstop: a `block`/`defer` result prevents creation/claim of a new delivery row and all sends; it does not query or modify an existing planned/claimed/sent row.

- [ ] **Step 2: Run the focused tests and confirm they fail first.**

  Run:

  ```bash
  npm test -- src/handlers/messageHandler.test.ts src/services/guideAccessActionService.test.ts src/services/guideDeliveryService.test.ts
  ```

- [ ] **Step 3: Thread authorization through the direct-DM owner.**

  In `messageHandler.ts`, preserve inbound persistence/duplicate handling and resolve the account identity before it can select legacy versus strict guide delivery. Call the shared service for `dm` or `redelivery`; silently stop on `block`/`defer`. Avoid a fallback to a generic reply, because that would violate the zero-outbound contract.

  Ensure existing non-guide message handling is untouched. The guard must cover both `deliverOwnedGuide` legacy sequences and the `startDirectDmGuideRequest` strict path.

- [ ] **Step 4: Make `guideAccessActionService` a non-bypassable strict-flow boundary.**

  Extend `GuideAccessActionDependencies` with an arrow-typed `authorizeNewGuideAction` dependency and call it after binding/validating the token's account but before fresh follow reads, attempt creation, recovery send, or `startGuideDelivery`. Add two internal outcomes:

  ```ts
  | "guide_audience_blocked"
  | "guide_audience_deferred"
  ```

  Return them without changing action tokens, receipt idempotency, or existing delivery state. Map an explicit repeat-guide intent to source `redelivery`; use `quick_reply` and `postback` for their actual transport source.

- [ ] **Step 5: Add the new-plan delivery backstop without touching existing worker rows.**

  In `guideDeliveryService.ts`, inject the shared authorizer into the *new trigger* entry point (`deliverGuideForTrigger`) before `createOrLoad`/claim/send. Resolve the conversation's `igUserId` and current profile data only for a new trigger. Return a typed non-delivery result for `block`/`defer` so an accidental future caller cannot send a guide. Do not add this check to `guideDeliveryWorker.ts` and do not cancel existing rows.

- [ ] **Step 6: Run focused and compile checks.**

  Run:

  ```bash
  npm test -- src/handlers/messageHandler.test.ts src/services/guideAccessActionService.test.ts src/services/guideDeliveryService.test.ts
  npx tsc --noEmit
  ```

- [ ] **Step 7: Commit this task.**

  ```bash
  git add src/handlers/messageHandler.ts src/handlers/messageHandler.test.ts src/services/guideAccessActionService.ts src/services/guideAccessActionService.test.ts src/services/guideDeliveryService.ts src/services/guideDeliveryService.test.ts
  git commit -m "feat: apply guide audience policy to DM delivery"
  ```

## Task 6: Suppress all action-token presentations for block and defer

**Files:**
- Modify: `src/handlers/guideActionRouter.ts`
- Modify: `src/handlers/guideActionRouter.test.ts`
- Modify: `src/services/guideActionOutcomeService.ts`
- Modify: `src/services/guideActionOutcomeService.test.ts`

- [ ] **Step 1: Add failing no-presentation tests.**

  In `guideActionRouter.test.ts`, make either action dependency return `guide_audience_blocked` and `guide_audience_deferred`. Assert `presentOutcome` is either not called or returns the dedicated no-op presentation; specifically assert no recovery metric is recorded and no send mock is reached.

  In `guideActionOutcomeService.test.ts`, assert both outcomes return `none_audience_policy` before `loadContext`, `createOrLoadAttempt`, `issueToken`, `sendRecoveryAction`, or `sendText`. Keep existing `duplicate_event`, invalid, expired, and review tests unchanged.

- [ ] **Step 2: Run the focused test baseline.**

  Run: `npm test -- src/handlers/guideActionRouter.test.ts src/services/guideActionOutcomeService.test.ts`

- [ ] **Step 3: Add explicit non-presentable vocabulary and control flow.**

  Extend `GuideAccessActionOutcome` with the two Task 5 outcomes and `GuideActionOutcomePresentation` with `none_audience_policy`. In `presentGuideActionOutcome`, return `none_audience_policy` before context load for either outcome. In `routeGuideAction`, retain received/duplicate telemetry but do not call presentation logic that can send and do not count `recovered` for either policy outcome.

- [ ] **Step 4: Run focused regression tests.**

  Run:

  ```bash
  npm test -- src/handlers/guideActionRouter.test.ts src/services/guideActionOutcomeService.test.ts src/services/guideAccessActionService.test.ts
  npx tsc --noEmit
  ```

- [ ] **Step 5: Commit this task.**

  ```bash
  git add src/handlers/guideActionRouter.ts src/handlers/guideActionRouter.test.ts src/services/guideActionOutcomeService.ts src/services/guideActionOutcomeService.test.ts
  git commit -m "feat: suppress guide action policy notices"
  ```

## Task 7: Add end-to-end policy regression coverage and operator documentation

**Files:**
- Create: `src/services/guideAudiencePolicy.integration.test.ts`
- Modify: `docs/guide-delivery-operations.md`

- [ ] **Step 1: Write an integration-style policy matrix test using all synthetic fixtures.**

  Compose real authorization service logic with mocked NVIDIA/Prisma/Meta boundaries. Exercise comment V1, comment strict V2, direct DM legacy, direct DM strict V2, quick reply, postback, and explicit redelivery. For each path prove:

  - `south_asian/high` and `south_asian/low`: zero Meta sends, no new `GuideDelivery`, one `block` audit record;
  - valid `unknown`: same expected successful send/plan behavior as that path before this change;
  - timeout/malformed/changed identity: zero sends/no delivery and one `defer` audit record;
  - an already-existing planned/claimed/sent delivery is untouched.

  Include generic handles, Indic-script fixtures, weak Latin-script fixtures, injection-shaped user strings, and an empty profile. All fixture values must be invented and must never call the NVIDIA endpoint.

- [ ] **Step 2: Run the new integration test until it passes.**

  Run: `npm test -- src/services/guideAudiencePolicy.integration.test.ts`

- [ ] **Step 3: Document production controls without exposing a value.**

  Document these exact Railway `api` service variables: `NVIDIA_API_KEY`, `NVIDIA_AUDIENCE_MODEL`, `NVIDIA_AUDIENCE_TIMEOUT_MS`, and `GUIDE_AUDIENCE_BLOCK_ENABLED`. State that the key is server-only, must never be placed in source/control-plane logs, and that `GUIDE_AUDIENCE_BLOCK_ENABLED=false` is the deployment default.

  State the hard activation gate: NVIDIA Developer/free key may be used only for development/test validation; before `true`, secure a production-eligible NVIDIA arrangement and obtain explicit owner authorization. Document the audit location/table names and the intended query fields, without exposing data values.

- [ ] **Step 4: Run the full local verification suite.**

  Run:

  ```bash
  npx prisma generate
  npm test
  npm run build
  git diff --check
  ```

  Expected: all tests/build pass; the diff contains no API key; no legacy Gemini origin field/schema/method has been changed; and the plan/implementation contains no unimplemented `TODO` in the authorization path.

- [ ] **Step 5: Commit this task.**

  ```bash
  git add src/services/guideAudiencePolicy.integration.test.ts docs/guide-delivery-operations.md
  git commit -m "test: cover guide audience outbound policy"
  ```

## Task 8: Perform a disabled production release and define the activation evidence

**Files:**
- No source changes expected; release only the commits from Tasks 1–7.

- [ ] **Step 1: Reconcile the branch before release.**

  Inspect `git status --short`, `git log --oneline origin/main..HEAD`, and the final diff. Preserve unrelated user changes. Do not deploy an uncommitted tree.

- [ ] **Step 2: Verify the production migration plan without applying it blindly.**

  Run `supabase db push --linked --dry-run` (or the repository's documented production migration preflight) and inspect the generated SQL against `20260921030000_add_guide_audience_authorization`. Confirm the migration identity has not already been applied under another name before proceeding.

- [ ] **Step 3: Deploy code + schema with enforcement explicitly off.**

  Ensure the Railway production `api` service has `NVIDIA_API_KEY` configured securely, `GUIDE_AUDIENCE_BLOCK_ENABLED=false`, and the intended timeout/model values. Apply the migration, deploy the exact approved SHA, wait for deployment success, then verify API health, runtime SHA/log startup evidence, and effective non-secret variable names/values. This state is deployed but not enforcing and must be reported as such.

- [ ] **Step 4: Verify no live user is classified or blocked while disabled.**

  Send no real customer test traffic. Use only unit/integration fixtures or a sanctioned non-production test account. Confirm logs contain no secret/raw response data and no new guide-audience decision row was created by a disabled live path.

- [ ] **Step 5: Collect the required activation evidence; do not enable the flag yet.**

  Before any `true` setting, require all of:

  1. owner-provided production-eligible NVIDIA serving/license confirmation;
  2. explicit production-release authorization from the owner;
  3. fixture/shadow decision-matrix evidence signed off by the owner;
  4. a fresh audit query showing expected safe fields; and
  5. a controlled test account plan that proves a policy block produces no public reply, DM, or `GuideDelivery` row.

  Only after those inputs can a separate, explicitly authorized release turn enable the flag and report fresh end-to-end evidence. Do not call the disabled deployment "live enforcement."
