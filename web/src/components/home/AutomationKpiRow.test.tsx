// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuideFollowResult } from "@/lib/types";
import { AutomationKpiRow } from "./AutomationKpiRow";

const funnel = {
  key: "guide-follow",
  name: "Guide → follow",
  question: "",
  window: { from: "2026-07-15T00:00:00.000Z", to: "2026-08-14T00:00:00.000Z" },
  cohortSize: 3383,
  stages: [],
  headline: {
    fromStage: "gateSent",
    toStage: "replied",
    label: "Reply rate",
    rationale: "",
    rate: { numerator: 1589, denominator: 3360, pct: 47.3, belowMinSample: false },
  },
  followGateConversion: { numerator: 202, denominator: 270, pct: 74.8, belowMinSample: false },
  stuckAtWall: 68,
  askDistribution: [],
  expressLane: 1355,
  byEntryPath: [],
  retention: { numerator: 5, denominator: 5, pct: 100, belowMinSample: false },
  homeTileCohort: { deliveredToNonFollower: 29, ofWhichRedelivery: 1 },
} satisfies GuideFollowResult;

afterEach(cleanup);
function markup(rate: GuideFollowResult["headline"]["rate"] = funnel.headline.rate) {
  return renderToStaticMarkup(<AutomationKpiRow
    funnel={{ ...funnel, headline: { ...funnel.headline, rate } }}
    isLoading={false} isError={false} onRetry={() => {}} />);
}

describe("AutomationKpiRow", () => {
  it("keeps the measured reply rate, counts and meter", () => {
    const html = markup();
    expect(html).toContain("47.3%");
    expect(html).toContain("1,589 of 3,360 answered the unlock DM");
    expect(html).toContain("1,771 never replied");
    expect(html).toContain('role="img"');
    expect(html).not.toContain("followers");
  });
  it("withholds the percentage and meter below minimum sample", () => {
    const html = markup({ numerator: 2, denominator: 4, pct: null, belowMinSample: true });
    expect(html).toContain("2 of 4");
    expect(html).not.toContain("50%");
    expect(html).not.toContain('role="img"');
  });
  it("preserves measured zero rather than treating it as missing", () => {
    const html = markup({ numerator: 0, denominator: 10, pct: 0, belowMinSample: false });
    expect(html).toContain("0%");
    expect(html).toContain("0 of 10 answered");
    expect(html).toContain('role="img"');
  });
  it("shows counts and no meter for an empty cohort", () => {
    const html = markup({ numerator: 0, denominator: 0, pct: null, belowMinSample: true });
    expect(html).toContain("0 of 0");
    expect(html).not.toContain('role="img"');
  });
  it("does not show stale evidence as current when loading", () => {
    render(<AutomationKpiRow funnel={funnel} isLoading isError={false} onRetry={() => {}} />);
    expect(screen.queryByText("47.3%")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("shows unavailable and allows retry even when cached evidence exists", async () => {
    const retry = vi.fn();
    render(<AutomationKpiRow funnel={funnel} isLoading={false} isError onRetry={retry} />);
    expect(screen.queryByText("47.3%")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry reply rate" }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it("shows unavailable when evidence is missing", () => {
    render(<AutomationKpiRow funnel={undefined} isLoading={false} isError={false} onRetry={() => {}} />);
    expect(screen.getByText("Reply rate is temporarily unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
