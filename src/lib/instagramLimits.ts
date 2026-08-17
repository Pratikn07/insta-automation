/**
 * Limits Instagram enforces on outbound messages.
 *
 * Meta's Instagram Messaging API states this one in **bytes**, not characters:
 * "Message text must be UTF-8 and be a 1000 bytes or less." An emoji costs 4
 * bytes and a bullet or curly quote costs 3, so a character check is wrong for
 * every guide this account sends. See docs/meta-verification.md for the
 * measurement against production that established it.
 *
 * Lives here rather than in an API route so the sender can use it too: a route
 * importing from a service is fine, a service importing from a route is not.
 */
export const IG_TEXT_BYTE_LIMIT = 1000;

/** What Instagram measures. Never use `.length` for this. */
export function instagramTextBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function exceedsInstagramTextLimit(text: string): boolean {
  return instagramTextBytes(text) > IG_TEXT_BYTE_LIMIT;
}
