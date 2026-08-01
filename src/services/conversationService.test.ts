import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: { conversation: { findFirst } },
}));

const { hasCompletedKeyword } = await import("./conversationService.js");

// WHY THIS TEST EXISTS.
//
// hasCompletedKeyword is the duplicate-delivery chokepoint, and it dedupes on
// keywordId — NOT on the keyword WORD. That distinction used to be invisible
// because SLEEP was a single global row: a user who commented SLEEP on six reels
// hit one keywordId and got one guide.
//
// Now that a word can exist as one row PER POST, the same code means something
// different: six SLEEP rows are six keywordIds, so that user receives each post's
// guide. That is the intended behaviour (decision: different posts, different
// content) — measured at ~50 users per 90 days.
//
// Nothing in the codebase would break if someone "fixed" this by matching on the
// word instead; it would just silently withhold guides. These tests pin the
// semantics so that change fails loudly.
describe("hasCompletedKeyword", () => {
  beforeEach(() => findFirst.mockReset());

  it("queries by keywordId, never by the keyword word", async () => {
    findFirst.mockResolvedValue(null);

    await hasCompletedKeyword("user-1", "kw-sleep-postA");

    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      igUserId: "user-1",
      keywordId: "kw-sleep-postA",
      state: "completed",
    });
    // A `keyword` filter here would mean per-WORD dedupe — the regression.
    expect(where).not.toHaveProperty("keyword");
  });

  it("treats the same word on two posts as two separate guides", async () => {
    // Completed on post A...
    findFirst.mockResolvedValueOnce({ id: "convo-1" });
    expect(await hasCompletedKeyword("user-1", "kw-sleep-postA")).toBe(true);

    // ...but post B's SLEEP is a different keywordId, so it is still deliverable.
    findFirst.mockResolvedValueOnce(null);
    expect(await hasCompletedKeyword("user-1", "kw-sleep-postB")).toBe(false);
  });

  it("still blocks a genuine repeat of the same post's keyword", async () => {
    findFirst.mockResolvedValue({ id: "convo-1" });

    expect(await hasCompletedKeyword("user-1", "kw-sleep-postA")).toBe(true);
  });
});
