import { describe, expect, it } from "vitest";
import {
  IG_TEXT_CHAR_LIMIT,
  exceedsInstagramTextLimit,
  instagramTextChars,
} from "../lib/instagramLimits.js";

/**
 * The guard is on characters. It was on bytes for one day, on the strength of
 * Meta's wording, and production disproved it — see instagramLimits.ts.
 *
 * The cases below are production shapes rather than invented ones, because the
 * failure mode here is asymmetric: sequenceSender SKIPS what this flags, so a
 * measure that is too strict deletes messages that would have arrived.
 */
describe("Instagram text character limit", () => {
  it("is the documented 1000", () => {
    expect(IG_TEXT_CHAR_LIMIT).toBe(1000);
  });

  it("counts an emoji as one character where .length counts two", () => {
    expect("👹".length).toBe(2);
    expect(instagramTextChars("👹")).toBe(1);
  });

  it("counts bullets and curly quotes as one", () => {
    expect(instagramTextChars("•")).toBe(1);
    expect(instagramTextChars("’")).toBe(1);
  });

  it("accepts a message exactly on the limit", () => {
    expect(exceedsInstagramTextLimit("a".repeat(IG_TEXT_CHAR_LIMIT))).toBe(false);
    expect(exceedsInstagramTextLimit("a".repeat(IG_TEXT_CHAR_LIMIT + 1))).toBe(true);
  });

  /**
   * The regression guard. "potty" step 0 is 973 characters and 1,005 bytes, and
   * it is the first step of a guide ~194 people receive each month. Under a byte
   * check the sender skips it and they receive nothing; it delivered 79 times in
   * the 30 days before this was corrected.
   */
  it("does not reject the over-1000-byte messages production delivers", () => {
    const pottyShaped = "a".repeat(962) + "💛".repeat(11);
    expect(instagramTextChars(pottyShaped)).toBe(973);
    expect(Buffer.byteLength(pottyShaped, "utf8")).toBeGreaterThan(1000);
    expect(exceedsInstagramTextLimit(pottyShaped)).toBe(false);
  });

  it("rejects the one stored message that is genuinely over", () => {
    // "OVERTIRED" step 0: 1,749 characters, 1,819 bytes.
    expect(exceedsInstagramTextLimit("a".repeat(1749))).toBe(true);
  });

  it("does not let astral characters inflate the count", () => {
    // 600 emoji: 600 characters, 1,200 UTF-16 units. `.length` would reject a
    // message at 60% of the limit.
    const body = "🙂".repeat(600);
    expect(body.length).toBe(1200);
    expect(instagramTextChars(body)).toBe(600);
    expect(exceedsInstagramTextLimit(body)).toBe(false);
  });
});
