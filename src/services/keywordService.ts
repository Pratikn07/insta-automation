import { prisma } from "../lib/prisma.js";
import { resolveCommentMatch, resolveDmKeywordCandidates } from "./keywordMatchCore.js";

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
 * (not just the first).
 *
 * A post that has ANY keyword attached is matched STRICTLY against its own
 * keywords — no falling through to a global. That is what stops `SLEEP` on a
 * potty reel from sending the sleep guide. A post with nothing attached still
 * uses the globals, so the legacy keywords keep working untouched. See
 * keywordMatchCore for why the rule is per-post rather than a flat cutoff.
 *
 * Returns the matched row, which token matched, and how it resolved
 * (post_strict | global_fallback) for adoption auditing — or null.
 */
export async function findKeywordForComment(text: string, mediaId?: string | null) {
  const scan = scannableCommentTokens(text);
  if (scan.length === 0) return null;

  // Fetch the post's keywords and the globals in one round trip, then let the
  // pure core decide. Note the post query is NOT filtered by `scan`: the core
  // needs to know the post has keywords at all, even when none match this
  // comment, because that is exactly when the global fallback must be withheld.
  const [postKeywords, globalKeywords] = await Promise.all([
    mediaId
      ? prisma.keyword.findMany({ where: { mediaId, active: true } })
      : Promise.resolve([]),
    prisma.keyword.findMany({ where: { keyword: { in: scan }, mediaId: null, active: true } }),
  ]);

  return resolveCommentMatch(scan, postKeywords, globalKeywords);
}

// Carry the sequence so the DM path can deliver instantly (follower /
// already-completed) without a second lookup — mirrors findActiveAwaitingDone.
const WITH_SEQUENCE = { resource: { include: { messages: true } } } as const;

/**
 * Resolve a keyword from an inbound DM.
 *
 * A DM carries no post context — the user opened the inbox and typed a word — so
 * a global keyword matches unambiguously and is tried first. When only
 * POST-SCOPED rows carry the word, the newest post wins: measured at 472
 * DM-sourced matches per 90 days (408 of them SLEEP, live on 6 posts), and
 * dropping them would silence real traffic. `inferredFromPost` is set on that
 * path so the guess is auditable rather than invisible.
 *
 * Every word is scanned with no length gate, since a DM is an intentional
 * message — so "sleep", "Sleep", "sleep🙏" and "DM me sleep" all resolve.
 */
export async function findDmKeywordCandidates(text: string) {
  const meaningfulTokens = extractCandidates(text);
  if (meaningfulTokens.length === 0) return { meaningfulTokens, matches: [] };

  const rows = await prisma.keyword.findMany({
    where: { keyword: { in: meaningfulTokens }, active: true },
    include: WITH_SEQUENCE,
  });

  return {
    meaningfulTokens,
    matches: resolveDmKeywordCandidates(meaningfulTokens, rows),
  };
}

/** Backward-compatible first-match view for older internal callers. */
export async function findKeywordInMessage(text: string) {
  const { matches } = await findDmKeywordCandidates(text);
  const first = matches[0];
  return first ? { ...first.keyword, inferredFromPost: first.inferredFromPost } : null;
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
