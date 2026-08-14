import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { FUNNELS, getFunnelDef } from "../services/funnels/registry.js";
import { runGuideFollowFunnel, defaultWindow } from "../services/funnels/runFunnel.js";

/**
 * Funnel reads. Mounted under apiRouter, so requireAdmin has already run.
 * Reads only — every funnel is a single SELECT.
 *
 * The route is thin on purpose: stage definitions, the cohort SQL and every
 * percentage live in src/services/funnels, so the page, the CLI and any MCP
 * client report the same numbers instead of three implementations drifting.
 */
export const funnelsRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Widest cohort window we will run. A funnel scans event_log over the window
 * plus EVENT_LOOKBACK_MARGIN, so an unbounded `from` lets one dashboard load
 * table-scan years of events.
 */
const MAX_WINDOW_DAYS = 365;

const windowQuery = z.object({
  // YYYY-MM-DD. Dates rather than timestamps because the cohort boundary is a
  // day in the user's head, and a half-open day range is what they mean.
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// GET /api/funnels — what funnels exist. Drives the section's nav without the
// client hardcoding a list that drifts from the registry.
funnelsRouter.get("/", (_req, res) => {
  res.json({
    items: Object.values(FUNNELS).map((def) => ({
      key: def.key,
      name: def.name,
      question: def.question,
    })),
  });
});

// GET /api/funnels/:key?from=&to= — one funnel over a cohort window.
funnelsRouter.get("/:key", async (req, res) => {
  const def = getFunnelDef(req.params.key);
  if (!def) {
    res.status(404).json({ error: "unknown_funnel", available: Object.keys(FUNNELS) });
    return;
  }

  const parsed = windowQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_window", detail: "from/to must be YYYY-MM-DD" });
    return;
  }

  const fallback = defaultWindow();
  const to = parsed.data.to ? new Date(`${parsed.data.to}T00:00:00.000Z`) : fallback.to;
  const from = parsed.data.from ? new Date(`${parsed.data.from}T00:00:00.000Z`) : fallback.from;

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    res.status(400).json({ error: "bad_window", detail: "from/to must be real dates" });
    return;
  }
  if (from >= to) {
    res.status(400).json({ error: "bad_window", detail: "from must be before to" });
    return;
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    res.status(400).json({ error: "window_too_wide", maxDays: MAX_WINDOW_DAYS });
    return;
  }

  // Only one funnel so far; the registry grows into a switch here.
  const result = await runGuideFollowFunnel(prisma, { from, to }, def.minSample);
  res.json(result);
});
