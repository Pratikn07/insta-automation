import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TooltipModel } from "@/lib/chartTooltip";
import { ChartTooltip } from "./ChartTooltip";

const model: TooltipModel = {
  heading: "Jul 24",
  totalLabel: "+59 net",
  rows: [
    { region: "us", value: 41, valueLabel: "+41" },
    { region: "anglosphere", value: 13, valueLabel: "+13" },
    { region: "other", value: -1, valueLabel: "−1" },
  ],
  notes: [],
  emptyLabel: null,
};

describe("ChartTooltip", () => {
  it("renders the heading, total, and a labelled row per region", () => {
    const html = renderToStaticMarkup(
      <ChartTooltip model={model} x={300} y={120} containerWidth={1080} />,
    );
    expect(html).toContain("Jul 24");
    expect(html).toContain("+59 net");
    expect(html).toContain("US");
    expect(html).toContain("+41");
    expect(html).toContain("UK/CA/AU/NZ/IE");
    expect(html).toContain("Rest of world");
    expect(html).toContain("−1");
  });

  it("renders the honest caveats when present", () => {
    const html = renderToStaticMarkup(
      <ChartTooltip
        model={{
          ...model,
          notes: ["Meta did not refresh in between", "+3 unplaced (top-country cutoff)"],
        }}
        x={300}
        y={120}
        containerWidth={1080}
      />,
    );
    expect(html).toContain("Meta did not refresh in between");
    expect(html).toContain("+3 unplaced (top-country cutoff)");
  });

  it("shows the empty label instead of rows for a zero-net day", () => {
    const html = renderToStaticMarkup(
      <ChartTooltip
        model={{ ...model, rows: [], emptyLabel: "No net change" }}
        x={300}
        y={120}
        containerWidth={1080}
      />,
    );
    expect(html).toContain("No net change");
  });

  it("omits the total row for a gap column", () => {
    const html = renderToStaticMarkup(
      <ChartTooltip
        model={{
          heading: "Jul 20",
          totalLabel: null,
          rows: [],
          notes: ["No snapshot captured"],
          emptyLabel: null,
        }}
        x={300}
        y={120}
        containerWidth={1080}
      />,
    );
    expect(html).toContain("No snapshot captured");
    expect(html).not.toContain("net<");
  });

  it("flips to the cursor's left near the right edge", () => {
    const near = renderToStaticMarkup(
      <ChartTooltip model={model} x={1040} y={120} containerWidth={1080} />,
    );
    const far = renderToStaticMarkup(
      <ChartTooltip model={model} x={200} y={120} containerWidth={1080} />,
    );
    // Flipped cards anchor by right edge; normal cards anchor by left.
    expect(near).toContain("right:");
    expect(far).toContain("left:");
  });

  it("never intercepts its own hover and is hidden from assistive tech", () => {
    const html = renderToStaticMarkup(
      <ChartTooltip model={model} x={300} y={120} containerWidth={1080} />,
    );
    expect(html).toContain("pointer-events-none");
    expect(html).toContain('aria-hidden="true"');
  });

  it("shows the feed-attribution action without changing the chart data", () => {
    const html = renderToStaticMarkup(
      <ChartTooltip
        model={model}
        x={300}
        y={120}
        containerWidth={1080}
        actionHint="Click to see contributing feed posts"
      />,
    );
    expect(html).toContain("Click to see contributing feed posts");
    expect(html).toContain("+59 net");
    expect(html).toContain("US");
  });
});
