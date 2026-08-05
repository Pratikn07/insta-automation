import { describe, expect, it } from "vitest";
import { booleanFlag } from "./booleanFlag.js";

const flag = booleanFlag(false);

describe("booleanFlag", () => {
  /**
   * The bug this exists to prevent.
   *
   * `z.coerce.boolean()` runs `Boolean("false")` === true, so the exact value the
   * deploy docs tell an operator to write turns the feature ON. For AI_SEND_ENABLED
   * that means a message reaching a real person without the owner's consent.
   */
  it('parses the string "false" as false', () => {
    expect(flag.parse("false")).toBe(false);
  });

  it("treats every documented off value as off", () => {
    for (const value of ["false", "FALSE", "False", "0", "no", "off", "", "  false  "]) {
      expect(flag.parse(value), `${JSON.stringify(value)} must be off`).toBe(false);
    }
  });

  it("treats every documented on value as on", () => {
    for (const value of ["true", "TRUE", "True", "1", "yes", "on", " true "]) {
      expect(flag.parse(value), `${JSON.stringify(value)} must be on`).toBe(true);
    }
  });

  it("uses the default when unset", () => {
    expect(flag.parse(undefined)).toBe(false);
    expect(booleanFlag(true).parse(undefined)).toBe(true);
  });

  // A typo must stop the boot, not silently pick a side. Guessing "on" would send
  // messages; guessing "off" would hide a feature the operator asked for.
  it("rejects an unrecognised value rather than guessing", () => {
    for (const value of ["flase", "maybe", "enabled", "2", "null"]) {
      expect(flag.safeParse(value).success, `${JSON.stringify(value)} must be rejected`).toBe(
        false,
      );
    }
  });

  it("passes real booleans through", () => {
    expect(flag.parse(true)).toBe(true);
    expect(flag.parse(false)).toBe(false);
  });
});
