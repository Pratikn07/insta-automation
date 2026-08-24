import { beforeEach, describe, expect, it, vi } from "vitest";

const bool = vi.fn();
const percent = vi.fn();
const findFirst = vi.fn();

vi.mock("./flagService.js", () => ({ flags: { bool, percent } }));
vi.mock("../lib/prisma.js", () => ({
  prisma: { resourceCoverVersion: { findFirst } },
}));
vi.mock("../lib/supabase.js", () => ({
  publicMediaUrl: (path: string) => `https://cdn.example.test/${path}`,
  serverMediaBucket: () => ({}),
}));
vi.mock("../meta/sendMessage.js", () => ({ sendMetaMessage: vi.fn() }));

const {
  GUIDE_GATE_CARD_SUBTITLE,
  guideGateCardBucket,
  guideGateCardSelected,
  loadGateCard,
} = await import("./guideGateCard.js");

beforeEach(() => {
  bool.mockReset();
  percent.mockReset();
  findFirst.mockReset();
  bool.mockReturnValue(true);
  percent.mockReturnValue(100);
});

describe("card share selection", () => {
  it("is stable for the same commenter and guide", () => {
    const a = guideGateCardBucket("ig-1", "res-1");
    const b = guideGateCardBucket("ig-1", "res-1");
    expect(a).toBe(b);
    // Stability is the point: a coin flip per send would give one person a card and then
    // text, which reads as a broken account rather than a rollout.
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(10_000);
  });

  it("varies by guide, so being in the share for one is not being in it for all", () => {
    expect(guideGateCardBucket("ig-1", "res-1")).not.toBe(
      guideGateCardBucket("ig-1", "res-2"),
    );
  });

  it("selects nobody when the switch is off, whatever the share says", () => {
    bool.mockReturnValue(false);
    percent.mockReturnValue(100);
    expect(guideGateCardSelected({ igUserId: "ig-1", resourceId: "res-1" })).toBe(false);
  });

  it("selects nobody at a zero share, even with the switch on", () => {
    percent.mockReturnValue(0);
    expect(guideGateCardSelected({ igUserId: "ig-1", resourceId: "res-1" })).toBe(false);
  });

  it("selects everyone at a full share", () => {
    expect(guideGateCardSelected({ igUserId: "ig-1", resourceId: "res-1" })).toBe(true);
  });

  /**
   * A flag-read problem must never be the reason something NEW goes out. The text gate is the
   * message that has been converting; an exception here resolves to it rather than to the
   * untested shape.
   */
  it("falls back to the text gate when a flag cannot be read", () => {
    bool.mockImplementation(() => {
      throw new Error("flag store unavailable");
    });
    expect(guideGateCardSelected({ igUserId: "ig-1", resourceId: "res-1" })).toBe(false);
  });

  it("refuses to bucket a missing commenter or guide", () => {
    expect(guideGateCardSelected({ igUserId: "", resourceId: "res-1" })).toBe(false);
    expect(guideGateCardSelected({ igUserId: "ig-1", resourceId: "" })).toBe(false);
  });

  /**
   * The share has to mean roughly what it says, or a "10% rollout" could quietly be 60%.
   * Checked across many synthetic ids rather than asserting one bucket.
   */
  it("puts roughly the requested share in the card arm", () => {
    percent.mockReturnValue(10);
    const ids = Array.from({ length: 4000 }, (_, index) => `ig-${index}`);
    const selected = ids.filter((igUserId) =>
      guideGateCardSelected({ igUserId, resourceId: "res-1" }),
    ).length;
    const share = (selected / ids.length) * 100;
    expect(share).toBeGreaterThan(7);
    expect(share).toBeLessThan(13);
  });
});

describe("loadGateCard", () => {
  it("returns the square cover and the guide name together", async () => {
    findFirst.mockResolvedValue({
      squareStoragePath: "guide-cover/r/v/h/square.png",
      resource: { name: "WAFFLE" },
    });

    await expect(loadGateCard("res-1")).resolves.toEqual({
      coverUrl: "https://cdn.example.test/guide-cover/r/v/h/square.png",
      guideName: "WAFFLE",
    });
    // A published cover with a square, specifically — a dm-only cover would be centre-cropped
    // in a card slot and lose its first word.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          resourceId: "res-1",
          status: "published",
          squareStoragePath: { not: null },
        },
      }),
    );
  });

  it("returns null when the guide has no square yet", async () => {
    findFirst.mockResolvedValue(null);
    await expect(loadGateCard("res-1")).resolves.toBeNull();
  });

  it("returns null rather than throwing when the lookup fails", async () => {
    // The caller is about to send the one private reply this comment gets. A failed lookup
    // must degrade to the text gate, not abort the gate entirely.
    findFirst.mockRejectedValue(new Error("pool exhausted"));
    await expect(loadGateCard("res-1")).resolves.toBeNull();
  });
});

describe("card copy", () => {
  /**
   * The card's button is a profile link and cannot confirm a follow, so the subtitle must
   * carry the instruction. Using the button-naming variant here would describe a control the
   * card does not have.
   */
  it("tells the parent to reply DONE", () => {
    expect(GUIDE_GATE_CARD_SUBTITLE).toMatch(/reply DONE/u);
    expect(GUIDE_GATE_CARD_SUBTITLE).not.toMatch(/tap below|I'm following/u);
  });
});
