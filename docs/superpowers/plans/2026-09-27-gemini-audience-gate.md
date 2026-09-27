# Gemini South Asian Outbound Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task with TDD discipline and verification.

**Spec:** `docs/superpowers/specs/2026-09-27-gemini-south-asian-outbound-gate-design.md`
**Branch:** `feat/gemini-audience-gate` (spec committed at `3f4b598`)

## Goal

Stop every outbound reply — public comment and DM — to Instagram users Gemini classifies as `south_asian`, reading the verdict from `ig_users.inferred_origin` and failing open when no verdict can be obtained.

## Architecture

The gate becomes a read of the same column the DM-recovery gate already reads (`ig_users.inferred_origin` at `origin_method = 'llm_v3'`), with an inline `classifyOrigins()` call on a cache miss under a 3,000ms ceiling. Three pieces (`readStoredOrigin`, `compareAndSetOrigin`, `ORIGIN_STILL_DUE`) move out of `originEnrichmentWorker` and `dmRecoveryRepository` into a shared `src/services/originVerdictStore.ts` so the gate, the enrichment worker, and the recovery gate all agree by construction. `authorizeNewGuideAction` returns `allow | block` instead of `allow | block | defer`, and every consumer's failure branch flips from withhold to send.

## Tech Stack

- TypeScript (ESM, `.js` import specifiers), Node
- Prisma 5.22 against Postgres (Supabase pooler in prod, `insta-contract-pg` for contract tests)
- Vitest (`npm test` runs `vitest run`)
- axios for the Gemini REST boundary (`src/meta/geminiClient.ts`)
- Zod for env parsing (`src/config/env.ts`)

## Global Constraints

Copied verbatim from the spec. Do not substitute values.

**Decision rule:**

| State | Decision | Audit row |
|---|---|---|
| stored verdict `south_asian` (high or low) | **block** — no comment reply, no DM | `block` |
| stored verdict `us_western` / `other` / `unknown` | allow | none |
| no stored verdict, live call returns `south_asian` | **block** | `block` |
| no stored verdict, live call returns anything else | allow | none |
| live call times out, throws, or is unreadable | allow | `allow_unverified` |
| `GUIDE_AUDIENCE_BLOCK_ENABLED` off, or Gemini disabled | allow | none |

- **Timeout: 3,000ms, one attempt, no retry.** Measured p50 811ms, p90 = max = 1,327ms, n=8, 8/8 successful. 3,000ms is 2.3x the slowest observed call.
- **Env added:** `GUIDE_AUDIENCE_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(3_000)`
- **Env removed:** `NVIDIA_API_KEY`, `NVIDIA_AUDIENCE_MODEL`, `NVIDIA_AUDIENCE_TIMEOUT_MS`, `NVIDIA_AUDIENCE_RECOVERY_TIMEOUT_MS`
- **Env kept:** `GUIDE_AUDIENCE_BLOCK_ENABLED: booleanFlag(false)` — never `coerce.boolean`, because `FLAG=false` parses as TRUE.
- **Current method string:** `CURRENT_ORIGIN_METHOD = "llm_v3"` from `src/services/historicalAudienceSegment.ts:8`. Also exported as `ORIGIN_PROMPT_VERSION` from `originClassifier.ts:16`.
- **Both confidences block.** `south_asian`/low blocks exactly like `south_asian`/high.
- **`unknown` sends.**
- **No `inferOrigin()` name-screen fallback in this gate.** That screen caught 3 of 50 accounts where Gemini caught 22; as a second classifier it can only add false blocks. `resolveAudienceOrigin` keeps its fallback unchanged.
- **Failure direction flips everywhere:**
  ```
  today:   catch { log; return; }        → withhold        (fail closed)
  becomes: catch { log; return true; }   → send, audited   (fail open)
  ```
- **Two migrations.** M1 (Task 3) is purely additive and ships with the code. M2 (Task 8) drops `guide_audience_decision.classification_id` and table `guide_audience_classification`, and ships only after the new path has run in production.
- **`ALTER TYPE ... ADD VALUE` cannot use the new value in the transaction that adds it,** so M1 must not also insert a row using `allow_unverified`.
- **`defer` stays in `GuideAudienceDecisionKind` but is never written again.** The 72 historical rows mean "withheld"; reusing the value would make new rows mean the opposite.
- **`GuideAudienceDeferReason` is reused on `allow_unverified` rows** for `provider_timeout`, `provider_unavailable`, `invalid_provider_response`. `identity_unavailable`, `identity_changed`, `persistence_failed` become unreachable and stay in the enum for the historical rows.
- **`guide_audience_decision.identity_hash` is `CHAR(64) NOT NULL`.** The new service still computes the sha256 identity snapshot for this column; dropping it would need a third migration.
- **Contract DB:** `insta-contract-pg`, user/password `postgres`/`disposable`, database `contract`, port **5433** — not the recipe in docs. Leftover rows in that database and a stale generated Prisma client both fail as consistent contract assertions; re-run one file before suspecting the change.
- **Handler tests assert at the Graph client, not at a mocked service.** The last five Critical bugs on a comparable branch all sat exactly where tests mocked the boundary.
- **Never run `railway up`.** Railway and Vercel both deploy from `main` on merge.

## File Structure

```
src/
  config/
    env.ts                                    MODIFY  Task 2 (+GUIDE_AUDIENCE_TIMEOUT_MS), Task 6 (−NVIDIA)
    env.test.ts                               MODIFY  Task 2, Task 6
  services/
    originVerdictStore.ts                     CREATE  Task 1
    originVerdictStore.test.ts                CREATE  Task 1
    originEnrichmentWorker.ts                 MODIFY  Task 1 (import the moved pieces)
    dmRecoveryRepository.ts                   MODIFY  Task 1 (resolveAudienceOrigin delegates)
    originClassifier.ts                       MODIFY  Task 2 (injectable deadline)
    originClassifier.test.ts                  MODIFY  Task 2
    guideAudienceAuthorization.ts             REWRITE Task 6
    guideAudienceAuthorization.test.ts        REWRITE Task 6
    guideAudienceAuthorizationRepository.ts   MODIFY  Task 6
    guideAudienceAuthorizationRepository.test.ts REWRITE Task 6
    guideAudiencePolicy.integration.test.ts   REWRITE Task 6
    guideAudienceAuthorizationMigrationContract.test.ts MODIFY Task 3, Task 8
    guideAudienceTimeoutRecovery.ts           DELETE  Task 4
    guideAudienceTimeoutRecovery.test.ts      DELETE  Task 4
    nvidiaAudienceClassifier.ts               DELETE  Task 6
    nvidiaAudienceClassifier.test.ts          DELETE  Task 6
    guideAccessActionService.ts               MODIFY  Task 5
    guideDeliveryService.ts                   MODIFY  Task 5
    guideActionOutcomeService.ts              MODIFY  Task 5
  handlers/
    commentHandler.ts                         MODIFY  Task 5
    commentHandler.test.ts                    MODIFY  Task 5
    messageHandler.ts                         MODIFY  Task 5
    messageHandler.test.ts                    MODIFY  Task 5
    guideAudienceGate.handler.test.ts         CREATE  Task 7
scripts/
  guide-audience-timeout-recovery.ts          DELETE  Task 4
  guide-audience-timeout-recovery-core.ts     DELETE  Task 4
  guide-audience-timeout-recovery.test.ts     DELETE  Task 4
prisma/
  schema.prisma                               MODIFY  Task 3, Task 6 (comment), Task 8
  migrations/20260927010000_guide_audience_decision_origin/migration.sql   CREATE Task 3
  migrations/20260928010000_drop_guide_audience_classification/migration.sql CREATE Task 8
package.json                                  MODIFY  Task 4 (drop recovery script)
```

---

## Task 1: Shared origin verdict store

Behavior-preserving extraction. Nothing in production changes; the enrichment worker and the recovery gate keep producing identical results while gaining a module the new gate can import.

**Files:**
- Create: `src/services/originVerdictStore.ts`
- Create: `src/services/originVerdictStore.test.ts`
- Modify: `src/services/originEnrichmentWorker.ts` (delete `ORIGIN_STILL_DUE` at 88-94 and `compareAndSetOrigin` at 96-121; import both; use `originVerdictWriteData` in the verdict branch at 219-234)
- Modify: `src/services/dmRecoveryRepository.ts` (`resolveAudienceOrigin` at 250-265, `isOrigin` at 267-271)

**Interfaces:**

Consumes:
- `CURRENT_ORIGIN_METHOD: "llm_v3"` from `./historicalAudienceSegment.js`
- `Origin = "us_western" | "south_asian" | "other" | "unknown"` from `./originInference.js`
- `OriginVerdict` (type only) from `./originClassifier.js`
- `prisma` from `../lib/prisma.js`

Produces:
```ts
export type StoredOriginRow = {
  username: string | null;
  name: string | null;
  inferredOrigin: string | null;
  originConfidence: string | null;
  originMethod: string | null;
};

export type StoredOriginVerdict = { origin: Origin; confidence: "high" | "low" };

export type OriginIdentity = { id: string; username: string | null; name: string | null };

export const ORIGIN_STILL_DUE: Prisma.IgUserWhereInput;
export function isOrigin(value: string | null | undefined): value is Origin;
export function readStoredOrigin(person: StoredOriginRow | null): StoredOriginVerdict | null;
export function originVerdictWriteData(
  verdict: OriginVerdict,
  now: Date,
): Prisma.IgUserUpdateManyMutationInput;
export function compareAndSetOrigin(
  writes: Array<{ candidate: OriginIdentity; data: Prisma.IgUserUpdateManyMutationInput }>,
): Promise<number>;
```

**Steps:**

