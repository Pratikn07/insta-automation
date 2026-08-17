/**
 * How much of Instagram's message budget a step uses.
 *
 * CHARACTERS, not bytes — and this file previously argued the opposite at
 * length, so the correction is worth stating plainly.
 *
 * Meta's wording is "Message text must be UTF-8 and be a 1000 bytes or less",
 * and on 2026-08-16 that was taken literally. Production disagrees. "potty"
 * step 0 is 1,005 bytes and 973 characters, and it is the FIRST step of that
 * guide: under a byte ceiling every send would fail before anything reached the
 * recipient. In the preceding 30 days it logged 79 successful completions. Five
 * further stored messages sit in the same window — over 1,000 bytes, under 1,000
 * characters — and all of them deliver.
 *
 * So the counter that used to live here would have shown "1,005 / 1,000 — over"
 * on a message Instagram accepts, and the matching backend guard would have
 * skipped it. A counter that condemns deliverable messages is not more cautious
 * than one that flatters them; it is wrong in the more expensive direction,
 * because someone edits a working guide to satisfy it.
 *
 * Counting is by CODEPOINT. `String.length` counts UTF-16 code units, so 💛
 * scores 2 there but 1 in Postgres `length()` — and Postgres is where the
 * measurement above came from. `[...text].length` agrees with it.
 */

/** Meta's documented ceiling for one text message, in characters. */
export const IG_TEXT_CHAR_LIMIT = 1000;

/** Where the counter starts warning, before anything is broken. */
export const IG_TEXT_CHAR_WARN = 900;

/** Codepoints, not `.length`. "🍎".length is 2; this returns 1. */
export function textChars(text: string): number {
  return [...text].length;
}

export type BudgetLevel = "ok" | "near" | "over";

export interface MessageBudget {
  chars: number;
  limit: number;
  level: BudgetLevel;
  /** Characters beyond the limit; 0 when within it. */
  over: number;
}

export function messageBudget(text: string): MessageBudget {
  const chars = textChars(text);
  const level: BudgetLevel =
    chars > IG_TEXT_CHAR_LIMIT ? "over" : chars >= IG_TEXT_CHAR_WARN ? "near" : "ok";
  return {
    chars,
    limit: IG_TEXT_CHAR_LIMIT,
    level,
    over: Math.max(0, chars - IG_TEXT_CHAR_LIMIT),
  };
}
