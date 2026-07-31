// Uses the insights client (v23.0), NOT the v21.0 messaging client: media_audio_type
// is only returned on newer versions. The media list is read-only, so the version
// bump here is safe and unrelated to the gate flow.
import { insightsGraph } from "./insightsGraphClient.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * What kind of post this is, from the automation's point of view.
 *
 * Only these two exist on the account (verified against the live Graph media
 * list: 114 REELS/VIDEO + 33 FEED/CAROUSEL_ALBUM, no single-image FEED posts).
 * A future single-image post would classify as "carousel" — it behaves
 * identically for keyword attachment, which is all `kind` is used for.
 */
export type MediaKind = "reel" | "carousel";

/** A single post as returned to the admin UI (reel or carousel). */
export interface AccountMedia {
  id: string;
  kind: MediaKind;
  caption: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
  // Insights-only extras (optional; only the reel path reads them). The
  // snapshot worker reads these; mediaUrl is absent when the reel uses licensed audio.
  mediaUrl?: string | null;
  mediaAudioType?: string | null; // MUSIC | ORIGINAL_SOUND
}

interface GraphMediaItem {
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
  data: GraphMediaItem[];
  paging?: { cursors?: { after?: string }; next?: string };
}

const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,thumbnail_url,media_url,media_audio_type,permalink,timestamp";
const PAGE_LIMIT = 50;
// Safety cap so a runaway/huge account can't spin forever. 40 pages × 50 =
// 2000 media — far beyond any single creator account.
const MAX_PAGES = 40;
const CACHE_TTL_MS = 5 * 60 * 1000;

// The media list is read-only and changes rarely, so a short in-memory cache
// spares the Graph API on every page visit. Cleared on process restart. Holds
// ALL media; the reel-only view is derived from it, so both callers share one
// cache and one Graph walk.
let allCache: { at: number; media: AccountMedia[] } | null = null;

/**
 * Is this a reel? `media_product_type` is authoritative when present; the
 * `media_type === "VIDEO"` fallback covers older items where Meta omits it.
 * Everything else (FEED carousels, single images) is not a reel.
 */
function isReel(m: GraphMediaItem): boolean {
  return m.media_product_type === "REELS" || (!m.media_product_type && m.media_type === "VIDEO");
}

function toMedia(m: GraphMediaItem): AccountMedia {
  const reel = isReel(m);
  return {
    id: m.id,
    kind: reel ? "reel" : "carousel",
    caption: m.caption ?? null,
    // Reels are VIDEO and carry thumbnail_url (the still frame). Carousels carry
    // NO thumbnail_url at all — verified live on all 33 — but media_url holds the
    // first slide as a JPEG, so the same fallback covers both.
    thumbnailUrl: m.thumbnail_url ?? m.media_url ?? null,
    permalink: m.permalink ?? null,
    timestamp: m.timestamp ?? null,
    mediaUrl: m.media_url ?? null,
    mediaAudioType: m.media_audio_type ?? null,
  };
}

/**
 * Fetch ALL of the account's media (reels AND carousels) by walking every page.
 *
 * A creator account has at most a few hundred posts, so returning the whole set
 * in one response keeps the UI simple (one scrollable grid, no paging). Result
 * is cached for CACHE_TTL_MS; bounded by MAX_PAGES as a safety net.
 */
export async function fetchAllMedia(): Promise<AccountMedia[]> {
  if (allCache && Date.now() - allCache.at < CACHE_TTL_MS) {
    return allCache.media;
  }

  const media: AccountMedia[] = [];
  let after: string | undefined;
  let pages = 0;

  do {
    const params: Record<string, string | number> = { fields: MEDIA_FIELDS, limit: PAGE_LIMIT };
    if (after) params.after = after;

    const res = await insightsGraph.get<MediaResponse>(`/${env.IG_USER_ID}/media`, { params });
    for (const m of res.data.data ?? []) {
      media.push(toMedia(m));
    }

    after = res.data.paging?.next ? res.data.paging?.cursors?.after : undefined;
    pages += 1;
  } while (after && pages < MAX_PAGES);

  if (pages >= MAX_PAGES && after) {
    logger.warn({ pages, media: media.length }, "fetchAllMedia hit MAX_PAGES; some media may be omitted");
  }

  allCache = { at: Date.now(), media };
  logger.debug(
    { pages, total: media.length, reels: media.filter((m) => m.kind === "reel").length },
    "Fetched all media",
  );
  return media;
}

/**
 * Reels only — the insights/analytics view of the account.
 *
 * Kept as its own function because everything downstream of it (ReelMeta,
 * performance snapshots, Gemini profiling, US-fit scoring) is video-specific:
 * watch time and skip rate have no carousel equivalent. Carousels belong in the
 * keyword-attachment UI, not in the reel leaderboard.
 */
export async function fetchAllReels(): Promise<AccountMedia[]> {
  const media = await fetchAllMedia();
  return media.filter((m) => m.kind === "reel");
}
