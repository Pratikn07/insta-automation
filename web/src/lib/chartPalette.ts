/**
 * Chart colours for a paper interface.
 *
 * The previous palette was built for a dark ground: Tailwind's `*-400` tints, plus
 * two semi-transparent WHITE strokes for the mean line and the provisional
 * outline. On #1c1c1c that reads beautifully. On this console's paper — #f7f5ef
 * canvas, #fffef9 card — emerald-400 measures about 1.5:1 and white measures 1.05:1,
 * which is to say the mean line was invisible and the bars were suggestions.
 *
 * So every value here is opaque and dark enough to clear 3:1 against *both* paper
 * surfaces, which is the WCAG floor for a non-text graphical object. Opacity is not
 * used to distinguish state either: fading a series makes it fail the contrast it
 * was chosen to pass. Provisional data is marked with a dash, and selection with an
 * outline, because shape survives what transparency destroys.
 */

/**
 * The stacked follower regions.
 *
 * `us` is deliberately NOT the moss accent (#2C4A3B), even though a dark green is
 * the obvious choice for the primary series. DESIGN.md's Accent Scope Rule reserves
 * moss for focus and affirmative state — "never a data series, a chart line" — and
 * an accent that also means "United States" stops meaning "the system is working".
 * #1F5D3F is a separate value in the same family: 7.15:1 on the canvas and 7.71:1
 * on a card, so the floor is cleared with room to spare.
 */
export const REGION_CHART_COLORS = {
  us: "#1F5D3F",
  southAsian: "#8C5A1F",
  anglosphere: "#2A4A6B",
  other: "#66665F",
} as const;

/**
 * Per-country series, in assignment order. Eight so the six shown at once keep a
 * stable colour when the set changes, and ordered so adjacent pairs stay separable
 * for the common colour-vision deficiencies.
 */
export const COUNTRY_CHART_COLORS = [
  "#1F5D3F",
  "#8C5A1F",
  "#2A4A6B",
  "#8C3A2B",
  "#5A4E7C",
  "#3F6B22",
  "#1E5F66",
  "#8C3B63",
] as const;

/** Everything outside the named series. */
export const CHART_OTHER = "#66665F";

/** The 7-day rolling average. Near-ink, so it reads as a statement of fact. */
export const CHART_MEAN = "#171812";

/** Incomplete windows. Paired with a dash — the colour alone must not carry it. */
export const CHART_PROVISIONAL = "#66665F";

/**
 * Semantic marks render fully opaque, always.
 *
 * Exported as a constant so the rule is assertable rather than a convention: a
 * test can prove no mark or ancestor group has faded, which is how the old chart
 * lost its contrast in exactly the states that mattered most.
 */
export const CHART_SEMANTIC_MARK_OPACITY = 1;

/** The two surfaces a chart can sit on. Kept here so the tests can measure both. */
export const PAPER_SURFACES = {
  canvas: "#f7f5ef",
  card: "#fffef9",
} as const;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance per WCAG 2.1. */
export function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Hue angle in degrees, 0–360.
 *
 * Two series are told apart by hue, not by lightness — a green and an amber of the
 * same luminance are obviously different marks, so luminance contrast is the wrong
 * measure between series. It is the right measure against the ground.
 */
export function hueAngle(hex: string): number {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  if (span === 0) return 0;
  const raw =
    max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return ((raw * 60) % 360 + 360) % 360;
}

/** Shortest distance between two hue angles, 0–180. */
export function hueDistance(a: string, b: string): number {
  const delta = Math.abs(hueAngle(a) - hueAngle(b)) % 360;
  return delta > 180 ? 360 - delta : delta;
}

/** Contrast ratio between two opaque colours, 1:1 to 21:1. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}