- [ ] Write `src/services/originVerdictStore.test.ts` with the `readStoredOrigin` cases only (no DB):
  ```ts
  import { describe, expect, it } from "vitest";
  import { readStoredOrigin, originVerdictWriteData } from "./originVerdictStore.js";

  const row = (over: Partial<Parameters<typeof readStoredOrigin>[0] & object> = {}) => ({
    username: "someone",
    name: "Some One",
    inferredOrigin: "south_asian",
    originConfidence: "high",
    originMethod: "llm_v3",
    ...over,
  });

  describe("readStoredOrigin", () => {
    it("returns a current-method verdict", () => {
      expect(readStoredOrigin(row())).toEqual({ origin: "south_asian", confidence: "high" });
    });

    it("returns null for a null person", () => {
      expect(readStoredOrigin(null)).toBeNull();
    });

    it("returns null when the method is not the current prompt version", () => {
      expect(readStoredOrigin(row({ originMethod: "name" }))).toBeNull();
    });

    it("returns null when the stored origin is not a known value", () => {
      expect(readStoredOrigin(row({ inferredOrigin: "martian" }))).toBeNull();
    });

    it("reads anything that is not exactly \"high\" as low", () => {
      expect(readStoredOrigin(row({ originConfidence: "HIGH" }))).toEqual({
        origin: "south_asian",
        confidence: "low",
      });
    });
  });

  describe("originVerdictWriteData", () => {
    it("stamps every field the cached read requires", () => {
      const now = new Date("2026-09-27T00:00:00.000Z");
      expect(
        originVerdictWriteData(
          {
            id: "1",
            origin: "us_western",
            confidence: "high",
            cueKind: "distinctive_cultural",
            audienceSegment: "western",
            evidence: "anglophone given name",
          },
          now,
        ),
      ).toEqual({
        inferredOrigin: "us_western",
        originConfidence: "high",
        originMethod: "llm_v3",
        originEvidence: "anglophone given name",
        audienceSegment: "western",
        originCheckedAt: now,
      });
    });
  });
  ```
  Those literals are the real vocabulary: `GeminiCueKind` is
  `distinctive_cultural | ambiguous_cultural | generic_or_no_cue` and `AudienceSegment` is
  `western | other | unknown_cue | unknown_generic | unknown_no_name | south_asian`
  (`historicalAudienceSegment.ts:5-7` and `41-48`). `us_western` + `positive_cue` +
  `distinctive_cultural` derives `western` through `AUDIENCE_SEGMENT_BY_GEMINI_RESPONSE`.
- [ ] Run `npx vitest run src/services/originVerdictStore.test.ts`. Confirm it fails because the module does not exist.
- [ ] Create `src/services/originVerdictStore.ts`:
  ```ts
  import type { Prisma } from "@prisma/client";
  import { prisma } from "../lib/prisma.js";
  import { CURRENT_ORIGIN_METHOD } from "./historicalAudienceSegment.js";
  import type { OriginVerdict } from "./originClassifier.js";
  import type { Origin } from "./originInference.js";

  /**
   * One reader and one writer for `ig_users.inferred_origin`, shared by the
   * enrichment worker, the DM-recovery gate, and the guide audience gate. Before
   * this module the worker owned the write and the recovery repository owned the
   * read, so a third caller could only agree with them by copying both.
   */

  export type StoredOriginRow = {
    username: string | null;
    name: string | null;
    inferredOrigin: string | null;
    originConfidence: string | null;
    originMethod: string | null;
  };

  export type StoredOriginVerdict = { origin: Origin; confidence: "high" | "low" };

  /** Identity snapshot a write is allowed to land against. */
  export type OriginIdentity = { id: string; username: string | null; name: string | null };

  const ORIGINS = new Set(["us_western", "south_asian", "other", "unknown"]);

  export function isOrigin(value: string | null | undefined): value is Origin {
    return typeof value === "string" && ORIGINS.has(value);
  }

  /**
   * The stored verdict, or null when there is none written by the CURRENT prompt
   * version. Null is deliberately not a value: the same columns are written by a
   * one-time backfill (origin_method "name") and by any future prompt, so pinning
   * the version means a prompt change re-earns trust through the worker. Callers
   * decide what a miss means — recovery falls back to the name screen, the guide
   * gate calls Gemini.
   */
  export function readStoredOrigin(person: StoredOriginRow | null): StoredOriginVerdict | null {
    if (!person || person.originMethod !== CURRENT_ORIGIN_METHOD) return null;
    if (!isOrigin(person.inferredOrigin)) return null;
    return {
      origin: person.inferredOrigin,
      // Anything not exactly "high" reads as low: "high" is the value that
      // withholds a public reminder, so a malformed column must not grant it.
      confidence: person.originConfidence === "high" ? "high" : "low",
    };
  }

  export const ORIGIN_STILL_DUE = {
    OR: [
      { originCheckedAt: null },
      { originMethod: null },
      { originMethod: { not: CURRENT_ORIGIN_METHOD } },
    ],
  } satisfies Prisma.IgUserWhereInput;

  /**
   * Every field `readStoredOrigin` inspects, written together. Omitting
   * originMethod here would leave the row a permanent cache miss and re-bill it
   * on every interaction.
   */
  export function originVerdictWriteData(
    verdict: OriginVerdict,
    now: Date,
  ): Prisma.IgUserUpdateManyMutationInput {
    return {
      inferredOrigin: verdict.origin,
      originConfidence: verdict.confidence,
      originMethod: CURRENT_ORIGIN_METHOD,
      originEvidence: verdict.evidence,
      audienceSegment: verdict.audienceSegment,
      originCheckedAt: now,
    };
  }

  /**
   * Persist classifier output only for the exact identity snapshot that was sent to
   * Gemini and only while it still needs this method revision. A profile update clears
   * origin fields; matching name and username prevents a delayed old response from
   * immediately restoring a verdict for the prior identity.
   */
  export async function compareAndSetOrigin(
    writes: Array<{ candidate: OriginIdentity; data: Prisma.IgUserUpdateManyMutationInput }>,
  ): Promise<number> {
    if (writes.length === 0) return 0;
    const results = await prisma.$transaction(
      writes.map(({ candidate, data }) => prisma.igUser.updateMany({
        where: {
          id: candidate.id,
          username: candidate.username,
          name: candidate.name,
          ...ORIGIN_STILL_DUE,
        },
        data,
      })),
    );
    return results.reduce((count, write) => count + write.count, 0);
  }
  ```
- [ ] Run `npx vitest run src/services/originVerdictStore.test.ts`. Confirm it passes.
- [ ] In `src/services/originEnrichmentWorker.ts`, delete `ORIGIN_STILL_DUE` (lines 88-94) and `compareAndSetOrigin` (lines 96-121), then add to the import block:
  ```ts
  import {
    compareAndSetOrigin,
    ORIGIN_STILL_DUE,
    originVerdictWriteData,
  } from "./originVerdictStore.js";
  ```
- [ ] In the same file, replace the verdict write block (lines 219-234) so the data comes from the shared helper:
  ```ts
  const candidateById = new Map(classifiable.map((candidate) => [candidate.id, candidate]));
  result.classified += await compareAndSetOrigin(
    verdicts.flatMap((v) => {
      const candidate = candidateById.get(v.id);
      return candidate ? [{ candidate, data: originVerdictWriteData(v, now) }] : [];
    }),
  );
  ```
  Leave the `noSignal` and `unplaced` write blocks as they are — they stamp `unknown` without a verdict object, so they build their `data` inline.
- [ ] Run `npx vitest run src/services/originEnrichmentWorker.test.ts`. Confirm it still passes with no test changes. If it fails, the extraction changed behavior — fix the extraction, not the test.
- [ ] In `src/services/dmRecoveryRepository.ts`, replace `resolveAudienceOrigin` (250-265) and delete the local `ORIGINS`/`isOrigin` (267-271):
  ```ts
  export type OriginSource = StoredOriginRow | null;

  /**
   * Prefer a stored LLM verdict; otherwise classify the name live.
   *
   * The stored read lives in originVerdictStore so the guide audience gate reads
   * the identical column, method pin, and confidence rule. Only the fallback is
   * local: recovery accepts the hardcoded token screen on a miss, the guide gate
   * deliberately does not.
   */
  export function resolveAudienceOrigin(person: OriginSource): {
    origin: Origin;
    confidence: "high" | "low";
  } {
    const stored = readStoredOrigin(person);
    if (stored) return stored;
    const inferred = inferOrigin(person?.username ?? null, person?.name ?? null);
    return { origin: inferred.origin, confidence: inferred.confidence };
  }
  ```
  Add `import { readStoredOrigin, type StoredOriginRow } from "./originVerdictStore.js";` and drop the now-unused `ORIGIN_PROMPT_VERSION` import at line 11 if nothing else in the file uses it.
- [ ] Run `npx vitest run src/services/dmRecoveryRepository.test.ts src/services/dmRecoveryPolicy.test.ts`. Confirm both pass unchanged.
- [ ] Run `npx tsc --noEmit`. Confirm clean.
- [ ] Commit: `refactor: share the origin verdict read and write in one module`

---

## Task 2: Injectable classifier deadline

**Files:**
- Modify: `src/services/originClassifier.ts` (`classifyOrigins` at 187-278, the `gemini.post` call at 211)
- Modify: `src/services/originClassifier.test.ts`
- Modify: `src/config/env.ts` (add `GUIDE_AUDIENCE_TIMEOUT_MS` next to `GUIDE_AUDIENCE_BLOCK_ENABLED` at line 142)
- Modify: `src/config/env.test.ts`

**Interfaces:**

Consumes: `gemini` (axios instance, instance-level `timeout: 120_000` at `geminiClient.ts:15`)

