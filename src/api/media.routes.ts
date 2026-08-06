import { Router } from "express";
import { fetchAllMedia, fetchAllReels } from "../meta/fetchMedia.js";
import { logger } from "../lib/logger.js";
import { describeGraphError } from "../services/eventLogger.js";

export const mediaRouter = Router();

// GET /api/media/content
// Every post a keyword can be attached to — reels AND feed carousels. The
// comment webhook never cared about media type (carousel comments have been
// firing global keywords all along), so this endpoint is what lets the UI scope
// a keyword to one specific carousel.
//
// Each item carries `kind` ("reel" | "carousel") so the frontend can render the
// right aspect ratio and filter without a second request. The Graph media list
// is walked across every page and cached 5 min; a creator account has at most a
// few hundred posts, so one response keeps the UI a single scrollable grid.
mediaRouter.get("/content", async (_req, res) => {
  try {
    const items = await fetchAllMedia();
    res.json({ items, nextCursor: null });
  } catch (err) {
    logger.error(describeGraphError(err), "Failed to fetch media from Graph API");
    res.status(502).json({ error: "media_fetch_failed" });
  }
});

// GET /api/media/reels
// Reels only. Superseded by /content for the admin UI, kept because it is the
// stable contract for anything that specifically wants videos.
mediaRouter.get("/reels", async (_req, res) => {
  // The Graph call is the one external dependency here and the likeliest thing
  // to fail (token expiry, rate limit), so handle it explicitly rather than
  // letting it become an unhandled rejection.
  try {
    const items = await fetchAllReels();
    res.json({ items, nextCursor: null });
  } catch (err) {
    logger.error(describeGraphError(err), "Failed to fetch reels from Graph API");
    res.status(502).json({ error: "reels_fetch_failed" });
  }
});
