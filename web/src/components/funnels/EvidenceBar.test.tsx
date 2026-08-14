import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DropOffSummary } from "@/lib/types";
import { EvidenceBar } from "./EvidenceBar";

function evidence(
  over: Partial<DropOffSummary["readEvidence"]> = {},
): DropOffSummary["readEvidence"] {
  return {
    confirmedSeen: 64,
    trackedNeverConfirmed: 556,
    noReadData: 1107,
    confirmedSeenOfTracked: {
      numerator: 64,
      denominator: 620,
      pct: 10.3,
      belowMinSample: false,
    },
    ...over,
  };
}

describe("EvidenceBar", () => {
  it("labels the unknown segment as unknown, never as unseen", () => {
    // The whole point. 1,107 conversations were never tracked for read
    // receipts; calling them unseen would claim a finding the data cannot
    // support and would point the fix at DM copy instead of deliverability.
    const html = renderToStaticMarkup(<EvidenceBar evidence={evidence()} />);
    expect(html).toContain("no read data");
    expect(html).toContain("unknown, not unseen");
  });

  it("gives the unknown segment the neutral token, not a hue", () => {
    const html = renderToStaticMarkup(<EvidenceBar evidence={evidence()} />);
    expect(html).toContain("--color-funnel-unknown");
  });

  it("shows all three counts so the bar cannot be read as two", () => {
    const html = renderToStaticMarkup(<EvidenceBar evidence={evidence()} />);
    expect(html).toContain("64");
    expect(html).toContain("556");
    expect(html).toContain("1,107");
  });

  it("omits a zero segment from the bar but keeps it in the legend", () => {
    const full = renderToStaticMarkup(<EvidenceBar evidence={evidence()} />);
    const zeroed = renderToStaticMarkup(<EvidenceBar evidence={evidence({ confirmedSeen: 0 })} />);

    const barSegments = (html: string) => html.split('class="min-w-[3px]"').length - 1;
    expect(barSegments(full)).toBe(3);
    expect(barSegments(zeroed)).toBe(2);

    // The category still needs explaining even at zero, so the legend keeps it.
    expect(zeroed).toContain("confirmed read");
  });

  it("says so when there is nothing to read evidence from", () => {
    const html = renderToStaticMarkup(
      <EvidenceBar
        evidence={evidence({ confirmedSeen: 0, trackedNeverConfirmed: 0, noReadData: 0 })}
      />,
    );
    expect(html).toContain("No conversations in this bucket");
  });
});
