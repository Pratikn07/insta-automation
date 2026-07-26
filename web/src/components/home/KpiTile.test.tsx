import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArrowUpRight, Users } from "lucide-react";
import { KpiTile } from "./KpiTile";

describe("KpiTile", () => {
  it("renders the label, value, context and note", () => {
    const html = renderToStaticMarkup(
      <KpiTile
        label="US followers this week"
        value="+182"
        context="vs +140 last week"
        note="newest 2 still settling"
        Icon={Users}
        tone="emerald"
        trendIcon={ArrowUpRight}
      />,
    );

    expect(html).toContain("US followers this week");
    expect(html).toContain("+182");
    expect(html).toContain("vs +140 last week");
    expect(html).toContain("newest 2 still settling");
  });

  it("omits the context and note lines when they are absent", () => {
    const html = renderToStaticMarkup(
      <KpiTile label="Total followers" value="4,355" Icon={Users} />,
    );

    expect(html).toContain("4,355");
    expect(html).not.toContain("still settling");
    expect(html).not.toContain("vs ");
  });

  it("renders a skeleton instead of a value while loading", () => {
    const html = renderToStaticMarkup(
      <KpiTile label="Total followers" value="4,355" Icon={Users} isLoading />,
    );

    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("4,355");
  });

  it("renders an em dash value without inventing a comparison", () => {
    const html = renderToStaticMarkup(
      <KpiTile
        label="Guide → follow yield"
        value="—"
        context="No non-follower deliveries to measure yet"
        Icon={Users}
      />,
    );

    expect(html).toContain("—");
    expect(html).toContain("No non-follower deliveries to measure yet");
  });
});
