import { prisma } from "../lib/prisma.js";

export function normalizeKeyword(text: string): string {
  return text.trim().toUpperCase();
}

export function extractKeyword(commentText: string): string | null {
  const tokens = commentText.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return normalizeKeyword(tokens[0]!);
}

/**
 * Resolve the keyword that should fire for a comment.
 *
 * A keyword can be scoped to a specific reel (mediaId) or left global (mediaId
 * = null). A reel-specific match wins; if none exists for this reel, a global
 * keyword is the fallback. This keeps every pre-existing global keyword working
 * while letting the same word mean different things on different reels.
 */
export async function findActiveKeyword(keyword: string, mediaId?: string | null) {
  const norm = normalizeKeyword(keyword);

  if (mediaId) {
    const scoped = await prisma.keyword.findFirst({
      where: { keyword: norm, mediaId, active: true },
    });
    if (scoped) return scoped;
  }

  return prisma.keyword.findFirst({
    where: { keyword: norm, mediaId: null, active: true },
  });
}

/**
 * Resolve a keyword from an inbound DM.
 *
 * Unlike a comment, a DM has no reel context, so only GLOBAL keywords
 * (mediaId = null) can match. We scan every word in the message — not just the
 * first — so "sleep", "Sleep", and "DM me sleep" all resolve. Returns the first
 * active global keyword found, or null.
 */
export async function findKeywordInMessage(text: string) {
  const tokens = [...new Set(text.split(/\s+/).map(normalizeKeyword).filter(Boolean))];
  if (tokens.length === 0) return null;

  return prisma.keyword.findFirst({
    where: { keyword: { in: tokens }, mediaId: null, active: true },
  });
}
