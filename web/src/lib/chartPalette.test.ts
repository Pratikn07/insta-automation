import { describe, expect, it } from "vitest";
import {
  CHART_MEAN,
  CHART_OTHER,
  CHART_PROVISIONAL,
  CHART_SEMANTIC_MARK_OPACITY,
  COUNTRY_CHART_COLORS,
  PAPER_SURFACES,
  REGION_CHART_COLORS,
  contrastRatio,
  hueDistance,
} from "./chartPalette";

/** WCAG 2.1 non-text contrast: a graphical object needs 3:1 to be perceivable. */
const FLOOR = 3;

const EVERY_MARK = [
  ...Object.entries(REGION_CHART_COLORS).map(([name, hex]) => [`region ${name}`, hex] as const),
  ...COUNTRY_CHART_COLORS.map((hex, i) => [`country ${i}`, hex] as const),
  ["other", CHART_OTHER] as const,
  ["mean", CHART_MEAN] as const,
  ["provisional", CHART_PROVISIONAL] as const,
];

describe("contrastRatio", () => {
  it("agrees with known reference pairs", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
});

describe("paper contrast floor", () => {
  it.each(EVERY_MARK)("%s clears 3:1 on the canvas", (_name, hex) => {
    expect(contrastRatio(hex, PAPER_SURFACES.canvas)).toBeGreaterThanOrEqual(FLOOR);
  });

  it.each(EVERY_MARK)("%s clears 3:1 on a card", (_name, hex) => {
    expect(contrastRatio(hex, PAPER_SURFACES.card)).toBeGreaterThanOrEqual(FLOOR);
  });

  // The specific regression: the old palette's mean line and provisional outline
  // were semi-transparent white, which is ~1.05:1 on paper — not dim, absent.
  it("uses no white value for the mean or provisional marks", () => {
    for (const hex of [CHART_MEAN, CHART_PROVISIONAL]) {
      expect(hex.toLowerCase()).not.toBe("#ffffff");
      expect(hex.toLowerCase()).not.toBe("#fff");
      expect(contrastRatio(hex, PAPER_SURFACES.card)).toBeGreaterThan(FLOOR);
    }
  });

  it("renders semantic marks fully opaque", () => {
    // Fading a series makes it fail the contrast it was chosen to pass, so state is
    // carried by dash and outline instead.
    expect(CHART_SEMANTIC_MARK_OPACITY).toBe(1);
  });
});

describe("palette structure", () => {
  it("keeps eight distinct country slots so assignment stays stable", () => {
    expect(COUNTRY_CHART_COLORS).toHaveLength(8);
    expect(new Set(COUNTRY_CHART_COLORS).size).toBe(8);
  });

  it("gives every region its own colour", () => {
    const values = Object.values(REGION_CHART_COLORS);
    expect(new Set(values).size).toBe(values.length);
  });

  // Separation between two series is a matter of hue, not lightness: a green and
  // an amber at the same luminance are plainly different marks. Luminance is the
  // right measure against the ground, and the wrong one between series.
  it("separates adjacent country slots by hue", () => {
    for (let i = 1; i < COUNTRY_CHART_COLORS.length; i += 1) {
      expect(hueDistance(COUNTRY_CHART_COLORS[i], COUNTRY_CHART_COLORS[i - 1])).toBeGreaterThan(
        25,
      );
    }
  });

  it("makes the mean line the darkest mark, so it reads as the statement", () => {
    const others = [...Object.values(REGION_CHART_COLORS), ...COUNTRY_CHART_COLORS];
    for (const hex of others) {
      expect(contrastRatio(CHART_MEAN, PAPER_SURFACES.card)).toBeGreaterThanOrEqual(
        contrastRatio(hex, PAPER_SURFACES.card),
      );
    }
  });
});
