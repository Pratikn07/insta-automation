import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { keyword: { findMany } },
}));

const { findDmKeywordCandidates } = await import("./keywordService.js");

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
