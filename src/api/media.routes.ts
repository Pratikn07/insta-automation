import { Router } from "express";
import { fetchAllReels } from "../meta/fetchMedia.js";
import { logger } from "../lib/logger.js";

export const mediaRouter = Router();

// GET /api/media/reels
// Returns ALL of the account's reels (the Graph media list is walked across
// every page, 5-min cached). A creator account has at most a few hundred reels,
// so one response keeps the UI a single scrollable grid. The frontend pairs
// this with /api/keywords to show which reels have keywords attached.
mediaRouter.get("/reels", async (_req, res) => {
  // The Graph call is the one external dependency here and the likeliest thing
  // to fail (token expiry, rate limit), so handle it explicitly rather than
  // letting it become an unhandled rejection.
  try {
    const items = await fetchAllReels();
    res.json({ items, nextCursor: null });
  } catch (err) {
    logger.error({ err }, "Failed to fetch reels from Graph API");
    res.status(502).json({ error: "reels_fetch_failed" });
  }
});
