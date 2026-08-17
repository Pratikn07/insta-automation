/**
 * Limits Instagram enforces on outbound messages.
 *
 * CHARACTERS, not bytes. This file said bytes until 2026-08-16, on the strength
 * of Meta's wording ("Message text must be UTF-8 and be a 1000 bytes or less").
 * Production disproves it:
 *
 *   "potty" step 0 is 1,005 UTF-8 bytes and 973 characters. It is the FIRST step
 *   of that guide, so under a byte limit every send would throw before anything
 *   was delivered and no conversation could ever reach markCompleted — that call
 *   sits after sendSequence. In the 30 days to 2026-08-16, potty logged 79
 *   `sequence_completed` events across 82 completed conversations.
 *
 * A limit that rejects 1,005 bytes cannot deliver that message 79 times. So the
 * ceiling is not 1,000 bytes, and the documented 1,000 characters is what we
 * measure. Five more messages sit in the same window — over 1,000 bytes, under
 * 1,000 characters — and all of them deliver today.
 *
 * This matters more than a wrong constant. The byte check was already written
 * into sequenceSender, which skips any step that fails it. Shipping it would
 * have silently dropped the opening message of a guide that ~194 people a month
 * receive, causing exactly the failure it was written to prevent.
 *
 * Counting is by CODEPOINT, not `String.length`. JavaScript counts UTF-16 code
 * units, so an emoji outside the BMP counts as 2 — 💛 is one character to a
 * reader and to Postgres `length()`, and the measurement above came from
 * Postgres. `[...text].length` matches it.
 *
 * What remains unproven: exactly where the ceiling sits. Bytes is disproved by
 * evidence; 1,000 characters is Meta's documented figure and now agrees with
 * every message we can observe. If a send ever fails on length again, measure
 * the failing body both ways before changing this.
 *
 * Lives here rather than in an API route so the sender can use it too: a route
 * importing from a service is fine, a service importing from a route is not.
 */
export const IG_TEXT_CHAR_LIMIT = 1000;

/**
 * What Instagram counts.
 *
 * Not `text.length`: that is UTF-16 code units, which overcounts every astral
 * character. "🍎".length is 2; this returns 1.
 */
export function instagramTextChars(text: string): number {
  return [...text].length;
}

export function exceedsInstagramTextLimit(text: string): boolean {
  return instagramTextChars(text) > IG_TEXT_CHAR_LIMIT;
}
