import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getLeaderboard, getReelDetail, getLatestGeo, getRecipe } from "../services/insightsService.js";
import {
  listExperiments,
  createExperiment,
  updateExperiment,
  getUsReachTrend,
  getGeoWindowTrend,
} from "../services/experimentService.js";
import { computeUsFit } from "../services/usFitScore.js";
import type { ContentProfile } from "../services/geminiAnalysisService.js";

export const insightsRouter = Router();

// GET /api/insights/leaderboard — every reel, US-fit scored reels first.
insightsRouter.get("/leaderboard", async (_req, res) => {
  res.json({ items: await getLeaderboard() });
});

// GET /api/insights/geo — latest account-level country split (3 stages).
insightsRouter.get("/geo", async (_req, res) => {
  res.json({ stages: await getLatestGeo() });
});

// GET /api/insights/recipe — top-vs-bottom US-fit contrast + derived checklist.
insightsRouter.get("/recipe", async (_req, res) => {
  res.json(await getRecipe());
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

// GET /api/insights/experiments — all experiments, newest first.
insightsRouter.get("/experiments", async (_req, res) => {
  res.json({ items: await listExperiments() });
});

const createExperimentSchema = z.object({
  hypothesis: z.string().min(1).max(500),
  variable: z.string().min(1).max(200),
  reelMediaIds: z.array(z.string()).default([]),
  postedAt: z.string().datetime().nullable().optional(),
});

// POST /api/insights/experiments — create one; baselineUsPct captured at creation.
insightsRouter.post("/experiments", async (req, res) => {
  const parsed = createExperimentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(await createExperiment(parsed.data));
});

const updateExperimentSchema = z.object({
  status: z.enum(["running", "inconclusive", "confirmed", "busted"]).optional(),
  postedAt: z.string().datetime().nullable().optional(),
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
