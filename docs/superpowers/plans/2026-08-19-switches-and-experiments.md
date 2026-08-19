# Switches and Experiments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single overwhelming `/flags` page with two destinations whose lists are one line per row, and detail pages carrying the descriptions and each experiment's own measurements.

**Architecture:** A second static registry (`experimentRegistry.ts`) declares the three experiments and which flags each owns; `FlagDefinition` gains `experimentKey`. Per-experiment summaries are separate functions registered by key, not a generic metrics abstraction. Four React pages replace one.

**Tech Stack:** Express, Prisma/Postgres, Zod, React 19, TanStack Query, React Router, Vitest, Playwright.

## Global Constraints

- **An experiment is a flag with declared arms.** No arms → it is a switch. Enforced by a registry test, not by judgment.
- **Lists carry no controls and no descriptions.** One line per row. Controls live on detail pages, because stopping should be deliberate.
- **No statistics.** No confidence intervals, no significance, no "visitors remaining". Counts in whole people. `docs/funnels.md` forbids a rate its sample cannot support; recovery reminders have 593 sends.
- **`not_started` returns intent and blocker, never zeroes.** Zeroes read as failure; "never switched on" reads as a decision.
- **The asymmetric control model is unchanged.** Off in one click, on only via a deploy; `pageMayStop` only where the flag is read per operation; the enable fence enforced in the route *and* the resolver.
- **`/flags` must redirect, not 404.** It is live and may be bookmarked.
- **No `api()` in web code.** `apiRead` / `apiMutation` only.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/config/experimentRegistry.ts` | **New.** The three `ExperimentDefinition`s: state, arms, outcome, owned flags, blocker. No logic. |
| `src/config/experimentRegistry.test.ts` | **New.** Ownership integrity: owned keys exist, none owned twice, every `experimentKey` resolves. |
| `src/config/flagRegistry.ts` | Modify. Add optional `experimentKey` to eight flags. |
| `src/services/experimentSummary.ts` | **New.** `summarizeExperiment(key)` dispatching to per-key functions. The only impure part. |
| `src/services/experimentSummary.test.ts` | **New.** |
| `src/api/experiments.routes.ts` | **New.** `GET /`, `GET /:key`. |
| `src/api/flags.routes.ts` | Modify. Add `GET /:key`. |
| `src/api/router.ts` | Modify. Register `/experiments`. |
| `web/src/pages/Switches.tsx` | **New.** Compact grouped list. |
| `web/src/pages/SwitchDetail.tsx` | **New.** Descriptions, value, control. |
| `web/src/pages/Experiments.tsx` | **New.** Three lines. |
| `web/src/pages/ExperimentDetail.tsx` | **New.** Arms or intent. |
| `web/src/pages/Flags.tsx` | **Delete.** Replaced by the four above. |
| `web/src/lib/navigation.ts` | Modify. Two destinations replace one. |
| `web/src/AppRoutes.tsx` | Modify. Four routes plus a `/flags` redirect. |
| `web/src/lib/types.ts` | Modify. `ExperimentView`, `ExperimentSummary`, `experimentKey` on `FlagView`. |

---

### Task 1: The experiment registry

**Files:**
- Create: `src/config/experimentRegistry.ts`
- Test: `src/config/experimentRegistry.test.ts`
- Modify: `src/config/flagRegistry.ts`

**Interfaces:**
- Consumes: `FLAG_REGISTRY`, `flagDefinition` from `flagRegistry.ts`.
- Produces: `ExperimentState`, `ExperimentArm`, `ExperimentDefinition`, `EXPERIMENT_REGISTRY`, `experimentDefinition(key)`. `FlagDefinition` gains `experimentKey?: string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/config/experimentRegistry.test.ts
import { describe, expect, it } from "vitest";
import { FLAG_REGISTRY, flagDefinition } from "./flagRegistry.js";
import { EXPERIMENT_REGISTRY, experimentDefinition } from "./experimentRegistry.js";

