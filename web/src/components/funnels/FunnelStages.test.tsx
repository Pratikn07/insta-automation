import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FunnelStageCount } from "@/lib/types";
import { FunnelStages } from "./FunnelStages";

function stage(over: Partial<FunnelStageCount> = {}): FunnelStageCount {
  return {
    key: "k",
    label: "A stage",
    definition: "what counts",
    count: 100,
    ofEntryPct: 100,
    ofPrevPct: 100,
    ...over,
  };
}

describe("FunnelStages", () => {
  it("shows no step conversion across a stage people can join", () => {
    // Someone already following reaches delivery without replying. Dividing
    // one by the other would print a number above 100%, which is the fastest
    // way to make a marketer stop trusting the page.
    const html = renderToStaticMarkup(
      <FunnelStages
        cohortSize={200}
        stages={[
          stage({ key: "replied", label: "Replied", count: 40, ofPrevPct: 40 }),
          stage({
            key: "guideDelivered",
            label: "Got the guide",
            count: 180,
            ofPrevPct: null,
            bypassable: true,
          }),
        ]}
      />,
    );
    expect(html).toContain("joinable");
    expect(html).toContain("no step");
    expect(html).not.toContain("450%");
  });

  it("never reports a loss across a joinable stage", () => {
    // The difference there is a different population, not people who fell out.
    const html = renderToStaticMarkup(
      <FunnelStages
        cohortSize={200}
        stages={[
          stage({ key: "a", count: 190 }),
          stage({ key: "b", count: 180, bypassable: true, ofPrevPct: null }),
        ]}
        renderLoss={(_s, lost) => <p>{lost} lost here</p>}
      />,
    );
    expect(html).not.toContain("lost here");
  });

  it("never reports a loss across a coverage-only stage", () => {
    // The 21-day reading: 1,400 eligible, 5 re-measured. "1,395 lost here"
    // would sit directly above a caveat saying the gap is coverage, not churn.
    const html = renderToStaticMarkup(
      <FunnelStages
        cohortSize={3383}
        stages={[
          stage({ key: "followingMeasured", count: 1400 }),
          stage({ key: "followingD21", count: 5, ofPrevPct: 0.4, coverageOnly: true }),
        ]}
        renderLoss={(_s, lost) => <p>{lost} lost here</p>}
      />,
    );
    expect(html).not.toContain("lost here");
    expect(html).not.toContain("1,395");
  });

  it("reports the loss across a real sequential step", () => {
    const html = renderToStaticMarkup(
      <FunnelStages
        cohortSize={200}
        stages={[stage({ key: "a", count: 190 }), stage({ key: "b", count: 40, ofPrevPct: 21.1 })]}
        renderLoss={(_s, lost) => <p>{lost} lost here</p>}
      />,
    );
    expect(html).toContain("150 lost here");
  });

  it("keeps a tiny non-zero stage visible", () => {
    // "5 of 1,400" rendering as a zero-width bar reads as a bug, not a number.
    const html = renderToStaticMarkup(
      <FunnelStages cohortSize={3383} stages={[stage({ key: "d21", count: 5, ofPrevPct: 0.4 })]} />,
    );
    expect(html).toMatch(/width:\s*0\.15%/);
  });

  it("carries each stage's definition for hover", () => {
    const html = renderToStaticMarkup(
      <FunnelStages
        cohortSize={10}
        stages={[stage({ definition: "Counted once per conversation" })]}
      />,
    );
    expect(html).toContain("Counted once per conversation");
  });
});
