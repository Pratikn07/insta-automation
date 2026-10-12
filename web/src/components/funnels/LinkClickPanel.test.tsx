// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LinkClickResult } from "@/lib/types";
import { LinkClickPanel } from "./LinkClickPanel";

afterEach(cleanup);

const rate = (numerator: number, denominator: number, pct: number | null) => ({
  numerator,
  denominator,
  pct,
  belowMinSample: pct === null,
});

const DATA: LinkClickResult = {
  key: "link-click",
  name: "Comment → link click",
  question: "q",
  window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" },
  cohortSize: 412,
  stages: [
    { key: "entered", label: "Asked for a link guide", definition: "d", count: 412, ofEntryPct: 100, ofPrevPct: null },
    { key: "linkSent", label: "Got the link", definition: "d", count: 398, ofEntryPct: 96.6, ofPrevPct: 96.6 },
    { key: "clicked", label: "Opened the page", definition: "d", count: 171, ofEntryPct: 41.5, ofPrevPct: 43 },
  ],
  headline: { fromStage: "linkSent", toStage: "clicked", label: "Click rate", rationale: "r", rate: rate(171, 398, 43) },
  followedAnyway: rate(20, 80, 25),
  byReel: [{ mediaId: "reel-9", entered: 412, linkSent: 398, clicked: 171, clickRate: rate(171, 398, 43) }],
};

describe("LinkClickPanel", () => {
  it("shows links sent, click rate, follows and each reel", () => {
    render(<LinkClickPanel data={DATA} isLoading={false} isError={false} />);
    // With a single reel, the headline and the reel row repeat the same figures.
    expect(screen.getAllByText("Click rate").length).toBeGreaterThan(0);
    expect(screen.getAllByText("43%").length).toBeGreaterThan(0);
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getAllByText("398").length).toBeGreaterThan(0);
    expect(screen.getByText("reel-9")).toBeInTheDocument();
  });

  it("says so when no link guide was asked for", () => {
    render(<LinkClickPanel data={{ ...DATA, cohortSize: 0, byReel: [] }} isLoading={false} isError={false} />);
    expect(screen.getByText("No link guide has been asked for in this window.")).toBeInTheDocument();
  });

  it("keeps an error inside its own panel", () => {
    render(<LinkClickPanel data={undefined} isLoading={false} isError />);
    expect(screen.getByText("Couldn't load link clicks. The rest of this page is unaffected.")).toBeInTheDocument();
  });

  it("shows a dash for a rate withheld for want of sample", () => {
    render(
      <LinkClickPanel
        data={{ ...DATA, headline: { ...DATA.headline, rate: rate(1, 2, null) } }}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.getByText("Too few to say")).toBeInTheDocument();
  });
});
