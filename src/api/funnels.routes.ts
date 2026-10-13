import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { FUNNELS, getFunnelDef } from "../services/funnels/registry.js";
import {
  runGuideFollowFunnel,
  runLinkClickFunnel,
  runDropOff,
  defaultWindow,
  DROP_OFF_DEFAULT_LIMIT,
  DROP_OFF_MAX_LIMIT,
  type FunnelWindow,
} from "../services/funnels/runFunnel.js";
import { DROP_OFF_BUCKETS, type DropOffBucket } from "../services/funnels/dropOff.js";
import { guideFollowDef } from "../services/funnels/guideFollowFunnel.js";
import { linkClickDef, type LinkClickResult } from "../services/funnels/linkClickFunnel.js";
import { createReadThroughCache } from "../lib/readThroughCache.js";
import { runGuideAccessMetrics } from "../services/guideAccessMetrics.js";
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

/**
 * The cohort query behind a funnel is the single slowest read in the API (~1.7s
 * mean), and Home runs one on every mount.
 *
 * The key carries the whole denominator — funnel, both cohort bounds and the
 * minimum sample — because serving one window's numbers under another window's
 * label is precisely the unstated-denominator bug `resolveWindow` refuses to
 * commit. A caller walking date ranges gets a miss per range, capped by
 * maxEntries.
 *
 * Exported so tests can start from a cold cache.
 */
export const FUNNEL_CACHE_TTL_MS = 60_000;
export const funnelCache = createReadThroughCache<
  Awaited<ReturnType<typeof runGuideFollowFunnel>>
>({ ttlMs: FUNNEL_CACHE_TTL_MS, maxEntries: 32 });

/** Separate cache: the two funnels return different shapes. */
export const linkClickCache = createReadThroughCache<LinkClickResult>({
  ttlMs: FUNNEL_CACHE_TTL_MS,
  maxEntries: 32,
});

/**
 * Quantised to the TTL, because `defaultWindow()` is `now`-relative to the
 * millisecond: keying on the raw bounds would miss on every single request, and
 * the default window is exactly the one Home loads. Explicit windows arrive
 * day-aligned from `resolveWindow`, so their buckets are already stable.
 *
 * The consequence is deliberate: consecutive loads inside a bucket share one
 * snapshot, so the `window.to` echoed back can trail real time by up to a TTL.
 * That is what a cached read means, and it keeps the numbers and the label they
 * are reported under consistent with each other.
 */
export function funnelCacheKey(key: string, window: FunnelWindow, minSample: number): string {
  const bucket = (d: Date) => Math.floor(d.getTime() / FUNNEL_CACHE_TTL_MS);
  return `${key}|${bucket(window.from)}|${bucket(window.to)}|${minSample}`;
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

// GET /api/funnels/guide-access-metrics — aggregate-only strict-gate operations.
// This exact route stays before /:key so it cannot be mistaken for a registry
// funnel. It intentionally has no drop-off endpoint or parent identifiers.
funnelsRouter.get("/guide-access-metrics", async (req, res) => {
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

  res.json(await runGuideAccessMetrics(prisma, window));
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

  if (def.key === linkClickDef.key) {
    res.json(
      await linkClickCache.get(funnelCacheKey(def.key, window, def.minSample), () =>
        runLinkClickFunnel(prisma, window, def.minSample),
      ),
    );
    return;
  }
  res.json(
    await funnelCache.get(funnelCacheKey(def.key, window, def.minSample), () =>
      runGuideFollowFunnel(prisma, window, def.minSample),
    ),
  );
});

// GET /api/funnels/:key/drop-off/:bucket — who fell out, and what we know about
// why. The half that makes this an operations tool rather than a dashboard.
funnelsRouter.get("/:key/drop-off/:bucket", async (req, res) => {
  const def = getFunnelDef(req.params.key);
  if (!def) {
    res.status(404).json({ error: "unknown_funnel", available: Object.keys(FUNNELS) });
    return;
  }
  // Drop-off lists are built on the guide-follow cohort only.
  if (def.key !== guideFollowDef.key) {
    res.status(404).json({ error: "no_drop_off_for_funnel" });
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
