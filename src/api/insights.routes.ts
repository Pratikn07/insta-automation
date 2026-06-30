import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getLeaderboard, getReelDetail, getLatestGeo } from "../services/insightsService.js";
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
