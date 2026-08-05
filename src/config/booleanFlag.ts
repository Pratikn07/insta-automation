import { z } from "zod";

/**
 * A strict on/off environment flag.
 *
 * `z.coerce.boolean()` must NEVER be used for these. It runs `Boolean(value)`, and
 * every non-empty string is truthy — so `AI_SEND_ENABLED=false`, the exact value
 * the deploy docs instruct you to set, parses to `true` and silently turns sending
 * ON. That is the opposite of what the operator wrote.
 *
 * This accepts only an explicit allowlist, case-insensitively:
 *   true  → "true",  "1", "yes", "on"
 *   false → "false", "0", "no",  "off", ""
 *
 * Anything else is a hard parse error rather than a guess. A typo like
 * `AI_SEND_ENABLED=flase` should stop the boot, not enable sending.
 */
const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off", ""]);

export function booleanFlag(defaultValue: boolean) {
  return z
    .preprocess((value) => {
      if (value === undefined || value === null) return defaultValue;
      if (typeof value === "boolean") return value;
      if (typeof value !== "string") return value;

      const normalized = value.trim().toLowerCase();
      if (TRUE_VALUES.has(normalized)) return true;
      if (FALSE_VALUES.has(normalized)) return false;
      // Deliberately passed through unchanged so z.boolean() rejects it with a
      // clear error instead of this function inventing a value.
      return value;
    }, z.boolean())
    .default(defaultValue);
}
