// src/services/funnels/linkClickFunnel.test.ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { summarizeLinkClick, type LinkClickRow } from "./linkClickFunnel.js";

const WINDOW = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" };

function row(patch: Partial<LinkClickRow>): LinkClickRow {
  return {
    conversationId: randomUUID(),
    mediaId: "reel-a",
    linkSent: true,
    clicked: false,
    rechecked: false,
    followsNow: null,
    ...patch,
  };
}

describe("summarizeLinkClick", () => {
  it("reports click rate over links sent, and each reel, busiest first", () => {
    const rows = [
      ...Array.from({ length: 6 }, () => row({ mediaId: "reel-a", clicked: true })),
      ...Array.from({ length: 4 }, () => row({ mediaId: "reel-a" })),
      ...Array.from({ length: 2 }, () => row({ mediaId: "reel-b", linkSent: false })),
    ];

    const result = summarizeLinkClick(rows, WINDOW, 5);

    expect(result.cohortSize).toBe(12);
    expect(result.stages.map((stage) => [stage.key, stage.count])).toEqual([
      ["entered", 12],
      ["linkSent", 10],
      ["clicked", 6],
      ["followingMeasured", 0],
    ]);
    expect(result.headline.rate).toEqual({ numerator: 6, denominator: 10, pct: 60, belowMinSample: false });
    expect(result.byReel).toEqual([
      {
        mediaId: "reel-a",
        entered: 10,
        linkSent: 10,
        clicked: 6,
        clickRate: { numerator: 6, denominator: 10, pct: 60, belowMinSample: false },
      },
      {
        mediaId: "reel-b",
        entered: 2,
        linkSent: 0,
        clicked: 0,
        clickRate: { numerator: 0, denominator: 0, pct: null, belowMinSample: true },
      },
    ]);
  });

  it("measures followed-anyway among rechecked clickers only", () => {
    const rows = [
      row({ clicked: true, rechecked: true, followsNow: true }),
      row({ clicked: true, rechecked: true, followsNow: false }),
      row({ clicked: true, rechecked: false, followsNow: true }),
      row({ clicked: false, rechecked: true, followsNow: true }),
    ];
    expect(summarizeLinkClick(rows, WINDOW, 1).followedAnyway).toEqual({
      numerator: 1,
      denominator: 2,
      pct: 50,
      belowMinSample: false,
    });
  });

  it("withholds a rate below the minimum sample", () => {
    const result = summarizeLinkClick([row({ clicked: true })], WINDOW, 5);
    expect(result.headline.rate.pct).toBeNull();
    expect(result.headline.rate.belowMinSample).toBe(true);
  });
});
