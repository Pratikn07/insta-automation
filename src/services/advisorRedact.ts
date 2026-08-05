/**
 * Redaction for advisor topic excerpts.
 *
 * The advisor answers questions about the business, so it needs to know a thread is
 * *about* picky eating — it does not need the parent's email, phone number, or the
 * link they pasted. Excerpts are the only place raw participant text reaches a
 * model prompt, so they are scrubbed and truncated here.
 *
 * Pure, so both the scrubbing and the cap are testable without a database.
 */

export const EXCERPT_MAX_LENGTH = 160;

// Order matters: emails before phone-like runs, so the digits inside an address
// aren't mangled first and left as a partial match.
const PATTERNS: Array<[RegExp, string]> = [
  // Emails.
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  // URLs, with or without a scheme.
  [/\b(?:https?:\/\/|www\.)\S+/gi, "[link]"],
  // Phone-like: 7+ digits allowing spaces, dashes, dots, parens, leading +.
  [/\+?\d[\d\s().-]{6,}\d/g, "[number]"],
  // Long bare digit runs (account/order numbers) the phone pattern may miss.
  [/\b\d{7,}\b/g, "[number]"],
  // @handles — the advisor gets `username` as its own field, so an inline mention
  // is just another identifier it doesn't need.
  [/(^|\s)@[\w.]{2,}/g, "$1[handle]"],
];

/** Scrub identifiers, collapse whitespace, and cap at 160 characters. */
export function redactExcerpt(text: string | null | undefined): string | null {
  if (!text) return null;

  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);

  out = out.replace(/\s+/g, " ").trim();
  if (out.length === 0) return null;
  if (out.length <= EXCERPT_MAX_LENGTH) return out;
  // Hard cap, with an ellipsis so a truncated excerpt is visibly partial.
  return `${out.slice(0, EXCERPT_MAX_LENGTH - 1).trimEnd()}…`;
}
