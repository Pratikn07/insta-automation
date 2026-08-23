import type {
  GuideCoverRendition,
  GuideCoverRenderInput,
  GuideCoverTextField,
} from "./guideCoverPolicy.js";
import {
  validateGuideCoverCategoryText,
  validateGuideCoverDraft,
  validateGuideCoverEdition,
} from "./guideCoverPolicy.js";
import {
  GUIDE_COVER_TEMPLATES,
  type GuideCoverCategory,
  validateGuideCoverVisualSelection,
} from "./guideCoverRegistry.js";

export interface GuideCoverTextMeasureInput {
  family: "Inter" | "Source Serif 4";
  fontSize: number;
  fontWeight: 400 | 600;
  letterSpacing: number;
  text: string;
}

export interface GuideCoverFontMetrics {
  measureText(input: GuideCoverTextMeasureInput): number;
}

export interface GuideCoverTextBlock {
  x: number;
  y: number;
  maxWidth: number;
  lines: string[];
  family: GuideCoverTextMeasureInput["family"];
  fontSize: number;
  fontWeight: GuideCoverTextMeasureInput["fontWeight"];
  letterSpacing: number;
  lineHeight: number;
  textAnchor: "start" | "end";
}

interface GuideCoverGeometry {
  cornerRadius: number;
  labelTop: number;
  leftInset: number;
  rightInset: number;
  headlineTop: number;
  supportTop: number;
  closingBottom: number;
  textRight: number;
  artwork: { x: number; y: number; width: number; height: number };
}

export interface GuideCoverLayout {
  canvas: { width: number; height: number };
  rendition: GuideCoverRendition;
  normalizedInput: GuideCoverRenderInput;
  editionLabel: string;
  category: GuideCoverCategory;
  geometry: GuideCoverGeometry;
  text: {
    kicker: GuideCoverTextBlock;
    collectionLabel: GuideCoverTextBlock;
    headline: GuideCoverTextBlock;
    supportingLine: GuideCoverTextBlock;
    closingLine: GuideCoverTextBlock;
  };
}

export interface GuideCoverFontFaces {
  inter400: string;
  inter600: string;
  sourceSerif400: string;
  sourceSerif600: string;
}

export type GuideCoverSvgTextRenderer = (
  block: GuideCoverTextBlock,
  color: string,
) => string;

export type GuideCoverLayoutResult =
  | { ok: true; value: GuideCoverLayout }
  | {
      ok: false;
      error: {
        code:
          | "cover_invalid_input"
          | "cover_invalid_visual_key"
          | "cover_text_overflow";
        field: string;
      };
    };

const TYPOGRAPHY = {
  kicker: {
    family: "Inter",
    fontSize: 24,
    fontWeight: 600,
    letterSpacing: 5,
    lineHeight: 31,
  },
  collectionLabel: {
    family: "Inter",
    fontSize: 24,
    fontWeight: 600,
    letterSpacing: 4,
    lineHeight: 31,
  },
  headline: {
    family: "Source Serif 4",
    fontSize: 76,
    fontWeight: 600,
    letterSpacing: 0,
    lineHeight: 78,
  },
  supportingLine: {
    family: "Inter",
    fontSize: 34,
    fontWeight: 400,
    letterSpacing: 0,
    lineHeight: 45,
  },
  closingLine: {
    family: "Source Serif 4",
    fontSize: 40,
    fontWeight: 600,
    letterSpacing: 0,
    lineHeight: 48,
  },
} as const satisfies Record<
  Exclude<GuideCoverTextField, "alternativeDescription">,
  Omit<GuideCoverTextBlock, "x" | "y" | "maxWidth" | "lines" | "textAnchor">
>;

function renditionGeometry(
  templateKey: keyof typeof GUIDE_COVER_TEMPLATES,
  rendition: GuideCoverRendition,
): { canvas: { width: number; height: number }; geometry: GuideCoverGeometry } {
  const template = GUIDE_COVER_TEMPLATES[templateKey];
  if (rendition === "dm_cover") {
    return {
      canvas: { width: 1200, height: 916 },
      geometry: { ...template, artwork: { ...template.artwork } },
    };
  }

  const rightPanel = templateKey === "editorial_right_panel_v1";
  return {
    canvas: { width: 1200, height: 628 },
    geometry: {
      ...template,
      labelTop: 47,
      headlineTop: 126,
      supportTop: 355,
      closingBottom: 50,
      artwork: rightPanel
        ? { x: 804, y: 0, width: 396, height: 628 }
        : { x: 720, y: 258, width: 480, height: 370 },
    },
  };
}

