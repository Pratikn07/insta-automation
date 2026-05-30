import { Router } from "express";
import { z } from "zod";
import { fetchReels } from "../meta/fetchMedia.js";
import { logger } from "../lib/logger.js";

export const mediaRouter = Router();

const reelsQuerySchema = z.object({
  after: z.string().optional(),
});

// GET /api/media/reels?after=<cursor>
// Live-fetches the account's reels from the Graph API (5-min cached). The
// frontend pairs this with /api/keywords to show which reels have keywords
// attached, so the response here is intentionally just the reels.
mediaRouter.get("/reels", async (req, res) => {
  const parsed = reelsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // The Graph call is the one external dependency here and the likeliest thing
  // to fail (token expiry, rate limit), so handle it explicitly rather than
  // letting it become an unhandled rejection.
  try {
    const page = await fetchReels(parsed.data.after ?? null);
    res.json(page);
  } catch (err) {
    logger.error({ err }, "Failed to fetch reels from Graph API");
    res.status(502).json({ error: "reels_fetch_failed" });
  }
});
