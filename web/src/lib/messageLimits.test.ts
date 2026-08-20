import { describe, expect, it } from "vitest";
import { IG_TEXT_CHAR_LIMIT, messageBudget, textChars } from "./messageLimits";

/**
 * These cases were written for a byte limit and inverted on 2026-08-16. The
 * production shapes they are drawn from did not change; what changed is which
 * side of the line they sit on. Keeping them, rather than deleting and
 * rewriting, so the regression they now guard against is the specific one that
 * nearly shipped.
 */
describe("textChars", () => {
  it("matches length for plain ASCII", () => {
    expect(textChars("Brush. Spit. Then move on.")).toBe(26);
  });

  it("counts an emoji as ONE character where .length counts two", () => {
    expect("👹".length).toBe(2); // UTF-16 surrogate pair
    expect(textChars("👹")).toBe(1);
  });

  it("counts a bullet and a curly quote as one each", () => {
    expect(textChars("•")).toBe(1);
    expect(textChars("’")).toBe(1);
  });
});

describe("messageBudget", () => {
  it("is ok well inside the limit", () => {
    expect(messageBudget("Short and deliverable.").level).toBe("ok");
  });

  it("warns before anything is broken", () => {
    expect(messageBudget("a".repeat(950)).level).toBe("near");
  });

  it("flags a message over the limit", () => {
    const b = messageBudget("a".repeat(IG_TEXT_CHAR_LIMIT + 1));
    expect(b.level).toBe("over");
    expect(b.over).toBe(1);
  });

  it("treats exactly the limit as deliverable", () => {
    const b = messageBudget("a".repeat(IG_TEXT_CHAR_LIMIT));
    expect(b.level).toBe("near");
    expect(b.over).toBe(0);
  });

  /**
   * The regression this file exists for.
   *
   * "potty" step 0: 973 characters, 1,005 UTF-8 bytes, and the FIRST step of a
   * guide roughly 194 people receive each month. A byte counter calls this over
   * limit and the sender skips it, so those people get nothing. It delivered 79
   * times in the 30 days before this was corrected.
   */
  it("passes the message a byte counter would have condemned", () => {
    const body = "a".repeat(962) + "💛".repeat(11);
    expect(textChars(body)).toBe(973);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(1000);
    expect(messageBudget(body).level).not.toBe("over");
  });

  it("still catches the one genuinely over-limit message", () => {
    // "OVERTIRED" step 0: 1,749 characters, 1,819 bytes.
    expect(messageBudget("a".repeat(1749)).level).toBe("over");
  });

  it("does not let astral characters inflate the count past the limit", () => {
    // 600 emoji are 600 characters but 1,200 UTF-16 units. Using .length here
    // would report "over" on a message half the limit.
    const body = "🙂".repeat(600);
    expect(body.length).toBe(1200);
    expect(messageBudget(body).chars).toBe(600);
    expect(messageBudget(body).level).toBe("ok");
  });
});
