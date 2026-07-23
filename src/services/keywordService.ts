import { prisma } from "../lib/prisma.js";

export function normalizeKeyword(text: string): string {
  return text.trim().toUpperCase();
}

/** Strip everything but letters/digits from a token — "Potty🙏" → "POTTY". */
function normalizeToken(token: string): string {
  return token.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// A comment is scanned for a keyword in ANY position only when it's short; longer
// comments match the first word only. Calibrated on 30 days of production
// comments: at ≤3 meaningful tokens, keyword-bearing comments are genuine gate
// requests ("DM EGG", "@tinysoho sleep", "Potty🙏"); above it they are organic
// chatter that merely mentions a keyword ("at what age should we start potty
// training?"). @mentions do not count toward the length.
const MAX_COMMENT_SCAN_TOKENS = 3;

/**
 * Normalized, deduped keyword candidates from free text: split on whitespace,
 * drop @mentions, strip punctuation/emoji, uppercase. Order is preserved. Shared
 * by the comment matcher, the DM matcher, and the backfill scanner so all three
 * agree on what counts as "a word".
 */
export function extractCandidates(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    if (!raw || raw.startsWith("@")) continue; // @mentions aren't keyword intent
    const norm = normalizeToken(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * The tokens a COMMENT is matched against: every candidate for a short comment,
 * or just the first for a long one (keeps paragraph comments high-precision).
 * Single source of the length-gate rule — shared with the backfill scanner.
 */
export function scannableCommentTokens(text: string): string[] {
  const cands = extractCandidates(text);
  return cands.length <= MAX_COMMENT_SCAN_TOKENS ? cands : cands.slice(0, 1);
}

/**
 * Resolve the keyword a comment should fire, scanning all words in short comments
 * (not just the first). A reel-scoped keyword wins over a global one. Returns the
 * matched keyword row plus which token matched (for observability), or null.
 */
export async function findKeywordForComment(text: string, mediaId?: string | null) {
  const scan = scannableCommentTokens(text);
  if (scan.length === 0) return null;

  const lookup = (scope: string | null) =>
    prisma.keyword.findFirst({ where: { keyword: { in: scan }, mediaId: scope, active: true } });

  let row = mediaId ? await lookup(mediaId) : null; // reel-scoped wins
  if (!row) row = await lookup(null); // global fallback
  if (!row) return null;

  return { keyword: row, matchedToken: row.keyword };
}

/**
 * Resolve a keyword from an inbound DM.
 *
 * Unlike a comment, a DM has no reel context, so only GLOBAL keywords
 * (mediaId = null) can match. We scan every word — with no length gate, since a
 * DM is an intentional message — so "sleep", "Sleep", "sleep🙏", and "DM me
 * sleep" all resolve. Returns the first active global keyword found, or null.
 */
export async function findKeywordInMessage(text: string) {
  const candidates = extractCandidates(text);
  if (candidates.length === 0) return null;

  return prisma.keyword.findFirst({
    where: { keyword: { in: candidates }, mediaId: null, active: true },
    // Carry the sequence so the DM path can deliver instantly (follower /
    // already-completed) without a second lookup — mirrors findActiveAwaitingDone.
    include: { resource: { include: { messages: true } } },
  });
}

/**
 * Does the text contain the keyword as a standalone word, under the same
 * length-gate the live comment matcher uses? So "Potty🙏" and "DM EGG" match,
 * but a long "cook him one egg…" does not. Used by the late-keyword backfill so
 * historical scanning and live matching agree.
 */
export function textContainsKeyword(text: string, keyword: string): boolean {
  const target = normalizeToken(keyword);
  if (!target) return false;
  return scannableCommentTokens(text).includes(target);
}
