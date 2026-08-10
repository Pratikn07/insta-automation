// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint, FollowerStock } from "@/lib/types";
import { summarizeFollowerFlow } from "@/lib/followerFlow";
import { shiftDay } from "@/lib/dateRange";
import { FollowerFlowPanel } from "./FollowerFlowPanel";

afterEach(cleanup);

// cmdk (the country picker's search list) drives its own scroll and measurement,
// using two browser APIs jsdom does not implement. No-op stubs are enough:
// nothing here asserts on layout or scroll position, only on what is rendered.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

// A 41-day series matching the account's real coverage shape, so the "30d range
// on 41 days leaves an 11-day predecessor" case is exercised for real.
const FIRST_DAY = "2026-06-30";
const DAYS = 41;

function series(usPerDay: (i: number) => number): FollowerDailyAddsPoint[] {
  return Array.from({ length: DAYS }, (_, i) => {
    const us = usPerDay(i);
    return {
      day: shiftDay(FIRST_DAY, i),
      capturedAt: `${shiftDay(FIRST_DAY, i)}T23:00:00.000Z`,
      us,
      southAsian: 1,
      anglosphere: 2,
      other: 3,
      total: us + 6,
      unattributed: 0,
      byCountry: { US: us, IN: 1, GB: 2, ZA: 3 },
      reportedTotalDelta: us + 6,
      spanDays: 1,
      stale: false,
      provisional: false,
      basis: "diff" as const,
    };
  });
}

const stock: FollowerStock = {
  capturedAt: "2026-08-09T23:00:00.000Z",
  totalCounted: 5977,
  followersTotal: 6200,
  us: 2000,
  southAsian: 1500,
  anglosphere: 1200,
  other: 1277,
  countriesReported: 45,
};

function renderPanel(points: FollowerDailyAddsPoint[]) {
  return render(
    <FollowerFlowPanel
      points={points}
      stock={stock}
      summary={summarizeFollowerFlow(points)}
      isLoading={false}
      isError={false}
      onRetry={() => {}}
    />,
  );
}

