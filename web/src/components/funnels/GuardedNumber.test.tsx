import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GuardedNumber } from "./GuardedNumber";

describe("GuardedNumber", () => {
  it("renders the percentage with its counts when the sample supports it", () => {
    const html = renderToStaticMarkup(
      <GuardedNumber
        rate={{ numerator: 202, denominator: 270, pct: 74.8, belowMinSample: false }}
      />,
    );
    expect(html).toContain("74.8%");
    // A bare percentage invites a comparison the counts immediately qualify.
    expect(html).toContain("202 of 270");
  });

  it("puts counts in the value slot and no percentage at all when the sample is thin", () => {
    const html = renderToStaticMarkup(
      <GuardedNumber rate={{ numerator: 5, denominator: 32, pct: null, belowMinSample: true }} />,
    );
    expect(html).toContain("5 of 32");
    expect(html).toContain("too few to rate");
    // Not greyed out, not parenthesised, not in a tooltip — absent.
    expect(html).not.toContain("15.6");
    expect(html).not.toContain("%");
  });

  it("distinguishes an unmeasured rate from a suppressed one", () => {
    const html = renderToStaticMarkup(
      <GuardedNumber rate={{ numerator: 0, denominator: 0, pct: null, belowMinSample: false }} />,
    );
    expect(html).toContain("nothing measured yet");
    expect(html).not.toContain("too few to rate");
  });

  it("formats large counts with separators", () => {
    const html = renderToStaticMarkup(
      <GuardedNumber
        rate={{ numerator: 1589, denominator: 3360, pct: 47.3, belowMinSample: false }}
      />,
    );
    expect(html).toContain("1,589 of 3,360");
  });
});