describe("experiment registry", () => {
  it("declares arms for every experiment, because that is what makes it one", () => {
    for (const e of EXPERIMENT_REGISTRY) {
      expect(e.arms.length, `${e.key} arms`).toBeGreaterThanOrEqual(2);
      for (const arm of e.arms) expect(arm.doesWhat.length).toBeGreaterThan(10);
    }
  });

  it("owns only flags that exist", () => {
    const missing = EXPERIMENT_REGISTRY.flatMap((e) =>
      e.ownedFlagKeys.filter((k) => !flagDefinition(k)).map((k) => `${e.key} owns unknown ${k}`),
    );
    expect(missing).toEqual([]);
  });

  // A flag owned twice would appear under two experiments and its numbers would
  // seem to contradict themselves.
  it("never lets two experiments own the same flag", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const e of EXPERIMENT_REGISTRY) {
      for (const k of e.ownedFlagKeys) {
        const prior = seen.get(k);
        if (prior) clashes.push(`${k} owned by ${prior} and ${e.key}`);
        seen.set(k, e.key);
      }
    }
    expect(clashes).toEqual([]);
  });

  // The two directions must agree, or a flag links to an experiment that does not
  // claim it.
  it("keeps flag.experimentKey and experiment.ownedFlagKeys consistent", () => {
    const problems: string[] = [];
    for (const f of FLAG_REGISTRY) {
      if (!f.experimentKey) continue;
      const e = experimentDefinition(f.experimentKey);
      if (!e) problems.push(`${f.key} points at unknown ${f.experimentKey}`);
      else if (!e.ownedFlagKeys.includes(f.key)) {
        problems.push(`${f.key} claims ${e.key} but is not owned back`);
      }
    }
    for (const e of EXPERIMENT_REGISTRY) {
      for (const k of e.ownedFlagKeys) {
        if (flagDefinition(k)?.experimentKey !== e.key) {
          problems.push(`${e.key} owns ${k} but it does not point back`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("gives a not-started experiment a blocker rather than pretending it runs", () => {
    for (const e of EXPERIMENT_REGISTRY) {
      if (e.state === "not_started") expect(e.blocker.length, e.key).toBeGreaterThan(10);
    }
  });

  it("describes every experiment in plain words", () => {
    for (const e of EXPERIMENT_REGISTRY) {
      expect(e.doesWhat.length).toBeGreaterThan(20);
      expect(e.affectsWho.length).toBeGreaterThan(10);
      expect(e.outcome.length).toBeGreaterThan(10);
      expect(`${e.doesWhat} ${e.affectsWho} ${e.outcome}`).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run experimentRegistry`
Expected: FAIL — cannot resolve `./experimentRegistry.js`.

- [ ] **Step 3: Add `experimentKey` to `FlagDefinition`**

In `src/config/flagRegistry.ts`, add to the interface:

```ts
  /**
   * The experiment this flag is part of, if any.
   *
   * Five of these belong to recovery reminder timing — its kill switch, its split,
   * its eligibility rule, its circuit breaker, and what happens when it ends. Listed
   * flat they looked like five unrelated things, which is most of why the single
   * page felt arbitrary.
   */
  experimentKey?: string;
```

Then add the key to exactly eight entries:

```ts
// DM_RECOVERY_ENABLED, DM_RECOVERY_HOLDOUT_PERCENT, DM_RECOVERY_WESTERN_ONLY,
// DM_RECOVERY_FAILURE_RATE_PERCENT, DM_RECOVERY_POST_EXPERIMENT_ENABLED:
    experimentKey: "recovery-reminder-timing",
// GUIDE_DELIVERY_ENABLED, GUIDE_DELIVERY_ROLLOUT_PERCENT:
    experimentKey: "guide-delivery-rollout",
// GATE_DM_EXPERIMENT:
    experimentKey: "cold-message-test",
```

- [ ] **Step 4: Write the registry**

```ts
// src/config/experimentRegistry.ts
/**
 * The experiments, and what makes something one.
 *
 * An experiment is a flag with DECLARED ARMS — named, split stated, outcome chosen.
 * No arms means it is a switch. That line is checkable rather than debatable, which
 * matters: the older Insights → Experiments tab defined it by feeling and now holds
 * 94 rows nobody can close.
 *
 * `not_started` is a state rather than a separate place, because a list of
 * experiments you could run tomorrow is the most useful thing on the page.
 */

export type ExperimentState = "running" | "not_started" | "ended";

export interface ExperimentArm {
  key: string;
  /** Share of eligible people, 0-100. Null when the split is not fixed in code. */
  percent: number | null;
  doesWhat: string;
  isControl: boolean;
}

export interface ExperimentDefinition {
  key: string;
  name: string;
  state: ExperimentState;
  doesWhat: string;
  affectsWho: string;
  /** What decides the winner, in plain words. */
  outcome: string;
  arms: ExperimentArm[];
  /** Flags that belong to this experiment. Each appears under exactly one. */
  ownedFlagKeys: string[];
  /** Why it is not running. Empty for a running experiment. */
  blocker: string;
}

export const EXPERIMENT_REGISTRY: readonly ExperimentDefinition[] = [
  {
    key: "recovery-reminder-timing",
    name: "Recovery reminder timing",
    state: "running",
    doesWhat:
      "Tests whether leaving a public comment helps when someone never opens the guide we sent them, by leaving one for most people and deliberately saying nothing to the rest.",
    affectsWho:
      "People who commented a keyword and were sent a guide but have not opened it. Around 190 a week.",
    outcome: "Whether they received the guide within 48 hours of first asking.",
    arms: [
      {
        key: "treatment",
        percent: 90,
        doesWhat: "Gets a public comment on the reel telling them to check their requests.",
        isControl: false,
      },
      {
        key: "control",
        percent: 10,
        doesWhat: "Gets nothing, so we can tell whether the reminder is what worked.",
        isControl: true,
      },
    ],
    ownedFlagKeys: [
      "DM_RECOVERY_ENABLED",
      "DM_RECOVERY_HOLDOUT_PERCENT",
      "DM_RECOVERY_WESTERN_ONLY",
      "DM_RECOVERY_FAILURE_RATE_PERCENT",
      "DM_RECOVERY_POST_EXPERIMENT_ENABLED",
    ],
    blocker: "",
  },
  {
    key: "guide-delivery-rollout",
    name: "Guide delivery rollout",
    state: "not_started",
    doesWhat:
      "Would compare the newer way of sending a guide against the older one, by serving a share of people through each.",
    affectsWho: "New guide requests. Deliveries already under way would be untouched.",
    outcome: "Whether the guide arrived complete, and whether anything needed review.",
    arms: [
      {
        key: "new_path",
        percent: null,
        doesWhat: "Served by the newer delivery path, which tracks each step separately.",
        isControl: false,
      },
      {
        key: "old_path",
        percent: null,
        doesWhat: "Served by the older path, which is what everyone gets today.",
        isControl: true,
      },
    ],
    ownedFlagKeys: ["GUIDE_DELIVERY_ENABLED", "GUIDE_DELIVERY_ROLLOUT_PERCENT"],
    blocker:
      "The rollout is at zero, so nobody is on the newer path yet. Raising it starts the comparison.",
  },
  {
    key: "cold-message-test",
    name: "Cold message test",
    state: "not_started",
    doesWhat:
      "Would find out whether an ordinary message is ever accepted by someone whose unlock message already failed every attempt.",
    affectsWho:
      "Only people whose unlock message ran out of retries. Nobody new would be contacted.",
    outcome: "Whether the message was accepted at all.",
    arms: [
      {
        key: "cold_dm",
        percent: null,
        doesWhat: "Gets one ordinary message after the unlock message gave up.",
        isControl: false,
      },
      {
        key: "left_alone",
        percent: null,
        doesWhat: "Gets nothing further, which is what happens today.",
        isControl: true,
      },
    ],
    ownedFlagKeys: ["GATE_DM_EXPERIMENT"],
    blocker: "It has never been switched on, so no message has been tried.",
  },
] as const;

const BY_KEY = new Map(EXPERIMENT_REGISTRY.map((e) => [e.key, e]));

export function experimentDefinition(key: string): ExperimentDefinition | undefined {
  return BY_KEY.get(key);
}
```

- [ ] **Step 5: Run the test and typecheck**

```bash
npx vitest run experimentRegistry flagRegistry
npx tsc --noEmit
```

Expected: both suites pass, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/config/experimentRegistry.ts src/config/experimentRegistry.test.ts src/config/flagRegistry.ts
git commit -m "feat: declare the three experiments and which flags they own"
```

---

### Task 2: Per-experiment summaries

**Files:**
- Create: `src/services/experimentSummary.ts`
- Test: `src/services/experimentSummary.test.ts`

**Interfaces:**
- Consumes: `EXPERIMENT_REGISTRY`, `experimentDefinition`, Prisma `dmRecoveryReminder`, `env`.
- Produces: `ArmCount`, `NotCounted`, `ExperimentSummary`, `createExperimentSummarizer(deps)`, `summarizeExperiment(key)`.

Deliberately **not** generic. Recovery counts arms out of `dm_recovery_reminder`; a rollout would compare two paths. One abstraction over three different shapes would be invented structure.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/experimentSummary.test.ts
import { describe, expect, it, vi } from "vitest";
import { createExperimentSummarizer } from "./experimentSummary.js";

function make(rows: { cohort: string; status: string; suppressionReason: string | null; _count: number }[]) {
  return createExperimentSummarizer({
    groupRecoveryReminders: vi.fn().mockResolvedValue(rows),
    experimentEndsAt: () => "2026-08-21T21:45:00.000Z",
    postExperimentEnabled: () => false,
  });
}

const ROWS = [
  { cohort: "treatment", status: "sent", suppressionReason: null, _count: 585 },
  { cohort: "treatment", status: "suppressed", suppressionReason: "seen", _count: 519 },
  { cohort: "treatment", status: "suppressed", suppressionReason: "audience_out_of_market", _count: 265 },
  { cohort: "control", status: "control", suppressionReason: null, _count: 394 },
];

describe("recovery reminder timing summary", () => {
  it("counts each arm in whole people", async () => {
    const summary = await make(ROWS).summarize("recovery-reminder-timing");

    expect(summary.kind).toBe("running");
    if (summary.kind !== "running") throw new Error("expected running");
    expect(summary.arms).toEqual([
      { key: "treatment", label: "Got a reminder", people: 585 },
      { key: "control", label: "Got nothing", people: 394 },
    ]);
  });

  // Suppressed people are neither arm: they were never reminded and were never a
  // control. Folding them in either direction would overstate that side.
  it("reports the skipped separately, with why", async () => {
    const summary = await make(ROWS).summarize("recovery-reminder-timing");
    if (summary.kind !== "running") throw new Error("expected running");

    expect(summary.notCounted).toEqual([
      { reason: "They opened it themselves", people: 519 },
      { reason: "Outside your audience", people: 265 },
    ]);
  });

  it("says when it ends and what happens then", async () => {
    const summary = await make(ROWS).summarize("recovery-reminder-timing");
    if (summary.kind !== "running") throw new Error("expected running");

    expect(summary.endsAt).toBe("2026-08-21T21:45:00.000Z");
    expect(summary.whenItEnds).toMatch(/reminders stop/i);
  });

  it("says the opposite when post-experiment sending is on", async () => {
    const s = createExperimentSummarizer({
      groupRecoveryReminders: vi.fn().mockResolvedValue(ROWS),
      experimentEndsAt: () => "2026-08-21T21:45:00.000Z",
      postExperimentEnabled: () => true,
    });
    const summary = await s.summarize("recovery-reminder-timing");
    if (summary.kind !== "running") throw new Error("expected running");

    expect(summary.whenItEnds).toMatch(/keep going/i);
  });

  it("renders no percentage anywhere", async () => {
    const summary = await make(ROWS).summarize("recovery-reminder-timing");

    expect(JSON.stringify(summary)).not.toMatch(/%/);
  });
});

describe("a not-started experiment", () => {
  it("returns what it would compare and what is blocking it, not zeroes", async () => {
    const summary = await make([]).summarize("guide-delivery-rollout");

    expect(summary).toEqual({
      kind: "not_started",
      wouldCompare: "Served by the newer delivery path, which tracks each step separately. versus Served by the older path, which is what everyone gets today.",
      blocker:
        "The rollout is at zero, so nobody is on the newer path yet. Raising it starts the comparison.",
    });
  });

  it("does not query anything for an experiment that never ran", async () => {
    const summarizer = make([]);
    await summarizer.summarize("cold-message-test");

    expect(summarizer.deps.groupRecoveryReminders).not.toHaveBeenCalled();
  });
});

describe("an unknown key", () => {
  it("throws rather than returning an empty summary", async () => {
    await expect(make([]).summarize("nope")).rejects.toThrow(/nope/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run experimentSummary`
Expected: FAIL — cannot resolve `./experimentSummary.js`.

- [ ] **Step 3: Write the summarizer**

```ts
// src/services/experimentSummary.ts
import { experimentDefinition } from "../config/experimentRegistry.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { flags } from "./flagService.js";

/**
 * What each experiment actually measured.
 *
 * One function per experiment, registered by key. NOT a generic metrics layer:
 * recovery counts arms out of dm_recovery_reminder and a rollout would compare two
 * delivery paths. A single abstraction over three different shapes would be
 * structure we invented rather than structure the data has.
 *
 * Counts only, never rates. 593 sends cannot support a percentage — see
 * docs/funnels.md, which refuses to print one its sample does not justify.
 */

export type ArmCount = { key: string; label: string; people: number };
export type NotCounted = { reason: string; people: number };

export type ExperimentSummary =
  | { kind: "not_started"; wouldCompare: string; blocker: string }
  | {
      kind: "running";
      arms: ArmCount[];
      notCounted: NotCounted[];
      endsAt: string | null;
      whenItEnds: string;
    };

/** Suppression reasons in the owner's words, ordered by how often they happen. */
const SKIP_LABELS: Record<string, string> = {
  seen: "They opened it themselves",
  inbound_reply: "They replied, so they saw it",
  audience_out_of_market: "Outside your audience",
  person_cooldown: "Reminded too recently",
  attachment: "They sent something back",
  reaction: "They reacted to it",
};

type ReminderGroup = {
  cohort: string;
  status: string;
  suppressionReason: string | null;
  _count: number;
};

export type SummarizerDeps = {
  groupRecoveryReminders: () => Promise<ReminderGroup[]>;
  experimentEndsAt: () => string | null;
  postExperimentEnabled: () => boolean;
};

export function createExperimentSummarizer(deps: SummarizerDeps) {
  async function recoveryReminderTiming(): Promise<ExperimentSummary> {
    const rows = await deps.groupRecoveryReminders();
    const total = (predicate: (r: ReminderGroup) => boolean) =>
      rows.filter(predicate).reduce((sum, r) => sum + r._count, 0);

    const skipped = rows
      .filter((r) => r.status === "suppressed" && r.suppressionReason)
      .reduce<Map<string, number>>((map, r) => {
        const label = SKIP_LABELS[r.suppressionReason!] ?? r.suppressionReason!;
        return map.set(label, (map.get(label) ?? 0) + r._count);
      }, new Map());

    return {
      kind: "running",
      // Only people actually reminded count as treatment. Someone suppressed was
      // never reminded, so counting them here would overstate the arm.
      arms: [
        {
          key: "treatment",
          label: "Got a reminder",
          people: total((r) => r.cohort === "treatment" && r.status === "sent"),
        },
        {
          key: "control",
          label: "Got nothing",
          people: total((r) => r.cohort === "control"),
        },
      ],
      notCounted: [...skipped.entries()]
        .map(([reason, people]) => ({ reason, people }))
        .sort((a, b) => b.people - a.people),
      endsAt: deps.experimentEndsAt(),
      whenItEnds: deps.postExperimentEnabled()
        ? "Reminders keep going after the window closes."
        : "When the window closes, reminders stop and wait for your decision. Nothing announces it.",
    };
  }

  const RUNNING: Record<string, () => Promise<ExperimentSummary>> = {
    "recovery-reminder-timing": recoveryReminderTiming,
  };

  return {
    deps,
    async summarize(key: string): Promise<ExperimentSummary> {
      const definition = experimentDefinition(key);
      if (!definition) throw new Error(`Unknown experiment: ${key}`);

      // Nothing to query, and no zeroes to print. A row of zeroes reads as
      // failure; "never switched on" reads as a decision.
      if (definition.state !== "running") {
        return {
          kind: "not_started",
          wouldCompare: definition.arms.map((a) => a.doesWhat).join(" versus "),
          blocker: definition.blocker,
        };
      }

      const summarize = RUNNING[key];
      if (!summarize) throw new Error(`No summary registered for running ${key}`);
      return summarize();
    },
  };
}

export const experimentSummarizer = createExperimentSummarizer({
  groupRecoveryReminders: async () => {
    const rows = await prisma.dmRecoveryReminder.groupBy({
      by: ["cohort", "status", "suppressionReason"],
      _count: { _all: true },
    });
    return rows.map((r) => ({
      cohort: r.cohort,
      status: r.status,
      suppressionReason: r.suppressionReason,
      _count: r._count._all,
    }));
  },
  experimentEndsAt: () => env.DM_RECOVERY_EXPERIMENT_END_AT ?? null,
  postExperimentEnabled: () => flags.bool("DM_RECOVERY_POST_EXPERIMENT_ENABLED"),
});

export const summarizeExperiment = (key: string) => experimentSummarizer.summarize(key);
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run experimentSummary`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/experimentSummary.ts src/services/experimentSummary.test.ts
git commit -m "feat: summarize each experiment in whole people, per key"
```

---

### Task 3: The API

**Files:**
- Create: `src/api/experiments.routes.ts`
- Test: `src/api/experiments.routes.test.ts`
- Modify: `src/api/flags.routes.ts`, `src/api/router.ts`

**Interfaces:**
- Consumes: Task 1 registry, Task 2 `summarizeExperiment`, existing `flags`.
- Produces: `GET /api/experiments` → `{ experiments: ExperimentListItem[] }`; `GET /api/experiments/:key` → definition + `summary` + `ownedFlags`; `GET /api/flags/:key` → one `FlagView`.

- [ ] **Step 1: Write the failing test**

```ts
// src/api/experiments.routes.test.ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const summarize = vi.fn();
const snapshot = vi.fn();

vi.mock("../services/experimentSummary.js", () => ({
  summarizeExperiment: (key: string) => summarize(key),
}));
vi.mock("../services/flagService.js", () => ({
  flags: { snapshot: () => snapshot() },
}));

const { experimentsRouter } = await import("./experiments.routes.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/experiments", experimentsRouter);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  snapshot.mockReturnValue([]);
  summarize.mockResolvedValue({ kind: "not_started", wouldCompare: "a versus b", blocker: "off" });
});

describe("experiments API", () => {
  it("lists all three with their state", async () => {
    const response = await request(app()).get("/api/experiments").expect(200);

    expect(response.body.experiments).toHaveLength(3);
    const recovery = response.body.experiments.find(
      (e: { key: string }) => e.key === "recovery-reminder-timing",
    );
    expect(recovery).toMatchObject({ name: "Recovery reminder timing", state: "running" });
  });

  it("does not summarize every experiment just to list them", async () => {
    await request(app()).get("/api/experiments").expect(200);

    // Three summaries on a list render would mean three database round trips for a
    // page showing three lines.
    expect(summarize).not.toHaveBeenCalled();
  });

  it("returns one experiment with its summary and its flags", async () => {
    snapshot.mockReturnValue([
      { key: "DM_RECOVERY_ENABLED", valueBool: true, valuePercent: null, source: "environment", driftsFromEnv: false, updatedBy: null, updatedAt: null },
    ]);
    summarize.mockResolvedValue({
      kind: "running",
      arms: [{ key: "treatment", label: "Got a reminder", people: 585 }],
      notCounted: [],
      endsAt: "2026-08-21T21:45:00.000Z",
      whenItEnds: "reminders stop",
    });

    const response = await request(app())
      .get("/api/experiments/recovery-reminder-timing")
      .expect(200);

    expect(response.body).toMatchObject({
      key: "recovery-reminder-timing",
      state: "running",
      summary: { kind: "running" },
    });
    expect(response.body.arms).toHaveLength(2);
    expect(response.body.ownedFlags.map((f: { key: string }) => f.key)).toContain(
      "DM_RECOVERY_ENABLED",
    );
    // Descriptions come along, so the page needs one request.
    expect(response.body.ownedFlags[0].doesWhat.length).toBeGreaterThan(20);
  });

  it("404s an unknown experiment", async () => {
    await request(app()).get("/api/experiments/nope").expect(404);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run experiments.routes`
Expected: FAIL — cannot resolve `./experiments.routes.js`.

- [ ] **Step 3: Write the router**

```ts
// src/api/experiments.routes.ts
import { Router } from "express";
import {
  EXPERIMENT_REGISTRY,
  experimentDefinition,
} from "../config/experimentRegistry.js";
import { FLAG_REGISTRY, flagDefinition } from "../config/flagRegistry.js";
import { flags } from "../services/flagService.js";
import { summarizeExperiment } from "../services/experimentSummary.js";

export const experimentsRouter = Router();

/**
 * The list. Definitions only — no summaries.
 *
 * Summarizing all three here would mean a database round trip per experiment to
 * render three lines of text. The list says what exists; the detail page measures.
 */
experimentsRouter.get("/", (_req, res) => {
  res.json({
    experiments: EXPERIMENT_REGISTRY.map((e) => ({
      key: e.key,
      name: e.name,
      state: e.state,
      armCount: e.arms.length,
      blocker: e.blocker,
    })),
  });
});

experimentsRouter.get("/:key", async (req, res) => {
  const definition = experimentDefinition(req.params.key);
  if (!definition) return res.status(404).json({ error: "not_found" });

  const byKey = new Map(flags.snapshot().map((row) => [row.key, row]));
  const ownedFlags = definition.ownedFlagKeys
    .map((key) => flagDefinition(key))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .map((d) => ({ ...d, ...(byKey.get(d.key) ?? {}) }));

  res.json({
    ...definition,
    summary: await summarizeExperiment(definition.key),
    ownedFlags,
  });
});

// Referenced so the flag registry cannot be tree-shaken out of the ownedFlags
// lookup above; also asserts at import time that the registry is non-empty.
if (FLAG_REGISTRY.length === 0) throw new Error("flag registry is empty");
```

- [ ] **Step 4: Add `GET /flags/:key`**

Append to `src/api/flags.routes.ts`, above the `patch` handler:

```ts
/** One flag, for its detail page. Same shape as a row of the list. */
flagsRouter.get("/:key", (req, res) => {
  const definition = flagDefinition(req.params.key);
  if (!definition) return res.status(404).json({ error: "not_found" });
  const row = flags.snapshot().find((entry) => entry.key === definition.key);
  res.json({ ...definition, ...row });
});
```

- [ ] **Step 5: Register the router**

In `src/api/router.ts`:

```ts
import { experimentsRouter } from "./experiments.routes.js";
// ...
apiRouter.use("/experiments", experimentsRouter);
```

- [ ] **Step 6: Run and commit**

```bash
npx vitest run experiments.routes flags.routes
npx tsc --noEmit
git add src/api/experiments.routes.ts src/api/experiments.routes.test.ts src/api/flags.routes.ts src/api/router.ts
git commit -m "feat: serve experiments and a single flag"
```

---

### Task 4: Switches — list and detail

**Files:**
- Create: `web/src/pages/Switches.tsx`, `web/src/pages/Switches.test.tsx`
- Create: `web/src/pages/SwitchDetail.tsx`, `web/src/pages/SwitchDetail.test.tsx`
- Modify: `web/src/lib/types.ts`

**Interfaces:**
- Consumes: `GET /api/flags`, `GET /api/flags/:key`, `PATCH /api/flags/:key`.
- Produces: `Switches`, `SwitchDetail` components. `FlagView` gains `experimentKey?: string`.

- [ ] **Step 1: Extend the types**

In `web/src/lib/types.ts`, add to `FlagView`:

```ts
  /** The experiment this switch belongs to, if any. */
  experimentKey?: string;
```

And add:

```ts
export type ExperimentState = "running" | "not_started" | "ended";

export interface ExperimentListItem {
  key: string;
  name: string;
  state: ExperimentState;
  armCount: number;
  blocker: string;
}

export interface ExperimentArmView {
  key: string;
  percent: number | null;
  doesWhat: string;
  isControl: boolean;
}

export type ExperimentSummaryView =
  | { kind: "not_started"; wouldCompare: string; blocker: string }
  | {
      kind: "running";
      arms: { key: string; label: string; people: number }[];
      notCounted: { reason: string; people: number }[];
      endsAt: string | null;
      whenItEnds: string;
    };

export interface ExperimentDetailView {
  key: string;
  name: string;
  state: ExperimentState;
  doesWhat: string;
  affectsWho: string;
  outcome: string;
  arms: ExperimentArmView[];
  blocker: string;
  summary: ExperimentSummaryView;
  ownedFlags: FlagView[];
}
```

- [ ] **Step 2: Write the failing list test**

```tsx
// web/src/pages/Switches.test.tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlagView } from "@/lib/types";

const apiRead = vi.fn();
vi.mock("../lib/api", () => ({
  apiRead: (...a: unknown[]) => apiRead(...a),
  apiMutation: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { Switches } = await import("./Switches");

function flag(over: Partial<FlagView> = {}): FlagView {
  return {
    key: "AI_DRAFTS_ENABLED",
    name: "Reply drafts",
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Switches />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => apiRead.mockReset());

describe("Switches list", () => {
  // The whole reason for this rewrite. Sixteen rows of three sentences was
  // unreadable; a list is for finding the thing, not deciding about it.
  it("shows no descriptions and no controls", async () => {
    apiRead.mockResolvedValue({ flags: [flag()] });
    renderPage();

    expect(await screen.findByRole("link", { name: /Reply drafts/ })).toBeInTheDocument();
    expect(screen.queryByText(/Writes a suggested reply/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Who it affects/)).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
  });

  it("links each row to its own page", async () => {
    apiRead.mockResolvedValue({ flags: [flag()] });
    renderPage();

    expect(await screen.findByRole("link", { name: /Reply drafts/ })).toHaveAttribute(
      "href",
      "/switches/AI_DRAFTS_ENABLED",
    );
  });

  it("keeps the blast-radius grouping, loudest first", async () => {
    apiRead.mockResolvedValue({
      flags: [
        flag(),
        flag({ key: "DM_RECOVERY_ENABLED", name: "Recovery reminders", group: "outbound" }),
      ],
    });
    renderPage();

    const outbound = await screen.findByText("Reaches real people");
    const assistive = screen.getByText("Nothing leaves the app");
    expect(
      outbound.compareDocumentPosition(assistive) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Five of these move together and nothing used to say so.
  it("says which experiment a switch belongs to", async () => {
    apiRead.mockResolvedValue({
      flags: [
        flag({
          key: "DM_RECOVERY_ENABLED",
          name: "Recovery reminders",
          group: "outbound",
          experimentKey: "recovery-reminder-timing",
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText(/part of/i)).toBeInTheDocument();
  });

  it("calls a failed read a connection problem", async () => {
    apiRead.mockRejectedValue(new Error("down"));
    renderPage();

    expect(await screen.findByText(/connection problem/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npm --prefix web test -- Switches`
Expected: FAIL — cannot resolve `./Switches`.

- [ ] **Step 4: Write the list**

```tsx
// web/src/pages/Switches.tsx
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { apiRead } from "@/lib/api";
import type { FlagGroup, FlagView, FlagsResponse } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Grouped by blast radius, loudest first. That part of the old page worked: these
 * sixteen are not peers, and the group that can reach a real parent is the one you
 * open during an incident.
 */
const GROUPS: { key: FlagGroup; heading: string }[] = [
  { key: "outbound", heading: "Reaches real people" },
  { key: "experiment", heading: "Measuring something" },
  { key: "assistive", heading: "Nothing leaves the app" },
  { key: "infrastructure", heading: "Not a product choice" },
];

const EXPERIMENT_NAMES: Record<string, string> = {
  "recovery-reminder-timing": "Recovery reminder timing",
  "guide-delivery-rollout": "Guide delivery rollout",
  "cold-message-test": "Cold message test",
};

export function Switches() {
  const query = useQuery<FlagsResponse>({
    queryKey: ["flags"],
    queryFn: ({ signal }) => apiRead<FlagsResponse>("/flags", { signal }),
  });
  const all = query.data?.flags ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Switches</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every switch in the system. Open one to see what it does and change it.
        </p>
      </div>

      {query.isLoading ? (
        <div className="space-y-2 border-t pt-3">
          <Skeleton className="h-8 rounded-md" />
          <Skeleton className="h-8 rounded-md" />
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
          const rows = all.filter((entry) => entry.group === key);
          if (rows.length === 0) return null;
          return (
            <section key={key}>
              <h2 className="label-caps border-b border-line pb-1.5">{heading}</h2>
              <ul>
                {rows.map((entry) => (
                  <SwitchRow key={entry.key} flag={entry} />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

function SwitchRow({ flag }: { flag: FlagView }) {
  const live =
    flag.kind === "boolean" ? flag.valueBool === true : (flag.valuePercent ?? 0) > 0;
  const experiment = flag.experimentKey ? EXPERIMENT_NAMES[flag.experimentKey] : null;

  return (
    <li>
      <Link
        to={`/switches/${flag.key}`}
        className="grid grid-cols-[1fr_auto_auto_16px] items-center gap-3 border-b py-3 transition-[padding] hover:pl-1.5 active:opacity-60 [@media(pointer:coarse)]:min-h-11"
      >
        <span className="text-sm font-medium">{flag.name}</span>
        <span className="text-[12.5px] text-muted-foreground">
          {experiment ? `part of ${experiment}` : ""}
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium",
            live ? "bg-signal-soft text-signal" : "bg-muted text-muted-foreground",
          )}
        >
          {flag.kind === "percent" ? `${flag.valuePercent ?? 0}%` : live ? "Live" : "Off"}
        </span>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  );
}
```

- [ ] **Step 5: Run the list test**

Run: `npm --prefix web test -- Switches`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing detail test**

```tsx
// web/src/pages/SwitchDetail.test.tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlagView } from "@/lib/types";

const apiRead = vi.fn();
const apiMutation = vi.fn();
vi.mock("../lib/api", () => ({
  apiRead: (...a: unknown[]) => apiRead(...a),
  apiMutation: (...a: unknown[]) => apiMutation(...a),
  ApiError: class ApiError extends Error {},
}));

const { SwitchDetail } = await import("./SwitchDetail");

function flag(over: Partial<FlagView> = {}): FlagView {
  return {
    key: "DM_RECOVERY_ENABLED",
    name: "Recovery reminders",
    group: "outbound",
    kind: "boolean",
    doesWhat: "Leaves a public comment telling them to check their requests.",
    affectsWho: "People sent a guide who have not opened it.",
    ifOff: "No public reminders are posted.",
    pageMayEnable: false,
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

function renderDetail(key = "DM_RECOVERY_ENABLED") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/switches/${key}`]}>
        <Routes>
          <Route path="/switches/:key" element={<SwitchDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  apiRead.mockReset();
  apiMutation.mockReset().mockResolvedValue(flag({ valueBool: false }));
});

describe("SwitchDetail", () => {
  it("answers all three questions here, where there is room", async () => {
    apiRead.mockResolvedValue(flag());
    renderDetail();

    expect(await screen.findByText(/Leaves a public comment/)).toBeInTheDocument();
    expect(screen.getByText(/People sent a guide/)).toBeInTheDocument();
    expect(screen.getByText(/No public reminders are posted/)).toBeInTheDocument();
  });

  it("offers Stop now and no way to start, for an outbound switch", async () => {
    apiRead.mockResolvedValue(flag());
    const user = userEvent.setup();
    renderDetail();

    const stop = await screen.findByRole("button", { name: "Stop Recovery reminders" });
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    await user.click(stop);
    await waitFor(() =>
      expect(apiMutation).toHaveBeenCalledWith("/flags/DM_RECOVERY_ENABLED", {
        method: "PATCH",
        body: JSON.stringify({ valueBool: false }),
      }),
    );
  });

  it("links back to the experiment it belongs to", async () => {
    apiRead.mockResolvedValue(flag({ experimentKey: "recovery-reminder-timing" }));
    renderDetail();

    expect(await screen.findByRole("link", { name: /Recovery reminder timing/ })).toHaveAttribute(
      "href",
      "/experiments/recovery-reminder-timing",
    );
  });

  it("warns when a restart would revert the value", async () => {
    apiRead.mockResolvedValue(flag({ source: "override", driftsFromEnv: true }));
    renderDetail();

    expect(await screen.findByText(/a restart would change this back/i)).toBeInTheDocument();
  });

  it("says so plainly when the console cannot change it", async () => {
    apiRead.mockResolvedValue(
      flag({ key: "WORKERS_ENABLED", name: "Background jobs", pageMayEnable: false, pageMayStop: false }),
    );
    renderDetail("WORKERS_ENABLED");

    expect(await screen.findByText(/changed in Railway/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Write the detail page**

```tsx
// web/src/pages/SwitchDetail.tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Lock } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { apiMutation, apiRead } from "@/lib/api";
import { outcomeMessage } from "@/lib/unknownOutcome";
import type { FlagView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

const EXPERIMENT_NAMES: Record<string, string> = {
  "recovery-reminder-timing": "Recovery reminder timing",
  "guide-delivery-rollout": "Guide delivery rollout",
  "cold-message-test": "Cold message test",
};

export function SwitchDetail() {
  const { key = "" } = useParams();
  const queryClient = useQueryClient();

  const query = useQuery<FlagView>({
    queryKey: ["flags", key],
    queryFn: ({ signal }) => apiRead<FlagView>(`/flags/${key}`, { signal }),
  });

  const change = useMutation({
    mutationFn: (value: { valueBool?: boolean; valuePercent?: number }) =>
      apiMutation<FlagView>(`/flags/${key}`, {
        method: "PATCH",
        body: JSON.stringify(value),
      }),
    // Settled, not success: after an unknown outcome the read is still the only
    // thing that can say what is in force.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["flags"] });
      void queryClient.invalidateQueries({ queryKey: ["flags", key] });
    },
  });

  const flag = query.data;

  return (
    <div className="space-y-5">
      <Link
        to="/switches"
        className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Switches
      </Link>

      {query.isLoading ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : query.isError || !flag ? (
        <p className="text-[13px] text-muted-foreground">
          Couldn&apos;t load this switch — the API did not answer. This is a connection
          problem, not a missing switch.
        </p>
      ) : (
        <>
          <div>
            <h1 className="text-2xl font-medium tracking-tight">{flag.name}</h1>
            <p className="key mt-1 font-mono text-xs text-muted-foreground">{flag.key}</p>
          </div>

          {change.error && (
            <p role="alert" className="rounded-md bg-urgent-soft px-3 py-2 text-[13px] text-urgent">
              {outcomeMessage(
                change.error,
                change.error instanceof Error ? change.error.message : "That did not save.",
              )}
            </p>
          )}

          <div className="space-y-3 rounded-lg bg-signal-soft px-4 py-3.5">
            <p className="text-[14.5px] leading-relaxed">{flag.doesWhat}</p>
            <p className="text-[13.5px] leading-relaxed">
              <span className="font-medium">Who it affects:</span> {flag.affectsWho}
            </p>
            <p className="text-[13.5px] leading-relaxed">
              <span className="font-medium">If you turn it off:</span> {flag.ifOff}
            </p>
          </div>

          <dl className="grid grid-cols-[170px_1fr] gap-y-2 text-[13.5px]">
            <dt className="text-muted-foreground">In force now</dt>
            <dd>
              {flag.kind === "percent"
                ? `${flag.valuePercent ?? 0}%`
                : flag.valueBool
                  ? "On"
                  : "Off"}
              {flag.source === "override" ? " · saved here" : " · from the deployed value"}
            </dd>
            {flag.experimentKey && EXPERIMENT_NAMES[flag.experimentKey] && (
              <>
                <dt className="text-muted-foreground">Part of</dt>
                <dd>
                  <Link
                    to={`/experiments/${flag.experimentKey}`}
                    className="text-signal underline underline-offset-2"
                  >
                    {EXPERIMENT_NAMES[flag.experimentKey]}
                  </Link>
                </dd>
              </>
            )}
          </dl>

          {flag.driftsFromEnv && (
            <p className="inline-flex items-start gap-1.5 rounded-md bg-caution-soft px-3 py-2 text-[13px] text-caution">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              Saved here, but a restart would change this back to the deployed value.
            </p>
          )}

          <div className="border-t pt-4">
            {flag.kind === "percent" && flag.pageMayEnable ? (
              <label className="flex items-center gap-3 text-[13px]">
                <span className="text-muted-foreground">Rollout</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  defaultValue={flag.valuePercent ?? 0}
                  disabled={change.isPending}
                  aria-label={flag.name}
                  className="w-48 accent-signal"
                  onMouseUp={(event) =>
                    change.mutate({
                      valuePercent: Number((event.target as HTMLInputElement).value),
                    })
                  }
                />
              </label>
            ) : flag.pageMayEnable && flag.pageMayStop ? (
              <label className="flex items-center gap-3 text-[13px]">
                <Switch
                  checked={flag.valueBool === true}
                  disabled={change.isPending}
                  aria-label={flag.name}
                  onCheckedChange={(checked) => change.mutate({ valueBool: checked })}
                />
                <span className="text-muted-foreground">
                  {flag.valueBool ? "On" : "Off"}
                </span>
              </label>
            ) : flag.pageMayStop && flag.valueBool ? (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  disabled={change.isPending}
                  aria-label={`Stop ${flag.name}`}
                  onClick={() => change.mutate({ valueBool: false })}
                >
                  {change.isPending ? "Stopping…" : "Stop now"}
                </Button>
                <p className="text-[12.5px] text-muted-foreground">
                  Turning this back on needs a deploy, on purpose.
                </p>
              </div>
            ) : (
              <p className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <Lock className="size-3.5" aria-hidden />
                changed in Railway
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run and commit**

```bash
npm --prefix web test -- Switches SwitchDetail
git add web/src/pages/Switches.tsx web/src/pages/Switches.test.tsx web/src/pages/SwitchDetail.tsx web/src/pages/SwitchDetail.test.tsx web/src/lib/types.ts
git commit -m "feat: switches as a scannable list with a page each"
```

---

### Task 5: Experiments — list and detail

**Files:**
- Create: `web/src/pages/Experiments.tsx`, `web/src/pages/Experiments.test.tsx`
- Create: `web/src/pages/ExperimentDetail.tsx`, `web/src/pages/ExperimentDetail.test.tsx`

**Interfaces:**
- Consumes: `GET /api/experiments`, `GET /api/experiments/:key`, types from Task 4.
- Produces: `Experiments`, `ExperimentDetail` components.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/pages/Experiments.test.tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiRead = vi.fn();
vi.mock("../lib/api", () => ({
  apiRead: (...a: unknown[]) => apiRead(...a),
  apiMutation: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { Experiments } = await import("./Experiments");

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Experiments />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => apiRead.mockReset());

const LIST = {
  experiments: [
    { key: "recovery-reminder-timing", name: "Recovery reminder timing", state: "running", armCount: 2, blocker: "" },
    { key: "guide-delivery-rollout", name: "Guide delivery rollout", state: "not_started", armCount: 2, blocker: "The rollout is at zero, so nobody is on the newer path yet." },
  ],
};

describe("Experiments list", () => {
  it("shows one line each, linking to its own page", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    expect(await screen.findByRole("link", { name: /Recovery reminder timing/ })).toHaveAttribute(
      "href",
      "/experiments/recovery-reminder-timing",
    );
  });

  // "Not started" is the useful part: a list of experiments you could run tomorrow.
  it("says not started, with why, rather than showing zeroes", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    expect(await screen.findByText("Not started")).toBeInTheDocument();
    expect(screen.getByText(/rollout is at zero/)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("puts a running experiment above one that has not started", async () => {
    apiRead.mockResolvedValue(LIST);
    renderPage();

    const running = await screen.findByText("Running");
    const notStarted = screen.getByText("Not started");
    expect(
      running.compareDocumentPosition(notStarted) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
```

```tsx
// web/src/pages/ExperimentDetail.test.tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiRead = vi.fn();
vi.mock("../lib/api", () => ({
  apiRead: (...a: unknown[]) => apiRead(...a),
  apiMutation: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const { ExperimentDetail } = await import("./ExperimentDetail");

function renderDetail(key = "recovery-reminder-timing") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/experiments/${key}`]}>
        <Routes>
          <Route path="/experiments/:key" element={<ExperimentDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const RUNNING = {
  key: "recovery-reminder-timing",
  name: "Recovery reminder timing",
  state: "running",
  doesWhat: "Tests whether leaving a public comment helps when someone never opens the guide.",
  affectsWho: "People sent a guide who have not opened it.",
  outcome: "Whether they received the guide within 48 hours of first asking.",
  arms: [
    { key: "treatment", percent: 90, doesWhat: "Gets a public comment.", isControl: false },
    { key: "control", percent: 10, doesWhat: "Gets nothing.", isControl: true },
  ],
  blocker: "",
  summary: {
    kind: "running",
    arms: [
      { key: "treatment", label: "Got a reminder", people: 585 },
      { key: "control", label: "Got nothing", people: 394 },
    ],
    notCounted: [{ reason: "They opened it themselves", people: 519 }],
    endsAt: "2026-08-21T21:45:00.000Z",
    whenItEnds: "When the window closes, reminders stop and wait for your decision.",
  },
  ownedFlags: [
    {
      key: "DM_RECOVERY_ENABLED",
      name: "Recovery reminders",
      group: "outbound",
      kind: "boolean",
      doesWhat: "Leaves a public comment.",
      affectsWho: "People sent a guide.",
      ifOff: "No reminders.",
      pageMayEnable: false,
      pageMayStop: true,
      valueBool: true,
      valuePercent: null,
      source: "environment",
      driftsFromEnv: false,
      updatedBy: null,
      updatedAt: null,
    },
  ],
};

afterEach(cleanup);
beforeEach(() => apiRead.mockReset());

describe("ExperimentDetail, running", () => {
  it("shows each arm in whole people, with the do-nothing arm", async () => {
    apiRead.mockResolvedValue(RUNNING);
    renderDetail();

    expect(await screen.findByText("585")).toBeInTheDocument();
    expect(screen.getByText("394")).toBeInTheDocument();
    expect(screen.getByText("Got nothing")).toBeInTheDocument();
  });

  // No confidence intervals, no significance. 593 sends cannot support them.
  it("prints no percentages or statistics", async () => {
    apiRead.mockResolvedValue(RUNNING);
    const { container } = renderDetail();

    await screen.findByText("585");
    expect(container.textContent).not.toMatch(/%|significan|confidence|p-value/i);
  });

  it("shows who was skipped and why, separately from the arms", async () => {
    apiRead.mockResolvedValue(RUNNING);
    renderDetail();

    expect(await screen.findByText("They opened it themselves")).toBeInTheDocument();
    expect(screen.getByText("519")).toBeInTheDocument();
  });

  it("says when it ends and what happens then", async () => {
    apiRead.mockResolvedValue(RUNNING);
    renderDetail();

    expect(await screen.findByText(/reminders stop and wait/)).toBeInTheDocument();
  });

  it("lists the switches it owns, each linking to its page", async () => {
    apiRead.mockResolvedValue(RUNNING);
    renderDetail();

    expect(await screen.findByRole("link", { name: /Recovery reminders/ })).toHaveAttribute(
      "href",
      "/switches/DM_RECOVERY_ENABLED",
    );
  });
});

describe("ExperimentDetail, not started", () => {
  it("says what it would compare and what is blocking it", async () => {
    apiRead.mockResolvedValue({
      ...RUNNING,
      key: "guide-delivery-rollout",
      name: "Guide delivery rollout",
      state: "not_started",
      blocker: "The rollout is at zero, so nobody is on the newer path yet.",
      summary: {
        kind: "not_started",
        wouldCompare: "The newer path versus the older path.",
        blocker: "The rollout is at zero, so nobody is on the newer path yet.",
      },
      ownedFlags: [],
    });
    renderDetail("guide-delivery-rollout");

    expect(await screen.findByText(/rollout is at zero/)).toBeInTheDocument();
    expect(screen.getByText(/newer path versus the older path/)).toBeInTheDocument();
    // Zeroes read as failure. This has not failed; it has not started.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run both and confirm they fail**

Run: `npm --prefix web test -- Experiments ExperimentDetail`
Expected: FAIL — cannot resolve the modules.

- [ ] **Step 3: Write the list**

```tsx
// web/src/pages/Experiments.tsx
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { apiRead } from "@/lib/api";
import type { ExperimentListItem, ExperimentState } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const STATE: Record<ExperimentState, { label: string; tone: string; order: number }> = {
  running: { label: "Running", tone: "bg-signal-soft text-signal", order: 0 },
  not_started: { label: "Not started", tone: "bg-muted text-muted-foreground", order: 1 },
  ended: { label: "Ended", tone: "bg-caution-soft text-caution", order: 2 },
};

export function Experiments() {
  const query = useQuery<{ experiments: ExperimentListItem[] }>({
    queryKey: ["experiments"],
    queryFn: ({ signal }) =>
      apiRead<{ experiments: ExperimentListItem[] }>("/experiments", { signal }),
  });

  // Running first: it is the only one that can need a decision from you.
  const rows = [...(query.data?.experiments ?? [])].sort(
    (a, b) => STATE[a.state].order - STATE[b.state].order,
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Experiments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Where two things are being compared, so you can tell which works better.
        </p>
      </div>

      {query.isLoading ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : query.isError ? (
        <p className="border-t py-4 text-[13px] text-muted-foreground">
          Couldn&apos;t load these — the API did not answer. This is a connection problem,
          not an empty list.{" "}
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="underline underline-offset-2 [@media(pointer:coarse)]:min-h-11"
          >
            Try again
          </button>
        </p>
      ) : (
        <ul className="border-t">
          {rows.map((row) => (
            <li key={row.key}>
              <Link
                to={`/experiments/${row.key}`}
                className="grid grid-cols-[1fr_auto_16px] items-center gap-3 border-b py-3.5 transition-[padding] hover:pl-1.5 active:opacity-60 [@media(pointer:coarse)]:min-h-11"
              >
                <span>
                  <span className="block text-sm font-medium">{row.name}</span>
                  {row.blocker && (
                    <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                      {row.blocker}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium",
                    STATE[row.state].tone,
                  )}
                >
                  {STATE[row.state].label}
                </span>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write the detail**

```tsx
// web/src/pages/ExperimentDetail.tsx
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { apiRead } from "@/lib/api";
import type { ExperimentDetailView } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";

const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function daysLeft(endsAt: string | null): string | null {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  const days = Math.ceil(ms / 86_400_000);
  if (days < 0) return "already closed";
  if (days === 0) return "closes today";
  return days === 1 ? "1 day left" : `${days} days left`;
}

export function ExperimentDetail() {
  const { key = "" } = useParams();
  const query = useQuery<ExperimentDetailView>({
    queryKey: ["experiments", key],
    queryFn: ({ signal }) => apiRead<ExperimentDetailView>(`/experiments/${key}`, { signal }),
  });

  const experiment = query.data;

  return (
    <div className="space-y-5">
      <Link
        to="/experiments"
        className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Experiments
      </Link>

      {query.isLoading ? (
        <Skeleton className="h-56 rounded-lg" />
      ) : query.isError || !experiment ? (
        <p className="text-[13px] text-muted-foreground">
          Couldn&apos;t load this — the API did not answer. This is a connection problem,
          not a missing experiment.
        </p>
      ) : (
        <>
          <h1 className="text-2xl font-medium tracking-tight">{experiment.name}</h1>

          <div className="space-y-3 rounded-lg bg-signal-soft px-4 py-3.5">
            <p className="text-[14.5px] leading-relaxed">{experiment.doesWhat}</p>
            <p className="text-[13.5px] leading-relaxed">
              <span className="font-medium">Who it affects:</span> {experiment.affectsWho}
            </p>
            <p className="text-[13.5px] leading-relaxed">
              <span className="font-medium">What decides it:</span> {experiment.outcome}
            </p>
          </div>

          {experiment.summary.kind === "running" ? (
            <>
              <section>
                <h2 className="label-caps border-b border-line pb-1.5">So far</h2>
                <ul className="mt-1">
                  {experiment.summary.arms.map((arm) => (
                    <li
                      key={arm.key}
                      className="grid grid-cols-[1fr_auto] items-baseline gap-3 border-b py-2.5"
                    >
                      <span className="text-[13.5px]">{arm.label}</span>
                      <span className="text-lg font-medium tabular-nums">{arm.people}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[12.5px] text-muted-foreground">
                  People, not rates. Too few to turn into a percentage honestly.
                </p>
              </section>

              {experiment.summary.notCounted.length > 0 && (
                <section>
                  <h2 className="label-caps border-b border-line pb-1.5">
                    Skipped, and why
                  </h2>
                  <ul className="mt-1">
                    {experiment.summary.notCounted.map((row) => (
                      <li
                        key={row.reason}
                        className="grid grid-cols-[1fr_auto] items-baseline gap-3 border-b py-2 text-[13px]"
                      >
                        <span className="text-muted-foreground">{row.reason}</span>
                        <span className="tabular-nums">{row.people}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[12.5px] text-muted-foreground">
                    Neither arm: never reminded, and never a control either.
                  </p>
                </section>
              )}

              <section className="rounded-md bg-caution-soft px-3.5 py-3 text-[13px] text-caution">
                {experiment.summary.endsAt && (
                  <p className="font-medium">
                    Closes {dayFormat.format(new Date(experiment.summary.endsAt))}
                    {daysLeft(experiment.summary.endsAt)
                      ? ` · ${daysLeft(experiment.summary.endsAt)}`
                      : ""}
                  </p>
                )}
                <p className="mt-1">{experiment.summary.whenItEnds}</p>
              </section>
            </>
          ) : (
            <section className="space-y-2 rounded-lg border border-dashed px-4 py-4">
              <h2 className="text-sm font-medium">Not started</h2>
              <p className="text-[13.5px] text-muted-foreground">
                {experiment.summary.blocker}
              </p>
              <p className="text-[13.5px]">
                <span className="text-muted-foreground">It would compare:</span>{" "}
                {experiment.summary.wouldCompare}
              </p>
            </section>
          )}

          {experiment.ownedFlags.length > 0 && (
            <section>
              <h2 className="label-caps border-b border-line pb-1.5">Its switches</h2>
              <ul>
                {experiment.ownedFlags.map((flag) => (
                  <li key={flag.key}>
                    <Link
                      to={`/switches/${flag.key}`}
                      className="flex items-baseline justify-between gap-3 border-b py-2.5 text-[13.5px] hover:pl-1.5 [@media(pointer:coarse)]:min-h-11"
                    >
                      <span>{flag.name}</span>
                      <span className="text-muted-foreground">
                        {flag.kind === "percent"
                          ? `${flag.valuePercent ?? 0}%`
                          : flag.valueBool
                            ? "Live"
                            : "Off"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run and commit**

```bash
npm --prefix web test -- Experiments ExperimentDetail
git add web/src/pages/Experiments.tsx web/src/pages/Experiments.test.tsx web/src/pages/ExperimentDetail.tsx web/src/pages/ExperimentDetail.test.tsx
git commit -m "feat: experiments as three lines and a result page each"
```

---

### Task 6: Navigation, redirect, E2E, full gate

**Files:**
- Modify: `web/src/lib/navigation.ts`, `web/src/lib/navigation.test.ts`, `web/src/AppRoutes.tsx`, `web/src/AppRoutes.test.tsx`
- Delete: `web/src/pages/Flags.tsx`, `web/src/pages/Flags.test.tsx`
- Modify: `web/e2e/main.tsx`, `web/e2e/visual-qa.spec.ts`
- Modify: `docs/experiments.md`, `docs/client-operation-contracts.md`

- [ ] **Step 1: Replace the destination**

In `web/src/lib/navigation.ts`, replace the single `/flags` entry in the System group:

```ts
      {
        path: "/experiments",
        label: "Experiments",
        mobileTitle: "Experiments",
        group: "System",
      },
      { path: "/switches", label: "Switches", mobileTitle: "Switches", group: "System" },
```

- [ ] **Step 2: Update the navigation test**

In `web/src/lib/navigation.test.ts`, change the System group expectation to
`["Experiments", "Switches", "Activity", "Assistant"]`, and replace the
`["/flags", "Testing"]` title row with:

```ts
    ["/experiments", "Experiments"],
    ["/switches", "Switches"],
```

- [ ] **Step 3: Replace the routes**

In `web/src/AppRoutes.tsx`, remove the `Flags` import and its route, then add:

```tsx
import { Experiments } from "@/pages/Experiments";
import { ExperimentDetail } from "@/pages/ExperimentDetail";
import { Switches } from "@/pages/Switches";
import { SwitchDetail } from "@/pages/SwitchDetail";
```

```tsx
        <Route path="experiments" element={<Experiments />} />
        <Route path="experiments/:key" element={<ExperimentDetail />} />
        <Route path="switches" element={<Switches />} />
        <Route path="switches/:key" element={<SwitchDetail />} />
        {/* /flags shipped and may be bookmarked. Redirect rather than 404. */}
        <Route path="flags" element={<Navigate to="/switches" replace />} />
```

`Navigate` is already imported in that file for the `/users` redirect; confirm with
`grep -n "Navigate" web/src/AppRoutes.tsx` and add it to the import if absent.

- [ ] **Step 4: Update the routes test and delete the old page**

In `web/src/AppRoutes.test.tsx`, replace the `@/pages/Flags` mock with four mocks:

```tsx
vi.mock("@/pages/Experiments", () => ({ Experiments: () => null }));
vi.mock("@/pages/ExperimentDetail", () => ({ ExperimentDetail: () => null }));
vi.mock("@/pages/Switches", () => ({ Switches: () => null }));
vi.mock("@/pages/SwitchDetail", () => ({ SwitchDetail: () => null }));
```

Then:

```bash
git rm web/src/pages/Flags.tsx web/src/pages/Flags.test.tsx
```

- [ ] **Step 5: Add a redirect test**

Append to `web/src/AppRoutes.test.tsx`:

```tsx
  it("sends the old /flags address to Switches", async () => {
    renderAt("/flags");
    expect(await screen.findByText("Switches")).toBeInTheDocument();
  });
```

Match the helper name the file already uses for rendering at a path — check with
`grep -n "function render" web/src/AppRoutes.test.tsx` and reuse it.

- [ ] **Step 6: Update the E2E harness**

In `web/e2e/main.tsx`: rename the `flags` scenario to `switches`, add an
`experiments` scenario rendering `<Experiments />`, and add two stubs beside the
existing `/flags` one:

```tsx
    if (path === "/experiments" && method === "GET") {
      return json({
        experiments: [
          { key: "recovery-reminder-timing", name: "Recovery reminder timing", state: "running", armCount: 2, blocker: "" },
          { key: "guide-delivery-rollout", name: "Guide delivery rollout", state: "not_started", armCount: 2, blocker: "The rollout is at zero, so nobody is on the newer path yet." },
          { key: "cold-message-test", name: "Cold message test", state: "not_started", armCount: 2, blocker: "It has never been switched on." },
        ],
      });
    }
```

- [ ] **Step 7: Replace the visual case**

In `web/e2e/visual-qa.spec.ts`, replace the `things we're testing` test with two:

```ts
  test("switches", async ({ page }, testInfo) => {
    await open(page, "switches");
    await expect(page.getByRole("heading", { level: 1, name: "Switches" })).toBeVisible();
    // The rewrite's whole point: a list you can scan, with no descriptions in it.
    await expect(page.getByText("Who it affects:")).toHaveCount(0);
    await expect(page.getByText("Reaches real people")).toBeVisible();
    await settleAnimations(page);
    await capture(page, testInfo.project.name, "switches");
  });

  test("experiments", async ({ page }, testInfo) => {
    await open(page, "experiments");
    await expect(page.getByRole("heading", { level: 1, name: "Experiments" })).toBeVisible();
    await expect(page.getByText("Running")).toBeVisible();
    await expect(page.getByText("Not started").first()).toBeVisible();
    await settleAnimations(page);
    await capture(page, testInfo.project.name, "experiments");
  });
```

- [ ] **Step 8: Update the docs**

In `docs/experiments.md`, add after the seven rules:

```markdown
## Switches versus experiments

An experiment is **a flag with declared arms** — named, split stated, outcome chosen.
No arms means it is a switch. Checkable rather than debatable, which is the point:
the older Insights → Experiments tab defined it by feeling and holds 94 rows nobody
can close.

Three qualify today, two of them `not_started`. That state is deliberate — a list of
experiments you could run tomorrow is more useful than hiding them.

An experiment owns flags: recovery reminder timing owns five, which is why they move
together. A flag appears once, on Switches, and links to its experiment.
```

In `docs/client-operation-contracts.md`, the `PATCH /flags/:key` row's canonical read
becomes `GET /flags/:key`.

- [ ] **Step 9: Run the whole gate**

```bash
export QA_DB="postgresql://postgres:codex_qa_only@127.0.0.1:55439/insta_contract"
DATABASE_URL="$QA_DB" MIGRATION_TEST_DATABASE_URL="$QA_DB" \
  MIGRATION_TEST_DATABASE_DISPOSABLE=true npm test -- --maxWorkers=1
npm run build
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
npm --prefix web run test:e2e
grep -rn "pages/Flags" web/src || echo "no stale Flags import"
git diff --check
```

Expected: every command exits 0, the backend suite reports **zero skipped**, and the
grep finds nothing.

- [ ] **Step 10: Look at both artifacts**

Open `docs/qa/artifacts/2026-08-16-maison-editorial/desktop/switches.png` and
`experiments.png`. Check what a test cannot: the switches list reads as a list rather
than a wall, the experiments list makes "not started" look like a decision rather
than a failure, and no row shows a control.

- [ ] **Step 11: Commit**

```bash
git add web docs
git commit -m "feat: two destinations replace the single flags page"
```

---

## Self-Review

**Spec coverage.** §2 (what an experiment is) → Task 1. §3 (ownership) → Task 1 plus
the reciprocity test. §4 (two destinations, four pages) → Tasks 4, 5, 6. §5 (controls
on detail only) → Task 4, asserted in both list tests. §6 (API, per-experiment
summaries, not-started returns intent) → Tasks 2, 3. §7 (testing table) → covered
across all six, with the `/flags` redirect in Task 6 Step 5.

**Placeholder scan.** No TBD/TODO. Two steps say to `grep` for an existing helper
name rather than guessing it (Task 6 Steps 3 and 5) — that is a real instruction with
a command, not a placeholder.

**Type consistency.** `ExperimentState`, `ExperimentArm`/`ExperimentArmView`,
`ExperimentDefinition`/`ExperimentDetailView`, `ArmCount`, `NotCounted`,
`ExperimentSummary`/`ExperimentSummaryView` — server and client names differ by the
`View` suffix, deliberately, and the field names match exactly. `experimentKey` is
optional on both `FlagDefinition` and `FlagView`. `summarizeExperiment(key)` is the
name used in Task 2 and consumed in Task 3.

**One gap found and fixed while reviewing.** The list endpoint originally returned a
headline figure per experiment, which would have meant a database round trip per row
to render three lines. Task 3 Step 3 now returns definitions only, and asserts that
nothing is summarized on a list render.
