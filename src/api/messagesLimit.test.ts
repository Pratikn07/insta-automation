import { describe, expect, it } from "vitest";
import { IG_TEXT_BYTE_LIMIT } from "../lib/instagramLimits.js";

/**
 * The guard is on bytes because Instagram's limit is on bytes. These cases are
 * drawn from production shapes, not invented: six stored steps sit under 1,000
 * characters and over 1,000 bytes, and the old `.max(2000)` character check
 * passed every one of them.
 */
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("Instagram text byte limit", () => {
  it("is the documented 1000", () => {
    expect(IG_TEXT_BYTE_LIMIT).toBe(1000);
  });

  it("counts an emoji as four bytes where .length counts two", () => {
    expect("👹".length).toBe(2);
    expect(bytes("👹")).toBe(4);
  });

  it("counts bullets and curly quotes as three", () => {
    expect(bytes("•")).toBe(3);
    expect(bytes("’")).toBe(3);
  });

  it("catches the shape a character check waves through", () => {
    // 972 characters / 1,017 bytes — "Brush" step 4 as stored in production.
    const body = "a".repeat(960) + "👹".repeat(12);
    expect(body.length).toBeLessThan(IG_TEXT_BYTE_LIMIT);
    expect(bytes(body)).toBeGreaterThan(IG_TEXT_BYTE_LIMIT);
  });

  it("accepts a message exactly on the limit", () => {
    expect(bytes("a".repeat(IG_TEXT_BYTE_LIMIT))).toBe(IG_TEXT_BYTE_LIMIT);
  });

  it("would have rejected the largest stored step", () => {
    // "OVERTIRED" step 0: 1,749 characters, 1,819 bytes.
    expect(1819).toBeGreaterThan(IG_TEXT_BYTE_LIMIT);
  });
});
