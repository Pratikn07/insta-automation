# Flags Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One page showing all 16 flags with a plain-English description each, live control of the safe ones, and a working stop for the three that reach real people.

**Architecture:** Static flag metadata lives in code (`src/config/flagRegistry.ts`); only mutable values live in the database (`flag_override`). A resolver reads override → env → schema default and fails closed. The React page reads one endpoint and writes one.

**Tech Stack:** Express, Prisma/Postgres, Zod, React 19, TanStack Query, Vitest, Playwright.

## Deviation from the spec, and why

The spec (§6) put `does_what` / `affects_who` / `if_off` as `NOT NULL` columns on a
`flag` table. This plan puts them in a **TypeScript registry** instead, and the database
holds only values.

Three reasons, all of which make the owner's "every time" requirement stronger:

1. The coverage check becomes a **plain unit test** with no database, so it runs in
   `npm test` on every commit rather than as a separate script someone must remember.
2. Descriptions get **code review**, in the same commit as the code that reads the flag.
3. Adding a flag to `env.ts` without a description **fails the build**, which is the
   enforcement the owner actually asked for.

`page_may_enable` and `page_may_stop` move to the registry for the same reason: they are
safety facts about the code, not user-editable data.

## Global Constraints

- **Never `z.coerce.boolean()` for a flag.** Use `booleanFlag()` from `src/config/booleanFlag.ts`. `AI_SEND_ENABLED=false` parses to `true` under coercion.
- **Fail closed.** The resolver must never return a value more permissive than env. A database problem makes the system quieter, never louder.
- **Enable fence is server-side.** `pageMayEnable: false` is checked in the route, not only in the UI.
- **A stop is only offered where it works.** `pageMayStop: true` requires a test proving the next operation halts.
- **No `api()` in web code.** Use `apiRead` / `apiMutation` from `web/src/lib/api.ts`.
- **Every new mutation route gets a row** in `docs/client-operation-contracts.md`.
- **Chips clear 4.5:1** on both `#f7f5ef` and `#fffef9`. Reuse the token pairs proven in `web/src/components/upcomingStatusContrast.test.ts`.
- **Backend contract tests need the disposable Postgres:** `DATABASE_URL`, `MIGRATION_TEST_DATABASE_URL` (identical), and `MIGRATION_TEST_DATABASE_DISPOSABLE=true`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/config/flagRegistry.ts` | **New.** The 16 definitions: key, name, group, kind, three descriptions, safety booleans. No logic. |
| `src/config/flagRegistry.test.ts` | **New.** Every env flag has a definition; every definition matches an env key; descriptions non-empty. |
| `prisma/migrations/20260818010000_add_flag_override/migration.sql` | **New.** One table. |
| `prisma/schema.prisma` | Modify. `FlagOverride` model. |
| `src/services/flagResolver.ts` | **New.** Pure precedence. No Prisma, no cache. |
| `src/services/flagService.ts` | **New.** Cached reader over `flagResolver` + Prisma. The only impure part. |
| `src/api/flags.routes.ts` | **New.** `GET /flags`, `PATCH /flags/:key`. |
| `src/api/router.ts` | Modify. Register the router. |
| `src/services/guideDeliveryWorker.ts:87-96` | Modify. `enabled: boolean` → `isEnabled: () => boolean`. |
| `web/src/pages/Flags.tsx` | **New.** The page: groups, rows, controls. |
| `web/src/lib/navigation.ts` | Modify. Add the destination under System. |
| `web/src/lib/types.ts` | Modify. `FlagView`, `FlagsResponse`. |
| `web/src/AppRoutes.tsx` | Modify. Add the route. |
| `docs/experiments.md` | **New.** The standard. |

---

### Task 1: The flag registry and its coverage test

**Files:**
- Create: `src/config/flagRegistry.ts`
- Test: `src/config/flagRegistry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FlagGroup`, `FlagKind`, `FlagDefinition`, `FLAG_REGISTRY`, `flagDefinition(key: string): FlagDefinition | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// src/config/flagRegistry.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLAG_REGISTRY, flagDefinition } from "./flagRegistry.js";

