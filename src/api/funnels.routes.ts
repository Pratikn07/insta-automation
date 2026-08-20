import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { FUNNELS, getFunnelDef } from "../services/funnels/registry.js";
import {
  runGuideFollowFunnel,
  runDropOff,
  defaultWindow,
  DROP_OFF_DEFAULT_LIMIT,
  DROP_OFF_MAX_LIMIT,
  type FunnelWindow,
} from "../services/funnels/runFunnel.js";
import { DROP_OFF_BUCKETS, type DropOffBucket } from "../services/funnels/dropOff.js";
import { asyncRouter } from "./asyncRouter.js";

/**
 * Funnel reads. Mounted under apiRouter, so requireAdmin has already run.
 * Reads only — every funnel is a SELECT.
 *
 * The routes are thin on purpose: stage definitions, the cohort SQL and every
 * percentage live in src/services/funnels, so the page, the CLI and any MCP
 * client report the same numbers instead of three implementations drifting.
 */
export const funnelsRouter = asyncRouter();

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Widest cohort window we will run. A funnel scans event_log over the window
 * plus EVENT_LOOKBACK_MARGIN, so an unbounded `from` lets one dashboard load
 * table-scan years of events.
 */
const MAX_WINDOW_DAYS = 365;

// YYYY-MM-DD rather than timestamps: the cohort boundary is a day in the
// reader's head, and a half-open day range is what they mean by it.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const windowQuery = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
});

const dropOffQuery = windowQuery.extend({
  limit: z.coerce.number().int().min(1).max(DROP_OFF_MAX_LIMIT).optional(),
});

interface WindowError {
  error: string;
  detail?: string;
  maxDays?: number;
}

/**
 * Reject rather than default. Silently falling back to 30 days would render a
 * funnel under a label claiming some other range — the same unstated-denominator
 * failure this whole layer exists to prevent.
 */
function resolveWindow(q: { from?: string; to?: string }): FunnelWindow | WindowError {
  const fallback = defaultWindow();
  const to = q.to ? new Date(`${q.to}T00:00:00.000Z`) : fallback.to;
  const from = q.from ? new Date(`${q.from}T00:00:00.000Z`) : fallback.from;

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: "bad_window", detail: "from/to must be real dates" };
  }
  if (from >= to) return { error: "bad_window", detail: "from must be before to" };
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    return { error: "window_too_wide", maxDays: MAX_WINDOW_DAYS };
  }
  return { from, to };
}

function isWindowError(w: FunnelWindow | WindowError): w is WindowError {
  return "error" in w;
}

// GET /api/funnels — what funnels exist. Drives the section's nav without the
// client hardcoding a list that drifts from the registry.
funnelsRouter.get("/", (_req, res) => {
  res.json({
    items: Object.values(FUNNELS).map((def) => ({
      key: def.key,
      name: def.name,
      question: def.question,
      headline: def.headline,
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

  const window = resolveWindow(parsed.data);
  if (isWindowError(window)) {
    res.status(400).json(window);
    return;
  }

  // Only one funnel so far; the registry grows into a switch here.
  res.json(await runGuideFollowFunnel(prisma, window, def.minSample));
});

// GET /api/funnels/:key/drop-off/:bucket — who fell out, and what we know about
// why. The half that makes this an operations tool rather than a dashboard.
funnelsRouter.get("/:key/drop-off/:bucket", async (req, res) => {
  const def = getFunnelDef(req.params.key);
  if (!def) {
    res.status(404).json({ error: "unknown_funnel", available: Object.keys(FUNNELS) });
    return;
  }

  const bucket = req.params.bucket as DropOffBucket;
  if (!Object.prototype.hasOwnProperty.call(DROP_OFF_BUCKETS, bucket)) {
    res.status(404).json({ error: "unknown_bucket", available: Object.keys(DROP_OFF_BUCKETS) });
    return;
  }

  const parsed = dropOffQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_window", detail: "from/to must be YYYY-MM-DD, limit a number" });
    return;
  }

  const window = resolveWindow(parsed.data);
  if (isWindowError(window)) {
    res.status(400).json(window);
    return;
  }

  res.json(
    await runDropOff(
      prisma,
      bucket,
      window,
      parsed.data.limit ?? DROP_OFF_DEFAULT_LIMIT,
      def.minSample,
    ),
  );
});
