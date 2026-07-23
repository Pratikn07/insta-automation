import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GeoWindowPoint } from "@/lib/types";
import type { AudienceGrowthSummary, RepeatCandidate } from "@/lib/homeDashboard";
import { AudienceGrowthPanel } from "./AudienceGrowthPanel";
import { RepeatReelsPanel } from "./RepeatReelsPanel";
import { AutomationHealthStrip } from "./AutomationHealthStrip";

const points: GeoWindowPoint[] = [
  {
    capturedAt: "2026-07-10T12:00:00.000Z",
    reachedUs90: 37,
    reachedUs14: 38,
    engagedUs90: 34,
    engagedUs14: 35,
    reachedIn14: 22,
    engagedIn14: 24,
  },
  {
    capturedAt: "2026-07-17T12:00:00.000Z",
    reachedUs90: 37,
    reachedUs14: 42,
    engagedUs90: 34,
    engagedUs14: 39,
    reachedIn14: 19,
    engagedIn14: 21,
  },
];

const summary: AudienceGrowthSummary = {
  status: "growing",
  source: "reached",
  currentPct: 42,
  baselinePct: 37,
  deltaPoints: 5,
  capturedAt: points[1]!.capturedAt,
  latestPoint: points[1]!,
};

const candidate: RepeatCandidate = {
  mediaId: "reel-1",
  caption: "The bedtime reset that finally worked",
  thumbnailUrl: "https://example.com/reel.jpg",
  permalink: "https://instagram.com/reel/example",
  postedAt: "2026-07-12T12:00:00.000Z",
  usFitScore: 78,
  confidence: "high",
  mediaAudioType: "original",
  videoUnavailable: false,
  analyzed: true,
  views: 12500,
  reach: 9800,
  skipRate: 0.21,
  conversion: { keywordComments: 90, gateDelivered: 70, completed: 44 },
  captureRatePct: 0.92,
  rank: 1,
  score: 92,
  reasonKey: "retention",
  reason: "People kept watching instead of skipping.",
  signals: { reach: 0.9, retention: 1, guides: 0.8 },
};

describe("AudienceGrowthPanel", () => {
  it("renders the visual growth verdict and honest comparison language", () => {
    const html = renderToStaticMarkup(
      <AudienceGrowthPanel
        points={points}
        summary={summary}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("Is my US audience growing?");
    expect(html).toContain("Growing");
    expect(html).toContain("42.0%");
    expect(html).toContain("+5.0 percentage points");
    expect(html).toContain("Recent 14 days");
    expect(html).toContain("90-day baseline");
    expect(html).toContain("US audience trend");
    expect(html).toContain("width:42%");
    expect(html).toContain("width:37%");
  });
});

describe("RepeatReelsPanel", () => {
  it("renders a visual, performance-led repeat recommendation", () => {
    const html = renderToStaticMarkup(
      <RepeatReelsPanel
        candidates={[candidate]}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("Which reels should I repeat?");
    expect(html).toContain("The bedtime reset that finally worked");
    expect(html).toContain("9.8K");
    expect(html).toContain("21% skip");
    expect(html).toContain("44 guides");
    expect(html).toContain("US fit 78");
    expect(html).toContain("People kept watching instead of skipping.");
    expect(html).toContain("Open reel on Instagram");
    expect(html).toContain("US-fit is context, not part of the ranking");
  });
});

describe("AutomationHealthStrip", () => {
  it("keeps delivery operations visible without competing with the two main stories", () => {
    const html = renderToStaticMarkup(
      <AutomationHealthStrip
        stats={{
          activeKeywords: 8,
          totalKeywords: 10,
          dmsSentToday: 16,
          conversationsAwaiting: 5,
          completedToday: 12,
          lastError: null,
          gateQueuePending: 2,
          gateQueueExhausted: 0,
        }}
        isLoading={false}
      />,
    );

    expect(html).toContain("Automation health");
    expect(html).toContain("12");
    expect(html).toContain("Sequences today");
    expect(html).toContain("5");
    expect(html).toContain("Awaiting reply");
    expect(html).toContain("2");
    expect(html).toContain("Retries queued");
  });
});