Produces:
```ts
export type ClassifyOriginsOptions = { timeoutMs?: number };
export function classifyOrigins(
  candidates: OriginCandidate[],
  options?: ClassifyOriginsOptions,
): Promise<OriginClassificationResult>;
```
`env.GUIDE_AUDIENCE_TIMEOUT_MS: number` (default `3000`).

**Steps:**

- [ ] Add a failing test to `src/services/originClassifier.test.ts` asserting the per-request timeout reaches axios:
  ```ts
  it("applies the caller's deadline to the request instead of the client default", async () => {
    post.mockResolvedValue({ data: { candidates: [] } });
    await classifyOrigins([{ id: "1", username: "sarah", name: "Sarah Jones" }], {
      timeoutMs: 3_000,
    });
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      { timeout: 3_000 },
    );
  });

  it("leaves the client default in place when no deadline is given", async () => {
    post.mockResolvedValue({ data: { candidates: [] } });
    await classifyOrigins([{ id: "1", username: "sarah", name: "Sarah Jones" }]);
    expect(post).toHaveBeenCalledWith(expect.any(String), expect.any(Object), undefined);
  });
  ```
  `post` is the file's existing spy — `originClassifier.test.ts:4` declares it and `:6-15` injects it as `gemini.post`. Reuse it; do not add a second mock. `envSchema` and `baseEnv` below are likewise the names already in `env.test.ts:3` and `:9`.
