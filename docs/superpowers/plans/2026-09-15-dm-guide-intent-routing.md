# DM Guide Intent Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ordinary DM sentences, blank messages, stickers, and unrelated open-request replies from starting or advancing guide delivery while keeping clear keyword requests and confirmations working.

**Architecture:** Add pure deterministic classifiers for keyword requests and open-request confirmations. Resolve every DM keyword candidate in token order, evaluate the policy for every eligible DM, and enforce it behind one runtime flag plus an exact sender allowlist. Preserve the existing strict V2 follower check, delivery ledger, structured guide actions, comment matching, and owner-review path.

**Tech Stack:** TypeScript, Node.js 22, Prisma, PostgreSQL/Supabase, Vitest, Railway, Vercel.

**Spec:** `docs/superpowers/specs/2026-09-14-dm-guide-intent-routing-design.md`

## Global Constraints

- Comment matching does not change.
- The classifier is deterministic and uses no LLM, embeddings, sentiment, or fuzzy matching.
- A rejected DM sends nothing, leaves an open guide request unchanged, keeps the thread unresolved, and may queue only an owner-review draft.
- Structured guide quick replies and postbacks continue through `guideActionRouter`.
- Strict V2 fresh-follow checks and the delivery ledger remain the only authorization and sending path after intent is accepted.
- New telemetry contains classifications, counts, positions, and actions only; never raw DM text, usernames, keyword values, webhook bodies, or access tokens.
- `GUIDE_DM_INTENT_GUARD_ENABLED` defaults to `false`; `GUIDE_DM_INTENT_GUARD_IG_USER_IDS` defaults to an empty string.
- No Prisma migration is required.
- Production completion requires merge and push to `main`, an applicable Railway deployment and flag update, an applicable Vercel deployment only if web assets change, and fresh production verification.

---

### Task 1: Pure DM intent policy

**Files:**
- Create: `src/services/dmGuideIntent.ts`
- Create: `src/services/dmGuideIntent.test.ts`

**Interfaces:**
- Consumes: normalized meaningful tokens and ordered `ResolvedDmKeyword<T>` candidates.
- Produces: `classifyDmKeywordIntent(tokens, matches)` and `classifyOpenRequestReply(text, messageType)`.

- [ ] **Step 1: Write failing decision-table tests**

Cover literal expected outcomes for:

```ts
expect(classifyDmKeywordIntent(["WAFFLE"], [waffle])).toMatchObject({
  kind: "accepted_short",
  selected: waffle,
});
expect(classifyDmKeywordIntent(
  ["THANK", "YOU", "IM", "WORKING", "ON", "A", "FRENCH", "ACTIVITY", "BOOK"],
  [activity],
)).toMatchObject({ kind: "rejected_conversational" });
expect(classifyDmKeywordIntent(
  ["PLEASE", "SEND", "ME", "THE", "WAFFLE", "RECIPE"],
  [waffle],
)).toMatchObject({ kind: "accepted_explicit" });
expect(classifyDmKeywordIntent(["DONT", "SEND", "WAFFLE"], [waffle])).toMatchObject({
  kind: "rejected_negative",
});
expect(classifyOpenRequestReply("Yes, please!", "text")).toMatchObject({
  kind: "accepted_confirmation",
});
expect(classifyOpenRequestReply("Thank you, this list is gold", "text")).toMatchObject({
  kind: "rejected_reply",
});
expect(classifyOpenRequestReply("", "image")).toMatchObject({
  kind: "rejected_reply",
  reason: "non_text",
});
```

Include every approved request signal, negative phrase, and confirmation phrase; punctuation, emoji, apostrophes, Unicode letters, mentions, first-keyword selection, and multiple-candidate counts.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npx vitest run src/services/dmGuideIntent.test.ts
```

Expected: failure because `dmGuideIntent.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure classifiers**

Use discriminated unions and these exported shapes:

```ts
export type ResolvedDmKeyword<T> = {
  keyword: T;
  matchedToken: string;
  tokenPosition: number;
  inferredFromPost: string | null;
};

export function classifyDmKeywordIntent<T>(
  meaningfulTokens: readonly string[],
  matches: readonly ResolvedDmKeyword<T>[],
): DmKeywordIntent<T>;

export function classifyOpenRequestReply(
  text: string,
  messageType: DmMessageType,
): OpenRequestReplyIntent;
```

Negative intent takes precedence. One-to-three meaningful tokens are accepted. Longer messages require a configured request signal. Confirmation matching is exact after punctuation/apostrophe normalization.

- [ ] **Step 4: Run the classifier tests and verify GREEN**

