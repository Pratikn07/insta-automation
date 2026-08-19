import { FLAG_REGISTRY, flagDefinition, type FlagDefinition } from "../config/flagRegistry.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { resolveBoolean, resolvePercent, type FlagOverrideValue } from "./flagResolver.js";

/**
 * The value of every flag, as it is right now.
 *
 * Values live in `flag_override` rather than only in the environment, because an
 * environment variable is parsed once at boot: changing one can only take effect
 * by restarting, and on Railway that restart is automatic. A console slider wired
 * to a restart is not a slider.
 *
 * Same shape as `ig_token`, which solved this before: the environment seeds it,
 * the table owns it while running, and nothing restarts to change it.
 */

/** How long a change takes to reach the workers. */
const REFRESH_MS = 20_000;

export type FlagSnapshot = {
  key: string;
  valueBool: boolean | null;
  valuePercent: number | null;
  /** Where the value in force came from. `override` only when one was honoured. */
  source: "override" | "environment";
  /** True when a restart would change the value in force back to the deployed one. */
  driftsFromEnv: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

type OverrideRow = FlagOverrideValue & {
  key: string;
  updatedBy?: string;
  updatedAt?: Date;
};

export type FlagServiceDeps = {
  findOverrides: () => Promise<OverrideRow[]>;
  envBool: (key: string) => boolean;
  envPercent: (key: string) => number;
  onReadFailure: () => void;
};

/**
 * Whether the resolver would actually use this row.
 *
 * Mirrors the rule in flagResolver deliberately, so `source` cannot claim a row is
 * in force when the safety rule threw it away. Telling an operator "override" for
 * a value that is really coming from the environment is worse than saying nothing.
 */
function overrideHonoured(definition: FlagDefinition, row: OverrideRow | null): boolean {
  if (!row) return false;
  if (definition.kind === "boolean") {
    if (row.valueBool === null || row.valueBool === undefined) return false;
    // Off is always honoured; on only where the console may enable it.
    return row.valueBool === false || definition.pageMayEnable;
  }
  if (row.valuePercent === null || row.valuePercent === undefined) return false;
  return definition.pageMayEnable;
}

export function createFlagService(deps: FlagServiceDeps) {
  // Empty until the first refresh, which is why every getter falls through to the
  // environment. A cold cache must behave exactly like production does today.
  let cache = new Map<string, OverrideRow>();

  function definitionOrThrow(key: string): FlagDefinition {
    const definition = flagDefinition(key);
    // Louder than returning false. A mistyped key that silently reads as "off" is
    // how an outbound feature stops without anybody noticing.
    if (!definition) throw new Error(`Unknown flag: ${key}`);
    return definition;
  }

  const service = {
    bool(key: string): boolean {
      const definition = definitionOrThrow(key);
      return resolveBoolean(definition, cache.get(key) ?? null, deps.envBool(key));
    },

    percent(key: string): number {
      const definition = definitionOrThrow(key);
      return resolvePercent(definition, cache.get(key) ?? null, deps.envPercent(key));
    },

    snapshot(): FlagSnapshot[] {
      return FLAG_REGISTRY.map((definition) => {
        const row = cache.get(definition.key) ?? null;
        const isBool = definition.kind === "boolean";
        const envBool = deps.envBool(definition.key);
        const envPercent = deps.envPercent(definition.key);
        const valueBool = isBool ? resolveBoolean(definition, row, envBool) : null;
        const valuePercent = isBool ? null : resolvePercent(definition, row, envPercent);

        return {
          key: definition.key,
          valueBool,
          valuePercent,
          source: overrideHonoured(definition, row)
            ? ("override" as const)
            : ("environment" as const),
          // What a restart would undo. The environment is re-read on boot, so a
          // drifted value reverts silently — worth showing before it happens.
          driftsFromEnv: isBool ? valueBool !== envBool : valuePercent !== envPercent,
          updatedBy: overrideHonoured(definition, row) ? row?.updatedBy ?? null : null,
          updatedAt: overrideHonoured(definition, row)
            ? row?.updatedAt?.toISOString() ?? null
            : null,
        };
      });
    },

    async refresh(): Promise<void> {
      try {
        const rows = await deps.findOverrides();
        cache = new Map(rows.map((row) => [row.key, row]));
      } catch {
        // Keeps the previous cache rather than clearing it. Clearing would revert
        // every override at once on a single failed query, which is a larger
        // change than the failure itself.
        deps.onReadFailure();
      }
    },

    start(): () => void {
      void service.refresh();
      const handle = setInterval(() => void service.refresh(), REFRESH_MS);
      return () => clearInterval(handle);
    },
  };

  return service;
}

/** Environment values, read by key. The schema has already validated every one. */
const envRecord = env as unknown as Record<string, unknown>;

export const flags = createFlagService({
  findOverrides: () => prisma.flagOverride.findMany(),
  envBool: (key) => Boolean(envRecord[key]),
  envPercent: (key) => Number(envRecord[key] ?? 0),
  onReadFailure: () =>
    // Stable code only, and no values: this line goes to the application log.
    logger.warn(
      { errorCode: "flag_override_read_failed" },
      "Flag overrides unreadable; serving deployed environment values",
    ),
});
