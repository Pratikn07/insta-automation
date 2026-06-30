// Uses the insights client (v23.0), NOT the v21.0 messaging client: media_audio_type
// is only returned on newer versions. The reel list is read-only, so the version
// bump here is safe and unrelated to the gate flow.
import { insightsGraph } from "./insightsGraphClient.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/** A single reel as returned to the admin UI (keywordCount is added by the route). */
export interface Reel {
  id: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
  // Insights-only extras (optional so the existing Reels page is unaffected). The
  // snapshot worker reads these; mediaUrl is absent when the reel uses licensed audio.
  mediaUrl?: string | null;
  mediaAudioType?: string | null; // MUSIC | ORIGINAL_SOUND
}

interface MediaItem {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  thumbnail_url?: string;
  media_url?: string;
  media_audio_type?: string;
  permalink?: string;
  timestamp?: string;
}

interface MediaResponse {
  data: MediaItem[];
  paging?: { cursors?: { after?: string }; next?: string };
}

const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,thumbnail_url,media_url,media_audio_type,permalink,timestamp";
const PAGE_LIMIT = 50;
// Safety cap so a runaway/huge account can't spin forever. 40 pages × 50 =
// 2000 media — far beyond any single creator account.
const MAX_PAGES = 40;
const CACHE_TTL_MS = 5 * 60 * 1000;

// The reels list is read-only and changes rarely, so a short in-memory cache
// spares the Graph API on every page visit. Cleared on process restart.
let allCache: { at: number; reels: Reel[] } | null = null;

function toReel(m: MediaItem): Reel {
  return {
    id: m.id,
    caption: m.caption ?? null,
    // Reels are VIDEO; thumbnail_url is the still frame. Fall back to media_url.
    thumbnailUrl: m.thumbnail_url ?? m.media_url ?? null,
    permalink: m.permalink ?? null,
    timestamp: m.timestamp ?? null,
    mediaUrl: m.media_url ?? null,
    mediaAudioType: m.media_audio_type ?? null,
  };
}

/**
 * Fetch ALL of the account's reels by walking every page of the media list.
 *
 * A creator account has at most a few hundred reels, so returning the whole
 * set in one response keeps the UI simple (one scrollable grid, no paging).
 * Result is cached for CACHE_TTL_MS; bounded by MAX_PAGES as a safety net.
 */
export async function fetchAllReels(): Promise<Reel[]> {
  if (allCache && Date.now() - allCache.at < CACHE_TTL_MS) {
    return allCache.reels;
  }

  const reels: Reel[] = [];
  let after: string | undefined;
  let pages = 0;
  let totalMedia = 0;

  do {
    const params: Record<string, string | number> = { fields: MEDIA_FIELDS, limit: PAGE_LIMIT };
    if (after) params.after = after;

    const res = await insightsGraph.get<MediaResponse>(`/${env.IG_USER_ID}/media`, { params });
    const batch = res.data.data ?? [];
    totalMedia += batch.length;

    for (const m of batch) {
      if (m.media_product_type === "REELS" || (!m.media_product_type && m.media_type === "VIDEO")) {
        reels.push(toReel(m));
      }
    }

    after = res.data.paging?.next ? res.data.paging?.cursors?.after : undefined;
    pages += 1;
  } while (after && pages < MAX_PAGES);

  if (pages >= MAX_PAGES && after) {
    logger.warn({ pages, reels: reels.length }, "fetchAllReels hit MAX_PAGES; some reels may be omitted");
  }

  allCache = { at: Date.now(), reels };
  logger.debug({ pages, totalMedia, reels: reels.length }, "Fetched all reels");
  return reels;
}
