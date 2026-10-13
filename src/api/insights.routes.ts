import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  getLeaderboard,
  getReelDetail,
  getLatestGeo,
  getRecipe,
  getReelOriginBreakdown,
} from "../services/insightsService.js";
import {
  listExperiments,
  createExperiment,
  updateExperiment,
  getUsReachTrend,
  getGeoWindowTrend,
} from "../services/experimentService.js";
import { idempotencyKeyMismatch } from "./createReplay.js";
import { getFollowerDailyAdds, type FollowerFlowResult } from "../services/followerFlowService.js";
import { createReadThroughCache } from "../lib/readThroughCache.js";
import { parseFeedFollowAttributionRange } from "../services/feedFollowAttributionCore.js";
import { getFeedFollowAttribution } from "../services/feedFollowAttributionService.js";
import { computeUsFit } from "../services/usFitScore.js";
import type { ContentProfile } from "../services/geminiAnalysisService.js";
import { mediaTimestamp } from "./mediaTimestamp.js";
import { asyncRouter } from "./asyncRouter.js";

export const insightsRouter = asyncRouter();

/**
 * The leaderboard rebuilds every reel's numbers from snapshots and event_log, and
 * it is the default Insights tab. Fresh for a minute; after that the last board
 * is served for up to half an hour while one refresh runs behind it.
 *
 * Exported so tests can start from a cold cache.
 */
export const leaderboardCache = createReadThroughCache<Awaited<ReturnType<typeof getLeaderboard>>>({
  ttlMs: 60_000,
  staleMs: 30 * 60_000,
  maxEntries: 1,
});

// GET /api/insights/leaderboard — every reel, US-fit scored reels first.
insightsRouter.get("/leaderboard", async (_req, res) => {
  res.json({ items: await leaderboardCache.get("default", getLeaderboard) });
});

// GET /api/insights/geo — latest account-level country split (3 stages).
insightsRouter.get("/geo", async (_req, res) => {
  res.json({ stages: await getLatestGeo() });
});

// GET /api/insights/recipe — top-vs-bottom US-fit contrast + derived checklist.
insightsRouter.get("/recipe", async (_req, res) => {
  res.json(await getRecipe());
});

// GET /api/insights/reel-origin — per-reel inferred origin of keyword-commenters.
// PROXY + gate-crowd-only; the UI must caveat both.
insightsRouter.get("/reel-origin", async (_req, res) => {
  res.json({ items: await getReelOriginBreakdown() });
});

// ── Experiments (Tab 3) ──────────────────────────────────────────────────────

// GET /api/insights/us-reach-trend — reached-US% time series (90d baseline).
insightsRouter.get("/us-reach-trend", async (_req, res) => {
  res.json({ points: await getUsReachTrend() });
});

// GET /api/insights/geo-window-trend — 14d vs 90d US% thermometer (reached+engaged).
insightsRouter.get("/geo-window-trend", async (_req, res) => {
  res.json({ points: await getGeoWindowTrend() });
});

/**
 * Home's slowest read by a wide margin — 9–13s on every load before this, which
 * was the whole of the dashboard's perceived ~10s wait.
 *
 * The series is one point per Pacific analytics day over a 90-day lookback, built
 * from snapshots a worker writes at most hourly, so consecutive page loads cannot
 * produce different bars. The one genuinely live value is `stock`, which
 * followerFlowService fetches from the Graph API per call so the headline cannot
 * drift from the profile; a minute of staleness there is a fair trade for not
 * rebuilding 90 days of history on every mount.
 *
 * Exported so tests can start from a cold cache.
 */
export const FOLLOWER_FLOW_CACHE_TTL_MS = 60_000;
export const followerFlowCache = createReadThroughCache<FollowerFlowResult>({
  ttlMs: FOLLOWER_FLOW_CACHE_TTL_MS,
  maxEntries: 1,
});

// GET /api/insights/follower-daily-adds — daily net follower adds by region
// (diffed from cumulative follower_demographics snapshots) + latest stock.
insightsRouter.get("/follower-daily-adds", async (_req, res) => {
  res.json(await followerFlowCache.get("default", getFollowerDailyAdds));
});

