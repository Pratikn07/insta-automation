import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { keyword: { findMany } },
}));

const {
  findDmKeywordCandidates,
  findKeywordForComment,
  scannableCommentMatchCandidates,
  textContainsKeyword,
} = await import("./keywordService.js");

function row(input: {
  id: string;
  keyword: string;
  mediaId?: string | null;
  mediaPostedAt?: Date | null;
}) {
  return {
    id: input.id,
    keyword: input.keyword,
    mediaId: input.mediaId ?? null,
    mediaPostedAt: input.mediaPostedAt ?? null,
    gateMessage: "gate",
    resource: { id: `resource-${input.id}`, name: input.keyword, messages: [] },
  };
}

beforeEach(() => {
  findMany.mockReset();
});

describe("findDmKeywordCandidates", () => {
  it("loads all active matching rows once and resolves them in message order", async () => {
    const recipe = row({ id: "recipe", keyword: "RECIPE" });
    const waffle = row({ id: "waffle", keyword: "WAFFLE" });
    findMany.mockResolvedValue([recipe, waffle]);

    const result = await findDmKeywordCandidates("Please send the WAFFLE recipe");

    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith({
      where: { keyword: { in: ["PLEASE", "SEND", "THE", "WAFFLE", "RECIPE"] }, active: true },
      include: { resource: { include: { messages: true } } },
    });
    expect(result.meaningfulTokens).toEqual(["PLEASE", "SEND", "THE", "WAFFLE", "RECIPE"]);
    expect(result.matches.map((match) => match.keyword.id)).toEqual(["waffle", "recipe"]);
    expect(result.matches.map((match) => match.tokenPosition)).toEqual([3, 4]);
  });

  it("returns normalized tokens and no matches without querying when the DM is empty", async () => {
    await expect(findDmKeywordCandidates(" 💛 @tinysoho ")).resolves.toEqual({
      meaningfulTokens: [],
      matches: [],
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("keeps Unicode letters as standalone meaningful tokens", async () => {
    findMany.mockResolvedValue([]);

    const result = await findDmKeywordCandidates("café WAFFLE🙏");

    expect(result.meaningfulTokens).toEqual(["CAFÉ", "WAFFLE"]);
  });
});

describe("comment keyword phrases", () => {
  it("includes exact adjacent phrases and compact aliases in comment scan order", () => {
    expect(scannableCommentMatchCandidates("high chair please")).toEqual([
      "HIGH CHAIR",
      "HIGHCHAIR",
      "HIGH",
      "CHAIR PLEASE",
      "CHAIRPLEASE",
      "CHAIR",
      "PLEASE",
    ]);
  });

  it("supports a two-word CTA at the start of a long comment without scanning later words", () => {
    expect(scannableCommentMatchCandidates("day 1 please send me the guide")).toEqual([
      "DAY 1",
      "DAY1",
      "DAY",
    ]);
  });

  it("queries and resolves a legacy compact keyword from a split numeric phrase", async () => {
    const legacy = row({ id: "day1", keyword: "DAY1", mediaId: "post-1" });
    findMany.mockImplementation(async (args: { where: { keyword?: { in: string[] } } }) =>
      args.where.keyword?.in.includes("DAY1") ? [legacy] : [],
    );

    const match = await findKeywordForComment("Day 1", "post-1");

    expect(findMany).toHaveBeenCalledWith({
      where: {
        keyword: { in: ["DAY 1", "DAY1", "DAY", "1"] },
        mediaId: null,
        active: true,
      },
    });
    expect(match?.keyword.id).toBe("day1");
    expect(match?.matchedToken).toBe("DAY1");
  });

  it("backfills a two-word keyword and its compact alias as exact phrases", () => {
    expect(textContainsKeyword("HIGH CHAIR", "HIGH CHAIR")).toBe(true);
    expect(textContainsKeyword("Day 1", "DAY1")).toBe(true);
    expect(textContainsKeyword("Day 10", "DAY1")).toBe(false);
  });
});
