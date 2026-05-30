import { graph } from "./graphClient.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/** A single reel as returned to the admin UI (keywordCount is added by the route). */
export interface Reel {
  id: string;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
}

interface MediaItem {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  thumbnail_url?: string;
  media_url?: string;
  permalink?: string;
  timestamp?: string;
}

interface MediaResponse {
  data: MediaItem[];
  paging?: { cursors?: { after?: string }; next?: string };
}

export interface ReelsPage {
  items: Reel[];
  nextCursor: string | null;
}

const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp";
const PAGE_LIMIT = 24;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Reels rarely change minute-to-minute and the page is read-only, so a short
// in-memory cache (keyed by pagination cursor) spares the Graph API on every
// visit. Cleared implicitly on process restart — no persistence needed.
const cache = new Map<string, { at: number; page: ReelsPage }>();

function toReel(m: MediaItem): Reel {
  return {
    id: m.id,
    caption: m.caption ?? null,
    // Reels are VIDEO; thumbnail_url is the still frame. Fall back to media_url.
    thumbnailUrl: m.thumbnail_url ?? m.media_url ?? null,
    permalink: m.permalink ?? null,
    timestamp: m.timestamp ?? null,
  };
}

/**
 * Fetch one page of the account's reels, newest first.
 *
 * Filters to `media_product_type === "REELS"`. The token probe confirmed this
 * field is present; if a future token type ever omits it we fall back to
 * `media_type === "VIDEO"` so the page still renders something useful.
 */
export async function fetchReels(after?: string | null): Promise<ReelsPage> {
  const cacheKey = after ?? "__first__";
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.page;
  }

  const params: Record<string, string | number> = {
    fields: MEDIA_FIELDS,
    limit: PAGE_LIMIT,
  };
  if (after) params.after = after;

  const res = await graph.get<MediaResponse>(`/${env.IG_USER_ID}/media`, { params });
  const all = res.data.data ?? [];

  const reels = all.filter(
    (m) => m.media_product_type === "REELS" || (!m.media_product_type && m.media_type === "VIDEO"),
  );

  const page: ReelsPage = {
    items: reels.map(toReel),
    nextCursor: res.data.paging?.cursors?.after ?? null,
  };

  cache.set(cacheKey, { at: Date.now(), page });
  logger.debug({ fetched: all.length, reels: page.items.length, after: after ?? null }, "Fetched reels");
  return page;
}
