// Pure core for keyword matching: which keyword should a comment or a DM fire?
// (No prisma imports, no Date.now() — candidate rows are passed in.)
//
// WHY THIS EXISTS. Every keyword used to be global, so `SLEEP` typed on ANY reel
// fired the same guide. Measured on 90 days of production: SLEEP was live on 6
// different posts (1,431 matches), RECIPE on 4, POTTY on 3 — all sending one
// guide. The goal is one keyword per post, each with its own guide.
//
// The subtlety is that this cannot be a flat "post-scoped only" rule. All 24
// existing keywords are global, so a hard cutoff would silence every reel until
// each was reattached by hand. Instead the rule is per-post (see resolveCommentMatch):
// a post that has its own keywords is strict, a post that has none still honours
// the globals. Converting a post is then a single action — attach one keyword and
// that post stops answering to globals.

import type { ResolvedDmKeyword } from "./dmGuideIntent.js";

/** The subset of a Keyword row the matching decision actually needs. */
export interface KeywordCandidate {
  id: string;
  keyword: string;
  /** null = global (legacy); a post id = scoped to that post. */
  mediaId: string | null;
  /** The POST's publish date, not the attach date. Null on global rows. */
  mediaPostedAt: Date | null;
}

/** How a comment's keyword was resolved — recorded for adoption auditing. */
export type MatchMode = "post_strict" | "global_fallback";

export interface CommentMatch<T extends KeywordCandidate> {
  keyword: T;
  /** The configured token or phrase that fired; kept for observability. */
  matchedToken: string;
  mode: MatchMode;
}

/**
 * Resolve the keyword a COMMENT should fire.
 *
 * `postKeywords` is every ACTIVE keyword attached to the post the comment landed
 * on; `globalKeywords` is every active global. `tokens` is the ordered list of
 * exact single-word, adjacent-phrase, and compact-alias keys from the comment.
 *
 * The rule, and the whole point of this module:
 *
 *   post has keywords attached  →  match ONLY those. No global fallback.
 *   post has none               →  fall back to globals, exactly as before.
 *
 * So a post you have configured never leaks another post's guide, while the
 * untouched ones keep working. Returns null when nothing matches — the caller
 * logs comment_ignored and stays silent.
 */
export function resolveCommentMatch<T extends KeywordCandidate>(
  tokens: string[],
  postKeywords: T[],
  globalKeywords: T[],
): CommentMatch<T> | null {
  if (tokens.length === 0) return null;

  // A post that has ANY keyword attached is strict, even if none of them match
  // this particular comment. That "even if" is the fix: it is what stops `SLEEP`
  // on a potty reel from firing the sleep guide.
  if (postKeywords.length > 0) {
    const hit = firstMatch(tokens, postKeywords);
    return hit ? { keyword: hit, matchedToken: hit.keyword, mode: "post_strict" } : null;
  }

  const hit = firstMatch(tokens, globalKeywords);
  return hit ? { keyword: hit, matchedToken: hit.keyword, mode: "global_fallback" } : null;
}

/**
 * First candidate matching any scan key, in comment order.
 *
 * Comment order, not database row order, so the earliest matching word or phrase
 * the commenter actually typed wins — "DM EGG" fires EGG regardless of how the
 * rows came back.
 */
function firstMatch<T extends KeywordCandidate>(tokens: string[], candidates: T[]): T | null {
  for (const token of tokens) {
    const hit = candidates.find((c) => c.keyword === token);
    if (hit) return hit;
  }
  return null;
}

/**
 * Rank post-scoped candidates for a COLD DM, newest post first.
 *
 * A DM webhook carries no media (see MessagingEntry in types/meta.ts) — the user
 * just opened the inbox and typed a word — so nothing in the message says which
 * of several posts they meant. Measured: 472 DM-sourced matches in 90 days, 408
 * of them SLEEP, which is live on 6 posts. Newest is the chosen inference: it is
 * the best guess at what they just watched.
 *
 * A null mediaPostedAt sorts LAST rather than being dropped: it means we could not
 * date the post, which is a reason to deprioritize a candidate, not to make it
 * unreachable. Ties (and all-null sets) fall back to id so the pick is stable
 * across calls rather than depending on row order.
 */
export function rankDmCandidates<T extends KeywordCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    const at = a.mediaPostedAt?.getTime();
    const bt = b.mediaPostedAt?.getTime();
    if (at === undefined && bt === undefined) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (at === undefined) return 1; // nulls last
    if (bt === undefined) return -1;
    if (bt !== at) return bt - at; // newest first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The post-scoped keyword a cold DM should fire: newest matching post wins.
 *
 * Callers try globals first (a global still answers a DM unambiguously, and while
 * the legacy globals exist that is the common path); this is the fallback for when
 * only post-scoped rows carry the word.
 */
export function resolveDmFallback<T extends KeywordCandidate>(candidates: T[]): T | null {
  return rankDmCandidates(candidates)[0] ?? null;
}

/**
 * Resolve every keyword token in a DM without allowing database row order to
 * choose the guide. Each token prefers a stable global row; when only scoped
 * rows exist, that token independently uses the existing newest-post fallback.
 */
export function resolveDmKeywordCandidates<T extends KeywordCandidate>(
  tokens: readonly string[],
  candidates: readonly T[],
): ResolvedDmKeyword<T>[] {
  const resolved: ResolvedDmKeyword<T>[] = [];
  const seenRows = new Set<string>();

  tokens.forEach((token, tokenPosition) => {
    const matching = candidates.filter((candidate) => candidate.keyword === token);
    const globals = matching
      .filter((candidate) => candidate.mediaId === null)
      .sort((a, b) => a.id.localeCompare(b.id));
    const selected =
      globals[0] ?? resolveDmFallback(matching.filter((candidate) => candidate.mediaId !== null));
    if (!selected || seenRows.has(selected.id)) return;

    seenRows.add(selected.id);
    resolved.push({
      keyword: selected,
      matchedToken: token,
      tokenPosition,
      inferredFromPost: selected.mediaId,
    });
  });

  return resolved;
}
