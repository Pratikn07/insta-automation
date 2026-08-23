import { describe, expect, it } from "vitest";
import { FLAG_REGISTRY, flagDefinition } from "./flagRegistry.js";
import { EXPERIMENT_REGISTRY, experimentDefinition } from "./experimentRegistry.js";

describe("experiment registry", () => {
  it("keeps the concluded 10-hour test separate from the active 45/45/10 timing test", () => {
    const concluded = experimentDefinition("recovery-reminder-timing");
    const active = experimentDefinition("recovery-reminder-timing-v2");

    expect(concluded).toMatchObject({
      name: "Recovery reminder — 10 hours vs none",
      state: "ended",
    });
    expect(concluded?.arms.map((arm) => [arm.key, arm.percent])).toEqual([
      ["treatment", 90],
      ["control", 10],
    ]);

    expect(active).toMatchObject({
      name: "Recovery reminder — 2 vs 6 hours",
      state: "running",
    });
    expect(active?.arms.map((arm) => [arm.key, arm.percent])).toEqual([
      ["two_hour", 45],
      ["six_hour", 45],
      ["no_reminder", 10],
    ]);
  });

  it("keeps legacy-only settings on V1 and shared live controls on V2", () => {
    expect(experimentDefinition("recovery-reminder-timing")?.ownedFlagKeys).toEqual([
      "DM_RECOVERY_HOLDOUT_PERCENT",
      "DM_RECOVERY_POST_EXPERIMENT_ENABLED",
    ]);
    expect(experimentDefinition("recovery-reminder-timing-v2")?.ownedFlagKeys).toEqual([
      "DM_RECOVERY_ENABLED",
      "DM_RECOVERY_WESTERN_ONLY",
      "DM_RECOVERY_FAILURE_RATE_PERCENT",
    ]);
  });

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
      // These are safety switches, not an invitation to compare strict access
      // against an ungated arm that violates the approved product rule.
      "GUIDE_FOLLOW_GATE_V2_ENABLED",
      "GUIDE_RICH_GATE_ENABLED",
      // Cover inclusion is a presentation switch, not a comparison arm. There is no
      // "guide without its cover" hypothesis being measured here; the percent exists to
      // ramp exposure safely, and pairing it with an experiment would imply an ungated
      // arm we are not running.
      "GUIDE_COVER_DELIVERY_ENABLED",
      "GUIDE_COVER_DELIVERY_ROLLOUT_PERCENT",
      "AI_SEND_ENABLED",
      "UPCOMING_AUTOMATIONS_ENABLED",
      "DM_RECOVERY_HISTORICAL_ENABLED",
      "DM_RECOVERY_ORIGIN_LLM_ENABLED",
      "AI_DRAFTS_ENABLED",
      "AI_FOLLOW_UPS_ENABLED",
      "AI_ADVISOR_ENABLED",
      "GUIDE_COVER_AUTHORING_ENABLED",
      "WORKERS_ENABLED",
    ]);
  });
});
