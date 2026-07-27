import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint, SpikeInfo } from "@/lib/types";
import { SpikeCandidates } from "./SpikeCandidates";

function candidate(
  mediaId: string,
  caption: string,
  reachGained: number,
  sharePct: number,
) {
  return {
    mediaId,
    caption,
    thumbnailUrl: `https://example.com/${mediaId}.jpg`,
    permalink: `https://instagram.com/reel/${mediaId}`,
    postedAt: "2026-07-21T23:00:00.000Z",
    reachGained,
    sharePct,
  };
}

function point(day: string, total: number, spike?: SpikeInfo): FollowerDailyAddsPoint {
  return {
    day,
    capturedAt: `${day}T23:00:00.000Z`,
    us: total,
    southAsian: 0,
    anglosphere: 0,
    other: 0,
    total,
    unattributed: 0,
    reportedTotalDelta: total,
    spanDays: 1,
    stale: false,
    provisional: false,
    basis: "diff",
    ...(spike ? { spike } : {}),
  };
}

const highSpike: SpikeInfo = {
  multiple: 5.7,
  net: 251,
  baselineMedian: 44,
  confidence: "high",
  candidates: [
    candidate("dinner", "It feels wrong to let them walk away from dinner.", 55179, 65),
    candidate("more", "Most parents think they should be doing more", 12370, 15),
    candidate("perfect", "Your toddler doesn't need to eat perfectly", 8414, 10),
  ],
};

describe("SpikeCandidates", () => {
  it("names the spike day, its multiple, and each candidate reel", () => {
    const html = renderToStaticMarkup(
      <SpikeCandidates points={[point("2026-07-22", 50), point("2026-07-23", 251, highSpike)]} />,
    );
    expect(html).toContain("Jul 23");
    expect(html).toContain("+251");
    expect(html).toContain("5.7×");
    expect(html).toContain("It feels wrong to let them walk away from dinner.");
    expect(html).toContain("65%");
    expect(html).toContain("Most parents think they should be doing more");
  });

  it("shows reach gained per candidate in compact form", () => {
    const html = renderToStaticMarkup(
      <SpikeCandidates points={[point("2026-07-23", 251, highSpike)]} />,
    );
    expect(html).toContain("55.2K");
  });

  it("never claims a reel caused the spike", () => {
    const html = renderToStaticMarkup(
      <SpikeCandidates points={[point("2026-07-23", 251, highSpike)]} />,
    );
    expect(html.toLowerCase()).not.toContain("caused");
    expect(html.toLowerCase()).not.toContain("because");
    expect(html).toContain("Candidates");
  });

  it("says several reels overlapped when no reel owns the window", () => {
    const html = renderToStaticMarkup(
      <SpikeCandidates
        points={[
          point("2026-07-23", 251, {
            ...highSpike,
            confidence: "low",
            candidates: [
              candidate("a", "First reel", 1000, 20),
              candidate("b", "Second reel", 900, 18),
              candidate("c", "Third reel", 800, 16),
            ],
          }),
        ]}
      />,
    );
    expect(html).toContain("Several reels overlapped");
  });

  it("shows at most two spikes so the section cannot swamp the page", () => {
    // Four spikes rendered ~1800px of text below the chart on real data.
    const html = renderToStaticMarkup(
      <SpikeCandidates
        points={[
          point("2026-07-11", 105, { ...highSpike, multiple: 2.7 }),
          point("2026-07-15", 187, { ...highSpike, multiple: 4.4 }),
          point("2026-07-22", 168, { ...highSpike, multiple: 3.9 }),
          point("2026-07-23", 251, highSpike),
        ]}
      />,
    );
    expect(html).toContain("Jul 23");
    expect(html).toContain("Jul 22");
    expect(html).not.toContain("Jul 15");
    expect(html).not.toContain("Jul 11");
  });

  it("drops trivial-share reels rather than listing the whole catalog", () => {
    // Real data had a spike whose 2nd and 3rd candidates were 2% each — that is
    // the back catalogue ticking over, not a candidate for anything.
    const html = renderToStaticMarkup(
      <SpikeCandidates
        points={[
          point("2026-07-11", 105, {
            ...highSpike,
            candidates: [
              candidate("lead", "The reel that actually moved", 89741, 90),
              candidate("noise-a", "Back catalogue reel A", 1950, 2),
              candidate("noise-b", "Back catalogue reel B", 1727, 2),
            ],
          }),
        ]}
      />,
    );
    expect(html).toContain("The reel that actually moved");
    expect(html).not.toContain("Back catalogue reel A");
    expect(html).not.toContain("Back catalogue reel B");
  });

  it("renders nothing at all when no day is a spike", () => {
    const html = renderToStaticMarkup(
      <SpikeCandidates points={[point("2026-07-18", 45), point("2026-07-19", 50)]} />,
    );
    expect(html).toBe("");
  });

  it("lists the newest spike first", () => {
    const older: SpikeInfo = {
      ...highSpike,
      multiple: 4.4,
      net: 187,
      candidates: [candidate("egg", "I made this from an egg carton", 7885, 49)],
    };
    const html = renderToStaticMarkup(
      <SpikeCandidates
        points={[point("2026-07-15", 187, older), point("2026-07-23", 251, highSpike)]}
      />,
    );
    expect(html.indexOf("Jul 23")).toBeLessThan(html.indexOf("Jul 15"));
  });

  it("links each candidate to the reel and falls back when a thumbnail is missing", () => {
    const html = renderToStaticMarkup(
      <SpikeCandidates
        points={[
          point("2026-07-23", 251, {
            ...highSpike,
            candidates: [
              { ...candidate("no-thumb", "No thumbnail reel", 500, 100), thumbnailUrl: null },
            ],
          }),
        ]}
      />,
    );
    expect(html).toContain("https://instagram.com/reel/no-thumb");
    expect(html).toContain("No thumbnail reel");
  });
});