// GET /api/insights/feed-follow-attribution — Meta-attributed gross follows for
// regular FEED posts, aligned cautiously with the existing net-add series.
insightsRouter.get("/feed-follow-attribution", async (req, res) => {
  let range: { from: string; to: string };
  try {
    range = parseFeedFollowAttributionRange({ from: req.query.from, to: req.query.to });
  } catch {
    return res.status(400).json({
      error: "invalid_date_range",
      detail: "Use inclusive Pacific dates (YYYY-MM-DD), from <= to, with at most 90 days.",
    });
  }
  res.json(await getFeedFollowAttribution(range));
});

// GET /api/insights/experiments — all experiments, newest first.
insightsRouter.get("/experiments", async (_req, res) => {
  res.json({ items: await listExperiments() });
});

const createExperimentSchema = z.object({
  id: z.string().uuid(),
  hypothesis: z.string().min(1).max(500),
  variable: z.string().min(1).max(200),
  reelMediaIds: z.array(z.string()).default([]),
  postedAt: mediaTimestamp,
});

// POST /api/insights/experiments — create one; baselineUsPct captured at creation.
//
// Keyed by a client UUID so a lost response can be resolved by asking again: the
// replay returns the original experiment, baseline untouched.
insightsRouter.post("/experiments", async (req, res) => {
  const parsed = createExperimentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (idempotencyKeyMismatch(req.headers["idempotency-key"], parsed.data.id)) {
    return res.status(400).json({ error: "idempotency_key_mismatch" });
  }
  const result = await createExperiment(parsed.data);
  if (result.status === "conflict") {
    return res.status(409).json({ error: "idempotency_conflict" });
  }
  res.status(result.status === "created" ? 201 : 200).json(result.experiment);
});

const updateExperimentSchema = z.object({
  status: z.enum(["running", "inconclusive", "confirmed", "busted"]).optional(),
  postedAt: mediaTimestamp,
  conclusion: z.string().max(1000).nullable().optional(),
  measure: z.boolean().optional(), // re-read current reached-US% into measuredUsPct
});

// PATCH /api/insights/experiments/:id — status/conclusion/postedAt or "Measure now".
insightsRouter.patch("/experiments/:id", async (req, res) => {
  const parsed = updateExperimentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await updateExperiment(req.params.id, parsed.data));
});

// GET /api/insights/reels/:mediaId — full drawer detail.
insightsRouter.get("/reels/:mediaId", async (req, res) => {
  const detail = await getReelDetail(req.params.mediaId);
  if (!detail) return res.status(404).json({ error: "not_found" });
  res.json(detail);
});

// PATCH /api/insights/reels/:mediaId/tags — manual overrides; recompute the score
// from the existing profile if one exists (no re-analysis).
const tagsSchema = z.object({
  manualAudioType: z.string().nullable().optional(),
  manualLangOverride: z.string().nullable().optional(),
  manualNote: z.string().max(2000).nullable().optional(),
});

insightsRouter.patch("/reels/:mediaId/tags", async (req, res) => {
  const parsed = tagsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = await prisma.reelMeta.update({
    where: { mediaId: req.params.mediaId },
    data: parsed.data,
  });

  // If we already have a Gemini profile, re-derive the cached score so a manual
  // audio-type override is reflected immediately (the score reads audioVibe, and
  // a manual MUSIC/ORIGINAL hint can shift the nudge). Pure recompute, no API call.
  const profile = await prisma.reelContentProfile.findUnique({
    where: { mediaId: req.params.mediaId },
  });
  if (profile) {
    const fit = computeUsFit(
      profile.profile as unknown as ContentProfile,
      profile.source as "gemini" | "fallback",
      updated.manualAudioType ?? updated.mediaAudioType,
    );
    await prisma.reelMeta.update({
      where: { mediaId: req.params.mediaId },
      data: { usFitScore: fit.score, confidence: fit.confidence, scoredAt: new Date() },
    });
  }

  res.json({ ok: true, mediaId: updated.mediaId });
});

// POST /api/insights/reels/:mediaId/analyze — force (re)enqueue a Gemini job. The
// queue worker picks it up; analysis is async. Resets a failed/done job to pending.
insightsRouter.post("/reels/:mediaId/analyze", async (req, res) => {
  const reel = await prisma.reelMeta.findUnique({ where: { mediaId: req.params.mediaId } });
  if (!reel) return res.status(404).json({ error: "reel_not_found" });

  await prisma.geminiJob.upsert({
    where: { mediaId: req.params.mediaId },
    create: { mediaId: req.params.mediaId },
    update: { status: "pending", attempts: 0, lastError: null, nextAttemptAt: new Date() },
  });
  res.json({ ok: true, queued: true });
});
