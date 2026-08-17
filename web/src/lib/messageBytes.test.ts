import { describe, expect, it } from "vitest";
import {
  IG_TEXT_BYTE_LIMIT,
  messageBudget,
  utf8Bytes,
} from "./messageBytes";

describe("utf8Bytes", () => {
  it("matches length for plain ASCII", () => {
    expect(utf8Bytes("Brush. Spit. Then move on.")).toBe(26);
  });

  it("counts an emoji as four bytes, not one character", () => {
    expect("👹".length).toBe(2); // UTF-16 surrogate pair
    expect(utf8Bytes("👹")).toBe(4);
  });

  it("counts a bullet and a curly quote as three bytes each", () => {
    expect(utf8Bytes("•")).toBe(3);
    expect(utf8Bytes("’")).toBe(3);
  });

  it("reproduces the real overhead seen in production", () => {
    // "Leave" step 4 measured 945 characters and 1,010 bytes — 65 bytes of
    // overhead from emoji and bullets alone.
    const body = "a".repeat(945 - 20) + "🔵🔺🟩🟥".repeat(5);
    expect(utf8Bytes(body)).toBeGreaterThan(body.length);
  });
});

describe("messageBudget", () => {
  it("is ok well inside the limit", () => {
    expect(messageBudget("Short and deliverable.").level).toBe("ok");
  });

  it("warns before anything is broken", () => {
    expect(messageBudget("a".repeat(950)).level).toBe("near");
  });

  it("flags a message over the byte limit", () => {
    const b = messageBudget("a".repeat(IG_TEXT_BYTE_LIMIT + 1));
    expect(b.level).toBe("over");
    expect(b.over).toBe(1);
  });

  it("catches the case a character counter would pass", () => {
    // 972 characters, over 1,000 bytes once emoji are counted — the exact shape
    // of "Brush" step 4, which a character check reports as comfortable.
    const body = "a".repeat(960) + "👹".repeat(12);
    expect(body.length).toBeLessThan(IG_TEXT_BYTE_LIMIT);
    expect(messageBudget(body).level).toBe("over");
  });

  it("reports overhead so the cause is visible, not just the total", () => {
    expect(messageBudget("hello 👋").overhead).toBeGreaterThan(0);
    expect(messageBudget("hello").overhead).toBe(0);
  });

  it("treats exactly the limit as deliverable", () => {
    const b = messageBudget("a".repeat(IG_TEXT_BYTE_LIMIT));
    expect(b.level).toBe("near");
    expect(b.over).toBe(0);
  });
});