function measure(
  metrics: GuideCoverFontMetrics,
  typography: (typeof TYPOGRAPHY)[keyof typeof TYPOGRAPHY],
  text: string,
): number {
  return metrics.measureText({ ...typography, text });
}

function wrapText(input: {
  field: Exclude<GuideCoverTextField, "alternativeDescription">;
  maxLines: number;
  maxWidth: number;
  metrics: GuideCoverFontMetrics;
  text: string;
}):
  | { ok: true; lines: string[] }
  | {
      ok: false;
      error: { code: "cover_text_overflow"; field: GuideCoverTextField };
    } {
  const typography = TYPOGRAPHY[input.field];
  const words = input.text.split(" ");
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    if (measure(input.metrics, typography, word) > input.maxWidth) {
      return {
        ok: false,
        error: { code: "cover_text_overflow", field: input.field },
      };
    }

    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (measure(input.metrics, typography, candidate) <= input.maxWidth) {
      line = candidate;
      continue;
    }

    lines.push(line);
    line = word;
    if (lines.length >= input.maxLines) {
      return {
        ok: false,
        error: { code: "cover_text_overflow", field: input.field },
      };
    }
  }

  if (line.length > 0) lines.push(line);
  if (lines.length > input.maxLines) {
    return {
      ok: false,
      error: { code: "cover_text_overflow", field: input.field },
    };
  }

  return { ok: true, lines };
}

