import { describe, expect, it } from "vitest";
// `?raw` works for source files; a `?raw` or `?inline` CSS import resolves to an
// empty string because vitest stubs stylesheets (`css: false`). So the token hexes
// are restated below rather than read, following PAPER_SURFACES in chartPalette.ts.
import componentSource from "./UpcomingAutomations.tsx?raw";
import { PAPER_SURFACES, contrastRatio } from "@/lib/chartPalette";

/**
 * The status chips have to be readable on paper.
 *
 * What this guards against already happened once. The values these tokens
 * replaced were built for a dark shell — sky-300, emerald-300, amber-300,
 * amber-400/30 — and on the #fffef9 card they measure between 1.2:1 and 1.7:1.
 * Not dim: unreadable. No test could see it, because a Tailwind class name is
 * just a string, and the Maison QA only caught the same bug on the Sequences
 * badge by looking at a screenshot.
 *
 * Two halves, so the loop closes:
 *  - the ratios below are measured, not asserted by eye;
 *  - the component is scanned to prove it renders these tokens and no others.
 */

/** WCAG 2.1: text needs 4.5:1 against its own background. */
const TEXT_FLOOR = 4.5;

/**
 * Mirrors the `@theme` block in index.css, where each of these ratios is also
 * recorded as a comment. Restated for the reason above; the scan further down is
 * what keeps the component honest about which of them it uses.
 */
const TOKENS = {
  caution: "#7a5a0c",
  "caution-soft": "#f0e6cc",
  urgent: "#a8412b",
  "urgent-soft": "#f5ddd6",
  signal: "#2c4a3b",
  "signal-soft": "#dce9e2",
  "muted-foreground": "#66665f",
  muted: "#ebe8df",
} as const;

/** The pairs UpcomingAutomations.tsx renders, one per status. */
const CHIPS = [
  ["waiting", "caution", "caution-soft"],
  ["needs attention", "urgent", "urgent-soft"],
  ["attached", "signal", "signal-soft"],
  ["cancelled", "muted-foreground", "muted"],
] as const;

/** Comments stripped, so a docstring naming an old colour is not read as using it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("upcoming automation status chips", () => {
  it.each(CHIPS)("keeps %s readable on its own chip", (_label, fg, bg) => {
    expect(contrastRatio(TOKENS[fg], TOKENS[bg])).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });

  // A chip sits on a card inside Content, and Content sits on the canvas. Both
  // grounds have to work, because the same component renders against both.
  it.each(CHIPS)("keeps %s readable on both paper surfaces", (_label, fg) => {
    expect(contrastRatio(TOKENS[fg], PAPER_SURFACES.card)).toBeGreaterThanOrEqual(TEXT_FLOOR);
    expect(contrastRatio(TOKENS[fg], PAPER_SURFACES.canvas)).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });

  // Needs attention must not read more faintly than Waiting. A chip that makes a
  // caption mismatch look calmer than "still waiting" is actively misinforming.
  it("does not render the failure state more faintly than the waiting state", () => {
    const urgent = contrastRatio(TOKENS.urgent, TOKENS["urgent-soft"]);
    const waiting = contrastRatio(TOKENS.caution, TOKENS["caution-soft"]);
    expect(urgent).toBeGreaterThan(waiting * 0.8);
  });

  // Ties the component to the tokens above: every colour pair it renders must be
  // one this file measured. A new status painted in an unmeasured colour fails here.
  it("renders only the token pairs measured in this file", () => {
    const tones = [...code(componentSource).matchAll(/tone:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(tones).toHaveLength(CHIPS.length);

    const measured = new Set(CHIPS.map(([, fg, bg]) => `bg-${bg} text-${fg}`));
    for (const tone of tones) {
      expect(measured).toContain(tone);
    }
  });

  it("has no dark-shell colour left in the component", () => {
    const darkShell =
      /\b(?:text|bg|border|ring)-(?:sky|amber|emerald|rose|slate|zinc|gray|blue|green|red|yellow|indigo|violet)-\d{2,3}\b/g;
    expect(code(componentSource).match(darkShell)).toBeNull();
  });

  // No `dark:` variant either. This console has no dark mode, and the Maison QA
  // found exactly this leftover on the Sequences badge — a colour pair that could
  // only ever render in a shell which no longer exists.
  it("has no dark-mode variant left in the component", () => {
    expect(code(componentSource).match(/\bdark:/g)).toBeNull();
  });

  // The generic api() was deleted when reads became abortable and mutations became
  // dispatch-classified. Importing it is a compile error today; asserting it stops
  // the file drifting back if that export ever returns.
  it("uses only the classified API helpers", () => {
    const imported = componentSource.match(/import \{([^}]+)\} from "@\/lib\/api"/)?.[1] ?? "";
    const names = imported
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    expect(names.sort()).toEqual(["apiMutation", "apiRead"]);
  });
});