/** Flag-shaped entries in env.ts: booleanFlag(...) or a *_PERCENT number. */
function envFlagKeys(): string[] {
  const source = readFileSync(new URL("./env.ts", import.meta.url), "utf8");
  const keys: string[] = [];
  for (const line of source.split("\n")) {
    const match = line.match(/^\s{2}([A-Z][A-Z0-9_]+):\s*(booleanFlag\(|z\.coerce\.number)/);
    if (!match) continue;
    const key = match[1]!;
    if (match[2].startsWith("booleanFlag") || /_PERCENT$/.test(key)) keys.push(key);
  }
  return keys;
}

describe("flag registry coverage", () => {
  it("has a definition for every flag in env.ts", () => {
    const missing = envFlagKeys().filter((key) => !flagDefinition(key));
    expect(missing).toEqual([]);
  });

  it("has no definition for a key env.ts does not define", () => {
    const envKeys = new Set(envFlagKeys());
    const orphans = FLAG_REGISTRY.filter((d) => !envKeys.has(d.key)).map((d) => d.key);
    expect(orphans).toEqual([]);
  });

  it("gives every flag all three plain-language answers", () => {
    for (const d of FLAG_REGISTRY) {
      expect(d.doesWhat.length, `${d.key} doesWhat`).toBeGreaterThan(20);
      expect(d.affectsWho.length, `${d.key} affectsWho`).toBeGreaterThan(10);
      expect(d.ifOff.length, `${d.key} ifOff`).toBeGreaterThan(10);
    }
  });

  it("uses no field names or code identifiers in the descriptions", () => {
    for (const d of FLAG_REGISTRY) {
      const prose = `${d.doesWhat} ${d.affectsWho} ${d.ifOff}`;
      expect(prose, `${d.key} reads like code`).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
  });

  // A flag the page can neither enable nor stop is display-only. That is allowed,
  // but claiming to stop something boot-read is not.
  it("never offers a stop on an infrastructure flag", () => {
    for (const d of FLAG_REGISTRY) {
      if (d.group === "infrastructure") expect(d.pageMayStop, d.key).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run flagRegistry`
Expected: FAIL — cannot resolve `./flagRegistry.js`.

- [ ] **Step 3: Write the registry**

```ts
// src/config/flagRegistry.ts
/**
 * What every switch in this system does, in words a person can act on.
 *
 * This lives in code rather than the database on purpose. A description in a
 * table can be added later, or never; a description here is reviewed in the
 * same commit as the flag it explains, and flagRegistry.test.ts fails the build
 * when a flag is added to env.ts without one.
 *
 * The database stores only VALUES. Everything here is a fact about the code.
 */

export type FlagGroup = "outbound" | "experiment" | "assistive" | "infrastructure";
export type FlagKind = "boolean" | "percent";

export interface FlagDefinition {
  /** Exactly the env var name. */
  key: string;
  name: string;
  group: FlagGroup;
  kind: FlagKind;
  /** One or two sentences. No jargon, no field names. */
  doesWhat: string;
  affectsWho: string;
  ifOff: string;
  /**
   * May the page switch this ON? False wherever turning it on begins contacting
   * real people. Checked in the route, not only in the UI.
   */
  pageMayEnable: boolean;
  /**
   * May the page switch this OFF? True only where the flag is read per
   * operation, so the stop actually takes effect. See docs/experiments.md rule 7.
   */
  pageMayStop: boolean;
}

export const FLAG_REGISTRY: readonly FlagDefinition[] = [
  // ── Outbound: turning these on starts contacting people ──────────────────
  {
    key: "DM_RECOVERY_ENABLED",
    name: "Recovery reminders",
    group: "outbound",
    kind: "boolean",
    doesWhat:
      "When someone asks for a guide but never opens our message, leaves a public comment on the reel telling them to check their message requests.",
    affectsWho:
      "People who commented a keyword and were sent a guide, but have not opened it. Around 190 a week.",
    ifOff:
      "No public reminders are posted. People who miss the message simply never get the guide.",
    pageMayEnable: false,
    pageMayStop: true,
  },
  {
    key: "GUIDE_DELIVERY_ENABLED",
    name: "Guide delivery",
    group: "outbound",
    kind: "boolean",
    doesWhat:
      "Sends the guide itself, step by step, once someone has followed and replied.",
    affectsWho: "Everyone who completes the unlock steps.",
    ifOff:
      "New guides stop being sent through this path, and anything already queued stops on the next check.",
    pageMayEnable: false,
    pageMayStop: true,
  },
  {
    key: "GUIDE_DELIVERY_ROLLOUT_PERCENT",
    name: "Guide delivery rollout",
    group: "outbound",
    kind: "percent",
    doesWhat:
      "How many people are served by the newer delivery path rather than the older one.",
    affectsWho: "New guide requests only. Deliveries already under way are unaffected.",
    ifOff: "At zero, everyone is served by the older path.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "AI_SEND_ENABLED",
    name: "AI sending",
    group: "outbound",
    kind: "boolean",
    doesWhat: "Lets an approved AI-written reply actually be sent to the person.",
    affectsWho: "Anyone in a conversation where you approve an AI reply.",
    ifOff: "Approving a reply is refused. Drafts can still be written and read.",
    pageMayEnable: false,
    pageMayStop: true,
  },
  {
    key: "UPCOMING_AUTOMATIONS_ENABLED",
    name: "Set up in advance",
    group: "outbound",
    kind: "boolean",
    doesWhat:
      "Attaches a keyword to a post Instagram has not published yet, by watching for a post whose caption contains that word.",
    affectsWho: "Posts you schedule inside Instagram. Nothing happens until one publishes.",
    ifOff:
      "Prepared setups stop attaching themselves, and a word one of them reserved gets no reply at all — not even from an older post.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "DM_RECOVERY_HISTORICAL_ENABLED",
    name: "Historical recovery campaigns",
    group: "outbound",
    kind: "boolean",
    doesWhat:
      "Runs an approved campaign that reaches back to people from before reminders existed and posts the same public comment.",
    affectsWho:
      "Only people inside a campaign you have approved. With no approved campaign, nothing happens.",
    ifOff: "Approved campaigns stop sending. Nothing already sent is affected.",
    pageMayEnable: true,
    pageMayStop: true,
  },

  // ── Experiments: measuring something ─────────────────────────────────────
  {
    key: "GATE_DM_EXPERIMENT",
    name: "Cold message test",
    group: "experiment",
    kind: "boolean",
    doesWhat:
      "Tries an ordinary message to people whose unlock message already failed every attempt, to find out whether a cold message is ever accepted.",
    affectsWho: "Only people whose unlock message already ran out of retries. Nobody new.",
    ifOff: "Those conversations are left alone.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "DM_RECOVERY_HOLDOUT_PERCENT",
    name: "Reminder holdout",
    group: "experiment",
    kind: "percent",
    doesWhat:
      "The share of people deliberately left without a reminder, so we can tell whether reminding helps at all.",
    affectsWho: "A fixed share of people eligible for a reminder.",
    ifOff:
      "At zero, everyone eligible gets a reminder and there is no way to prove the reminder is what worked.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "DM_RECOVERY_POST_EXPERIMENT_ENABLED",
    name: "Keep reminding after the test ends",
    group: "experiment",
    kind: "boolean",
    doesWhat:
      "Keeps sending reminders after the test window closes, instead of pausing everything until someone reviews the result.",
    affectsWho: "Everyone eligible for a reminder after the window closes.",
    ifOff:
      "Once the window closes, reminders stop and wait for a decision. Nothing announces it, which is why this flag is worth watching.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "DM_RECOVERY_WESTERN_ONLY",
    name: "Western audience only",
    group: "experiment",
    kind: "boolean",
    doesWhat:
      "Withholds the public reminder when someone looks likely to be outside the audience this account sells to.",
    affectsWho:
      "People whose name suggests an origin outside that audience. It withheld 265 reminders in the last 11 days.",
    ifOff: "Reminders are posted regardless of where the person appears to be from.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "DM_RECOVERY_ORIGIN_LLM_ENABLED",
    name: "Better origin guess",
    group: "experiment",
    kind: "boolean",
    doesWhat:
      "Improves the guess about where someone is from by asking a model, instead of matching name fragments against a list.",
    affectsWho:
      "The guess stored against each person. Measured on 50 real cases: the list caught 3, the model caught 22, with no false positives.",
    ifOff: "The name-fragment list is used instead, and catches far fewer.",
    pageMayEnable: true,
    pageMayStop: true,
  },

  // ── Assistive: nothing leaves the app ────────────────────────────────────
  {
    key: "AI_DRAFTS_ENABLED",
    name: "AI reply drafts",
    group: "assistive",
    kind: "boolean",
    doesWhat:
      "Writes a suggested reply for each conversation waiting on you, so you can send it with one tap instead of typing from scratch.",
    affectsWho: "Only you. A draft sits in Conversations until you approve it.",
    ifOff: "Suggestions stop appearing. You can still reply by hand.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "AI_FOLLOW_UPS_ENABLED",
    name: "AI follow-up drafts",
    group: "assistive",
    kind: "boolean",
    doesWhat:
      "Drafts a nudge for conversations that went quiet after the guide was sent. Sending it still needs AI sending switched on separately.",
    affectsWho: "Only you, until you approve one.",
    ifOff: "No follow-up drafts are written. Nothing already scheduled is sent.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "AI_ADVISOR_ENABLED",
    name: "Assistant",
    group: "assistive",
    kind: "boolean",
    doesWhat: "Lets you ask questions about your own numbers and get an answer in words.",
    affectsWho: "Only you.",
    ifOff: "The Assistant page stops answering. Every other number still works.",
    pageMayEnable: true,
    pageMayStop: true,
  },

  // ── Infrastructure: not a product choice ─────────────────────────────────
  {
    key: "WORKERS_ENABLED",
    name: "Background jobs",
    group: "infrastructure",
    kind: "boolean",
    doesWhat:
      "Runs everything that happens without you: sending queued messages, refreshing the Instagram connection, taking daily follower readings.",
    affectsWho: "All automation. The console still works with this off; the system does nothing on its own.",
    ifOff: "Nothing is sent, no readings are taken, and the Instagram connection stops renewing itself.",
    // Read once when the server starts, so a change here could not take effect
    // without a restart. Offering either control would be a lie.
    pageMayEnable: false,
    pageMayStop: false,
  },
] as const;

const BY_KEY = new Map(FLAG_REGISTRY.map((definition) => [definition.key, definition]));

export function flagDefinition(key: string): FlagDefinition | undefined {
  return BY_KEY.get(key);
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run flagRegistry`
Expected: PASS, 5 tests. If "has a definition for every flag" fails, the message
lists the missing keys — add them rather than loosening the regex.

- [ ] **Step 5: Commit**

```bash
git add src/config/flagRegistry.ts src/config/flagRegistry.test.ts
git commit -m "feat: describe every flag in words, and fail the build without one"
```

---

### Task 2: The `flag_override` table

**Files:**
- Create: `prisma/migrations/20260818010000_add_flag_override/migration.sql`
- Modify: `prisma/schema.prisma`
- Test: `src/services/flagOverrideMigrationContract.test.ts`

**Interfaces:**
- Consumes: `FlagKind` from Task 1.
- Produces: Prisma model `FlagOverride` with fields `key`, `valueBool`, `valuePercent`, `updatedBy`, `updatedAt`.

- [ ] **Step 1: Write the failing contract test**

```ts
// src/services/flagOverrideMigrationContract.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../prisma/migrations/20260818010000_add_flag_override/migration.sql",
  import.meta.url,
);

describe("flag override migration contract", () => {
  it("stores values only, keyed by the env var name", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain(`CREATE TABLE "flag_override"`);
    expect(sql).toContain(`"key" TEXT NOT NULL`);
    expect(sql).toContain(`CONSTRAINT "flag_override_pkey" PRIMARY KEY ("key")`);
  });

  // A row with neither value is meaningless, and a row with both is ambiguous
  // about which kind of flag it belongs to.
  it("requires exactly one of the two value columns", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain(`CONSTRAINT "flag_override_one_value_check"`);
    expect(sql).toMatch(/num_nonnulls\("value_bool",\s*"value_percent"\)\s*=\s*1/);
  });

  it("bounds a percentage to 0-100", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toMatch(/"value_percent" IS NULL OR \("value_percent" BETWEEN 0 AND 100\)/);
  });

  it("enables RLS without a browser-facing policy", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain(`ALTER TABLE "flag_override" ENABLE ROW LEVEL SECURITY`);
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run flagOverrideMigrationContract`
Expected: FAIL — ENOENT on the migration file.

- [ ] **Step 3: Write the migration**

```sql
-- prisma/migrations/20260818010000_add_flag_override/migration.sql

-- Values only. What each flag DOES lives in src/config/flagRegistry.ts, so a
-- description is reviewed with the code it describes and cannot be skipped.
--
-- A missing row means "no override" — the resolver falls through to the env
-- value. That is deliberate: an empty table must behave exactly like today.
CREATE TABLE "flag_override" (
    "key" TEXT NOT NULL,
    "value_bool" BOOLEAN,
    "value_percent" INTEGER,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flag_override_pkey" PRIMARY KEY ("key"),
    -- Exactly one, never both: a row carrying both values does not say which
    -- kind of flag it belongs to, and the resolver would have to guess.
    CONSTRAINT "flag_override_one_value_check"
      CHECK (num_nonnulls("value_bool", "value_percent") = 1),
    CONSTRAINT "flag_override_percent_range_check"
      CHECK ("value_percent" IS NULL OR ("value_percent" BETWEEN 0 AND 100))
);

-- The browser never reaches this table directly; the service-role admin API is
-- the only path, exactly as with upcoming_automations.
ALTER TABLE "flag_override" ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 4: Add the Prisma model**

Append to `prisma/schema.prisma`:

```prisma
/// Values only. Descriptions and safety facts live in src/config/flagRegistry.ts.
/// An absent row means "no override" — the resolver uses the environment value.
model FlagOverride {
  key          String   @id
  valueBool    Boolean? @map("value_bool")
  valuePercent Int?     @map("value_percent")
  updatedBy    String   @map("updated_by")
  updatedAt    DateTime @default(now()) @map("updated_at") @db.Timestamptz(3)

  @@map("flag_override")
}
```

- [ ] **Step 5: Run the contract and validate the schema**

```bash
npx prisma validate
npx prisma generate
export QA_DB="postgresql://postgres:codex_qa_only@127.0.0.1:55439/insta_contract"
DATABASE_URL="$QA_DB" MIGRATION_TEST_DATABASE_URL="$QA_DB" \
  MIGRATION_TEST_DATABASE_DISPOSABLE=true \
  npx vitest run --maxWorkers=1 flagOverrideMigrationContract
```

Expected: schema valid; 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add prisma/migrations/20260818010000_add_flag_override prisma/schema.prisma src/services/flagOverrideMigrationContract.test.ts
git commit -m "feat: add flag_override, values only"
```

---

### Task 3: The resolver, pure

**Files:**
- Create: `src/services/flagResolver.ts`
- Test: `src/services/flagResolver.test.ts`

**Interfaces:**
- Consumes: `FlagDefinition` from Task 1.
- Produces: `type FlagOverrideValue = { valueBool: boolean | null; valuePercent: number | null }`, `resolveBoolean(definition, override, envValue): boolean`, `resolvePercent(definition, override, envValue): number`.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/flagResolver.test.ts
import { describe, expect, it } from "vitest";
import { flagDefinition } from "../config/flagRegistry.js";
import { resolveBoolean, resolvePercent } from "./flagResolver.js";

const drafts = flagDefinition("AI_DRAFTS_ENABLED")!;
const send = flagDefinition("AI_SEND_ENABLED")!;
const rollout = flagDefinition("GUIDE_DELIVERY_ROLLOUT_PERCENT")!;

describe("resolveBoolean", () => {
  it("prefers an override over the environment", () => {
    expect(resolveBoolean(drafts, { valueBool: true, valuePercent: null }, false)).toBe(true);
    expect(resolveBoolean(drafts, { valueBool: false, valuePercent: null }, true)).toBe(false);
  });

  it("uses the environment when there is no override", () => {
    expect(resolveBoolean(drafts, null, true)).toBe(true);
    expect(resolveBoolean(drafts, { valueBool: null, valuePercent: null }, true)).toBe(true);
  });

  // The whole safety model. A row cannot switch on something the page is not
  // allowed to switch on, however it got written.
  it("refuses to enable a flag the page may not enable", () => {
    expect(resolveBoolean(send, { valueBool: true, valuePercent: null }, false)).toBe(false);
  });

  it("still lets that same flag be turned off", () => {
    expect(resolveBoolean(send, { valueBool: false, valuePercent: null }, true)).toBe(false);
  });
});

describe("resolvePercent", () => {
  it("prefers an override over the environment", () => {
    expect(resolvePercent(rollout, { valueBool: null, valuePercent: 100 }, 45)).toBe(100);
  });

  it("uses the environment when there is no override", () => {
    expect(resolvePercent(rollout, null, 45)).toBe(45);
  });

  it("clamps a stored value that is out of range", () => {
    expect(resolvePercent(rollout, { valueBool: null, valuePercent: 150 }, 45)).toBe(100);
    expect(resolvePercent(rollout, { valueBool: null, valuePercent: -5 }, 45)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run flagResolver`
Expected: FAIL — cannot resolve `./flagResolver.js`.

- [ ] **Step 3: Write the resolver**

```ts
// src/services/flagResolver.ts
import type { FlagDefinition } from "../config/flagRegistry.js";

/** The stored row, or null when nobody has overridden this flag. */
export type FlagOverrideValue = {
  valueBool: boolean | null;
  valuePercent: number | null;
};

/**
 * Resolve an on/off flag: override, else the environment.
 *
 * The `pageMayEnable` clause is the safety model, and it lives HERE rather than
 * only in the route. A row that says `true` for a flag the page may not enable
 * cannot have come from a legitimate action, so it is ignored rather than
 * obeyed — whether it arrived by a bug, a bad migration, or a direct write.
 *
 * The asymmetry is the point: a stored `false` is always honoured. This function
 * can make the system quieter, never louder.
 */
export function resolveBoolean(
  definition: FlagDefinition,
  override: FlagOverrideValue | null,
  envValue: boolean,
): boolean {
  const stored = override?.valueBool;
  if (stored === null || stored === undefined) return envValue;
  if (stored && !definition.pageMayEnable) return envValue && true ? envValue : false;
  return stored;
}

/** Resolve a percentage: override, else the environment. Clamped to 0-100. */
export function resolvePercent(
  definition: FlagDefinition,
  override: FlagOverrideValue | null,
  envValue: number,
): number {
  const stored = override?.valuePercent;
  if (stored === null || stored === undefined) return envValue;
  return Math.min(100, Math.max(0, stored));
}
```

- [ ] **Step 4: Simplify the enable fence and re-run**

Step 3's `envValue && true ? envValue : false` is convoluted. Replace that line with
the plain statement of the rule:

```ts
  // Cannot be enabled from a row. Fall back to whatever the environment says,
  // which is the only place this flag may be turned on.
  if (stored && !definition.pageMayEnable) return envValue;
```

Run: `npx vitest run flagResolver`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/flagResolver.ts src/services/flagResolver.test.ts
git commit -m "feat: resolve a flag from override, then environment, failing closed"
```

---

### Task 4: The cached service

**Files:**
- Create: `src/services/flagService.ts`
- Test: `src/services/flagService.test.ts`

**Interfaces:**
- Consumes: Task 1 registry, Task 3 resolver, Prisma `FlagOverride`.
- Produces: `createFlagService(deps)` and the singleton `flags`, exposing `bool(key: string): boolean`, `percent(key: string): number`, `snapshot(): FlagSnapshot[]`, `refresh(): Promise<void>`, `start(): () => void`.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/flagService.test.ts
import { describe, expect, it, vi } from "vitest";
import { createFlagService } from "./flagService.js";

function make(overrides: unknown[], envValues: Record<string, boolean | number> = {}) {
  const findMany = vi.fn().mockResolvedValue(overrides);
  const warn = vi.fn();
  const service = createFlagService({
    findOverrides: findMany,
    envBool: (key) => Boolean(envValues[key] ?? false),
    envPercent: (key) => Number(envValues[key] ?? 0),
    onReadFailure: warn,
  });
  return { service, findMany, warn };
}

describe("flagService", () => {
  it("reads the environment before any refresh has happened", () => {
    const { service } = make([], { AI_DRAFTS_ENABLED: true });
    expect(service.bool("AI_DRAFTS_ENABLED")).toBe(true);
  });

  it("prefers a stored override after refreshing", async () => {
    const { service } = make(
      [{ key: "AI_DRAFTS_ENABLED", valueBool: false, valuePercent: null }],
      { AI_DRAFTS_ENABLED: true },
    );
    await service.refresh();
    expect(service.bool("AI_DRAFTS_ENABLED")).toBe(false);
  });

  // The fail-closed rule. A database problem must not change behaviour, and
  // must never grant more than the environment already granted.
  it("keeps serving the environment value when the read fails", async () => {
    const { service, findMany, warn } = make([], { DM_RECOVERY_ENABLED: true });
    findMany.mockRejectedValue(new Error("connection refused"));
    await service.refresh();
    expect(service.bool("DM_RECOVERY_ENABLED")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not obey a row enabling a flag the page may not enable", async () => {
    const { service } = make(
      [{ key: "AI_SEND_ENABLED", valueBool: true, valuePercent: null }],
      { AI_SEND_ENABLED: false },
    );
    await service.refresh();
    expect(service.bool("AI_SEND_ENABLED")).toBe(false);
  });

  it("obeys a row disabling that same flag", async () => {
    const { service } = make(
      [{ key: "AI_SEND_ENABLED", valueBool: false, valuePercent: null }],
      { AI_SEND_ENABLED: true },
    );
    await service.refresh();
    expect(service.bool("AI_SEND_ENABLED")).toBe(false);
  });

  it("throws on a key with no definition rather than guessing false", () => {
    const { service } = make([]);
    expect(() => service.bool("NOT_A_FLAG")).toThrow(/NOT_A_FLAG/);
  });

  it("reports every flag with its value and where it came from", async () => {
    const { service } = make(
      [{ key: "AI_DRAFTS_ENABLED", valueBool: false, valuePercent: null }],
      { AI_DRAFTS_ENABLED: true },
    );
    await service.refresh();
    const rows = service.snapshot();
    const drafts = rows.find((r) => r.key === "AI_DRAFTS_ENABLED")!;
    expect(drafts).toMatchObject({ valueBool: false, source: "override", driftsFromEnv: true });
    const send = rows.find((r) => r.key === "AI_SEND_ENABLED")!;
    expect(send).toMatchObject({ source: "environment", driftsFromEnv: false });
    expect(rows).toHaveLength(16);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run flagService`
Expected: FAIL — cannot resolve `./flagService.js`.

- [ ] **Step 3: Write the service**

```ts
// src/services/flagService.ts
import { FLAG_REGISTRY, flagDefinition, type FlagDefinition } from "../config/flagRegistry.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import {
  resolveBoolean,
  resolvePercent,
  type FlagOverrideValue,
} from "./flagResolver.js";

const REFRESH_MS = 20_000;

export type FlagSnapshot = {
  key: string;
  valueBool: boolean | null;
  valuePercent: number | null;
  /** Where the value in force came from. */
  source: "override" | "environment";
  /** True when a restart would change the value in force. */
  driftsFromEnv: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

type OverrideRow = FlagOverrideValue & { key: string; updatedBy?: string; updatedAt?: Date };

export type FlagServiceDeps = {
  findOverrides: () => Promise<OverrideRow[]>;
  envBool: (key: string) => boolean;
  envPercent: (key: string) => number;
  onReadFailure: () => void;
};

export function createFlagService(deps: FlagServiceDeps) {
  // Empty until the first refresh, which is why every getter falls through to
  // the environment. A cold cache must behave exactly like today.
  let cache = new Map<string, OverrideRow>();

  function definitionOrThrow(key: string): FlagDefinition {
    const definition = flagDefinition(key);
    // Louder than returning false. A typo'd key that silently reads as "off"
    // is how an outbound feature stops without anybody noticing.
    if (!definition) throw new Error(`Unknown flag: ${key}`);
    return definition;
  }

  return {
    bool(key: string): boolean {
      const definition = definitionOrThrow(key);
      return resolveBoolean(definition, cache.get(key) ?? null, deps.envBool(key));
    },

    percent(key: string): number {
      const definition = definitionOrThrow(key);
      return resolvePercent(definition, cache.get(key) ?? null, deps.envPercent(key));
    },

    snapshot(): FlagSnapshot[] {
      return FLAG_REGISTRY.map((definition) => {
        const row = cache.get(definition.key) ?? null;
        const isBool = definition.kind === "boolean";
        const envBool = deps.envBool(definition.key);
        const envPercent = deps.envPercent(definition.key);
        const valueBool = isBool
          ? resolveBoolean(definition, row, envBool)
          : null;
        const valuePercent = isBool
          ? null
          : resolvePercent(definition, row, envPercent);
        const stored = isBool ? row?.valueBool : row?.valuePercent;
        const usedOverride = stored !== null && stored !== undefined;
        return {
          key: definition.key,
          valueBool,
          valuePercent,
          source: usedOverride ? ("override" as const) : ("environment" as const),
          // What a restart would change. Env is re-read on boot, so a drifted
          // value silently reverts — worth showing before it happens.
          driftsFromEnv: isBool ? valueBool !== envBool : valuePercent !== envPercent,
          updatedBy: row?.updatedBy ?? null,
          updatedAt: row?.updatedAt?.toISOString() ?? null,
        };
      });
    },

    async refresh(): Promise<void> {
      try {
        const rows = await deps.findOverrides();
        cache = new Map(rows.map((row) => [row.key, row]));
      } catch {
        // Deliberately keeps the previous cache and does NOT clear it. Clearing
        // would silently revert every override on one failed query.
        deps.onReadFailure();
      }
    },

    start(): () => void {
      void this.refresh();
      const handle = setInterval(() => void this.refresh(), REFRESH_MS);
      return () => clearInterval(handle);
    },
  };
}

export const flags = createFlagService({
  findOverrides: () => prisma.flagOverride.findMany(),
  envBool: (key) => Boolean((env as unknown as Record<string, unknown>)[key]),
  envPercent: (key) => Number((env as unknown as Record<string, unknown>)[key] ?? 0),
  onReadFailure: () =>
    logger.warn(
      { errorCode: "flag_override_read_failed" },
      "Flag overrides unreadable; serving environment values",
    ),
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run flagService`
Expected: PASS, 7 tests.

- [ ] **Step 5: Start it at boot**

In `src/server.ts`, inside `startBackgroundWorkers` beside the other schedulers:

```ts
  // Flag overrides. Refreshed on a timer so a change from the console takes
  // effect within seconds without a restart, the way ig_token already works.
  flags.start();
```

Import it with the other services. Run `npm run build`; expect exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/services/flagService.ts src/services/flagService.test.ts src/server.ts
git commit -m "feat: cache flag overrides, falling back to env on failure"
```

---

### Task 5: Make the guide-delivery stop actually stop

**Files:**
- Modify: `src/services/guideDeliveryWorker.ts` (the `enabled` option and line 88)
- Test: `src/services/guideDeliveryWorker.test.ts`

**Interfaces:**
- Consumes: `flags` from Task 4.
- Produces: `createGuideDeliveryWorker` now takes `isEnabled: () => boolean` instead of `enabled: boolean`.

This is the correction from spec §5a. Today `runGuideDeliveryTick` captures
`env.GUIDE_DELIVERY_ENABLED` at module load, so switching the flag off would stop new
sends while the worker kept draining its queue. `guideDeliveryCompletion.ts:271` already
uses the thunk pattern (`followUpsEnabled: () => env.AI_FOLLOW_UPS_ENABLED`), so this
follows an existing convention rather than inventing one.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/services/guideDeliveryWorker.test.ts
it("stops between ticks when the flag is switched off", async () => {
  let enabled = true;
  const claim = vi.fn().mockResolvedValue([]);
  const tick = createGuideDeliveryWorker({
    isEnabled: () => enabled,
    batchSize: 10,
    leaseMs: 300_000,
    repository: { claimDueDeliveries: claim } as never,
    finalize: vi.fn(),
    processClaimedGuideDelivery: vi.fn(),
    now: () => new Date("2026-08-18T00:00:00.000Z"),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });

  await tick();
  expect(claim).toHaveBeenCalledTimes(1);

  // The whole point: no restart, no re-construction.
  enabled = false;
  await tick();
  expect(claim).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run guideDeliveryWorker`
Expected: FAIL — `isEnabled` is not a recognised option; the worker reads `enabled`.

- [ ] **Step 3: Change the option**

In `createGuideDeliveryWorker`, replace the `enabled: boolean` option with
`isEnabled: () => boolean`, and change the guard at the top of the returned tick from
`if (!enabled) return ...` to:

```ts
    // Read per tick, not captured at construction. A captured boolean means
    // switching the flag off stops new deliveries while this worker keeps
    // draining the queue — a stop button that only half works.
    if (!options.isEnabled()) return;
```

Then update the export at line 87:

```ts
export const runGuideDeliveryTick = createGuideDeliveryWorker({
  isEnabled: () => flags.bool("GUIDE_DELIVERY_ENABLED"),
  batchSize: env.GUIDE_DELIVERY_BATCH_SIZE,
  leaseMs: env.GUIDE_DELIVERY_LEASE_MS,
  repository: guideDeliveryRepository,
  finalize: finalizeGuideDelivery,
  processClaimedGuideDelivery,
  now: () => new Date(),
  logger,
});
```

- [ ] **Step 4: Run the worker suite**

Run: `npx vitest run guideDeliveryWorker`
Expected: PASS. Fix any existing test still passing `enabled:` by switching it to
`isEnabled: () => <same value>`.

- [ ] **Step 5: Commit**

```bash
git add src/services/guideDeliveryWorker.ts src/services/guideDeliveryWorker.test.ts
git commit -m "fix: read the guide delivery flag per tick so a stop actually stops"
```

---

### Task 6: Migrate the remaining call sites

**Files:**
- Modify: `src/handlers/messageHandler.ts:68,141`, `src/handlers/commentHandler.ts`, `src/services/dmRecoveryWorker.ts:54`, `src/services/historicalRecoveryWorker.ts:100`, `src/services/originEnrichmentWorker.ts:130`, `src/services/gateQueueWorker.ts:414`, `src/api/ai.routes.ts:318,354`, `src/services/upcomingAutomationCommentBinding.ts`
- Test: `src/config/flagCallSites.test.ts`

**Interfaces:**
- Consumes: `flags` from Task 4.
- Produces: nothing new. Behaviour is unchanged when no override exists.

- [ ] **Step 1: Write the failing guard test**

```ts
// src/config/flagCallSites.test.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FLAG_REGISTRY } from "./flagRegistry.js";

const SRC = path.resolve("src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!full.endsWith(".ts") || full.endsWith(".test.ts")) return [];
    return [full];
  });
}

/**
 * Flags whose value may still be read straight from env.
 *
 * WORKERS_ENABLED is read once at boot to decide whether to start anything, so
 * it cannot be live-controlled and must not pretend to be. The percentage
 * knobs used only for validation in env.ts stay there too.
 */
const ENV_ONLY = new Set(["WORKERS_ENABLED"]);

describe("flag call sites", () => {
  it("reads every live-controlled flag through the service, not env", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith(path.join("config", "env.ts"))) continue;
      if (file.endsWith(path.join("services", "flagService.ts"))) continue;
      const source = readFileSync(file, "utf8");
      for (const definition of FLAG_REGISTRY) {
        if (ENV_ONLY.has(definition.key)) continue;
        if (source.includes(`env.${definition.key}`)) {
          offenders.push(`${path.relative(SRC, file)} reads env.${definition.key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see the full list**

Run: `npx vitest run flagCallSites`
Expected: FAIL, listing every remaining `env.<FLAG>` read. That list is this task's
work queue.

- [ ] **Step 3: Replace each read**

Mechanical, one per line. Import `flags` from `../services/flagService.js` and swap:

```ts
// before
if (!env.DM_RECOVERY_ENABLED) return emptyResult("disabled");
// after
if (!flags.bool("DM_RECOVERY_ENABLED")) return emptyResult("disabled");
```

```ts
// before
if (!env.AI_SEND_ENABLED) return res.status(403).json({ error: "ai_send_disabled" });
// after
if (!flags.bool("AI_SEND_ENABLED")) return res.status(403).json({ error: "ai_send_disabled" });
```

Leave `src/config/env.ts` untouched — its `superRefine` cross-checks are about what the
operator wrote, not what is in force.

For `src/server.ts`, the scheduler `enabled:` options stay on `env`: a scheduler that
was never started cannot be started by a row, and the per-tick guards inside each worker
are what the stop relies on. Add a comment saying so at each one.

- [ ] **Step 4: Run the guard and the full backend suite**

```bash
npx vitest run flagCallSites
export QA_DB="postgresql://postgres:codex_qa_only@127.0.0.1:55439/insta_contract"
DATABASE_URL="$QA_DB" MIGRATION_TEST_DATABASE_URL="$QA_DB" \
  MIGRATION_TEST_DATABASE_DISPOSABLE=true npm test -- --maxWorkers=1
```

Expected: guard passes; the whole suite passes with zero skips. Any suite that stubbed
`env` for a flag now needs `flags.bool` stubbed instead — mock
`../services/flagService.js` with `{ flags: { bool: () => true, percent: () => 0 } }`.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "refactor: read live-controlled flags through the flag service"
```

---

### Task 7: The API

**Files:**
- Create: `src/api/flags.routes.ts`
- Modify: `src/api/router.ts`
- Modify: `docs/client-operation-contracts.md`
- Test: `src/api/flags.routes.test.ts`

**Interfaces:**
- Consumes: Task 1 registry, Task 4 `flags`.
- Produces: `GET /api/flags` → `{ flags: FlagView[] }`; `PATCH /api/flags/:key` with body `{ valueBool?: boolean; valuePercent?: number }` → the updated `FlagView`.

`FlagView` is the registry definition plus the snapshot fields:
`{ key, name, group, kind, doesWhat, affectsWho, ifOff, pageMayEnable, pageMayStop, valueBool, valuePercent, source, driftsFromEnv, updatedBy, updatedAt }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/api/flags.routes.test.ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const refresh = vi.fn();
const snapshot = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: { flagOverride: { upsert } } }));
vi.mock("../services/flagService.js", () => ({
  flags: { snapshot: () => snapshot(), refresh: () => refresh() },
}));
vi.mock("../services/eventLogger.js", () => ({ logEvent: vi.fn() }));

const { flagsRouter } = await import("./flags.routes.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.adminEmail = "owner@example.com";
    next();
  });
  a.use("/api/flags", flagsRouter);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  snapshot.mockReturnValue([
    { key: "AI_DRAFTS_ENABLED", valueBool: true, valuePercent: null, source: "environment", driftsFromEnv: false, updatedBy: null, updatedAt: null },
    { key: "AI_SEND_ENABLED", valueBool: false, valuePercent: null, source: "environment", driftsFromEnv: false, updatedBy: null, updatedAt: null },
  ]);
  upsert.mockResolvedValue({});
});

describe("flags API", () => {
  it("returns each flag with its description and its value", async () => {
    const res = await request(app()).get("/api/flags").expect(200);
    const drafts = res.body.flags.find((f: { key: string }) => f.key === "AI_DRAFTS_ENABLED");
    expect(drafts).toMatchObject({
      name: "AI reply drafts",
      group: "assistive",
      kind: "boolean",
      valueBool: true,
      pageMayEnable: true,
    });
    expect(drafts.doesWhat.length).toBeGreaterThan(20);
  });

  it("saves a permitted change and refreshes the cache", async () => {
    await request(app())
      .patch("/api/flags/AI_DRAFTS_ENABLED")
      .send({ valueBool: false })
      .expect(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "AI_DRAFTS_ENABLED" } }),
    );
    expect(refresh).toHaveBeenCalled();
  });

  // The fence, server-side. The UI hides the control; this is what makes it true.
  it("refuses to enable a flag the page may not enable", async () => {
    const res = await request(app())
      .patch("/api/flags/AI_SEND_ENABLED")
      .send({ valueBool: true })
      .expect(403);
    expect(res.body).toEqual({ error: "flag_enable_not_permitted" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("allows that same flag to be switched off", async () => {
    await request(app())
      .patch("/api/flags/AI_SEND_ENABLED")
      .send({ valueBool: false })
      .expect(200);
    expect(upsert).toHaveBeenCalled();
  });

  it("refuses any change to a flag that offers no control", async () => {
    const res = await request(app())
      .patch("/api/flags/WORKERS_ENABLED")
      .send({ valueBool: false })
      .expect(403);
    expect(res.body).toEqual({ error: "flag_not_controllable" });
  });

  it("rejects the wrong kind of value for the flag", async () => {
    await request(app())
      .patch("/api/flags/AI_DRAFTS_ENABLED")
      .send({ valuePercent: 50 })
      .expect(400);
  });

  it("404s an unknown key", async () => {
    await request(app()).patch("/api/flags/NOPE").send({ valueBool: true }).expect(404);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run flags.routes`
Expected: FAIL — cannot resolve `./flags.routes.js`.

- [ ] **Step 3: Write the router**

```ts
// src/api/flags.routes.ts
import { Router } from "express";
import { z } from "zod";
import { FLAG_REGISTRY, flagDefinition } from "../config/flagRegistry.js";
import { prisma } from "../lib/prisma.js";
import { flags } from "../services/flagService.js";
import { logEvent } from "../services/eventLogger.js";

export const flagsRouter = Router();

const patchSchema = z
  .object({
    valueBool: z.boolean().optional(),
    valuePercent: z.number().int().min(0).max(100).optional(),
  })
  .refine(
    (body) => (body.valueBool === undefined) !== (body.valuePercent === undefined),
    { message: "Send exactly one of valueBool or valuePercent" },
  );

flagsRouter.get("/", (_req, res) => {
  const byKey = new Map(flags.snapshot().map((row) => [row.key, row]));
  res.json({
    flags: FLAG_REGISTRY.map((definition) => ({
      ...definition,
      ...(byKey.get(definition.key) ?? {}),
    })),
  });
});

flagsRouter.patch("/:key", async (req, res) => {
  const definition = flagDefinition(req.params.key);
  if (!definition) return res.status(404).json({ error: "not_found" });

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { valueBool, valuePercent } = parsed.data;

  // Kind mismatch is a client bug, not a permission problem.
  if (definition.kind === "boolean" && valueBool === undefined) {
    return res.status(400).json({ error: "expected_value_bool" });
  }
  if (definition.kind === "percent" && valuePercent === undefined) {
    return res.status(400).json({ error: "expected_value_percent" });
  }

  // A flag with neither control is display-only.
  if (!definition.pageMayEnable && !definition.pageMayStop) {
    return res.status(403).json({ error: "flag_not_controllable" });
  }
  // The fence. Off is always allowed; on is allowed only where the definition
  // says so. Duplicated in flagResolver on purpose — a row that slipped past
  // this route still cannot enable anything.
  if (valueBool === true && !definition.pageMayEnable) {
    return res.status(403).json({ error: "flag_enable_not_permitted" });
  }

  const updatedBy = req.adminEmail ?? "unknown";
  const data = {
    valueBool: valueBool ?? null,
    valuePercent: valuePercent ?? null,
    updatedBy,
    updatedAt: new Date(),
  };
  await prisma.flagOverride.upsert({
    where: { key: definition.key },
    create: { key: definition.key, ...data },
    update: data,
  });

  // Names and values only. Never the description text, which is static anyway.
  await logEvent("flag_changed", {
    key: definition.key,
    valueBool: valueBool ?? null,
    valuePercent: valuePercent ?? null,
    updatedBy,
  });

  await flags.refresh();
  const row = flags.snapshot().find((r) => r.key === definition.key);
  res.json({ ...definition, ...row });
});
```

- [ ] **Step 4: Register it**

In `src/api/router.ts`, beside the other routers:

```ts
import { flagsRouter } from "./flags.routes.js";
// ...
apiRouter.use("/flags", flagsRouter);
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run flags.routes`
Expected: PASS, 7 tests.

- [ ] **Step 6: Document the mutation**

Add to the patch/delete table in `docs/client-operation-contracts.md`:

```markdown
| `PATCH /flags/:key` | Flags | flag key | `GET /flags` | the row's `valueBool`/`valuePercent` equals the intended value | Yes — reapplying the same value is a no-op. A `403 flag_enable_not_permitted` is a definite refusal, not an unknown: that flag can only be enabled by an environment change. |
```

- [ ] **Step 7: Commit**

```bash
git add src/api/flags.routes.ts src/api/flags.routes.test.ts src/api/router.ts docs/client-operation-contracts.md
git commit -m "feat: read and change flags over the API, fenced server-side"
```

---

### Task 8: The page

**Files:**
- Create: `web/src/pages/Flags.tsx`
- Create: `web/src/pages/Flags.test.tsx`
- Modify: `web/src/lib/types.ts`, `web/src/lib/navigation.ts`, `web/src/AppRoutes.tsx`

**Interfaces:**
- Consumes: `GET /api/flags`, `PATCH /api/flags/:key` from Task 7.
- Produces: the `/flags` route and a `Things we're testing` nav destination.

- [ ] **Step 1: Add the types**

```ts
// append to web/src/lib/types.ts
export type FlagGroup = "outbound" | "experiment" | "assistive" | "infrastructure";

export interface FlagView {
  key: string;
  name: string;
  group: FlagGroup;
  kind: "boolean" | "percent";
  doesWhat: string;
  affectsWho: string;
  ifOff: string;
  pageMayEnable: boolean;
  pageMayStop: boolean;
  valueBool: boolean | null;
  valuePercent: number | null;
  source: "override" | "environment";
  /** A restart would change the value in force back to the environment's. */
  driftsFromEnv: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface FlagsResponse {
  flags: FlagView[];
}
```

- [ ] **Step 2: Write the failing test**

```tsx
// web/src/pages/Flags.test.tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiRead = vi.fn();
const apiMutation = vi.fn();
vi.mock("../lib/api", () => ({
  apiRead: (...a: unknown[]) => apiRead(...a),
  apiMutation: (...a: unknown[]) => apiMutation(...a),
  ApiError: class ApiError extends Error {},
}));

const { Flags } = await import("./Flags");

function flag(over: Partial<Record<string, unknown>> = {}) {
  return {
    key: "AI_DRAFTS_ENABLED",
    name: "AI reply drafts",
    group: "assistive",
    kind: "boolean",
    doesWhat: "Writes a suggested reply for each conversation waiting on you.",
    affectsWho: "Only you.",
    ifOff: "Suggestions stop appearing.",
    pageMayEnable: true,
    pageMayStop: true,
    valueBool: true,
    valuePercent: null,
    source: "environment",
    driftsFromEnv: false,
    updatedBy: null,
    updatedAt: null,
    ...over,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Flags />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  apiRead.mockReset();
  apiMutation.mockReset().mockResolvedValue(flag({ valueBool: false }));
});

describe("Flags", () => {
  it("groups by what a flag touches, loudest first", async () => {
    apiRead.mockResolvedValue({
      flags: [
        flag(),
        flag({ key: "DM_RECOVERY_ENABLED", name: "Recovery reminders", group: "outbound", pageMayEnable: false }),
        flag({ key: "WORKERS_ENABLED", name: "Background jobs", group: "infrastructure", pageMayEnable: false, pageMayStop: false }),
      ],
    });
    renderPage();

    const outbound = await screen.findByText("Reaches real people");
    const assistive = screen.getByText("Nothing leaves the app");
    expect(
      outbound.compareDocumentPosition(assistive) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("explains every flag in plain words", async () => {
    apiRead.mockResolvedValue({ flags: [flag()] });
    renderPage();

    expect(await screen.findByText(/Writes a suggested reply/)).toBeInTheDocument();
    expect(screen.getByText(/Only you/)).toBeInTheDocument();
    expect(screen.getByText(/Suggestions stop appearing/)).toBeInTheDocument();
  });

  it("offers Stop now, and no way to start, for an outbound flag", async () => {
    apiRead.mockResolvedValue({
      flags: [flag({ key: "DM_RECOVERY_ENABLED", name: "Recovery reminders", group: "outbound", pageMayEnable: false })],
    });
    const user = userEvent.setup();
    renderPage();

    const stop = await screen.findByRole("button", { name: /Stop Recovery reminders/ });
    expect(screen.queryByRole("switch", { name: /Recovery reminders/ })).not.toBeInTheDocument();

    await user.click(stop);
    await waitFor(() =>
      expect(apiMutation).toHaveBeenCalledWith("/flags/DM_RECOVERY_ENABLED", {
        method: "PATCH",
        body: JSON.stringify({ valueBool: false }),
      }),
    );
  });

  it("offers no control at all for a flag that cannot be changed", async () => {
    apiRead.mockResolvedValue({
      flags: [flag({ key: "WORKERS_ENABLED", name: "Background jobs", group: "infrastructure", pageMayEnable: false, pageMayStop: false })],
    });
    renderPage();

    expect(await screen.findByText("Background jobs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
    expect(screen.getByText(/changed in Railway/)).toBeInTheDocument();
  });

  it("warns when a restart would revert the value", async () => {
    apiRead.mockResolvedValue({ flags: [flag({ source: "override", valueBool: false, driftsFromEnv: true })] });
    renderPage();

    expect(await screen.findByText(/a restart would change this back/i)).toBeInTheDocument();
  });

  it("calls a failed read a connection problem, not an empty list", async () => {
    apiRead.mockRejectedValue(new Error("down"));
    renderPage();

    expect(await screen.findByText(/connection problem/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm --prefix web test -- Flags`
Expected: FAIL — cannot resolve `./Flags`.

- [ ] **Step 4: Write the page**

```tsx
// web/src/pages/Flags.tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Lock } from "lucide-react";
import { apiMutation, apiRead } from "@/lib/api";
import { outcomeMessage } from "@/lib/unknownOutcome";
import type { FlagGroup, FlagView, FlagsResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Grouped by blast radius, loudest first.
 *
 * The 16 flags are not peers: AI drafts cannot reach anyone, and recovery
 * reminders post public comments on real reels. A list sorted by name puts
 * those side by side and implies they carry the same weight.
 */
const GROUPS: { key: FlagGroup; heading: string }[] = [
  { key: "outbound", heading: "Reaches real people" },
  { key: "experiment", heading: "Measuring something" },
  { key: "assistive", heading: "Nothing leaves the app" },
  { key: "infrastructure", heading: "Not a product choice" },
];

export function Flags() {
  const queryClient = useQueryClient();
  const query = useQuery<FlagsResponse>({
    queryKey: ["flags"],
    queryFn: ({ signal }) => apiRead<FlagsResponse>("/flags", { signal }),
  });

  const change = useMutation({
    mutationFn: (input: { key: string; valueBool?: boolean; valuePercent?: number }) => {
      const { key, ...value } = input;
      return apiMutation<FlagView>(`/flags/${key}`, {
        method: "PATCH",
        body: JSON.stringify(value),
      });
    },
    // The list is the canonical read either way, including after an unknown
    // outcome — the response never decides what is in force.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["flags"] }),
  });

  const all = query.data?.flags ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Things we&apos;re testing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every switch in the system, what it does, and what changes if you turn it off.
        </p>
      </div>

      {change.error && (
        <p role="alert" className="rounded-md bg-urgent-soft px-3 py-2 text-[13px] text-urgent">
          {outcomeMessage(
            change.error,
            change.error instanceof Error ? change.error.message : "That change did not save.",
          )}
        </p>
      )}

      {query.isLoading ? (
        <div className="space-y-2 border-t pt-3">
          <Skeleton className="h-10 rounded-md" />
          <Skeleton className="h-10 rounded-md" />
        </div>
      ) : query.isError ? (
        <p className="border-t py-4 text-[13px] text-muted-foreground">
          Couldn&apos;t load your switches — the API did not answer. This is a connection
          problem, not an empty list.{" "}
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="underline underline-offset-2 [@media(pointer:coarse)]:min-h-11"
          >
            Try again
          </button>
        </p>
      ) : (
        GROUPS.map(({ key, heading }) => {
          const rows = all.filter((flag) => flag.group === key);
          if (rows.length === 0) return null;
          return (
            <section key={key}>
              <h2 className="label-caps border-b border-line pb-1.5">{heading}</h2>
              <ul>
                {rows.map((flag) => (
                  <FlagRow
                    key={flag.key}
                    flag={flag}
                    busy={change.isPending && change.variables?.key === flag.key}
                    onChange={(value) => change.mutate({ key: flag.key, ...value })}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

function FlagRow({
  flag,
  busy,
  onChange,
}: {
  flag: FlagView;
  busy: boolean;
  onChange: (value: { valueBool?: boolean; valuePercent?: number }) => void;
}) {
  const live = flag.kind === "boolean" ? flag.valueBool === true : (flag.valuePercent ?? 0) > 0;

  return (
    <li className="border-b py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-[18rem] flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{flag.name}</span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium",
                live ? "bg-signal-soft text-signal" : "bg-muted text-muted-foreground",
              )}
            >
              {flag.kind === "percent" ? `${flag.valuePercent ?? 0}%` : live ? "Live" : "Off"}
            </span>
          </div>
          <p className="mt-1 max-w-[70ch] text-[13px] text-muted-foreground">{flag.doesWhat}</p>
          <p className="mt-1 max-w-[70ch] text-[13px] text-muted-foreground">
            <span className="text-foreground">Who it affects:</span> {flag.affectsWho}
          </p>
          <p className="mt-1 max-w-[70ch] text-[13px] text-muted-foreground">
            <span className="text-foreground">If you turn it off:</span> {flag.ifOff}
          </p>
          {flag.driftsFromEnv && (
            <p className="mt-2 inline-flex items-start gap-1.5 rounded-md bg-caution-soft px-2.5 py-1.5 text-[12.5px] text-caution">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              Saved here, but a restart would change this back to the deployed value.
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {flag.kind === "percent" && flag.pageMayEnable ? (
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              defaultValue={flag.valuePercent ?? 0}
              disabled={busy}
              aria-label={`${flag.name} rollout`}
              onMouseUp={(event) =>
                onChange({ valuePercent: Number((event.target as HTMLInputElement).value) })
              }
            />
          ) : flag.pageMayEnable && flag.pageMayStop ? (
            <Switch
              checked={flag.valueBool === true}
              disabled={busy}
              aria-label={flag.name}
              onCheckedChange={(checked) => onChange({ valueBool: checked })}
            />
          ) : flag.pageMayStop && live ? (
            // Off in one click; on is a deploy. A bug here can only make the
            // system quieter.
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`Stop ${flag.name}`}
              onClick={() => onChange({ valueBool: false })}
            >
              {busy ? "Stopping…" : "Stop now"}
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <Lock className="size-3.5" aria-hidden />
              changed in Railway
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
```

- [ ] **Step 5: Run the test**

Run: `npm --prefix web test -- Flags`
Expected: PASS, 6 tests.

- [ ] **Step 6: Add the destination and the route**

In `web/src/lib/navigation.ts`, add to the `System` group's items, before Activity:

```ts
      {
        path: "/flags",
        label: "Things we're testing",
        mobileTitle: "Testing",
        group: "System",
      },
```

In `web/src/AppRoutes.tsx`, add beside the other routes:

```tsx
<Route path="/flags" element={<Flags />} />
```

- [ ] **Step 7: Run the whole web gate**

```bash
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
```

Expected: all pass. A navigation test asserting a destination count will need its
number raised by one.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/Flags.tsx web/src/pages/Flags.test.tsx web/src/lib/types.ts web/src/lib/navigation.ts web/src/AppRoutes.tsx
git commit -m "feat: one page for every switch, grouped by what it touches"
```

---

### Task 9: The standard, and the full gate

**Files:**
- Create: `docs/experiments.md`
- Modify: `web/e2e/main.tsx`, `web/e2e/visual-qa.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-facing.

- [ ] **Step 1: Write the standard**

Create `docs/experiments.md`, in the style of `docs/funnels.md` — rules with the reason
each was earned:

```markdown
# Experiments and flags

Every switch in this system is described in `src/config/flagRegistry.ts`, and
`flagRegistry.test.ts` fails the build when one is added to `env.ts` without a
description. This document is why those rules exist.

## The seven rules

**1. Plain English or it does not ship.** Three answers per flag: what it does, who it
affects, what changes if it is off. The third is the one an operator actually needs and
the one nobody thinks to write.

**2. The outcome is a funnel stage, not a sentence you invented.** Outcomes name a stage
in a `FunnelDef` (`src/services/funnels/registry.ts`). A typed-in metric is a metric
nobody implemented.

**3. A rate below `minSample` prints counts, never a percentage.** From `funnels.md`:
"15.6%" over 32 people and over 3,200 are different claims and only one is a number.

**4. Arms are immutable once anyone is assigned.** Recutting mid-flight invalidates the
result you were waiting for.

**5. There is a do-nothing arm.** Otherwise you learn that two hours beats six and never
whether reminding beats silence. It costs roughly 10% of people getting nothing, and
that is the price of an answer.

**6. Every experiment states what happens when it ends, and the system does it.** Earned
the hard way: the first timing experiment's real landing behaviour was "silently stop
sending reminders", which nobody chose. It was a default falling through.

**7. Off is one click. On is a deploy.** And a stop is only offered where the flag is
read per operation — `pageMayStop` requires a test proving the next operation halts.
`WORKERS_ENABLED` is read once at boot, so it offers neither control.

## Adding a flag

1. Add it to `src/config/env.ts` with `booleanFlag()` or a bounded number. Never
   `z.coerce.boolean()` — see `booleanFlag.ts` for why.
2. Add a `FlagDefinition` in the same commit. The build fails otherwise.
3. Read it through `flags.bool(key)` / `flags.percent(key)`, never `env.KEY`.
   `flagCallSites.test.ts` enforces this.
4. If you set `pageMayStop: true`, write the test that proves the stop works.

Phase 2 — closing experiments, the drawn diagram, funnel-backed outcomes and the
end-of-experiment worker — is specified in
`docs/superpowers/specs/2026-08-18-experiments-and-flags-design.md` and not yet built.
```

- [ ] **Step 2: Add the E2E fixture**

In `web/e2e/main.tsx`, add a stub beside the others and a `flags` scenario rendering
`<Flags />`:

```tsx
    if (path === "/flags" && method === "GET") {
      return json({ flags: FLAG_ROWS });
    }
```

Define `FLAG_ROWS` with one row per group: an assistive switch, an outbound
`pageMayEnable: false` row that is live, a percent row at 45, and
`WORKERS_ENABLED` with both controls false.

- [ ] **Step 3: Add the visual case**

In `web/e2e/visual-qa.spec.ts`:

```ts
  test("things we're testing", async ({ page }, testInfo) => {
    await open(page, "flags");
    await expect(
      page.getByRole("heading", { level: 1, name: "Things we're testing" }),
    ).toBeVisible();
    // The safety model, visible: a stop with no matching start.
    await expect(page.getByRole("button", { name: /Stop / })).toBeVisible();
    await expect(page.getByText("changed in Railway")).toBeVisible();
    await settleAnimations(page);
    await capture(page, testInfo.project.name, "flags");
  });
```

- [ ] **Step 4: Run the full gate**

```bash
npx prisma validate
export QA_DB="postgresql://postgres:codex_qa_only@127.0.0.1:55439/insta_contract"
DATABASE_URL="$QA_DB" MIGRATION_TEST_DATABASE_URL="$QA_DB" \
  MIGRATION_TEST_DATABASE_DISPOSABLE=true npm test -- --maxWorkers=1
npm run build
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
npm --prefix web run test:e2e
npm run check:guide-delivery-bypasses
git diff --check
```

Expected: every command exits 0, and the backend suite reports **zero skipped**.

- [ ] **Step 5: Look at the artifact**

Open `docs/qa/artifacts/2026-08-16-maison-editorial/desktop/flags.png` and check three
things a test cannot: the groups read loudest-first, every row's three sentences are
legible, and no row shows a control it does not have.

- [ ] **Step 6: Commit**

```bash
git add docs/experiments.md web/e2e docs/qa/artifacts
git commit -m "docs: state the flag and experiment rules, and capture the page"
```

---

## Self-Review

**Spec coverage.** §1 → Tasks 1, 4, 7, 8. §5 (no Railway writes) → Task 4, values in
Postgres. §5a → Tasks 1 and 5, `pageMayStop` plus the per-tick fix. §6 → Tasks 1 and 2,
with the documented deviation. §7 (grouping, no Source column, drift badge) → Task 8.
§10 (resolver, fail-closed, ~16 call sites) → Tasks 3, 4, 6. §12 → Tasks 1 and 9. §13 →
tests throughout.

**Deliberately not covered here**, all Phase 2 per spec §14: the decisions section,
`experiment_rule`, the drawn diagram, funnel-backed outcomes, verdict language, the
`on_end` worker, and the follower estimate. §8's presentation rules apply to Phase 2 and
have no Phase 1 surface.

**Placeholder scan.** No TBD/TODO. Every code step carries real code. The one place
Task 9 says "define `FLAG_ROWS`" names the four rows required, and Task 6's work queue
is produced by running the test rather than guessed at.

**Type consistency.** `FlagDefinition` (Task 1) is consumed by `flagResolver` (3) and
`flagService` (4). `FlagOverrideValue` is defined in Task 3 and used in Task 4.
`FlagSnapshot` (4) is spread into the API response (7) and typed as `FlagView` on the
client (8) — the field names match: `valueBool`, `valuePercent`, `source`,
`driftsFromEnv`, `updatedBy`, `updatedAt`. `isEnabled` is the option name in both Task 5
steps.

**One correction found while reviewing.** Task 3 Step 3 first writes
`return envValue && true ? envValue : false`, which is a convoluted way to write
`return envValue`. Step 4 replaces it deliberately rather than leaving it, because the
line states the safety rule and must read like it.