export function layoutGuideCover(
  input: GuideCoverRenderInput,
  fontMetrics: GuideCoverFontMetrics,
  rendition: GuideCoverRendition,
): GuideCoverLayoutResult {
  const visualSelection = validateGuideCoverVisualSelection(input);
  if (!visualSelection.ok) return visualSelection;

  const draft = validateGuideCoverDraft(input);
  if (!draft.ok) {
    return {
      ok: false,
      error: { code: draft.error.code, field: draft.error.field },
    };
  }

  const categoryText = validateGuideCoverCategoryText(input);
  if (!categoryText.ok) {
    return {
      ok: false,
      error: { code: categoryText.error.code, field: categoryText.error.field },
    };
  }

  const edition = validateGuideCoverEdition(input.editionNumber);
  if (!edition.ok) {
    return {
      ok: false,
      error: { code: edition.error.code, field: edition.error.field },
    };
  }

  const { canvas, geometry } = renditionGeometry(
    visualSelection.value.templateKey,
    rendition,
  );
  const isCorner = visualSelection.value.artworkPlacement === "corner";
  const leftWidth = geometry.textRight - geometry.leftInset;
  const headlineWidth = leftWidth;
  const lowerTextWidth = isCorner
    ? geometry.artwork.x - geometry.leftInset - 80
    : leftWidth;
  const editionLabel = `${categoryText.value.collectionLabel} · ${String(
    edition.value,
  ).padStart(2, "0")}`;

  const wrapRequests = {
    kicker: {
      field: "kicker",
      text: categoryText.value.kicker,
      maxLines: 1,
      maxWidth: Math.min(520, leftWidth),
    },
    collectionLabel: {
      field: "collectionLabel",
      text: editionLabel,
      maxLines: 1,
      maxWidth: 360,
    },
    headline: {
      field: "headline",
      text: draft.value.headline,
      maxLines: 2,
      maxWidth: headlineWidth,
    },
    supportingLine: {
      field: "supportingLine",
      text: draft.value.supportingLine,
      maxLines: 2,
      maxWidth: lowerTextWidth,
    },
    closingLine: {
      field: "closingLine",
      text: draft.value.closingLine,
      maxLines: 2,
      maxWidth: lowerTextWidth,
    },
  } as const;

  const wrapped = {} as Record<keyof typeof wrapRequests, string[]>;
  for (const [key, request] of Object.entries(wrapRequests) as Array<
    [keyof typeof wrapRequests, (typeof wrapRequests)[keyof typeof wrapRequests]]
  >) {
    const result = wrapText({ ...request, metrics: fontMetrics });
    if (!result.ok) return result;
    wrapped[key] = result.lines;
  }

  const normalizedInput: GuideCoverRenderInput = {
    ...input,
    ...draft.value,
    ...categoryText.value,
    editionNumber: edition.value,
  };

  const makeBlock = (
    field: keyof typeof wrapRequests,
    x: number,
    y: number,
    maxWidth: number,
    textAnchor: "start" | "end" = "start",
  ): GuideCoverTextBlock => ({
    x,
    y,
    maxWidth,
    lines: wrapped[field],
    ...TYPOGRAPHY[field],
    textAnchor,
  });

  const closingHeight =
    wrapped.closingLine.length * TYPOGRAPHY.closingLine.lineHeight;

  return {
    ok: true,
    value: {
      canvas,
      rendition,
      normalizedInput,
      editionLabel,
      category: visualSelection.value,
      geometry,
      text: {
        kicker: makeBlock(
          "kicker",
          geometry.leftInset,
          geometry.labelTop,
          wrapRequests.kicker.maxWidth,
        ),
        collectionLabel: makeBlock(
          "collectionLabel",
          canvas.width - geometry.rightInset,
          geometry.labelTop,
          wrapRequests.collectionLabel.maxWidth,
          "end",
        ),
        headline: makeBlock(
          "headline",
          geometry.leftInset,
          geometry.headlineTop,
          headlineWidth,
        ),
        supportingLine: makeBlock(
          "supportingLine",
          geometry.leftInset,
          geometry.supportTop,
          lowerTextWidth,
        ),
        closingLine: makeBlock(
          "closingLine",
          geometry.leftInset,
          canvas.height - geometry.closingBottom - closingHeight,
          lowerTextWidth,
        ),
      },
    },
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function textSvg(block: GuideCoverTextBlock, color: string): string {
  const anchor = block.textAnchor === "end" ? ' text-anchor="end"' : "";
  const spans = block.lines
    .map((line, index) => {
      const y = block.y + block.fontSize + index * block.lineHeight;
      return `<tspan x="${block.x}" y="${y}">${escapeXml(line)}</tspan>`;
    })
    .join("");
  return `<text fill="${color}" font-family="${block.family}" font-size="${block.fontSize}" font-weight="${block.fontWeight}" letter-spacing="${block.letterSpacing}"${anchor}>${spans}</text>`;
}

function fontFaceCss(fontFaces?: GuideCoverFontFaces): string {
  if (!fontFaces) return "";
  const face = (
    family: string,
    weight: number,
    source: string,
  ): string =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url('${source}') format('woff2')}`;
  return [
    face("Inter", 400, fontFaces.inter400),
    face("Inter", 600, fontFaces.inter600),
    face("Source Serif 4", 400, fontFaces.sourceSerif400),
    face("Source Serif 4", 600, fontFaces.sourceSerif600),
  ].join("");
}

function bedtimeArtwork(layout: GuideCoverLayout): string {
  const { x, y, width, height } = layout.geometry.artwork;
  const c = layout.category.renderColors;
  return `<g data-illustration="bedtime_window_house_v1">
    <path d="M ${x} ${y + height} L ${x + width} ${y + 70} L ${x + width} ${y + height} Z" fill="${c.surface}"/>
    <path d="M ${x + 95} ${y + height} V ${y + 250} A 145 145 0 0 1 ${x + 385} ${y + 250} V ${y + height} Z" fill="${c.artPrimary}"/>
    <circle cx="${x + 330}" cy="${y + 295}" r="52" fill="${c.surface}"/>
    <circle cx="${x + 351}" cy="${y + 276}" r="52" fill="${c.artPrimary}"/>
    <path d="M ${x} ${y + 475} Q ${x + 120} ${y + 420} ${x + 250} ${y + 470} T ${x + width} ${y + 452} V ${y + height} H ${x} Z" fill="${c.artSecondary}"/>
    <path d="M ${x + 205} ${y + 405} L ${x + 280} ${y + 343} L ${x + 355} ${y + 405} V ${y + 505} H ${x + 205} Z" fill="${c.surface}"/>
    <path d="M ${x + 198} ${y + 408} L ${x + 280} ${y + 338} L ${x + 362} ${y + 408}" fill="none" stroke="${c.ink}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="${x + 266}" y="${y + 433}" width="28" height="72" rx="4" fill="${c.accent}"/>
    <path d="M ${x} ${y + 505} Q ${x + 155} ${y + 462} ${x + 315} ${y + 510} T ${x + width} ${y + 492} V ${y + height} H ${x} Z" fill="${c.artSecondary}" opacity="0.72"/>
    <circle cx="${x + 166}" cy="${y + 260}" r="8" fill="${c.surface}"/><path d="M ${x + 165} ${y + 220} v 32 M ${x + 149} ${y + 236} h 32" stroke="${c.surface}" stroke-width="8" stroke-linecap="round"/>
  </g>`;
}

function pottyArtwork(layout: GuideCoverLayout): string {
  const { x, y, width, height } = layout.geometry.artwork;
  const c = layout.category.renderColors;
  return `<g data-illustration="potty_sunlit_ritual_v1">
    <path d="M ${x} ${y + height} L ${x + width} ${y + 84} L ${x + width} ${y + height} Z" fill="${c.surface}"/>
    <path d="M ${x + 140} ${y + height} V ${y + 230} A 145 145 0 0 1 ${x + 430} ${y + 230} V ${y + height} Z" fill="${c.accent}" opacity="0.82"/>
    <circle cx="${x + 365}" cy="${y + 210}" r="72" fill="${c.artPrimary}"/>
    <rect x="${x + 205}" y="${y + 390}" width="210" height="22" rx="11" fill="${c.ink}" opacity="0.72"/>
    <rect x="${x + 236}" y="${y + 330}" width="126" height="60" rx="12" fill="${c.surface}"/>
    <path d="M ${x + 255} ${y + 350} H ${x + 342}" stroke="${c.artPrimary}" stroke-width="8" stroke-linecap="round"/>
    <path d="M ${x + 135} ${y + 390} C ${x + 95} ${y + 330}, ${x + 115} ${y + 275}, ${x + 175} ${y + 260} C ${x + 205} ${y + 320}, ${x + 195} ${y + 365}, ${x + 160} ${y + 397}" fill="${c.artSecondary}"/>
    <rect x="${x + 132}" y="${y + 385}" width="48" height="63" rx="8" fill="${c.artPrimary}"/>
    <circle cx="${x + 236}" cy="${y + 468}" r="11" fill="${c.artSecondary}"/><circle cx="${x + 278}" cy="${y + 468}" r="11" fill="${c.artPrimary}"/><circle cx="${x + 320}" cy="${y + 468}" r="11" fill="${c.ink}" opacity="0.7"/>
  </g>`;
}

function recipeArtwork(layout: GuideCoverLayout): string {
  const { x, y, width, height } = layout.geometry.artwork;
  const c = layout.category.renderColors;
  return `<g data-illustration="recipes_corner_bowl_v1">
    <path d="M ${x} ${y + height} L ${x + width} ${y + 80} L ${x + width} ${y + height} Z" fill="${c.surface}"/>
    <ellipse cx="${x + 322}" cy="${y + 376}" rx="166" ry="58" fill="${c.artPrimary}"/>
    <path d="M ${x + 156} ${y + 376} Q ${x + 181} ${y + 515} ${x + 322} ${y + 515} Q ${x + 463} ${y + 515} ${x + 488} ${y + 376} Z" fill="${c.artPrimary}"/>
    <ellipse cx="${x + 322}" cy="${y + 368}" rx="142" ry="38" fill="${c.surface}"/>
    <path d="M ${x + 115} ${y + 260} Q ${x + 195} ${y + 315} ${x + 235} ${y + 354}" fill="none" stroke="${c.ink}" stroke-width="13" stroke-linecap="round"/>
    <ellipse cx="${x + 102}" cy="${y + 247}" rx="28" ry="48" transform="rotate(-44 ${x + 102} ${y + 247})" fill="${c.accent}"/>
    <path d="M ${x + 355} ${y + 283} C ${x + 330} ${y + 230}, ${x + 378} ${y + 205}, ${x + 401} ${y + 260} C ${x + 425} ${y + 210}, ${x + 476} ${y + 242}, ${x + 435} ${y + 302}" fill="${c.artSecondary}"/>
    <circle cx="${x + 275}" cy="${y + 367}" r="18" fill="${c.artSecondary}"/><circle cx="${x + 329}" cy="${y + 362}" r="20" fill="${c.accent}"/><circle cx="${x + 382}" cy="${y + 370}" r="16" fill="${c.artSecondary}"/>
  </g>`;
}

function montessoriArtwork(layout: GuideCoverLayout): string {
  const { x, y, width, height } = layout.geometry.artwork;
  const c = layout.category.renderColors;
  return `<g data-illustration="discovery_tray_right_v1">
    <rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${c.accent}"/>
    <circle cx="${x + width - 22}" cy="${y + 105}" r="144" fill="${c.surface}" opacity="0.6"/>
    <rect x="${x + 58}" y="${y + 285}" width="${width - 116}" height="290" rx="35" fill="${c.artPrimary}"/>
    <rect x="${x + 83}" y="${y + 310}" width="${width - 166}" height="240" rx="25" fill="${c.surface}"/>
    <circle cx="${x + 145}" cy="${y + 386}" r="38" fill="${c.artSecondary}"/>
    <path d="M ${x + 225} ${y + 350} L ${x + 277} ${y + 438} H ${x + 173} Z" fill="${c.ink}" opacity="0.82"/>
    <rect x="${x + 118}" y="${y + 462}" width="66" height="66" rx="14" fill="${c.accent}"/>
    <rect x="${x + 215}" y="${y + 466}" width="62" height="62" rx="31" fill="${c.artPrimary}"/>
    <path d="M ${x + 40} ${y + 680} Q ${x + 145} ${y + 610} ${x + width} ${y + 665}" fill="none" stroke="${c.artSecondary}" stroke-width="34" stroke-linecap="round"/>
    <circle cx="${x + 104}" cy="${y + 205}" r="12" fill="${c.surface}"/><path d="M ${x + 168} ${y + 152} v 44 M ${x + 146} ${y + 174} h 44" stroke="${c.surface}" stroke-width="10" stroke-linecap="round"/>
  </g>`;
}

function illustrationSvg(layout: GuideCoverLayout): string {
  switch (layout.category.illustrationKey) {
    case "bedtime_window_house_v1":
      return bedtimeArtwork(layout);
    case "potty_sunlit_ritual_v1":
      return pottyArtwork(layout);
    case "recipes_corner_bowl_v1":
      return recipeArtwork(layout);
    case "discovery_tray_right_v1":
      return montessoriArtwork(layout);
  }
}

export function renderGuideCoverSvg(
  layout: GuideCoverLayout,
  fontFaces?: GuideCoverFontFaces,
  textRenderer: GuideCoverSvgTextRenderer = textSvg,
): string {
  const { canvas, category, geometry, text } = layout;
  const c = category.renderColors;
  const clipId = "tinysoho-card-clip";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" role="img" aria-label="${escapeXml(layout.normalizedInput.alternativeDescription)}">
  <defs><clipPath id="${clipId}"><rect width="${canvas.width}" height="${canvas.height}" rx="${geometry.cornerRadius}"/></clipPath><style>${fontFaceCss(fontFaces)}</style></defs>
  <g clip-path="url(#${clipId})">
    <rect width="${canvas.width}" height="${canvas.height}" fill="${c.background}"/>
    ${illustrationSvg(layout)}
    ${textRenderer(text.kicker, c.ink)}
    ${textRenderer(text.collectionLabel, c.ink)}
    ${textRenderer(text.headline, c.ink)}
    ${textRenderer(text.supportingLine, c.ink)}
    ${textRenderer(text.closingLine, c.ink)}
  </g>
</svg>`;
}
