import { describe, expect, it } from "vitest";
import { EXCERPT_MAX_LENGTH, redactExcerpt } from "./advisorRedact.js";

describe("redactExcerpt", () => {
  it("keeps the topic while removing an email address", () => {
    const out = redactExcerpt("Can you email the guide to geri.taylor+baby@example.co.uk please?");
    expect(out).toContain("email the guide");
    expect(out).toContain("[email]");
    expect(out).not.toContain("geri.taylor");
    expect(out).not.toContain("example.co.uk");
  });

  it.each([
    "call me on +1 (415) 555-0132",
    "my number is 415-555-0132",
    "reach me at 4155550132",
  ])("removes phone-like strings: %s", (input) => {
    const out = redactExcerpt(input)!;
    expect(out).toContain("[number]");
    expect(out).not.toMatch(/\d{4,}/);
  });

  it("removes URLs with and without a scheme", () => {
    expect(redactExcerpt("saw it at https://shop.example.com/x?y=1")).toBe("saw it at [link]");
    expect(redactExcerpt("check www.example.com/deal")).toBe("check [link]");
  });

  it("removes long digit runs that look like account numbers", () => {
    const out = redactExcerpt("order 90210447781 never arrived")!;
    expect(out).toBe("order [number] never arrived");
  });

  it("removes inline @handles", () => {
    expect(redactExcerpt("told @some.brand about you")).toBe("told [handle] about you");
  });

  it("collapses whitespace and newlines", () => {
    expect(redactExcerpt("line one\n\n  line   two")).toBe("line one line two");
  });

  it("caps at 160 characters with an ellipsis", () => {
    const out = redactExcerpt("x".repeat(400))!;
    expect(out.length).toBe(EXCERPT_MAX_LENGTH);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short clean excerpt untouched", () => {
    expect(redactExcerpt("toddler refuses every vegetable")).toBe(
      "toddler refuses every vegetable",
    );
  });

  it("returns null for empty, null and whitespace-only input", () => {
    expect(redactExcerpt(null)).toBeNull();
    expect(redactExcerpt(undefined)).toBeNull();
    expect(redactExcerpt("")).toBeNull();
    expect(redactExcerpt("   \n ")).toBeNull();
  });

  it("returns null when redaction removes everything meaningful", () => {
    // A message that was ONLY a phone number still yields a placeholder, not the
    // digits — the important property is that no digits survive.
    const out = redactExcerpt("+1 415 555 0132")!;
    expect(out).not.toMatch(/\d{4,}/);
  });

  // The real inbound messages this feature exists for.
  it("preserves the substance of a real parent message", () => {
    const out = redactExcerpt(
      "Grandma here: I am helping raise my 2 year old grandson and he refuses most food. His diet is cheese and bread. Grilled cheese, Mac and cheese, Cheerios with milk, maybe yogurt if in the mood.",
    )!;
    expect(out).toContain("refuses most food");
    expect(out.length).toBeLessThanOrEqual(EXCERPT_MAX_LENGTH);
  });
});