- [ ] Run `npx vitest run src/services/originClassifier.test.ts`. Confirm the two new tests fail on the third argument.
- [ ] In `src/services/originClassifier.ts`, change the signature and pass the deadline through:
  ```ts
  /** Per-call deadline. The instance default (120s, sized for video analysis) is
   * far too long for a webhook-path name screen, and the guide gate needs a
   * ceiling it can also inject in tests without waiting for it. */
  export type ClassifyOriginsOptions = { timeoutMs?: number };

  export async function classifyOrigins(
    candidates: OriginCandidate[],
    options: ClassifyOriginsOptions = {},
  ): Promise<OriginClassificationResult> {
  ```
  and at the request:
  ```ts
  const { data } = await gemini.post<GenerateResponse>(
    `/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
    {
      /* unchanged body */
    },
    options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
  );
  ```
- [ ] Run `npx vitest run src/services/originClassifier.test.ts`. Confirm all tests pass, including the pre-existing ones.
- [ ] In `src/config/env.ts`, add below `GUIDE_AUDIENCE_BLOCK_ENABLED` (line 142):
  ```ts
  // Ceiling on the inline Gemini call the guide audience gate makes on a cache
  // miss. 3,000ms is 2.3x the slowest measured single-candidate call (1,327ms,
  // p50 811ms). Every premature cutoff sends to a South Asian user, so a tight
  // budget costs more than a slightly later DM — and server.ts:69 acks Meta
  // before dispatch, so this can never trip a webhook timeout.
  GUIDE_AUDIENCE_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(3_000),
  ```
- [ ] Add to `src/config/env.test.ts`:
  ```ts
  it("defaults the guide audience deadline to three seconds", () => {
    expect(envSchema.parse(baseEnv).GUIDE_AUDIENCE_TIMEOUT_MS).toBe(3_000);
  });

  it("accepts an operator override for the guide audience deadline", () => {
    expect(
      envSchema.parse({ ...baseEnv, GUIDE_AUDIENCE_TIMEOUT_MS: "5000" }).GUIDE_AUDIENCE_TIMEOUT_MS,
    ).toBe(5_000);
  });
  ```
- [ ] Run `npx vitest run src/config/env.test.ts`. Confirm both pass.
- [ ] Run `npx tsc --noEmit`. Confirm clean.
- [ ] Commit: `feat: allow a per-call deadline on origin classification`

---

## Task 3: M1 migration — decision origin, confidence, and `allow_unverified`

Purely additive. Safe to deploy while the flag is off and before any code reads the new columns.

**Files:**
- Create: `prisma/migrations/20260927010000_guide_audience_decision_origin/migration.sql`
- Modify: `prisma/schema.prisma` (`GuideAudienceDecisionKind` at 978-983, `GuideAudienceDecision` at 1027-1050). The stale `GuideAudienceOrigin` comment at 960-961 is corrected in Task 6, where NVIDIA's departure is what makes it wrong.
- Modify: `src/services/guideAudienceAuthorizationMigrationContract.test.ts`

**Interfaces:**

Produces (regenerated Prisma client):
- `GuideAudienceDecisionKind` gains `allow_unverified`
- `GuideAudienceDecision.origin: GuideAudienceOrigin | null`
- `GuideAudienceDecision.confidence: GuideAudienceConfidence | null`

**Steps:**

- [ ] Add a failing assertion block to `src/services/guideAudienceAuthorizationMigrationContract.test.ts`:
  ```ts
  const m1Url = new URL(
    "../../prisma/migrations/20260927010000_guide_audience_decision_origin/migration.sql",
    import.meta.url,
  );

  describe("guide audience decision origin migration contract", () => {
    it("records the verdict on the decision row and adds the fail-open kind", async () => {
      const sql = await readFile(m1Url, "utf8");
      expect(sql).toContain(
        `ALTER TYPE "guide_audience_decision_kind" ADD VALUE IF NOT EXISTS 'allow_unverified'`,
      );
      expect(sql).toContain(
        `ADD COLUMN IF NOT EXISTS "origin" "guide_audience_origin"`,
      );
      expect(sql).toContain(
        `ADD COLUMN IF NOT EXISTS "confidence" "guide_audience_confidence"`,
      );
    });

    it("does not insert a row using the enum value it adds", async () => {
      const sql = await readFile(m1Url, "utf8");
      expect(sql).not.toMatch(/INSERT INTO "guide_audience_decision"/i);
    });
  });
  ```
- [ ] Run `npx vitest run src/services/guideAudienceAuthorizationMigrationContract.test.ts`. Confirm the new block fails on the missing file.
- [ ] Create `prisma/migrations/20260927010000_guide_audience_decision_origin/migration.sql`:
  ```sql
  -- The verdict now lives on the decision row itself. It previously lived only on
  -- guide_audience_classification, reachable through a nullable classification_id
  -- with ON DELETE SET NULL — so dropping that table first would have blinded the
  -- audit trail. This migration is additive; the drop is a separate follow-up.

  -- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it,
  -- so this statement is intentionally outside the BEGIN block below and this
  -- migration writes no row using the new value.
  ALTER TYPE "guide_audience_decision_kind" ADD VALUE IF NOT EXISTS 'allow_unverified';

  BEGIN;

  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '30s';

  ALTER TABLE "guide_audience_decision"
    ADD COLUMN IF NOT EXISTS "origin" "guide_audience_origin",
    ADD COLUMN IF NOT EXISTS "confidence" "guide_audience_confidence";

  COMMIT;
  ```
- [ ] Update `prisma/schema.prisma`. `GuideAudienceDecisionKind` becomes:
  ```prisma
  enum GuideAudienceDecisionKind {
    block
    // Written when no verdict could be obtained and the send went out anyway.
    // Reaching a few percent of decisions means the Gemini call is failing —
    // raise GUIDE_AUDIENCE_TIMEOUT_MS before changing policy.
    allow_unverified
    // Historical only. 72 rows from the NVIDIA incident, where a failed
    // classification WITHHELD the send. Never written again: reusing the value
    // would make new rows mean the opposite of the old ones.
    defer

    @@map("guide_audience_decision_kind")
  }
  ```
  and add to `model GuideAudienceDecision`, immediately after `source`:
  ```prisma
    origin           GuideAudienceOrigin?
    confidence       GuideAudienceConfidence?
  ```
  Keep `classificationId` and the `classification` relation for now; Task 8 removes them.
- [ ] Run `npx prisma generate`. Confirm it succeeds and `GuideAudienceDecisionKind.allow_unverified` appears in `node_modules/.prisma/client/index.d.ts`.
- [ ] Run `npx vitest run src/services/guideAudienceAuthorizationMigrationContract.test.ts`. Confirm all blocks pass.
- [ ] Run `npx tsc --noEmit`. Confirm clean.
- [ ] Commit: `feat: record the audience verdict on the decision row`

---

## Task 4: Delete the completed timeout-recovery subsystem

Standalone and ordered before the type changes: its `AuthorizedAudienceTimeoutRecoveryCandidate` carries `classificationId` and `classificationOrigin`, and it imports the `defer` arm of `GuideAudienceAuthorization`.

Evidence it is finished, not abandoned: its window is hardcoded to `2026-09-23T23:54Z` → `2026-09-24T03:45Z`, it ran 6 times (`guide_audience_timeout_recovery_run`, 2026-09-24T06:11 → 2026-09-25T00:48) and emitted 32 `guide_audience_timeout_recovery_outcome` events on 2026-09-25, **all 32 `guide_opening_sent`**. Its 24-hour private-reply window has closed and fail-open produces no new defers to feed it.

**Files:**
- Delete: `src/services/guideAudienceTimeoutRecovery.ts` (303 lines)
- Delete: `src/services/guideAudienceTimeoutRecovery.test.ts` (252 lines)
- Delete: `scripts/guide-audience-timeout-recovery.ts` (230 lines)
- Delete: `scripts/guide-audience-timeout-recovery-core.ts` (239 lines)
- Delete: `scripts/guide-audience-timeout-recovery.test.ts` (182 lines)
- Modify: `package.json` (remove the `recovery:guide-audience-timeouts` script at line 21)

**Interfaces:**

Consumes: nothing new.
Produces: nothing. Removes `GUIDE_AUDIENCE_TIMEOUT_INCIDENT_STARTED_AT`, `GUIDE_AUDIENCE_TIMEOUT_INCIDENT_ENDED_AT`, `AuthorizedAudienceTimeoutRecoveryCandidate`.

**Steps:**

- [ ] Confirm nothing else imports the subsystem:
  ```bash
  grep -rn --include='*.ts' -e 'guideAudienceTimeoutRecovery' -e 'guide-audience-timeout-recovery' -e 'GUIDE_AUDIENCE_TIMEOUT_INCIDENT' src scripts
  ```
  Expect matches only inside the five files being deleted. If anything else matches, stop and report it before deleting.
- [ ] Delete the five files:
  ```bash
  git rm src/services/guideAudienceTimeoutRecovery.ts src/services/guideAudienceTimeoutRecovery.test.ts scripts/guide-audience-timeout-recovery.ts scripts/guide-audience-timeout-recovery-core.ts scripts/guide-audience-timeout-recovery.test.ts
  ```
- [ ] Remove this line from `package.json`:
  ```json
      "recovery:guide-audience-timeouts": "tsx scripts/guide-audience-timeout-recovery.ts",
  ```
- [ ] Run `npx tsc --noEmit`. Confirm clean.
- [ ] Run `npm test`. Confirm the suite passes with 1,206 fewer lines under test. Note the baseline failure count first — leftover rows in the disposable QA Postgres and a stale generated Prisma client both fail as consistent contract assertions, so compare against the pre-task baseline rather than against zero.
- [ ] Commit: `chore: remove the completed guide audience timeout recovery`

---

## Task 5: Fail open at every consumer

The service still returns `defer` after this task; no consumer acts on it. That is deliberate — it compiles, and in production the flag is off, so nothing changes behavior until Task 6 lands.

**Files:**
- Modify: `src/handlers/commentHandler.ts` (290-305)
- Modify: `src/handlers/commentHandler.test.ts` (the audience assertions around 780-790)
- Modify: `src/handlers/messageHandler.ts` (`mayStartGuideAction`, 129-146)
- Modify: `src/handlers/messageHandler.test.ts` (255-315)
- Modify: `src/services/guideAccessActionService.ts` (outcome union at 59, `audienceOutcome` at 292-304)
- Modify: `src/services/guideDeliveryService.ts` (outcome union at 73, the authorize block at 552-569)
- Modify: `src/services/guideActionOutcomeService.ts` (171-176)

**Interfaces:**

Consumes: `GuideAudienceAuthorization` — only `.kind === "block"` is acted on.
Produces: `"guide_audience_deferred"` is removed from `GuideAccessActionOutcome` and `GuideDeliveryResult`. `"guide_audience_blocked"` stays and still maps to `"none_audience_policy"`.

**Steps:**

- [ ] In `src/handlers/commentHandler.test.ts`, replace the whole `describe("guide audience policy — comment path")` block at lines 767-797. The existing `it.each` asserts that a `defer` verdict sends nothing — the exact behavior this task reverses — so it must go, not be added to. The file already declares every spy needed: `replyToComment` (27), `sendTrackedPrivateReply` (28), `resolveJourneyIntent` (32), `authorizeNewGuideAction` (33, injected through the `../services/guideAudienceAuthorization.js` mock at 107).
  ```ts
  describe("guide audience policy — comment path", () => {
    const COMMENT = {
      id: "comment-audience-1",
      text: "sleep",
      from: { id: "ig-parent", username: "parent" },
      media: { id: "reel-1", media_product_type: "REELS" },
    };

    it("sends nothing when a matched comment is blocked", async () => {
      authorizeNewGuideAction.mockResolvedValue({ kind: "block", auditId: "audit-1" });

      await handleComment(COMMENT);

      expect(authorizeNewGuideAction).toHaveBeenCalledWith({
        igUserId: "ig-parent",
        source: "comment",
        commentId: COMMENT.id,
        resourceId: RESOURCE_ID,
      });
      expect(resolveJourneyIntent).not.toHaveBeenCalled();
      expect(replyToComment).not.toHaveBeenCalled();
      expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
      expect(startCommentGuideRequest).not.toHaveBeenCalled();
      expect(enqueueGate).not.toHaveBeenCalled();
    });

    // Fail open. A gate that cannot reach a verdict silenced 46 of 60 people
    // during the NVIDIA incident, 21 of them confirmed US audience.
    it("still replies when the audience gate throws", async () => {
      authorizeNewGuideAction.mockRejectedValue(new Error("boom"));

      await handleComment(COMMENT);

      expect(replyToComment).toHaveBeenCalledTimes(1);
      expect(sendTrackedPrivateReply).toHaveBeenCalledTimes(1);
    });
  });
  ```
- [ ] Run `npx vitest run src/handlers/commentHandler.test.ts`. Confirm the new test fails (no reply sent).
- [ ] In `src/handlers/commentHandler.ts`, replace lines 290-305:
  ```ts
  // A blocked guide decision must stop BEFORE the public acknowledgement: the
  // user explicitly does not want a comment, private gate, recovery, or guide.
  // The authorization service writes the safe internal audit record.
  //
  // Failure sends. A gate that cannot reach a verdict silenced 46 of 60 people
  // wrongly during the NVIDIA incident, 21 of them confirmed US audience, so a
  // broken boundary now costs an occasional out-of-market reply instead of
  // dropping in-market ones. The service itself audits this as allow_unverified.
  try {
    const audienceDecision = await guideAudienceAuthorization.authorizeNewGuideAction({
      igUserId: senderId,
      source: "comment",
      commentId: comment.id,
      resourceId: keyword.resourceId,
    });
    if (audienceDecision.kind === "block") return;
  } catch {
    log.error(
      { errorCode: "guide_audience_authorization_failed", igUserId: senderId },
      "Guide audience authorization failed — sending anyway",
    );
  }
  ```
- [ ] Run `npx vitest run src/handlers/commentHandler.test.ts`. Confirm all tests pass, including the pre-existing block assertion.
- [ ] In `src/handlers/messageHandler.test.ts`, narrow the `it.each` at lines 277-302 to the `block` case only — its `defer` entry (279-283) asserts the behavior this task reverses — and add a fail-open case. Spies already declared: `findKeywordInMessage` (19), `resolveJourneyIntent` (25), `sendSequence` (28), `deliverGuideForTrigger` (30), `sendTrackedText` (31), `startDirectDmGuideRequest` (35), `authorizeNewGuideAction` (37).
  ```ts
  it("sends nothing and creates no guide journey when a keyword DM is blocked", async () => {
    authorizeNewGuideAction.mockResolvedValue({ kind: "block", auditId: "audit-1" });
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));

    expect(authorizeNewGuideAction).toHaveBeenCalledWith({
      igUserId: "ig-user-1",
      source: "dm",
      inboundMessageId: "message-1",
      resourceId: "resource-1",
    });
    expect(resolveJourneyIntent).not.toHaveBeenCalled();
    expect(startDirectDmGuideRequest).not.toHaveBeenCalled();
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
    expect(queueReplyDraft).not.toHaveBeenCalled();
  });

  it("starts the guide action when the audience gate throws", async () => {
    authorizeNewGuideAction.mockRejectedValue(new Error("boom"));
    findKeywordInMessage.mockResolvedValue(keywordFixture);

    await handleMessage(inbound("SLEEP"));

    expect(startDirectDmGuideRequest).toHaveBeenCalledTimes(1);
  });
  ```
  The `does not redeliver an already-completed guide when authorization blocks it` test at 304-321 keeps its `block` verdict and needs no change.
- [ ] Run `npx vitest run src/handlers/messageHandler.test.ts`. Confirm the new test fails.
- [ ] In `src/handlers/messageHandler.ts`, replace `mayStartGuideAction` (129-146):
  ```ts
  async function mayStartGuideAction(input: {
    igUserId: string;
    source: "dm" | "redelivery";
    conversationId?: string;
    inboundMessageId: string;
    resourceId: string;
  }): Promise<boolean> {
    try {
      const decision = await guideAudienceAuthorization.authorizeNewGuideAction(input);
      return decision.kind !== "block";
    } catch {
      // Fail open. An unreachable policy boundary must not drop an in-market
      // person; only an explicit south_asian verdict withholds.
      logger.error(
        { errorCode: "guide_audience_authorization_failed", igUserId: input.igUserId },
        "Guide audience authorization failed — sending anyway",
      );
      return true;
    }
  }
  ```
- [ ] Run `npx vitest run src/handlers/messageHandler.test.ts`. Confirm all tests pass.
- [ ] In `src/services/guideAccessActionService.ts`, remove `| "guide_audience_deferred"` from the outcome union at line 59, and replace `audienceOutcome` (292-304):
  ```ts
  async function audienceOutcome(
    input: AuthorizeNewGuideActionInput,
  ): Promise<"guide_audience_blocked" | null> {
    try {
      const decision = await dependencies.authorizeGuideAudience(input);
      return decision.kind === "block" ? "guide_audience_blocked" : null;
    } catch {
      // Fail open: an unavailable policy boundary is not a verdict, and
      // withholding on it cost 46 of 60 people during the NVIDIA incident.
      return null;
    }
  }
  ```
- [ ] In `src/services/guideDeliveryService.ts`, remove `| "guide_audience_deferred"` from the union at line 73 and replace the authorize block (552-569):
  ```ts
  if (!delivery) {
    let blocked = false;
    try {
      const audience = await (
        dependencies.authorizeGuideAudience ??
        guideAudienceAuthorization.authorizeNewGuideAction
      )({
        igUserId: input.igUserId,
        source: input.triggerKind === "explicit_redelivery" ? "redelivery" : "dm",
        conversationId: input.conversationId,
        inboundMessageId: input.triggerId,
        resourceId: input.resourceId,
      });
      blocked = audience.kind === "block";
    } catch {
      // Fail open — see guideAccessActionService.audienceOutcome.
      blocked = false;
    }
    if (blocked) return "guide_audience_blocked";
  ```
  Delete the now-unused `let audience: GuideAudienceAuthorization;` declaration and, if nothing else in the file uses it, the `type GuideAudienceAuthorization` import at line 31.
- [ ] In `src/services/guideActionOutcomeService.ts`, collapse 171-176 to:
  ```ts
  if (input.outcome === "guide_audience_blocked") return "none_audience_policy";
  ```
- [ ] Run `npx tsc --noEmit`. Confirm clean — any remaining reference to `"guide_audience_deferred"` surfaces here.
- [ ] Run `npm test`. Confirm no new failures against the Task 4 baseline.
- [ ] Commit: `feat: fail open when the audience gate cannot reach a verdict`

---

## Task 6: Swap the gate onto Gemini and the shared store

**Files:**
- Rewrite: `src/services/guideAudienceAuthorization.ts` (269 lines → roughly 150)
- Rewrite: `src/services/guideAudienceAuthorization.test.ts` (154 lines)
- Modify: `src/services/guideAudienceAuthorizationRepository.ts` (drop `findCurrentIdentity`, `findCurrentClassification`, `createClassification`, `classificationSelect`, `CurrentGuideAudienceClassification`, `CreateGuideAudienceClassificationInput`; add `findAudienceSubject`; add `origin`/`confidence` to `CreateGuideAudienceDecisionInput` and drop `classificationId`)
- Rewrite: `src/services/guideAudienceAuthorizationRepository.test.ts` (88 lines)
- Rewrite: `src/services/guideAudiencePolicy.integration.test.ts` (238 lines)
- Delete: `src/services/nvidiaAudienceClassifier.ts` (244), `src/services/nvidiaAudienceClassifier.test.ts` (188)
- Modify: `src/config/env.ts` (remove 126-139), `src/config/env.test.ts` (remove the NVIDIA cases at 20-40)
- Modify: `prisma/schema.prisma` (the comment at 960-961)

**Interfaces:**

Consumes:
- `readStoredOrigin`, `compareAndSetOrigin`, `originVerdictWriteData` from `./originVerdictStore.js`
- `classifyOrigins(candidates, { timeoutMs })` from `./originClassifier.js`
- `CURRENT_ORIGIN_METHOD` from `./historicalAudienceSegment.js`
- `geminiEnabled` from `../meta/geminiClient.js`
- `env.GUIDE_AUDIENCE_TIMEOUT_MS`, `env.GEMINI_MODEL`
- `flags.bool("GUIDE_AUDIENCE_BLOCK_ENABLED")`

Produces:
```ts
export const GUIDE_AUDIENCE_PROVIDER = "gemini";

export type AuthorizeNewGuideActionInput = {
  igUserId: string;
  source: GuideAudienceActionSource;
  conversationId?: string;
  commentId?: string;
  inboundMessageId?: string;
  resourceId?: string;
};

export type GuideAudienceAuthorization =
  | { kind: "allow" }
  | { kind: "block"; auditId: string | null };

export type GuideAudienceAuthorizationServiceDependencies = {
  repository: GuideAudienceAuthorizationRepository;
  classify: typeof classifyOrigins;
  persistVerdict: typeof compareAndSetOrigin;
  isEnabled(): boolean;
  classifierEnabled: boolean;
  timeoutMs: number;
  now?: () => Date;
};

export function createGuideAudienceAuthorizationService(
  dependencies: GuideAudienceAuthorizationServiceDependencies,
): { authorizeNewGuideAction(input: AuthorizeNewGuideActionInput): Promise<GuideAudienceAuthorization> };

export const guideAudienceAuthorization: ReturnType<typeof createGuideAudienceAuthorizationService>;
```
Repository:
```ts
export type GuideAudienceSubject = {
  id: string;
  username: string | null;
  name: string | null;
  inferredOrigin: string | null;
  originConfidence: string | null;
  originMethod: string | null;
};

export type CreateGuideAudienceDecisionInput = {
  igUserId: string;
  identityHash: string;
  kind: GuideAudienceDecisionKind;
  source: GuideAudienceActionSource;
  conversationId?: string;
  commentId?: string;
  inboundMessageId?: string;
  resourceId?: string;
  origin?: GuideAudienceOrigin;
  confidence?: GuideAudienceConfidence;
  deferReason?: GuideAudienceDeferReason;
  provider: string;
  modelId: string;
  method: string;
};

export type GuideAudienceAuthorizationRepository = {
  findAudienceSubject(igUserId: string): Promise<GuideAudienceSubject | null>;
  createDecision(input: CreateGuideAudienceDecisionInput): Promise<{ id: string }>;
};
```

**Steps:**

- [ ] Rewrite `src/services/guideAudienceAuthorizationRepository.ts`:
  ```ts
  import type {
    GuideAudienceActionSource,
    GuideAudienceConfidence,
    GuideAudienceDecisionKind,
    GuideAudienceDeferReason,
    GuideAudienceOrigin,
    PrismaClient,
  } from "@prisma/client";
  import { prisma } from "../lib/prisma.js";

  /** Identity plus the stored verdict, in one read. */
  export type GuideAudienceSubject = {
    id: string;
    username: string | null;
    name: string | null;
    inferredOrigin: string | null;
    originConfidence: string | null;
    originMethod: string | null;
  };

  export type CreateGuideAudienceDecisionInput = {
    igUserId: string;
    identityHash: string;
    kind: GuideAudienceDecisionKind;
    source: GuideAudienceActionSource;
    conversationId?: string;
    commentId?: string;
    inboundMessageId?: string;
    resourceId?: string;
    origin?: GuideAudienceOrigin;
    confidence?: GuideAudienceConfidence;
    deferReason?: GuideAudienceDeferReason;
    provider: string;
    modelId: string;
    method: string;
  };

  export type GuideAudienceAuthorizationRepository = {
    findAudienceSubject(igUserId: string): Promise<GuideAudienceSubject | null>;
    createDecision(input: CreateGuideAudienceDecisionInput): Promise<{ id: string }>;
  };

  export type GuideAudienceAuthorizationDatabase = Pick<
    PrismaClient,
    "igUser" | "guideAudienceDecision"
  >;

  /**
   * Persists guide-only audience provenance. The intentionally narrow decision
   * shape keeps names, usernames, prompts, and raw provider responses out of this
   * audit path — only a bounded verdict and a hash of the identity snapshot.
   */
  export function createGuideAudienceAuthorizationRepository(
    database: GuideAudienceAuthorizationDatabase = prisma,
  ): GuideAudienceAuthorizationRepository {
    return {
      // An absent row is a miss, not an error: rememberUsername runs before the
      // gate on the comment path, so absence means a DM-only sender we have
      // never resolved.
      findAudienceSubject: (igUserId) =>
        database.igUser.findUnique({
          where: { id: igUserId },
          select: {
            id: true,
            username: true,
            name: true,
            inferredOrigin: true,
            originConfidence: true,
            originMethod: true,
          },
        }),

      createDecision: async (input) =>
        database.guideAudienceDecision.create({
          data: {
            igUserId: input.igUserId,
            identityHash: input.identityHash,
            kind: input.kind,
            source: input.source,
            conversationId: input.conversationId ?? null,
            commentId: input.commentId ?? null,
            inboundMessageId: input.inboundMessageId ?? null,
            resourceId: input.resourceId ?? null,
            origin: input.origin ?? null,
            confidence: input.confidence ?? null,
            deferReason: input.deferReason ?? null,
            provider: input.provider,
            modelId: input.modelId,
            method: input.method,
          },
          select: { id: true },
        }),
    };
  }

  export const guideAudienceAuthorizationRepository = createGuideAudienceAuthorizationRepository();
  ```
- [ ] Rewrite `src/services/guideAudienceAuthorization.test.ts` against the new dependency shape. Cover every row of the decision rule:
  ```ts
  import { describe, expect, it, vi } from "vitest";
  import {
    createGuideAudienceAuthorizationService,
    type GuideAudienceAuthorizationServiceDependencies,
  } from "./guideAudienceAuthorization.js";

  const SUBJECT = {
    id: "ig-1",
    username: "priya_mommy",
    name: "Priya S",
    inferredOrigin: null as string | null,
    originConfidence: null as string | null,
    originMethod: null as string | null,
  };

  function harness(over: Partial<GuideAudienceAuthorizationServiceDependencies> = {}) {
    const createDecision = vi.fn().mockResolvedValue({ id: "audit-1" });
    const findAudienceSubject = vi.fn().mockResolvedValue({ ...SUBJECT });
    const classify = vi.fn();
    const persistVerdict = vi.fn().mockResolvedValue(1);
    const service = createGuideAudienceAuthorizationService({
      repository: { findAudienceSubject, createDecision },
      classify,
      persistVerdict,
      isEnabled: () => true,
      classifierEnabled: true,
      timeoutMs: 3_000,
      now: () => new Date("2026-09-27T12:00:00.000Z"),
      ...over,
    });
    return { service, createDecision, findAudienceSubject, classify, persistVerdict };
  }

  const ACTION = { igUserId: "ig-1", source: "comment" as const, commentId: "c-1" };

  describe("guide audience authorization", () => {
    it.each([
      ["south_asian", "high", "block"],
      ["south_asian", "low", "block"],
      ["us_western", "high", "allow"],
      ["us_western", "low", "allow"],
      ["other", "high", "allow"],
      ["other", "low", "allow"],
      ["unknown", "high", "allow"],
      ["unknown", "low", "allow"],
    ])("decides %s/%s as %s from the stored verdict", async (origin, confidence, kind) => {
      const { service, classify } = harness({
        repository: {
          findAudienceSubject: vi.fn().mockResolvedValue({
            ...SUBJECT,
            inferredOrigin: origin,
            originConfidence: confidence,
            originMethod: "llm_v3",
          }),
          createDecision: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
      });
      expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe(kind);
      expect(classify).not.toHaveBeenCalled();
    });

    it("writes exactly one block row carrying the verdict", async () => {
      const createDecision = vi.fn().mockResolvedValue({ id: "audit-1" });
      const { service } = harness({
        repository: {
          findAudienceSubject: vi.fn().mockResolvedValue({
            ...SUBJECT,
            inferredOrigin: "south_asian",
            originConfidence: "high",
            originMethod: "llm_v3",
          }),
          createDecision,
        },
      });
      await service.authorizeNewGuideAction(ACTION);
      expect(createDecision).toHaveBeenCalledTimes(1);
      expect(createDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "block",
          origin: "south_asian",
          confidence: "high",
          source: "comment",
          commentId: "c-1",
          provider: "gemini",
          method: "llm_v3",
        }),
      );
    });

    it("ignores a verdict written by an older prompt version", async () => {
      const { service, classify } = harness({
        repository: {
          findAudienceSubject: vi.fn().mockResolvedValue({
            ...SUBJECT,
            inferredOrigin: "south_asian",
            originConfidence: "high",
            originMethod: "name",
          }),
          createDecision: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
        classify: vi.fn().mockResolvedValue({
          verdicts: [],
          costUsd: 0,
          modelId: "gemini-2.5-flash",
          promptVersion: "llm_v3",
          finishReason: "STOP",
        }),
      });
      await service.authorizeNewGuideAction(ACTION);
      expect(classify).toHaveBeenCalledTimes(1);
    });

    it("classifies on a miss, blocks, and writes the verdict back", async () => {
      const { service, classify, persistVerdict, createDecision } = harness({
        classify: vi.fn().mockResolvedValue({
          verdicts: [{
            id: "ig-1",
            origin: "south_asian",
            confidence: "high",
            cueKind: "distinctive_cultural",
            audienceSegment: "south_asian",
            evidence: "south asian given name",
          }],
          costUsd: 0.00015,
          modelId: "gemini-2.5-flash",
          promptVersion: "llm_v3",
          finishReason: "STOP",
        }),
      });
      expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("block");
      expect(classify).toHaveBeenCalledWith(
        [{ id: "ig-1", username: "priya_mommy", name: "Priya S" }],
        { timeoutMs: 3_000 },
      );
      expect(persistVerdict).toHaveBeenCalledTimes(1);
      expect(createDecision).toHaveBeenCalledWith(expect.objectContaining({ kind: "block" }));
    });

    it("allows and writes back when the live call returns us_western", async () => {
      const { service, createDecision, persistVerdict } = harness({
        classify: vi.fn().mockResolvedValue({
          verdicts: [{
            id: "ig-1",
            origin: "us_western",
            confidence: "high",
            cueKind: "distinctive_cultural",
            audienceSegment: "western",
            evidence: "anglophone given name",
          }],
          costUsd: 0.00015,
          modelId: "gemini-2.5-flash",
          promptVersion: "llm_v3",
          finishReason: "STOP",
        }),
      });
      expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
      expect(persistVerdict).toHaveBeenCalledTimes(1);
      expect(createDecision).not.toHaveBeenCalled();
    });

    it.each([
      ["a timeout", Object.assign(new Error("timeout of 3000ms exceeded"), {
        isAxiosError: true, code: "ECONNABORTED",
      }), "provider_timeout"],
      ["any other throw", new Error("boom"), "provider_unavailable"],
    ])("allows on %s and audits it", async (_label, error, deferReason) => {
      const createDecision = vi.fn().mockResolvedValue({ id: "audit-1" });
      const { service } = harness({
        classify: vi.fn().mockRejectedValue(error),
        repository: { findAudienceSubject: vi.fn().mockResolvedValue({ ...SUBJECT }), createDecision },
      });
      expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
      expect(createDecision).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "allow_unverified", deferReason }),
      );
    });

    it("allows on an unreadable response and audits it", async () => {
      const createDecision = vi.fn().mockResolvedValue({ id: "audit-1" });
      const { service } = harness({
        classify: vi.fn().mockResolvedValue({
          verdicts: [],
          costUsd: 0.00015,
          modelId: "gemini-2.5-flash",
          promptVersion: "llm_v3",
          finishReason: "MAX_TOKENS",
        }),
        repository: { findAudienceSubject: vi.fn().mockResolvedValue({ ...SUBJECT }), createDecision },
      });
      expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
      expect(createDecision).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "allow_unverified", deferReason: "invalid_provider_response" }),
      );
    });

    it("blocks with a null auditId when the audit write fails", async () => {
      const { service } = harness({
        repository: {
          findAudienceSubject: vi.fn().mockResolvedValue({
            ...SUBJECT,
            inferredOrigin: "south_asian",
            originConfidence: "low",
            originMethod: "llm_v3",
          }),
          createDecision: vi.fn().mockRejectedValue(new Error("db down")),
        },
      });
      expect(await service.authorizeNewGuideAction(ACTION)).toEqual({
        kind: "block",
        auditId: null,
      });
    });

    it("allows with no call and no row when the flag is off", async () => {
      const { service, classify, createDecision } = harness({ isEnabled: () => false });
      expect(await service.authorizeNewGuideAction(ACTION)).toEqual({ kind: "allow" });
      expect(classify).not.toHaveBeenCalled();
      expect(createDecision).not.toHaveBeenCalled();
    });

    it("allows with no call when Gemini is disabled and nothing is stored", async () => {
      const { service, classify } = harness({ classifierEnabled: false });
      expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
      expect(classify).not.toHaveBeenCalled();
    });

    // Dash-only placeholders are absent fields, exactly as
    // classifyIdentityPresence already treats them for the enrichment worker.
    it.each([
      ["blank", null, "   "],
      ["dash-only", "-", "---"],
    ])("allows with no call when the identity is %s", async (_label, username, name) => {
      const { service, classify, createDecision } = harness({
        repository: {
          findAudienceSubject: vi.fn().mockResolvedValue({ ...SUBJECT, username, name }),
          createDecision: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
      });
      expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
      expect(classify).not.toHaveBeenCalled();
      expect(createDecision).not.toHaveBeenCalled();
    });

    it("allows with no call when the person has no row at all", async () => {
      const { service, classify } = harness({
        repository: {
          findAudienceSubject: vi.fn().mockResolvedValue(null),
          createDecision: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
      });
      expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
      expect(classify).not.toHaveBeenCalled();
    });

    it("allows when the stored read itself throws", async () => {
      const { service } = harness({
        repository: {
          findAudienceSubject: vi.fn().mockRejectedValue(new Error("db down")),
          createDecision: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
      });
      expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
    });
  });
  ```
- [ ] Run `npx vitest run src/services/guideAudienceAuthorization.test.ts`. Confirm it fails to compile against the old service.
- [ ] Rewrite `src/services/guideAudienceAuthorization.ts`:
  ```ts
  import { createHash } from "node:crypto";
  import { isAxiosError } from "axios";
  import type {
    GuideAudienceActionSource,
    GuideAudienceConfidence,
    GuideAudienceDeferReason,
    GuideAudienceOrigin,
  } from "@prisma/client";
  import { env } from "../config/env.js";
  import { geminiEnabled } from "../meta/geminiClient.js";
  import { flags } from "./flagService.js";
  import {
    guideAudienceAuthorizationRepository,
    type GuideAudienceAuthorizationRepository,
    type GuideAudienceSubject,
  } from "./guideAudienceAuthorizationRepository.js";
  import {
    classifyIdentityPresence,
    CURRENT_ORIGIN_METHOD,
  } from "./historicalAudienceSegment.js";
  import { classifyOrigins } from "./originClassifier.js";
  import {
    compareAndSetOrigin,
    originVerdictWriteData,
    readStoredOrigin,
  } from "./originVerdictStore.js";

  export type { GuideAudienceAuthorizationRepository } from "./guideAudienceAuthorizationRepository.js";

  export const GUIDE_AUDIENCE_PROVIDER = "gemini" as const;

  /** Same 80-char cap the classifier's roster applies, so the hashed snapshot and
   * the classified snapshot are the same string. */
  const IDENTITY_FIELD_LIMIT = 80;

  export type AuthorizeNewGuideActionInput = {
    igUserId: string;
    source: GuideAudienceActionSource;
    conversationId?: string;
    commentId?: string;
    inboundMessageId?: string;
    resourceId?: string;
  };

  export type GuideAudienceAuthorization =
    | { kind: "allow" }
    | { kind: "block"; auditId: string | null };

  export type GuideAudienceAuthorizationServiceDependencies = {
    repository: GuideAudienceAuthorizationRepository;
    classify: typeof classifyOrigins;
    persistVerdict: typeof compareAndSetOrigin;
    isEnabled(): boolean;
    classifierEnabled: boolean;
    timeoutMs: number;
    now?: () => Date;
  };

  const ALLOW: GuideAudienceAuthorization = { kind: "allow" };

  function safeIdentityField(value: string | null): string {
    if (!value) return "";
    return value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, IDENTITY_FIELD_LIMIT);
  }

  /** guide_audience_decision.identity_hash is CHAR(64) NOT NULL: the audit row
   * anchors to an identity without storing the name or username. */
  function identitySnapshot(subject: GuideAudienceSubject): {
    name: string;
    username: string;
    hash: string;
  } {
    const name = safeIdentityField(subject.name);
    const username = safeIdentityField(subject.username);
    return {
      name,
      username,
      hash: createHash("sha256").update(JSON.stringify({ name, username })).digest("hex"),
    };
  }

  function unverifiedReason(error: unknown): GuideAudienceDeferReason {
    if (isAxiosError(error) && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")) {
      return "provider_timeout";
    }
    return "provider_unavailable";
  }

  export function createGuideAudienceAuthorizationService(
    dependencies: GuideAudienceAuthorizationServiceDependencies,
  ) {
    const now = dependencies.now ?? (() => new Date());

    async function block(
      input: AuthorizeNewGuideActionInput,
      identityHash: string,
      origin: GuideAudienceOrigin,
      confidence: GuideAudienceConfidence,
    ): Promise<GuideAudienceAuthorization> {
      try {
        const audit = await dependencies.repository.createDecision({
          ...input,
          identityHash,
          kind: "block",
          origin,
          confidence,
          provider: GUIDE_AUDIENCE_PROVIDER,
          modelId: env.GEMINI_MODEL,
          method: CURRENT_ORIGIN_METHOD,
        });
        return { kind: "block", auditId: audit.id };
      } catch {
        // An unauditable block is still a block. The verdict was explicit; only
        // the record of it was lost.
        return { kind: "block", auditId: null };
      }
    }

    /** No verdict, and the send goes out. Recorded so the operator can tell a
     * policy decision from a broken classifier: more than a few percent of these
     * means raise GUIDE_AUDIENCE_TIMEOUT_MS, not change the policy. */
    async function allowUnverified(
      input: AuthorizeNewGuideActionInput,
      identityHash: string,
      reason: GuideAudienceDeferReason,
    ): Promise<GuideAudienceAuthorization> {
      try {
        await dependencies.repository.createDecision({
          ...input,
          identityHash,
          kind: "allow_unverified",
          deferReason: reason,
          provider: GUIDE_AUDIENCE_PROVIDER,
          modelId: env.GEMINI_MODEL,
          method: CURRENT_ORIGIN_METHOD,
        });
      } catch {
        // Audit-only. Losing the row must not change the send.
      }
      return ALLOW;
    }

    return {
      async authorizeNewGuideAction(
        input: AuthorizeNewGuideActionInput,
      ): Promise<GuideAudienceAuthorization> {
        try {
          if (!dependencies.isEnabled()) return ALLOW;
        } catch {
          return ALLOW;
        }

        let subject: GuideAudienceSubject | null;
        try {
          subject = await dependencies.repository.findAudienceSubject(input.igUserId);
        } catch {
          return ALLOW;
        }
        // An absent row is a miss with nothing to classify, not an error.
        if (!subject) return ALLOW;

        const snapshot = identitySnapshot(subject);

        const stored = readStoredOrigin(subject);
        if (stored) {
          return stored.origin === "south_asian"
            ? block(input, snapshot.hash, "south_asian", stored.confidence)
            : ALLOW;
        }

        // Nothing to screen. Gemini's own answer for an empty roster entry is
        // `unknown`, which sends anyway, so skip the call and the cost. This is
        // the worker's own predicate, so "-" and "---" count as absent here too
        // rather than being billed as a name.
        const absent = classifyIdentityPresence({
          username: subject.username,
          name: subject.name,
        });
        if (absent) return ALLOW;
        if (!dependencies.classifierEnabled) return ALLOW;

        let result;
        try {
          result = await dependencies.classify(
            [{ id: subject.id, username: subject.username, name: subject.name }],
            { timeoutMs: dependencies.timeoutMs },
          );
        } catch (error) {
          return allowUnverified(input, snapshot.hash, unverifiedReason(error));
        }

        const verdict = result.verdicts.find((v) => v.id === subject.id);
        if (!verdict) {
          return allowUnverified(input, snapshot.hash, "invalid_provider_response");
        }

        // Write back through the identity-guarded path so the next interaction —
        // and the DM-recovery gate — read the same verdict from the same column.
        // A rename between the read and here makes this a no-op rather than
        // stamping the new identity with the old one's answer.
        try {
          await dependencies.persistVerdict([
            {
              candidate: { id: subject.id, username: subject.username, name: subject.name },
              data: originVerdictWriteData(verdict, now()),
            },
          ]);
        } catch {
          // Cache-only. The verdict in hand still decides this action.
        }

        return verdict.origin === "south_asian"
          ? block(input, snapshot.hash, "south_asian", verdict.confidence)
          : ALLOW;
      },
    };
  }

  export const guideAudienceAuthorization = createGuideAudienceAuthorizationService({
    repository: guideAudienceAuthorizationRepository,
    classify: classifyOrigins,
    persistVerdict: compareAndSetOrigin,
    isEnabled: () => flags.bool("GUIDE_AUDIENCE_BLOCK_ENABLED"),
    classifierEnabled: geminiEnabled,
    timeoutMs: env.GUIDE_AUDIENCE_TIMEOUT_MS,
  });
  ```
- [ ] Run `npx vitest run src/services/guideAudienceAuthorization.test.ts`. Confirm every case passes.
- [ ] Delete the NVIDIA classifier: `git rm src/services/nvidiaAudienceClassifier.ts src/services/nvidiaAudienceClassifier.test.ts`

  That file also owned the `AudienceClassificationProvider` interface (`:25`) and `createTimeoutRetryingAudienceClassifier` (`:52`), so both go with it. One implementation remains, so the seam is dead weight — and the retry wrapper is actively wrong now: a retry inside a 3,000ms ceiling splits the same budget. Three files import the type and must stop: `guideAudienceAuthorization.ts:18` and `:48` (the rewritten `GuideAudienceAuthorizationServiceDependencies` above replaces `provider: AudienceClassificationProvider` with `classify: typeof classifyOrigins`), `guideAudienceAuthorization.test.ts:6` and `:36`, and `guideAudiencePolicy.integration.test.ts:8` and `:78`. `npx tsc --noEmit` at the end of this task is what proves none survived.
- [ ] In `src/config/env.ts`, delete lines 126-139 (`NVIDIA_API_KEY` through `NVIDIA_AUDIENCE_RECOVERY_TIMEOUT_MS`). Keep `GUIDE_AUDIENCE_BLOCK_ENABLED` and the `GUIDE_AUDIENCE_TIMEOUT_MS` added in Task 2.
- [ ] In `src/config/env.test.ts`, delete the NVIDIA case at lines 20-40 and replace it with:
  ```ts
  it("keeps guide-audience enforcement disabled unless explicitly configured", () => {
    expect(envSchema.parse(baseEnv).GUIDE_AUDIENCE_BLOCK_ENABLED).toBe(false);
  });

  it("does not carry a provider credential for the audience classifier", () => {
    expect(envSchema.parse(baseEnv)).not.toHaveProperty("NVIDIA_API_KEY");
  });
  ```
- [ ] Rewrite `src/services/guideAudienceAuthorizationRepository.test.ts` for the two surviving methods: `findAudienceSubject` selects the six fields and returns `null` for an absent row; `createDecision` maps `origin`/`confidence`/`deferReason` to `null` when omitted. Use a fake `GuideAudienceAuthorizationDatabase` with `vi.fn()` for `igUser.findUnique` and `guideAudienceDecision.create`, matching the existing file's style.
- [ ] Run `npx vitest run src/services/guideAudienceAuthorizationRepository.test.ts`. Confirm it passes.
- [ ] Rewrite `src/services/guideAudiencePolicy.integration.test.ts` against the contract database. Start it with the env guard the other DB suites use, then assert:
  1. A `south_asian`/low stored verdict writes exactly one `guide_audience_decision` row with `kind = 'block'`, `origin = 'south_asian'`, `confidence = 'low'`, `provider = 'gemini'`, `method = 'llm_v3'`, `classification_id IS NULL`.
  2. A classifier throw writes exactly one row with `kind = 'allow_unverified'` and `defer_reason = 'provider_unavailable'`, and the service returns `allow`.
  3. `compareAndSetOrigin` writes 0 rows when the username changed between the read and the write, and the stored verdict stays null.
  Drop the `nvidiaAudienceClassifier` import entirely.
- [ ] Start the contract database and run the suite:
  ```bash
  docker start insta-contract-pg && npx vitest run src/services/guideAudiencePolicy.integration.test.ts
  ```
  If the container does not exist, create it with user/password `postgres`/`disposable`, database `contract`, port 5433, then `npx prisma migrate deploy` against it. If assertions fail on row counts, truncate `guide_audience_decision` and re-run once before suspecting the code, and confirm `npx prisma generate` has run since Task 3.
- [ ] In `prisma/schema.prisma`, replace the comment at lines 960-961:
  ```prisma
  // The guide gate and the DM-recovery gate read ONE verdict: ig_users.inferred_origin
  // at origin_method = 'llm_v3'. These enums are the audit-row vocabulary for that
  // same verdict, not a second opinion — their values are exactly the Origin and
  // confidence values stored on IgUser and must stay aligned with them.
  ```
- [ ] Run `npx tsc --noEmit`. Confirm clean and that no `nvidia` identifier survives:
  ```bash
  grep -rni --include='*.ts' nvidia src scripts
  ```
  Expect no matches.
- [ ] Run `npm test`. Confirm no new failures against the Task 5 baseline.
- [ ] Commit: `feat: gate guide sends on the Gemini origin verdict`

---

## Task 7: Prove it at the Graph boundary

The five Critical bugs on a comparable branch all sat exactly where tests mocked the boundary. This test mocks nothing between the handler and the Graph client.

**Files:**
- Create: `src/handlers/guideAudienceGate.handler.test.ts`

**Interfaces:**

Consumes: `handleComment` from `./commentHandler.js`; the two axios instances that own every outbound HTTP call on this path — `graph` from `../meta/graphClient.js` (`src/meta/graphClient.ts:9`) and `gemini` from `../meta/geminiClient.js` (`src/meta/geminiClient.ts:13`); `prisma` from `../lib/prisma.js`.

Produces: no exports.

**Steps:**

- [ ] Create `src/handlers/guideAudienceGate.handler.test.ts`. It copies the mock block from `commentHandler.test.ts:51-108` with three modules deliberately **left real** — `../services/guideAudienceAuthorization.js`, `../meta/replyToComment.js` and `../services/dmDeliveryService.js` — so the public reply reaches `graph.post("/{commentId}/replies")` (`replyToComment.ts`) and the DM reaches `graph.post("/{IG_USER_ID}/messages")` through `sendPrivateReply` (`sendMessage.ts:32`). In their place it mocks the two HTTP clients, plus `../services/dmThreadService.js` so the real `sendTrackedPrivateReply` does not write to Postgres after a send:
  ```ts
  const graphPost = vi.fn().mockResolvedValue({ data: { id: "meta-1" } });
  const geminiPost = vi.fn();
  const findUnique = vi.fn();
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const createDecision = vi.fn().mockResolvedValue({ id: "audit-1" });

  vi.mock("../meta/graphClient.js", () => ({
    graph: { post: graphPost, get: vi.fn(), interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } },
    GRAPH_VERSION: "v21.0",
  }));
  vi.mock("../meta/geminiClient.js", () => ({
    gemini: { post: geminiPost },
    geminiEnabled: true,
    GeminiDisabledError: class GeminiDisabledError extends Error {},
  }));
  vi.mock("../services/dmThreadService.js", () => ({ recordOutboundMessage: vi.fn() }));
  vi.mock("../lib/prisma.js", () => ({
    prisma: {
      igUser: { findUnique, updateMany },
      guideAudienceDecision: { create: createDecision },
      $transaction: (operations: unknown[]) => Promise.all(operations as Promise<unknown>[]),
    },
  }));
  vi.mock("../config/env.js", () => ({
    env: {
      IG_USER_ID: "ig-account-owner",
      DM_RECOVERY_SETTINGS_BLOCKED_SIGNATURES: "10:12345",
      GEMINI_MODEL: "gemini-2.5-flash",
      GEMINI_API_KEY: "test-key",
      GUIDE_AUDIENCE_BLOCK_ENABLED: true,
      GUIDE_AUDIENCE_TIMEOUT_MS: 3_000,
    },
  }));
  ```
  `GRAPH_VERSION` is exported for completeness only — nothing outside `graphClient.ts` imports it. Mocking the module means `tokenStore.js` and the real request interceptor are never loaded, so no access token is resolved.
- [ ] In the same file, wire the happy path so a matched comment would normally reply: `claimComment` resolves claimed, `findKeywordForComment` returns a keyword, `resolveJourneyIntent` returns the disposition that leads to a public reply, `gateOwner` returns the V2 owner, `rememberUsername` resolves. Copy those fixtures from the passing positive-path test in `commentHandler.test.ts` rather than inventing them, then assert:
  ```ts
  const COMMENT = {
    id: "comment-audience-1",
    text: "sleep",
    from: { id: "ig-parent", username: "parent" },
    media: { id: "reel-1", media_product_type: "REELS" },
  };

  it("makes no outbound HTTP call for a stored south_asian commenter", async () => {
    findUnique.mockResolvedValue({
      id: "ig-parent", username: "parent", name: "Priya Sharma",
      inferredOrigin: "south_asian", originConfidence: "high", originMethod: "llm_v3",
    });
    await handleComment(COMMENT);
    expect(graphPost).not.toHaveBeenCalled();
    expect(geminiPost).not.toHaveBeenCalled();
    expect(createDecision).toHaveBeenCalledWith(expect.objectContaining({ kind: "block" }));
  });

  it("replies for a stored us_western commenter", async () => {
    findUnique.mockResolvedValue({
      id: "ig-parent", username: "parent", name: "Sarah Jones",
      inferredOrigin: "us_western", originConfidence: "low", originMethod: "llm_v3",
    });
    await handleComment(COMMENT);
    expect(graphPost).toHaveBeenCalled();
  });

  // Fail open, proven end to end: the axios timeout is the only thing that fired.
  it("replies when the Gemini call times out", async () => {
    findUnique.mockResolvedValue({
      id: "ig-parent", username: "parent", name: "Sarah Jones",
      inferredOrigin: null, originConfidence: null, originMethod: null,
    });
    geminiPost.mockRejectedValue(
      Object.assign(new Error("timeout of 3000ms exceeded"), {
        isAxiosError: true, code: "ECONNABORTED",
      }),
    );
    await handleComment(COMMENT);
    expect(geminiPost).toHaveBeenCalledTimes(1);
    expect(graphPost).toHaveBeenCalled();
    expect(createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "allow_unverified", deferReason: "provider_timeout" }),
    );
  });
  ```
- [ ] Run `npx vitest run src/handlers/guideAudienceGate.handler.test.ts`. Confirm all three pass. If the south_asian case still calls `graphPost`, trace which call escaped the gate — that is the bug this task exists to find, and it must be fixed in the handler, not accommodated in the test.
- [ ] Run `npm test`. Confirm no new failures.
- [ ] Commit: `test: prove the audience gate stops every outbound Meta call`

---

## Task 8: M2 migration — drop the classification table

**Ship only after Task 6 has run in production with the flag on and step 3 of the rollout holds.** This is the only irreversible step and it is not needed to stop the replies.

**Files:**
- Create: `prisma/migrations/20260928010000_drop_guide_audience_classification/migration.sql`
- Modify: `prisma/schema.prisma` (delete `model GuideAudienceClassification` at 1006-1025; delete `classificationId` and the `classification` relation from `GuideAudienceDecision`; remove `GuideAudienceClassification[]` from `IgUser`)
- Modify: `src/services/guideAudienceAuthorizationMigrationContract.test.ts`

**Interfaces:**

Consumes: nothing.
Produces: `GuideAudienceDecision` loses `classificationId` and `classification`. `prisma.guideAudienceClassification` no longer exists.

**Steps:**

- [ ] Confirm no code references the table:
  ```bash
  grep -rn --include='*.ts' -e 'guideAudienceClassification' -e 'classificationId' -e 'GuideAudienceClassification' src scripts
  ```
  Expect no matches. If any survive, they are leftovers from Task 6 — remove them before migrating.
- [ ] Add a failing assertion to `src/services/guideAudienceAuthorizationMigrationContract.test.ts`:
  ```ts
  const m2Url = new URL(
    "../../prisma/migrations/20260928010000_drop_guide_audience_classification/migration.sql",
    import.meta.url,
  );

  it("drops the superseded classification store", async () => {
    const sql = await readFile(m2Url, "utf8");
    expect(sql).toContain(`DROP COLUMN IF EXISTS "classification_id"`);
    expect(sql).toContain(`DROP TABLE IF EXISTS "guide_audience_classification"`);
    // The verdict must already live on the decision row before the table goes.
    expect(sql).not.toContain(`DROP COLUMN IF EXISTS "origin"`);
  });
  ```
- [ ] Run `npx vitest run src/services/guideAudienceAuthorizationMigrationContract.test.ts`. Confirm the new case fails.
- [ ] Create `prisma/migrations/20260928010000_drop_guide_audience_classification/migration.sql`:
  ```sql
  -- The verdict now lives on guide_audience_decision.origin/confidence, written by
  -- the 20260927010000 migration, and the gate reads ig_users.inferred_origin
  -- rather than a hash-keyed copy. Historical rows keep their verdict on the
  -- decision row; only the unreferenced FK and the store go.

  BEGIN;

  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '30s';

  ALTER TABLE "guide_audience_decision" DROP COLUMN IF EXISTS "classification_id";
  DROP TABLE IF EXISTS "guide_audience_classification";

  COMMIT;
  ```
- [ ] Update `prisma/schema.prisma` as listed under Files, then run `npx prisma generate`. Confirm it succeeds.
- [ ] Run `npx vitest run src/services/guideAudienceAuthorizationMigrationContract.test.ts`. Confirm it passes.
- [ ] Run `npx tsc --noEmit` and `npm test`. Confirm clean and no new failures.
- [ ] Commit: `chore: drop the superseded guide audience classification store`

---

## Rollout

1. Confirm `GUIDE_AUDIENCE_BLOCK_ENABLED` is `false` on the Railway `api` service, then merge Tasks 1-7. Vercel and Railway both deploy from `main` on merge; **never run `railway up`**. `flag_override` is empty, so the env value takes effect.
2. Remove `NVIDIA_API_KEY` from the Railway `api` service variables.
3. Flip `GUIDE_AUDIENCE_BLOCK_ENABLED` to `true`. Watch `guide_audience_decision` for an hour:
   ```sql
   SELECT kind, defer_reason, origin, confidence, count(*)
   FROM guide_audience_decision
   WHERE created_at > now() - interval '1 hour'
   GROUP BY 1,2,3,4 ORDER BY 5 DESC;
   ```
4. Expected: ~42% `block` among classified users, near-zero `allow_unverified`. NVIDIA's comparable figure was 69% failure.
5. If `allow_unverified` exceeds a few percent, the Gemini call is the problem, not the policy — raise `GUIDE_AUDIENCE_TIMEOUT_MS` before changing anything else.
6. Ship Task 8 once step 4 holds.

## Non-goals

- No change to the DM-recovery reminder's own gate. `DM_RECOVERY_WESTERN_ONLY` and `dmRecoveryPolicy.ts:222` stay exactly as they are.
- No new dashboard surface. The decision table is read by SQL.
- No change to `originEnrichmentWorker`'s batch schedule, budget, or prompt version.
- No backfill of the 924 comments already sent. They are sent.
- No per-user country lookup. Meta exposes none; origin stays an explicit name-based proxy.
