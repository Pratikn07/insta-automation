export const GUIDE_COVER_TEMPLATES = {
  warm_editorial_corner_v1: {
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
  },
  editorial_right_panel_v1: {
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
  },
} as const;

export const GUIDE_COVER_CATEGORIES = {
  bedtime: {
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
    renderColors: {
      background: "#F5DFDA",
      surface: "#FBF4E6",
      ink: "#6A3446",
      artPrimary: "#C9BFD8",
      artSecondary: "#B9C3A4",
      accent: "#E58C7D",
    },
    artworkPlacement: "corner",
    exampleCopy: {
      headline: "Bedtime can feel softer",
      supportingLine: "A calmer bedtime, one small shift at a time.",
      closingLine: "Made with care by TinySoho.",
      alternativeDescription:
        "Blush TinySoho sleep guide cover with a moonlit house illustration.",
    },
  },
  "potty-training": {
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
    renderColors: {
      background: "#F3E5DC",
      surface: "#FFF8EE",
      ink: "#604139",
      artPrimary: "#E0B49C",
      artSecondary: "#B5C1A8",
      accent: "#D4C9D8",
    },
    artworkPlacement: "corner",
    imageryExclusions: [
      "toilet",
      "potty",
      "stool",
      "underwear",
      "bodily-fluid",
      "clinical",
    ],
    exampleCopy: {
      headline: "Ready in their own time",
      supportingLine: "Simple routines for growing confidence, without pressure.",
      closingLine: "Made with care by TinySoho.",
      alternativeDescription:
        "Warm TinySoho potty-training guide cover with sunlight, a folded towel and a plant.",
    },
  },
  recipes: {
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
    renderColors: {
      background: "#F7EFE4",
      surface: "#F5E4B6",
      ink: "#663B45",
      artPrimary: "#DF9173",
      artSecondary: "#AEB995",
      accent: "#C9BFD8",
    },
    artworkPlacement: "corner",
    photographRequired: false,
    exampleCopy: {
      headline: "Something lovely for lunch",
      supportingLine: "Simple, nourishing food for busy family days.",
      closingLine: "Made with care by TinySoho.",
      alternativeDescription:
        "Cream TinySoho recipe guide cover with an illustrated bowl and spoon.",
    },
  },
  "montessori-activities": {
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
    renderColors: {
      background: "#F1E5DC",
      surface: "#FFF8EE",
      ink: "#5A3C4D",
      artPrimary: "#D7AA7F",
      artSecondary: "#AEBD9F",
      accent: "#C9BED8",
    },
    artworkPlacement: "right",
    exampleCopy: {
      headline: "Little hands, growing minds",
      supportingLine: "A calm invitation to focus, coordinate and discover.",
      closingLine: "Made with care by TinySoho.",
      alternativeDescription:
        "Blush TinySoho activity guide cover with a discovery tray on a structured right panel.",
    },
  },
} as const;

export type GuideCoverCategorySlug = keyof typeof GUIDE_COVER_CATEGORIES;
export type GuideCoverCategory =
  (typeof GUIDE_COVER_CATEGORIES)[GuideCoverCategorySlug];
export type GuideCoverTemplateKey = keyof typeof GUIDE_COVER_TEMPLATES;

export function getGuideCoverCategory(
  categorySlug: string,
): GuideCoverCategory | undefined {
  if (!Object.prototype.hasOwnProperty.call(GUIDE_COVER_CATEGORIES, categorySlug)) {
    return undefined;
  }

  return GUIDE_COVER_CATEGORIES[categorySlug as GuideCoverCategorySlug];
}

type VisualField =
  | "categorySlug"
  | "templateKey"
  | "paletteKey"
  | "illustrationKey";

export type GuideCoverVisualValidationResult =
  | { ok: true; value: GuideCoverCategory }
  | {
      ok: false;
      error: { code: "cover_invalid_visual_key"; field: VisualField };
    };

export function validateGuideCoverVisualSelection(input: {
  categorySlug: string;
  templateKey: string;
  paletteKey: string;
  illustrationKey: string;
}): GuideCoverVisualValidationResult {
  const category = getGuideCoverCategory(input.categorySlug);
  if (!category) {
    return {
      ok: false,
      error: { code: "cover_invalid_visual_key", field: "categorySlug" },
    };
  }

  for (const field of [
    "templateKey",
    "paletteKey",
    "illustrationKey",
  ] as const) {
    if (input[field] !== category[field]) {
      return {
        ok: false,
        error: { code: "cover_invalid_visual_key", field },
      };
    }
  }

  return { ok: true, value: category };
}
