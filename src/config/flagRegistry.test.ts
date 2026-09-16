import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLAG_REGISTRY, flagDefinition } from "./flagRegistry.js";

/**
 * Flag-shaped entries in env.ts: an on/off switch, or a bounded percentage.
 *
 * Parsed out of the source rather than imported, because importing `env` would
 * boot the whole schema and this test must run without a valid environment.
 */
function envFlagKeys(): string[] {
  const source = readFileSync(new URL("./env.ts", import.meta.url), "utf8");
  const keys: string[] = [];
  for (const line of source.split("\n")) {
    const match = line.match(/^\s{2}([A-Z][A-Z0-9_]+):\s*(booleanFlag\(|z\.coerce\.number)/);
    if (!match) continue;
    const key = match[1]!;
    if (match[2]!.startsWith("booleanFlag") || /_PERCENT$/.test(key)) keys.push(key);
  }
  return keys;
}

describe("flag registry coverage", () => {
  it.each([
    "GUIDE_DM_INTENT_GUARD_ENABLED",
    "GUIDE_FOLLOW_GATE_V2_ENABLED",
    "GUIDE_RICH_GATE_ENABLED",
    "GUIDE_COVER_DELIVERY_ENABLED",
  ])(
    "registers %s as an operator-stoppable outbound flag that the page cannot enable",
    (key) => {
      expect(flagDefinition(key)).toMatchObject({
        group: "outbound",
        kind: "boolean",
        pageMayEnable: false,
        pageMayStop: true,
      });
    },
  );

  it("describes the DM intent guard as a stoppable safety correction, not an experiment", () => {
    const definition = flagDefinition("GUIDE_DM_INTENT_GUARD_ENABLED");
    expect(definition).toMatchObject({
      group: "outbound",
      kind: "boolean",
      pageMayEnable: false,
      pageMayStop: true,
    });
    expect(definition?.experimentKey).toBeUndefined();
  });

  it("registers guide cover authoring as a reversible assistive feature", () => {
    expect(flagDefinition("GUIDE_COVER_AUTHORING_ENABLED")).toMatchObject({
      group: "assistive",
      kind: "boolean",
      pageMayEnable: true,
      pageMayStop: true,
    });
  });

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
  // but claiming to stop something read once at boot is not.
  it("never offers a stop on an infrastructure flag", () => {
    for (const d of FLAG_REGISTRY) {
      if (d.group === "infrastructure") expect(d.pageMayStop, d.key).toBe(false);
    }
  });
});

// Parent-delivery Task 6, review round 1. `pageMayStop` is a safety claim an operator acts
// on under pressure. `resolvePercent` ignores any stored value when `pageMayEnable` is
// false, so a percent entry that pairs the two is advertising a stop the console cannot
// perform. Asserted across the whole registry rather than per key, so a new entry inherits
// the check instead of needing to remember it.
describe("percent flags cannot advertise a stop the console cannot perform", () => {
  it("pairs pageMayStop with pageMayEnable for every percent flag", () => {
    const lying = FLAG_REGISTRY
      .filter((definition) => definition.kind === "percent")
      .filter((definition) => definition.pageMayStop && !definition.pageMayEnable)
      .map((definition) => definition.key);

    expect(lying).toEqual([]);
  });
});
