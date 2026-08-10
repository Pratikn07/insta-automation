import { describe, expect, it } from "vitest";
import type { FollowerDailyAddsPoint } from "./types";
import {
  COUNTRY_PALETTE,
  MAX_COLORED_COUNTRIES,
  OTHER_KEY,
  buildCountryStack,
  colorMapFor,
  countryLabel,
  rankCountries,
  resolveCountryStack,
} from "./followerCountry";

let n = 0;
function point(byCountry: Record<string, number> | null): FollowerDailyAddsPoint {
  n += 1;
  const day = `2026-07-${String(n).padStart(2, "0")}`;
  const total = byCountry ? Object.values(byCountry).reduce((s, v) => s + v, 0) : null;
  return {
    day,
    capturedAt: `${day}T23:00:00.000Z`,
    us: null,
    southAsian: null,
    anglosphere: null,
    other: null,
    total,
    unattributed: 0,
    byCountry,
    reportedTotalDelta: total,
    spanDays: byCountry ? 1 : null,
    stale: false,
    provisional: false,
    basis: byCountry ? "diff" : "no_snapshot",
  };
}

describe("rankCountries", () => {
  it("sums each country across points and ranks by absolute movement", () => {
    n = 0;
    const ranked = rankCountries([
      point({ US: 10, IN: 3, ZA: -20 }),
      point({ US: 15, IN: 2, ZA: -5 }),
    ]);
    // ZA is -25: a big loss outranks a smaller gain.
    expect(ranked.map((r) => r.code)).toEqual(["US", "ZA", "IN"]);
    expect(ranked[1]).toMatchObject({ code: "ZA", net: -25, movement: 25 });
  });

  it("ignores gap days with no country data", () => {
    n = 0;
    expect(rankCountries([point(null), point({ US: 5 })])).toEqual([
      { code: "US", net: 5, movement: 5 },
    ]);
  });

  it("breaks ties deterministically so renders don't reshuffle", () => {
    n = 0;
    const ranked = rankCountries([point({ GB: 5, AU: 5, CA: 5 })]);
    expect(ranked.map((r) => r.code)).toEqual(["AU", "CA", "GB"]);
  });
});

