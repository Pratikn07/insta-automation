import { z } from "zod";
import { FLAG_REGISTRY, flagDefinition } from "../config/flagRegistry.js";
import { experimentName } from "../config/experimentRegistry.js";
import { prisma } from "../lib/prisma.js";
import { flags } from "../services/flagService.js";
import { logEvent } from "../services/eventLogger.js";
import { configuredFlagExperimentKey } from "../services/experimentLifecycle.js";
import { asyncRouter } from "./asyncRouter.js";

export const flagsRouter = asyncRouter();

function definitionWithCurrentExperiment(definition: NonNullable<ReturnType<typeof flagDefinition>>) {
  const experimentKey = configuredFlagExperimentKey(definition.key, definition.experimentKey);
  return {
    ...definition,
    experimentKey,
    experimentName: experimentName(experimentKey),
  };
}

/**
 * Exactly one value, matching the flag's kind.
 *
 * The same rule the `flag_override_one_value_check` constraint enforces, stated
 * here so a bad request is a 400 rather than a database error.
 */
const patchSchema = z
  .object({
    valueBool: z.boolean().optional(),
    valuePercent: z.number().int().min(0).max(100).optional(),
  })
  .refine((body) => (body.valueBool === undefined) !== (body.valuePercent === undefined), {
    message: "Send exactly one of valueBool or valuePercent",
  });

/**
 * Every flag, its description, and the value in force.
 *
 * The registry is the spine, not the snapshot: a flag with no stored row still
 * appears, because the point of this page is that nothing is invisible.
 */
flagsRouter.get("/", (_req, res) => {
  const byKey = new Map(flags.snapshot().map((row) => [row.key, row]));
  res.json({
    flags: FLAG_REGISTRY.map((definition) => ({
      ...definitionWithCurrentExperiment(definition),
      ...(byKey.get(definition.key) ?? {}),
    })),
  });
});

/**
 * One flag, for its detail page. Same shape as a row of the list.
 *
 * The list no longer carries descriptions, so the detail page has to fetch its own
 * rather than filter a cached list — which also means a bookmarked switch URL works
 * without the list ever having been opened.
 */
flagsRouter.get("/:key", (req, res) => {
  const definition = flagDefinition(req.params.key);
  if (!definition) return res.status(404).json({ error: "not_found" });
  const row = flags.snapshot().find((entry) => entry.key === definition.key);
  res.json({
    ...definitionWithCurrentExperiment(definition),
    ...row,
  });
});

flagsRouter.patch("/:key", async (req, res) => {
  /**
   * Belt and braces on identity, before any work.
   *
   * `requireAdmin` already guarantees this — it runs on the whole apiRouter and
   * rejects a missing token, an invalid one, and a non-allowlisted email — so this
   * is unreachable today. It is here because `updatedBy` is an audit field on a
   * row that changes what the entire system does, and a fabricated
   * `"unknown"` would be indistinguishable from a real name afterwards. If the
   * identity is ever absent, the right answer is to refuse, not to invent one.
   *
   * Same reasoning as duplicating the enable fence in flagResolver: guarding only
   * the door means trusting every row already inside. Matches the two routes that
   * send to real people, ai.routes.ts approve and retry-send.
   */
  if (!req.adminEmail) return res.status(401).json({ error: "owner_auth_required" });

  const definition = flagDefinition(req.params.key);
  if (!definition) return res.status(404).json({ error: "not_found" });

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { valueBool, valuePercent } = parsed.data;

  // Wrong kind of value is a client bug, not a permission problem, so it answers
  // 400 rather than 403 — the caller needs to know which of the two it got wrong.
  if (definition.kind === "boolean" && valueBool === undefined) {
    return res.status(400).json({ error: "expected_value_bool" });
  }
  if (definition.kind === "percent" && valuePercent === undefined) {
    return res.status(400).json({ error: "expected_value_percent" });
  }

  // Neither control: display-only. WORKERS_ENABLED is read once at boot, and the
  // stop-sending threshold may only be moved in a deploy because raising it makes
  // the system tolerate more failures.
  if (!definition.pageMayEnable && !definition.pageMayStop) {
    return res.status(403).json({ error: "flag_not_controllable" });
  }

  // The fence. Off is always allowed; on only where the definition permits it.
  // Duplicated in flagResolver on purpose: this stops a request, that stops a row,
  // and a row can arrive without passing through here at all.
  if (valueBool === true && !definition.pageMayEnable) {
    return res.status(403).json({ error: "flag_enable_not_permitted" });
  }
  // A percentage is a dial, so "may enable" is what governs moving it at all.
  if (valuePercent !== undefined && !definition.pageMayEnable) {
    return res.status(403).json({ error: "flag_not_controllable" });
  }

  // No fallback: the guard above means this is always a verified, allowlisted
  // address, so the audit record cannot carry an invented name.
  const updatedBy = req.adminEmail;
  const data = {
    valueBool: valueBool ?? null,
    valuePercent: valuePercent ?? null,
    updatedBy,
    updatedAt: new Date(),
  };

  await prisma.flagOverride.upsert({
    where: { key: definition.key },
    create: { key: definition.key, ...data },
    update: data,
  });

  // Keys and values only. Never the description text, which is static anyway, and
  // never anything about a person.
  await logEvent("flag_changed", {
    key: definition.key,
    valueBool: valueBool ?? null,
    valuePercent: valuePercent ?? null,
    updatedBy,
  });

  // Refreshed before answering, so the value this response reports is the value
  // the workers will read — rather than whatever the cache held a moment ago.
  await flags.refresh();
  const row = flags.snapshot().find((entry) => entry.key === definition.key);
  res.json({
    ...definitionWithCurrentExperiment(definition),
    ...row,
  });
});