Run the Task 1 test command and require zero failures.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/services/dmGuideIntent.ts src/services/dmGuideIntent.test.ts
git commit -m "feat: classify DM guide intent"
```

### Task 2: Deterministic ordered DM keyword resolution

**Files:**
- Modify: `src/services/keywordMatchCore.ts`
- Modify: `src/services/keywordMatchCore.test.ts`
- Modify: `src/services/keywordService.ts`
- Create: `src/services/keywordService.test.ts`

**Interfaces:**
- Consumes: `extractCandidates(text)` token order and all active global/scoped rows matching those tokens.
- Produces: `resolveDmKeywordCandidates(tokens, rows)` and `findDmKeywordCandidates(text)` returning `{ meaningfulTokens, matches }`.

- [ ] **Step 1: Write failing pure resolver tests**

Prove that `WAFFLE` wins in `WAFFLE RECIPE` regardless of database row order, global rows beat post-scoped rows for the same token, post fallback chooses newest post with stable ID tie-breaking, and distinct token matches are preserved in token order.

- [ ] **Step 2: Run `keywordMatchCore.test.ts` and verify RED**

Expected: failure because `resolveDmKeywordCandidates` is missing.

- [ ] **Step 3: Implement the ordered pure resolver and verify GREEN**

Return one resolved row per unique keyword token, ordered by the token position. Prefer a stable global row; otherwise use `rankDmCandidates` for that token.

- [ ] **Step 4: Write a failing keyword-service query contract**

Mock only Prisma. Assert one `findMany` loads active matching rows with resource messages and that the service delegates selection to token order rather than Prisma row order.

- [ ] **Step 5: Replace the unordered `findFirst` DM lookup**

Implement:

```ts
export async function findDmKeywordCandidates(text: string): Promise<{
  meaningfulTokens: string[];
  matches: Array<ResolvedDmKeyword<KeywordWithSequence>>;
}>;
```

Do not change `findKeywordForComment`, `scannableCommentTokens`, or comment tests.

- [ ] **Step 6: Run keyword tests and commit Task 2**

```bash
npx vitest run src/services/keywordMatchCore.test.ts src/services/keywordService.test.ts src/handlers/commentHandler.test.ts
git add src/services/keywordMatchCore.ts src/services/keywordMatchCore.test.ts src/services/keywordService.ts src/services/keywordService.test.ts
git commit -m "fix: resolve DM keywords in message order"
```

### Task 3: Runtime rollout configuration

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `src/config/flagRegistry.ts`
- Modify: `src/config/flagRegistry.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces environment values `GUIDE_DM_INTENT_GUARD_ENABLED: boolean` and `GUIDE_DM_INTENT_GUARD_IG_USER_IDS: string`.
- Uses `parseIdentifierSet` for the exact controlled-recipient allowlist.

- [ ] **Step 1: Write failing configuration and registry tests**

Assert disabled/empty defaults, strict boolean parsing, exact allowlist parsing, and an outbound flag definition that the console cannot enable but can stop.

- [ ] **Step 2: Run the config tests and verify RED**

```bash
npx vitest run src/config/env.test.ts src/config/flagRegistry.test.ts src/services/flagService.test.ts
```

- [ ] **Step 3: Add the schema, operator contract, and examples**

The registry text must say that on permits only clear DM requests/confirmations, off retains legacy routing plus shadow evaluation, and the change affects new inbound decisions only.

- [ ] **Step 4: Run the config tests and commit Task 3**

```bash
git add src/config/env.ts src/config/env.test.ts src/config/flagRegistry.ts src/config/flagRegistry.test.ts .env.example
git commit -m "feat: add DM intent guard rollout controls"
```

### Task 4: Enforce intent in the DM handler

**Files:**
- Modify: `src/handlers/messageHandler.ts`
- Modify: `src/handlers/messageHandler.test.ts`

**Interfaces:**
- Consumes: Task 1 classifiers, Task 2 candidate lookup, Task 3 runtime flag and sender allowlist.
- Produces: accepted requests entering existing guide journeys and rejected messages reaching existing owner review without a send or thread resolution.

- [ ] **Step 1: Write failing handler regression tests**

The primary production regression fixture is:

```ts
"Thank you! This list is gold. I'm actually working on a French activity book for kids to help parents raising bilingual kids. Love your page!"
```

With an `ACTIVITY` candidate and an open `PODCAST` request, assert no journey, strict access action, follow gate, guide delivery, completion, or thread resolution; assert the Podcast request is unchanged and the message reaches owner review.

Also prove:

- `WAFFLE`, `waffle please`, and `Please send me the WAFFLE recipe` start the Waffle journey;
- clear new-guide requests still take priority over older open requests;
- every exact confirmation advances an open request;
- `Thanks`, unrelated long text, affirmative words inside longer sentences, blank text, images, and stickers do not advance it;
- exact expired `DONE` recovery remains;
- structured guide actions remain routed before free-text intent;
- both first-time and repeat conversational keyword mentions are rejected;
- shadow mode records the guarded decision while retaining legacy behaviour;
- classifier failure fails closed only when enforcement is active; and
- the new telemetry contains counts/decisions but not raw text, username, or keyword values.

- [ ] **Step 2: Run `messageHandler.test.ts` and verify RED**

Expected: the production screenshot fixture starts Activity and/or advances Podcast under current code.

