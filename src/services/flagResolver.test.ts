import { describe, expect, it } from "vitest";
import { flagDefinition } from "../config/flagRegistry.js";
import { resolveBoolean, resolvePercent } from "./flagResolver.js";

const drafts = flagDefinition("AI_DRAFTS_ENABLED")!;
const send = flagDefinition("AI_SEND_ENABLED")!;
const rollout = flagDefinition("GUIDE_DELIVERY_ROLLOUT_PERCENT")!;
const threshold = flagDefinition("DM_RECOVERY_FAILURE_RATE_PERCENT")!;

describe("resolveBoolean", () => {
  it("prefers a stored value over the environment", () => {
    expect(resolveBoolean(drafts, { valueBool: true, valuePercent: null }, false)).toBe(true);
    expect(resolveBoolean(drafts, { valueBool: false, valuePercent: null }, true)).toBe(false);
  });

  it("uses the environment when nothing is stored", () => {
    expect(resolveBoolean(drafts, null, true)).toBe(true);
    expect(resolveBoolean(drafts, { valueBool: null, valuePercent: null }, true)).toBe(true);
    expect(resolveBoolean(drafts, null, false)).toBe(false);
  });

  // The whole safety model. However a row got written — a bug, a bad migration,
  // a direct database write — it cannot switch on something the console is not
  // allowed to switch on.
  it("ignores a stored value that would enable a flag the console may not enable", () => {
    expect(resolveBoolean(send, { valueBool: true, valuePercent: null }, false)).toBe(false);
  });

  it("still honours a stored value that turns that same flag off", () => {
    expect(resolveBoolean(send, { valueBool: false, valuePercent: null }, true)).toBe(false);
  });

  // Stated as its own case because it is the property that matters, not an
  // implementation detail: this function can only ever make things quieter.
  it("never returns true unless either the environment or a permitted row says so", () => {
    const cases: { stored: boolean | null; env: boolean }[] = [
      { stored: true, env: false },
      { stored: false, env: false },
      { stored: null, env: false },
    ];
    for (const { stored, env } of cases) {
      expect(resolveBoolean(send, { valueBool: stored, valuePercent: null }, env)).toBe(false);
    }
  });
});

describe("resolvePercent", () => {
  it("prefers a stored value over the environment", () => {
    expect(resolvePercent(rollout, { valueBool: null, valuePercent: 100 }, 45)).toBe(100);
  });

  it("uses the environment when nothing is stored", () => {
    expect(resolvePercent(rollout, null, 45)).toBe(45);
    expect(resolvePercent(rollout, { valueBool: null, valuePercent: null }, 45)).toBe(45);
  });

  it("clamps a stored value that is out of range", () => {
    expect(resolvePercent(rollout, { valueBool: null, valuePercent: 150 }, 45)).toBe(100);
    expect(resolvePercent(rollout, { valueBool: null, valuePercent: -5 }, 45)).toBe(0);
  });

  // The stop-sending threshold is display-only: raising it would make the system
  // tolerate MORE failures, which is louder, not quieter.
  it("ignores a stored value for a percentage the console may not change", () => {
    expect(resolvePercent(threshold, { valueBool: null, valuePercent: 90 }, 50)).toBe(50);
  });
});
