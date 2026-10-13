import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { FUNNELS, getFunnelDef } from "../services/funnels/registry.js";
import {
  runGuideFollowFunnel,
  runGuideJourneyFunnel,
  runGuideJourneyLeak,
  runLinkClickFunnel,
  runDropOff,
  defaultWindow,
  DROP_OFF_DEFAULT_LIMIT,
  DROP_OFF_MAX_LIMIT,
  type FunnelWindow,
} from "../services/funnels/runFunnel.js";
import { DROP_OFF_BUCKETS, type DropOffBucket } from "../services/funnels/dropOff.js";
import { guideFollowDef } from "../services/funnels/guideFollowFunnel.js";
import {
  GUIDE_JOURNEY_LEAKS,
  guideJourneyDef,
  type GuideJourneyLeak,
  type GuideJourneyLeakList,
  type GuideJourneyResult,
} from "../services/funnels/guideJourneyFunnel.js";
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
 * Every report on Home and Funnels is an aggregate over event_log that costs
 * between half a second and several seconds, and the Funnels page fires four of
 * them at once.
 *
 * Fresh for a minute; after that the last report is served for up to half an
 * hour while ONE refresh runs behind it, so a page never waits on a report just
 * because the TTL passed. Every report echoes the window it was computed over,
 * so a stale read is labelled by its own bounds, never by the request's.
 *
 * Exported so tests can start from a cold cache.
 */
export const FUNNEL_CACHE_TTL_MS = 60_000;
export const FUNNEL_CACHE_STALE_MS = 30 * 60_000;
const reportCacheOptions = {
  ttlMs: FUNNEL_CACHE_TTL_MS,
  staleMs: FUNNEL_CACHE_STALE_MS,
  maxEntries: 32,
};

export const funnelCache =
  createReadThroughCache<Awaited<ReturnType<typeof runGuideFollowFunnel>>>(reportCacheOptions);

/** Separate caches: each report returns a different shape. */
export const linkClickCache = createReadThroughCache<LinkClickResult>(reportCacheOptions);
export const dropOffCache =
  createReadThroughCache<Awaited<ReturnType<typeof runDropOff>>>(reportCacheOptions);
export const guideAccessMetricsCache =
  createReadThroughCache<Awaited<ReturnType<typeof runGuideAccessMetrics>>>(reportCacheOptions);
export const journeyCache = createReadThroughCache<GuideJourneyResult>(reportCacheOptions);
export const journeyLeakCache = createReadThroughCache<GuideJourneyLeakList>(reportCacheOptions);

/**
 * Keyed on the request, not the resolved bounds. `defaultWindow()` is
 * `now`-relative to the millisecond, so keying on the bounds would miss on every
 * request, and the default window is exactly the one Home loads. Explicit
 * windows are YYYY-MM-DD strings, so they are already stable.
 *
 * The key still carries the whole denominator — funnel, both bounds as asked
 * and the minimum sample — because serving one window's numbers under another
 * window's label is precisely the unstated-denominator bug `resolveWindow`
 * refuses to commit.
 */
export function funnelCacheKey(
  key: string,
  query: { from?: string; to?: string },
  minSample: number,
): string {
  return `${key}|${query.from ?? "default"}|${query.to ?? "default"}|${minSample}`;
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

  res.json(
    await guideAccessMetricsCache.get(funnelCacheKey("guide-access-metrics", parsed.data, 0), () =>
      runGuideAccessMetrics(prisma, window),
    ),
  );
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
      await linkClickCache.get(funnelCacheKey(def.key, parsed.data, def.minSample), () =>
        runLinkClickFunnel(prisma, window, def.minSample),
      ),
    );
    return;
  }
  if (def.key === guideJourneyDef.key) {
    res.json(
      await journeyCache.get(funnelCacheKey(def.key, parsed.data, def.minSample), () =>
        runGuideJourneyFunnel(prisma, window, def.minSample),
      ),
    );
    return;
  }
  res.json(
    await funnelCache.get(funnelCacheKey(def.key, parsed.data, def.minSample), () =>
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
  // Drop-off lists exist for the two guide funnels only, each with its own buckets: the
  // per-card guide-follow lists, and the per-person journey's two leaks.
  const journey = def.key === guideJourneyDef.key;
  if (!journey && def.key !== guideFollowDef.key) {
    res.status(404).json({ error: "no_drop_off_for_funnel" });
    return;
  }

  const bucket = req.params.bucket;
  const available: readonly string[] = journey ? GUIDE_JOURNEY_LEAKS : Object.keys(DROP_OFF_BUCKETS);
  if (!available.includes(bucket)) {
    res.status(404).json({ error: "unknown_bucket", available });
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

  const limit = parsed.data.limit ?? DROP_OFF_DEFAULT_LIMIT;
  const cacheKey = `${funnelCacheKey(def.key, parsed.data, def.minSample)}|${bucket}|${limit}`;
  if (journey) {
    res.json(
      await journeyLeakCache.get(cacheKey, () =>
        runGuideJourneyLeak(prisma, bucket as GuideJourneyLeak, window, limit),
      ),
    );
    return;
  }
  res.json(
    await dropOffCache.get(cacheKey, () =>
      runDropOff(prisma, bucket as DropOffBucket, window, limit, def.minSample),
    ),
  );
});
