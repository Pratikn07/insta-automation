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

  it("gives every experiment exactly one control arm to compare against", () => {
    for (const e of EXPERIMENT_REGISTRY) {
      const controls = e.arms.filter((arm) => arm.isControl);
      expect(controls.length, `${e.key} control arms`).toBe(1);
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

  /**
   * A switch must not be called the same thing as the experiment it belongs to.
   *
   * The list prints "<switch> · part of <experiment>", so identical names rendered
   * "Guide delivery rollout · part of Guide delivery rollout" — a tautology that
   * looked like a bug and told the reader nothing.
   */
  it("never names a flag the same as the experiment it belongs to", () => {
    const clashes = FLAG_REGISTRY.filter(
      (f) => f.experimentKey && f.name === experimentDefinition(f.experimentKey)?.name,
    ).map((f) => `${f.key} is named "${f.name}", the same as its experiment`);
    expect(clashes).toEqual([]);
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

  // The whole point of the split. A flag that belongs to an experiment must not
  // also be findable as a standalone thing, and a flag that belongs to none must
  // not silently acquire a link.
  it("leaves exactly the flags with no declared comparison standing alone", () => {
    const owned = new Set(EXPERIMENT_REGISTRY.flatMap((e) => e.ownedFlagKeys));
    const standalone = FLAG_REGISTRY.filter((f) => !owned.has(f.key)).map((f) => f.key);
    expect(standalone).toEqual([
      "AI_SEND_ENABLED",
      "UPCOMING_AUTOMATIONS_ENABLED",
      "DM_RECOVERY_HISTORICAL_ENABLED",
      "DM_RECOVERY_ORIGIN_LLM_ENABLED",
      "AI_DRAFTS_ENABLED",
      "AI_FOLLOW_UPS_ENABLED",
      "AI_ADVISOR_ENABLED",
      "WORKERS_ENABLED",
    ]);
  });
});
