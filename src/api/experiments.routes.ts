import { Router } from "express";
import { EXPERIMENT_REGISTRY, experimentDefinition } from "../config/experimentRegistry.js";
import { flagDefinition } from "../config/flagRegistry.js";
import { flags } from "../services/flagService.js";
import { summarizeExperiment } from "../services/experimentSummary.js";

export const experimentsRouter = Router();

/**
 * The list: name, state, and the one number that matters. Nothing else.
 *
 * Descriptions are deliberately withheld. Three sentences per row is right on a
 * detail page and wrong on a list — a list is for finding the thing, the sentences
 * are for deciding about it. Serving them here is what made the old single page a
 * wall of text.
 *
 * The summary IS included, so a row can read "594 v 395 · ends in 2 days" without a
 * second request. That costs one query rather than three: a not-started summary is
 * computed from the registry and touches no table.
 */
experimentsRouter.get("/", async (_req, res) => {
  const experiments = await Promise.all(
    EXPERIMENT_REGISTRY.map(async (e) => ({
      key: e.key,
      name: e.name,
      state: e.state,
      armCount: e.arms.length,
      blocker: e.blocker,
      summary: await summarizeExperiment(e.key),
    })),
  );
  res.json({ experiments });
});

/**
 * One experiment, with its own measurements and every flag it owns.
 *
 * The flags arrive with their descriptions and the value in force merged in, so the
 * detail page renders from a single request. The registry is the spine, not the
 * snapshot: an owned flag with no stored override row still appears, because a
 * switch nobody has touched is exactly the one you need to be able to see.
 */
experimentsRouter.get("/:key", async (req, res) => {
  const definition = experimentDefinition(req.params.key);
  if (!definition) return res.status(404).json({ error: "not_found" });

  const byKey = new Map(flags.snapshot().map((row) => [row.key, row]));
  const ownedFlags = definition.ownedFlagKeys
    .map((key) => flagDefinition(key))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .map((d) => ({ ...d, ...(byKey.get(d.key) ?? {}) }));

  res.json({
    ...definition,
    summary: await summarizeExperiment(definition.key),
    ownedFlags,
  });
});
