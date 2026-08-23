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
 * Flags whose value may still be read straight from the environment.
 *
 * WORKERS_ENABLED is read once at boot to decide whether to start anything at
 * all, so it cannot be controlled while running and the registry marks it
 * display-only. Reading it through the service would imply otherwise.
 */
const ENV_ONLY = new Set(["WORKERS_ENABLED"]);

/**
 * Files allowed to read a flag from the environment.
 *
 * env.ts validates what the OPERATOR WROTE — its cross-field checks are about the
 * deployed configuration, not about the value in force — and flagService.ts is the
 * thing that reads the environment on everyone else's behalf.
 */
const ALLOWED = [
  path.join("config", "env.ts"),
  path.join("services", "flagService.ts"),
  // server.ts decides at boot whether to START each scheduler. A stored row
  // cannot start a scheduler that was never started, and reading the service
  // there would imply it could. What the console's stop relies on instead is the
  // per-tick guard inside each worker, which this test does enforce.
  "server.ts",
];

describe("flag call sites", () => {
  it("reads every live-controlled flag through the service, not the environment", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      if (ALLOWED.some((allowed) => file.endsWith(allowed))) continue;
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

  it.each(["GUIDE_FOLLOW_GATE_V2_ENABLED", "GUIDE_RICH_GATE_ENABLED"])(
    "keeps %s eligible for per-action service reads",
    (key) => {
      expect(ENV_ONLY.has(key)).toBe(false);
      expect(FLAG_REGISTRY.find((definition) => definition.key === key)).toMatchObject({
        pageMayStop: true,
      });
    },
  );
});
