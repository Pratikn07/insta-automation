import { describe, expect, it } from "vitest";

import {
  GUIDE_COVER_CATEGORIES,
  GUIDE_COVER_TEMPLATES,
  getGuideCoverCategory,
  validateGuideCoverVisualSelection,
} from "./guideCoverRegistry.js";

describe("approved TinySoho guide cover registry", () => {
  it("contains exactly the four owner-approved categories", () => {
    expect(Object.keys(GUIDE_COVER_CATEGORIES)).toEqual([
      "bedtime",
      "potty-training",
      "recipes",
      "montessori-activities",
    ]);
  });

  it("pins Bedtime — Warm editorial", () => {
    expect(GUIDE_COVER_CATEGORIES.bedtime).toMatchObject({
      categorySlug: "bedtime",
      name: "Bedtime",
      defaultKicker: "A TINY WIN FOR TONIGHT",
      collectionLabel: "SLEEP",
      templateKey: "warm_editorial_corner_v1",
      paletteKey: "bedtime_blush_v1",
      illustrationKey: "bedtime_window_house_v1",
      palette: {
        blush: "#F5DFDA",
        cream: "#FBF4E6",
        lavender: "#C9BFD8",
        sage: "#B9C3A4",
        berry: "#6A3446",
        softCoral: "#E58C7D",
      },
    });
  });

  it("pins Potty Training — Sunlit ritual and its exclusions", () => {
    expect(GUIDE_COVER_CATEGORIES["potty-training"]).toMatchObject({
      categorySlug: "potty-training",
      name: "Potty Training",
      defaultKicker: "A LITTLE STEP FOR TODAY",
      collectionLabel: "POTTY",
      templateKey: "warm_editorial_corner_v1",
      paletteKey: "potty_sunlit_v1",
      illustrationKey: "potty_sunlit_ritual_v1",
      palette: {
        warmBlush: "#F3E5DC",
        apricot: "#E0B49C",
        sage: "#B5C1A8",
        lavenderGrey: "#D4C9D8",
        brown: "#604139",
        cream: "#FFF8EE",
      },
      imageryExclusions: [
        "toilet",
        "potty",
        "stool",
        "underwear",
        "bodily-fluid",
        "clinical",
      ],
    });
  });

  it("pins Recipes — Corner table", () => {
    expect(GUIDE_COVER_CATEGORIES.recipes).toMatchObject({
      categorySlug: "recipes",
      name: "Recipes",
      defaultKicker: "A LITTLE WIN AT THE TABLE",
      collectionLabel: "RECIPES",
      templateKey: "warm_editorial_corner_v1",
      paletteKey: "recipes_corner_table_v1",
      illustrationKey: "recipes_corner_bowl_v1",
      palette: {
        butter: "#F5E4B6",
        apricot: "#DF9173",
        sage: "#AEB995",
        cream: "#F7EFE4",
        berry: "#663B45",
        lavenderAccent: "#C9BFD8",
      },
      photographRequired: false,
    });
  });

  it("pins Montessori discovery tray to the right-side composition", () => {
    expect(GUIDE_COVER_CATEGORIES["montessori-activities"]).toMatchObject({
      categorySlug: "montessori-activities",
      name: "Montessori-inspired Activities",
      defaultKicker: "PURPOSEFUL PLAY FOR TODAY",
      collectionLabel: "LEARNING",
      templateKey: "editorial_right_panel_v1",
      paletteKey: "montessori_discovery_v1",
      illustrationKey: "discovery_tray_right_v1",
      palette: {
        blush: "#F1E5DC",
        naturalWood: "#D7AA7F",
        sage: "#AEBD9F",
        lavender: "#C9BED8",
        berry: "#5A3C4D",
        cream: "#FFF8EE",
      },
      artworkPlacement: "right",
    });
  });

  it("pins the shared safe areas for both approved compositions", () => {
    expect(GUIDE_COVER_TEMPLATES.warm_editorial_corner_v1).toEqual({
      key: "warm_editorial_corner_v1",
      cornerRadius: 44,
      labelTop: 69,
      leftInset: 84,
      rightInset: 84,
      headlineTop: 192,
      supportTop: 467,
      closingBottom: 82,
      textRight: 1116,
      artwork: { x: 684, y: 385, width: 516, height: 531 },
    });
    expect(GUIDE_COVER_TEMPLATES.editorial_right_panel_v1).toEqual({
      key: "editorial_right_panel_v1",
      cornerRadius: 44,
      labelTop: 69,
      leftInset: 84,
      rightInset: 84,
      headlineTop: 192,
      supportTop: 467,
      closingBottom: 82,
      textRight: 696,
      artwork: { x: 804, y: 0, width: 396, height: 916 },
    });
  });

  it("fails closed for unknown or category-mismatched visual keys", () => {
    expect(getGuideCoverCategory("feeding")).toBeUndefined();
    expect(
      validateGuideCoverVisualSelection({
        categorySlug: "bedtime",
        templateKey: "editorial_right_panel_v1",
        paletteKey: "bedtime_blush_v1",
        illustrationKey: "bedtime_window_house_v1",
      }),
    ).toEqual({
      ok: false,
      error: { code: "cover_invalid_visual_key", field: "templateKey" },
    });
    expect(
      validateGuideCoverVisualSelection({
        categorySlug: "unknown",
        templateKey: "warm_editorial_corner_v1",
        paletteKey: "bedtime_blush_v1",
        illustrationKey: "bedtime_window_house_v1",
      }),
    ).toEqual({
      ok: false,
      error: { code: "cover_invalid_visual_key", field: "categorySlug" },
    });
  });
});
