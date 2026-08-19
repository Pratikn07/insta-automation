import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint } from "@/lib/types";
import { preventChartDayPointerFocus } from "@/lib/chartPointerInteraction";
import { DailyAddsChart } from "./DailyAddsChart";

function pointerEvent(pointerType: string): PointerEvent {
  const event = new Event("pointerdown", { cancelable: true }) as PointerEvent;
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

// A null total is a day Meta never refreshed, which is what `measured` filters
// out — so one real day plus one unmeasured day is the waiting state.
function point(day: string, total: number | null): FollowerDailyAddsPoint {
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
  };
}

describe("chart day pointer focus", () => {
  it("prevents mouse focus from leaving a native outline around a clicked SVG bar", () => {
    const event = pointerEvent("mouse");
    preventChartDayPointerFocus(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("does not cancel touch interaction", () => {
    const event = pointerEvent("touch");
    preventChartDayPointerFocus(event);

    expect(event.defaultPrevented).toBe(false);
  });
});

/**
 * The waiting state, asserted on the rendered markup rather than trusted from
 * the source. It shipped as a 224px `rounded-xl border border-dashed` panel:
 * a 12px radius on a surface whose --radius-lg is 3px, and an edge that
 * resolved through the base layer to #EBE8DF — 1.12:1 on the ground, so it
 * could not be seen even where it was wanted.
 */
describe("chart waiting state", () => {
  function markup() {
    return renderToStaticMarkup(
      <DailyAddsChart points={[point("2026-08-10", 12), point("2026-08-11", null)]} />,
    );
  }

  it("states the condition as a sentence", () => {
    expect(markup()).toContain("Daily adds appear after two measured days.");
  });

  it("draws no container around the sentence", () => {
    const html = markup();

    expect(html).not.toContain("rounded-xl");
    expect(html).not.toContain("border-dashed");
    // Any bare `border` utility, which is the one that ships invisible.
    expect(html).not.toMatch(/class="[^"]*\bborder\b/);
    // Reserving the chart's full height for one line renders the state as the
    // gap it is meant to replace.
    expect(html).not.toContain("h-56");
  });

  it("does not substitute a different label for assistive tech", () => {
    expect(markup()).not.toContain('role="img"');
  });
});