describe("Follower flow date filter", () => {
  it("defaults to All and keeps the trailing-7-day legend", () => {
    renderPanel(series(() => 10));
    expect(screen.getByText(/Where your new followers come from \(7 days\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("relabels the legend to the selected span and rescopes the sums", async () => {
    // 10 US/day everywhere, so a 7-day range must total exactly 70.
    renderPanel(series(() => 10));
    await userEvent.click(screen.getByRole("button", { name: "7d" }));

    expect(screen.getByText(/Where your new followers come from \(7 days\)/)).toBeInTheDocument();
    const legend = screen.getByText("US").closest("span")!.parentElement!;
    expect(within(legend).getByText("+70")).toBeInTheDocument();
  });

  it("compares against the preceding range, not a fixed 28 days", async () => {
    // Flat 5/day until the last 7 days, which jump to 60/day.
    renderPanel(series((i) => (i >= DAYS - 7 ? 60 : 5)));
    await userEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(screen.getByText("Accelerating")).toBeInTheDocument();
  });

  it("hides the trend badge when the predecessor is only partly covered", async () => {
    renderPanel(series(() => 10));
    // 30 days of a 41-day account leaves an 11-day predecessor — not comparable.
    await userEvent.click(screen.getByRole("button", { name: "30d" }));

    expect(screen.queryByText("Accelerating")).not.toBeInTheDocument();
    expect(screen.queryByText("Holding steady")).not.toBeInTheDocument();
    expect(screen.queryByText("Slowing")).not.toBeInTheDocument();
  });

  it("shows the badge again on a range that does have a full predecessor", async () => {
    renderPanel(series(() => 10));
    await userEvent.click(screen.getByRole("button", { name: "14d" }));
    expect(screen.getByText("Holding steady")).toBeInTheDocument();
  });

  it("opens a calendar and commits a two-click custom range", async () => {
    renderPanel(series(() => 10));
    await userEvent.click(screen.getByRole("button", { name: /Custom/ }));

    const dialog = screen.getByRole("dialog", { name: "Choose a date range" });
    await userEvent.click(within(dialog).getByRole("button", { name: "2026-08-01" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "2026-08-05" }));

    // Aug 1–5 inclusive is 5 days; the legend must say so.
    expect(screen.getByText(/Where your new followers come from \(5 days\)/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables calendar days outside real coverage", async () => {
    renderPanel(series(() => 10));
    await userEvent.click(screen.getByRole("button", { name: /Custom/ }));
    const dialog = screen.getByRole("dialog", { name: "Choose a date range" });
    // Coverage ends Aug 9, so Aug 20 exists in the grid but must not be pickable.
    expect(within(dialog).getByRole("button", { name: "2026-08-20" })).toBeDisabled();
  });

  it("leaves the spike panel reading the full window, not the filtered range", async () => {
    const points = series(() => 10);
    // A spike on the very first day, far outside a 7-day range.
    points[0]!.spike = {
      multiple: 7.2,
      net: 321,
      baselineMedian: 45,
      confidence: "high",
      candidates: [],
    };
    renderPanel(points);
    await userEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(screen.getByText(/7.2×/)).toBeInTheDocument();
  });
});

describe("Follower flow country mode", () => {
  it("stays on regions by default", () => {
    renderPanel(series(() => 10));
    expect(screen.getByRole("button", { name: "regions" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Rest of world")).toBeInTheDocument();
  });

  it("surfaces South Africa as its own band instead of Rest of world", async () => {
    // The whole point of country mode: ZA is not in ANGLOSPHERE, so region mode
    // buries it in the grey band.
    renderPanel(series(() => 10));
    await userEvent.click(screen.getByRole("button", { name: "countries" }));

    expect(screen.getByText("South Africa")).toBeInTheDocument();
    expect(screen.queryByText("Rest of world")).not.toBeInTheDocument();
  });

  it("names the chart by country and keeps the region chart otherwise", async () => {
    renderPanel(series(() => 10));
    expect(screen.getByText("Daily net adds by region")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "countries" }));
    expect(screen.getByText("Daily net adds by country")).toBeInTheDocument();
  });

  it("hides a country when its legend chip is clicked", async () => {
    renderPanel(series(() => 10));
    await userEvent.click(screen.getByRole("button", { name: "countries" }));
    await userEvent.click(screen.getByRole("button", { name: /South Africa/ }));

    expect(screen.queryByText("South Africa")).not.toBeInTheDocument();
    expect(screen.getByText(/Other \(1 countries?\)/)).toBeInTheDocument();
  });

  it("offers no country mode when the server sent no byCountry", () => {
    const points = series(() => 10).map((p) => ({ ...p, byCountry: undefined }));
    renderPanel(points);
    expect(screen.queryByRole("button", { name: "countries" })).not.toBeInTheDocument();
  });

  it("lists every reported country with its net adds in the picker", async () => {
    renderPanel(series(() => 10));
    await userEvent.click(screen.getByRole("button", { name: "countries" }));
    await userEvent.click(screen.getByRole("button", { name: /All countries \(4\)/ }));

    const dialog = screen.getByRole("dialog", { name: "All reported countries" });
    expect(within(dialog).getByText("India")).toBeInTheDocument();
    expect(within(dialog).getByText("South Africa")).toBeInTheDocument();
  });

  it("keeps a country's colour when a date change reorders the stack", async () => {
    // Colour must follow the entity, not its rank: US dominates overall but ZA
    // dominates the last 7 days. ZA's swatch must be identical in both views.
    const points = series((i) => (i >= DAYS - 7 ? 0 : 40)).map((p, i) => ({
      ...p,
      byCountry: { US: i >= DAYS - 7 ? 0 : 40, IN: 1, GB: 2, ZA: i >= DAYS - 7 ? 90 : 3 },
    }));
    renderPanel(points);
    await userEvent.click(screen.getByRole("button", { name: "countries" }));

    const swatchOf = (name: RegExp) =>
      screen.getByRole("button", { name }).querySelector("span")!.getAttribute("style");
    const before = swatchOf(/South Africa/);

    await userEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(swatchOf(/South Africa/)).toBe(before);
  });

  it("keeps the region legend untouched when switching back", async () => {
    renderPanel(series(() => 10));
    await userEvent.click(screen.getByRole("button", { name: "countries" }));
    await userEvent.click(screen.getByRole("button", { name: "regions" }));
    expect(screen.getByText("Rest of world")).toBeInTheDocument();
    expect(screen.queryByText("South Africa")).not.toBeInTheDocument();
  });
});