- [ ] **Step 3: Implement classification and enforcement**

Evaluate intent after existing early exits and durable inbound capture. Load the current open request for routing/metrics. Enforce when the global flag is on or the sender is allowlisted. Accepted keyword intent keeps current keyword-first priority; rejected keyword intent cannot count as open-request confirmation. Rejected messages fall through to the unhandled/owner-draft branch with `hadOpenConversation` accurately recorded.

Emit one aggregate-safe `dm_guide_intent_evaluated` event containing enforcement state, classification, token/candidate counts, selected position, open-request presence, legacy action, and guarded action.

- [ ] **Step 4: Run handler, strict-access, delivery, and comment regression suites**

```bash
npx vitest run \
  src/handlers/messageHandler.test.ts \
  src/handlers/guideActionRouter.test.ts \
  src/handlers/commentHandler.test.ts \
  src/services/guideAccessActionService.test.ts \
  src/services/guideDeliveryService.test.ts
```

- [ ] **Step 5: Commit Task 4**

```bash
git add src/handlers/messageHandler.ts src/handlers/messageHandler.test.ts
git commit -m "fix: require clear DM guide intent"
```

### Task 5: Operations documentation and complete verification

**Files:**
- Create: `docs/guide-delivery-operations.md` if absent, otherwise modify it.
- Modify: `docs/superpowers/specs/2026-09-14-dm-guide-intent-routing-design.md`

**Interfaces:**
- Produces rollout, rollback, privacy-safe metric queries, and production evidence requirements.

- [ ] **Step 1: Add executable operations guidance**

Document classification counts, legacy-versus-guarded differences, delivery/follow-gate correlation, failure counts, safe enablement, rollback, and post-deploy SHA/flag/log/database/provider verification. Mark the design implementation status accurately.

- [ ] **Step 2: Run focused tests, full backend tests, build, and web checks**

```bash
NODE_ENV=test WORKERS_ENABLED=false \
META_APP_SECRET=mock_secret META_VERIFY_TOKEN=mock_verify IG_USER_ID=12345 \
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
SUPABASE_URL=https://mock.supabase.co SUPABASE_SERVICE_KEY=mock_service_key \
npm test
npm run build
npm --prefix web ci
npm --prefix web test -- --run
npm --prefix web run build
```

Contract suites that require `MIGRATION_TEST_DATABASE_URL` must either run against the established disposable local database or be reported as skipped; no production database may be substituted.

- [ ] **Step 3: Self-review the diff and commit Task 5**

Confirm every spec acceptance criterion maps to a test or explicit production check, scan telemetry for private content, and inspect `git diff origin/main...HEAD`.

```bash
git add docs/guide-delivery-operations.md docs/superpowers/specs/2026-09-14-dm-guide-intent-routing-design.md
git commit -m "docs: add DM intent guard operations runbook"
```

### Task 6: Merge, deploy, enable, and verify production

**Files:**
- No source files beyond Tasks 1–5.

**Interfaces:**
- Consumes: green release commit.
- Produces: pushed `main`, Railway deployment, effective production flag, and evidence-backed production status.

- [ ] **Step 1: Re-fetch `origin/main`, resolve any divergence, and rerun release tests**

Never force-push. If `origin/main` moved, merge it into the feature branch, inspect conflicts, and rerun affected plus full tests.

- [ ] **Step 2: Merge the feature branch into the clean local `main` worktree**

The user has explicitly selected local merge and production release. Fast-forward local `main` to current `origin/main`, merge `codex/dm-intent-guard`, rerun the full backend suite and production build on the merged tree, then push `main`.

- [ ] **Step 3: Deploy applicable services from the exact pushed SHA**

Railway is required because backend routing and variables changed. Deploy from a pristine checkout of the pushed SHA, never from a dirty working directory. Update `GUIDE_DM_INTENT_GUARD_ENABLED=true` after the deploy is healthy. No database migration is expected. Deploy Vercel only if the final diff contains web assets; otherwise record that it was not applicable.

- [ ] **Step 4: Verify production**

Verify:

- GitHub `main` equals the release SHA;
- Railway reports that same source SHA and a successful build/start;
- the effective DM intent guard is true with no overriding false row;
- boot logs contain no environment, migration, handler, or provider errors;
- the health endpoint is successful;
- a bounded read-only production query confirms new `dm_guide_intent_evaluated` rows contain only safe fields;
- the production screenshot sentence classifies as `rejected_conversational` through the shipped pure classifier/test fixture; and
- fresh production records show rejected conversational/open-request messages create no guide access attempt, follow gate, or delivery when such traffic arrives.

If no approved internal Instagram test account is available, do not send a synthetic customer DM. Report the provider-level controlled test as pending while keeping the code/flag/deployment evidence explicit.

- [ ] **Step 5: Report the complete release**

Report commit SHA, merge/push evidence, Railway deployment ID and status, Vercel applicability/deployment ID, effective flag state, test/build totals, production log/database verification, and any remaining provider test that cannot safely be performed.
