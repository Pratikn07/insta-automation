/**
 * How much of Instagram's message budget a step uses.
 *
 * Meta's Instagram Messaging API states the limit in **bytes**, not characters:
 * "Message text must be UTF-8 and be a 1000 bytes or less." That distinction is
 * the whole reason this file exists. A naive `body.length` check is wrong for
 * every guide this account sends, because an emoji costs 4 bytes and a bullet
 * or a curly quote costs 3.
 *
 * Measured against production on 2026-08-16: counting characters found 3
 * over-limit messages; counting bytes found 10. Six of them looked comfortable
 * on a character count and were not — "Brush" step 4 reads 972 characters and
 * weighs 1,017 bytes, and one step sits at 999, a single byte inside the limit.
 *
 * A character counter would therefore have shown "972 / 1000 — fine" on a
 * message Instagram rejects, which is worse than no counter at all: it would
 * have made an undeliverable guide look approved.
 */

/** Meta's documented ceiling for one text message. Bytes, UTF-8. */
export const IG_TEXT_BYTE_LIMIT = 1000;

/** Where the counter starts warning, before anything is broken. */
export const IG_TEXT_BYTE_WARN = 900;

const encoder = new TextEncoder();

/** UTF-8 byte length — what Instagram measures, not what `.length` returns. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

export type BudgetLevel = "ok" | "near" | "over";

export interface MessageBudget {
  bytes: number;
  limit: number;
  level: BudgetLevel;
  /** Bytes beyond the limit; 0 when within it. */
  over: number;
  /**
   * How much of the weight is not plain ASCII. Named because it is the part
   * people do not expect: a guide can gain 70 bytes without gaining a word.
   */
  overhead: number;
}

export function messageBudget(text: string): MessageBudget {
  const bytes = utf8Bytes(text);
  const level: BudgetLevel =
    bytes > IG_TEXT_BYTE_LIMIT ? "over" : bytes >= IG_TEXT_BYTE_WARN ? "near" : "ok";
  return {
    bytes,
    limit: IG_TEXT_BYTE_LIMIT,
    level,
    over: Math.max(0, bytes - IG_TEXT_BYTE_LIMIT),
    overhead: bytes - text.length,
  };
}