describe("colorMapFor", () => {
  it("assigns hues by overall rank", () => {
    n = 0;
    const colors = colorMapFor([point({ US: 100, IN: 50, GB: 40, ZA: 30 })]);
    expect(colors.get("US")).toBe(COUNTRY_PALETTE[0]);
    expect(colors.get("IN")).toBe(COUNTRY_PALETTE[1]);
  });

  it("does not repaint survivors when a filter changes the stack", () => {
    // The invariant that makes the filters trustworthy. The map is built ONCE
    // from the full dataset, so narrowing to a week where ZA outranks everything
    // changes which countries are stacked but never what colour any of them is.
    // Assigning by index into the range-scoped top-N would repaint them all.
    n = 0;
    const all = [
      point({ US: 100, IN: 50, GB: 40, ZA: 5, AU: 4, CA: 3, PK: 2, IE: 1 }),
      point({ ZA: 900, US: 5 }),
    ];
    const colors = colorMapFor(all);

    const wide = resolveCountryStack(rankCountries(all), colors, { topN: 3 });
    const narrow = resolveCountryStack(rankCountries([all[1]!]), colors, { topN: 3 });

    // Different membership...
    expect(wide.keys).not.toEqual(narrow.keys);
    // ...identical colours for every country present in both.
    for (const code of narrow.keys.filter((k) => wide.keys.includes(k))) {
      expect(colors.get(code)).toBe(colors.get(code));
    }
    // Across the whole dataset ZA totals 905 and US 105, so ZA is #1 overall and
    // holds hue 0 in BOTH views — including the wide one, where it ranks 4th on
    // the first day alone. Rank within a view never touches the colour.
    expect(colors.get("ZA")).toBe(COUNTRY_PALETTE[0]);
    expect(colors.get("US")).toBe(COUNTRY_PALETTE[1]);
  });

  it("gives a hue to at most the palette size", () => {
    n = 0;
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`C${String(i).padStart(2, "0")}`, 100 - i]),
    );
    expect(colorMapFor([point(many)]).size).toBe(MAX_COLORED_COUNTRIES);
  });

  it("assigns no duplicate hues", () => {
    n = 0;
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`C${String(i).padStart(2, "0")}`, 100 - i]),
    );
    const values = [...colorMapFor([point(many)]).values()];
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("resolveCountryStack", () => {
  const points = [
    point({ US: 633, IN: 226, GB: 164, AU: 125, CA: 114, ZA: 81, PK: 24, IE: 21 }),
  ];
  const ranked = rankCountries(points);
  const colors = colorMapFor(points);

  it("stacks the top N and folds the rest, biggest first", () => {
    const stack = resolveCountryStack(ranked, colors, { topN: 6 });
    expect(stack.keys).toEqual(["US", "IN", "GB", "AU", "CA", "ZA"]);
    expect(stack.otherCount).toBe(2); // PK, IE
    expect(stack.otherNet).toBe(45);
    expect(stack.hasOther).toBe(true);
  });

  it("surfaces South Africa as its own band rather than inside Rest of world", () => {
    // The finding that motivated country mode: ZA is the #6 market but is not in
    // ANGLOSPHERE, so region mode buries it in the grey band.
    expect(resolveCountryStack(ranked, colors, { topN: 6 }).keys).toContain("ZA");
  });

  it("includes a pinned country ranked below the cut", () => {
    const stack = resolveCountryStack(ranked, colors, { topN: 3, pinned: ["IE"] });
    expect(stack.keys).toContain("IE");
    expect(stack.keys).toHaveLength(3);
  });

  it("keeps stack order by movement regardless of pin order", () => {
    const stack = resolveCountryStack(ranked, colors, { topN: 3, pinned: ["IE", "US"] });
    expect(stack.keys.indexOf("US")).toBeLessThan(stack.keys.indexOf("IE"));
  });

  it("folds a muted country into Other", () => {
    const stack = resolveCountryStack(ranked, colors, { topN: 6, muted: ["US"] });
    expect(stack.keys).not.toContain("US");
    expect(stack.otherNet).toBeGreaterThan(600); // US's 633 landed in Other
  });

  it("folds a country with no stable colour even when pinned", () => {
    // Beyond the palette there is no hue left that isn't already another
    // country's, and cycling would make two countries share one colour.
    n = 0;
    const many = [
      point(
        Object.fromEntries(
          Array.from({ length: 12 }, (_, i) => [`C${String(i).padStart(2, "0")}`, 100 - i]),
        ),
      ),
    ];
    const stack = resolveCountryStack(rankCountries(many), colorMapFor(many), {
      topN: 6,
      pinned: ["C11"],
    });
    expect(stack.keys).not.toContain("C11");
  });

  it("reports no Other when everything is shown", () => {
    n = 0;
    const small = [point({ US: 10, IN: 5 })];
    const stack = resolveCountryStack(rankCountries(small), colorMapFor(small), { topN: 6 });
    expect(stack.hasOther).toBe(false);
    expect(stack.otherCount).toBe(0);
  });

  it("survives every country being muted", () => {
    const stack = resolveCountryStack(ranked, colors, {
      topN: 6,
      muted: ["US", "IN", "GB", "AU", "CA", "ZA", "PK", "IE"],
    });
    expect(stack.keys).toEqual([]);
    expect(stack.hasOther).toBe(true);
  });
});

describe("buildCountryStack", () => {
  it("accounts for the whole day: named countries plus Other equal the total", () => {
    // The bug this guards: without an Other series the bars drew only the named
    // countries while the legend printed an Other total, so a bar whose tooltip
    // said "+186 net" rendered 157 of it.
    n = 0;
    const p = point({ US: 53, IN: 45, AU: 19, GB: 20, CA: 11, ZA: 9, PK: 20, IE: 9 });
    const spec = buildCountryStack(["US", "IN", "AU", "GB", "CA", "ZA"], true);
    const drawn = spec.keys.reduce((sum, key) => sum + spec.valueOf(p, key), 0);
    expect(drawn).toBe(p.total);
  });

  it("puts exactly the unnamed countries in Other, per day", () => {
    n = 0;
    const p = point({ US: 10, ZZ: 3, YY: 4 });
    const spec = buildCountryStack(["US"], true);
    expect(spec.valueOf(p, OTHER_KEY)).toBe(7);
    expect(spec.keys).toEqual(["US", OTHER_KEY]);
  });

  it("omits the Other series entirely when nothing is folded", () => {
    expect(buildCountryStack(["US"], false).keys).toEqual(["US"]);
  });

  it("reads a gap day as zero rather than throwing", () => {
    n = 0;
    expect(buildCountryStack(["US"], true).valueOf(point(null), OTHER_KEY)).toBe(0);
  });
});

describe("countryLabel", () => {
  it("resolves ISO codes to names", () => {
    expect(countryLabel("ZA")).toBe("South Africa");
    expect(countryLabel("US")).toMatch(/United States/);
  });

  it("falls back to the raw code for an unknown one", () => {
    expect(countryLabel("XKCD")).toBe("XKCD");
  });
});
