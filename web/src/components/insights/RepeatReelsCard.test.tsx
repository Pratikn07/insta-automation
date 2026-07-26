import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LeaderboardRow } from "@/lib/types";
import { RepeatReelsCard } from "./RepeatReelsCard";

function reel(overrides: Partial<LeaderboardRow> & Pick<LeaderboardRow, "mediaId">): LeaderboardRow {
  const { mediaId, ...rest } = overrides;
  return {
    mediaId,
    caption: "A useful parenting reel",
    thumbnailUrl: null,
    permalink: null,
    postedAt: "2026-07-01T12:00:00.000Z",
    usFitScore: 50,
    confidence: "medium",
    mediaAudioType: null,
    videoUnavailable: false,
    analyzed: true,
    views: null,
    reach: null,
    skipRate: null,
    conversion: { keywordComments: 0, gateDelivered: 0, completed: 0 },
    captureRatePct: null,
    ...rest,
  };
}

describe("RepeatReelsCard", () => {
  it("ranks reels and explains why each one earned the pick", () => {
    const html = renderToStaticMarkup(
      <RepeatReelsCard
        rows={[
          reel({
            mediaId: "a",
            caption: "The bedtime reset that finally worked",
            reach: 9800,
            skipRate: 0.21,
            usFitScore: 78,
            conversion: { keywordComments: 90, gateDelivered: 70, completed: 44 },
          }),
          reel({ mediaId: "b", reach: 1200, skipRate: 0.7 }),
        ]}
        isLoading={false}
      />,
    );

    expect(html).toContain("Which reels should I repeat?");
    expect(html).toContain("The bedtime reset that finally worked");
    expect(html).toContain("9.8K");
    expect(html).toContain("21% skip");
    expect(html).toContain("44 guides");
    expect(html).toContain("US fit 78");
    expect(html).toContain("US-fit is context, not part of the ranking");
  });

  it("explains the wait instead of rendering an empty list", () => {
    const html = renderToStaticMarkup(<RepeatReelsCard rows={[]} isLoading={false} />);
    expect(html).toContain("Not enough measured performance yet");
  });

  it("renders a skeleton while loading", () => {
    const html = renderToStaticMarkup(<RepeatReelsCard rows={[]} isLoading />);
    expect(html).toContain("animate-pulse");
  });
});
