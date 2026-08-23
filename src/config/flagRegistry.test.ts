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
