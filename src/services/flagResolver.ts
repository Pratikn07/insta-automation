import type { FlagDefinition } from "../config/flagRegistry.js";

/**
 * Deciding which value of a flag is actually in force.
 *
 * Pure on purpose: no Prisma, no cache, no clock. The safety rule this file
 * encodes is the one thing in the flag system that must be provable by reading
 * it, and a function that also fetches rows is not.
 */

/** A stored override row, or null when nobody has overridden this flag. */
export type FlagOverrideValue = {
  valueBool: boolean | null;
  valuePercent: number | null;
};

/**
 * Resolve an on/off flag: the stored value, else the deployed environment value.
 *
 * The `pageMayEnable` clause is the safety model, and it lives HERE as well as in
 * the route that writes rows. That duplication is deliberate. The route stops a
 * request; this stops a row — and a row can arrive from a bug, a bad migration, a
 * restored backup, or someone with database access. Checking only at the door
 * would mean trusting every row already inside.
 *
 * The asymmetry is the whole point: a stored `false` is always honoured, a stored
 * `true` only where the definition permits it. This function can make the system
 * quieter. It cannot make it louder.
 */
export function resolveBoolean(
  definition: FlagDefinition,
  override: FlagOverrideValue | null,
  envValue: boolean,
): boolean {
  const stored = override?.valueBool;
  if (stored === null || stored === undefined) return envValue;

  // Cannot be switched on from a row. Fall back to the environment, which is the
  // only place this flag may be turned on at all.
  if (stored && !definition.pageMayEnable) return envValue;

  return stored;
}

/**
 * Resolve a percentage: the stored value, else the deployed environment value.
 *
 * `pageMayEnable` is honoured here too, for a case that is easy to miss:
 * DM_RECOVERY_FAILURE_RATE_PERCENT is the point at which the system gives up
 * sending by itself. RAISING it makes the system tolerate more failures, which is
 * louder — the one direction the console is not allowed to move anything. So a
 * stored value for a percentage the console may not change is ignored outright,
 * rather than clamped and obeyed.
 */
export function resolvePercent(
  definition: FlagDefinition,
  override: FlagOverrideValue | null,
  envValue: number,
): number {
  if (!definition.pageMayEnable) return envValue;

  const stored = override?.valuePercent;
  if (stored === null || stored === undefined) return envValue;

  // Clamped rather than rejected: the column already constrains 0-100, so an
  // out-of-range value here means the constraint was bypassed and the safest
  // reading of 150 is "all of them", not "crash the request".
  return Math.min(100, Math.max(0, stored));
}
