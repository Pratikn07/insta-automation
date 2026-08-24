import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Resvg } from "@resvg/resvg-js";
import { create as createFont, type Font } from "fontkit";

import {
  GUIDE_COVER_FONT_ASSETS,
  resolveGuideCoverFontPath,
  type GuideCoverFontFilename,
} from "../../shared/guideCoverAssets.js";
import type {
  GuideCoverRendition,
  GuideCoverRenderInput,
} from "../../shared/guideCoverPolicy.js";
import { GUIDE_COVER_RENDITION_FILENAMES } from "../../shared/guideCoverPolicy.js";
import {
  layoutGuideCover,
  renderGuideCoverSvg,
  type GuideCoverFontMetrics,
  type GuideCoverTextBlock,
  type GuideCoverTextMeasureInput,
} from "../../shared/guideCoverRenderer.js";

export const GUIDE_COVER_RENDERER_VERSION = "tinysoho-guide-cover-v1";

// Filenames live in shared/guideCoverPolicy.ts so this module and guideCoverStorage
// cannot disagree about where a rendition belongs.
const RENDITION_FILENAMES = GUIDE_COVER_RENDITION_FILENAMES;

interface LoadedGuideCoverFont {
  bytes: Buffer;
  filename: GuideCoverFontFilename;
  font: Font;
  path: string;
  sha256: string;
}

interface LoadedGuideCoverFonts {
  inter400: LoadedGuideCoverFont;
  inter600: LoadedGuideCoverFont;
  sourceSerif400: LoadedGuideCoverFont;
  sourceSerif600: LoadedGuideCoverFont;
}

export interface RenderedGuideCoverPng {
  contentHash: string;
  filename: string;
  height: number;
  png: Buffer;
  pngHash: string;
  rendition: GuideCoverRendition;
  rendererVersion: typeof GUIDE_COVER_RENDERER_VERSION;
  svg: string;
  width: number;
}

export type RenderGuideCoverPngResult =
  | { ok: true; value: RenderedGuideCoverPng }
  | {
      ok: false;
      error: {
        code:
          | "cover_invalid_input"
          | "cover_invalid_visual_key"
          | "cover_render_failed"
          | "cover_text_overflow";
        field?: string;
      };
    };

function isFont(value: ReturnType<typeof createFont>): value is Font {
  return "layout" in value && typeof value.layout === "function";
}

async function loadFont(
  filename: GuideCoverFontFilename,
): Promise<LoadedGuideCoverFont> {
  const asset = GUIDE_COVER_FONT_ASSETS.find(
    (candidate) => candidate.filename === filename,
  );
  if (!asset) throw new Error("guide_cover_font_not_registered");

  const path = resolveGuideCoverFontPath(filename);
  const bytes = await readFile(path);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== asset.sha256) {
    throw new Error("guide_cover_font_hash_mismatch");
  }

  const parsed = createFont(bytes);
  if (!isFont(parsed)) throw new Error("guide_cover_font_collection_unsupported");

  return { bytes, filename, font: parsed, path, sha256: asset.sha256 };
}

let loadedFontsPromise: Promise<LoadedGuideCoverFonts> | undefined;

function loadFonts(): Promise<LoadedGuideCoverFonts> {
  loadedFontsPromise ??= Promise.all([
    loadFont("inter-latin-400-normal.woff2"),
    loadFont("inter-latin-600-normal.woff2"),
    loadFont("source-serif-4-latin-400-normal.woff2"),
    loadFont("source-serif-4-latin-600-normal.woff2"),
  ]).then(([inter400, inter600, sourceSerif400, sourceSerif600]) => ({
    inter400,
    inter600,
    sourceSerif400,
    sourceSerif600,
  }));
  return loadedFontsPromise;
}

function selectFont(
  fonts: LoadedGuideCoverFonts,
  input: GuideCoverTextMeasureInput,
): LoadedGuideCoverFont {
  if (input.family === "Inter") {
    return input.fontWeight === 600 ? fonts.inter600 : fonts.inter400;
  }
  return input.fontWeight === 600
    ? fonts.sourceSerif600
    : fonts.sourceSerif400;
}

function createMetrics(fonts: LoadedGuideCoverFonts): GuideCoverFontMetrics {
  return {
    measureText(input) {
      const selected = selectFont(fonts, input);
      const glyphWidth =
        (selected.font.layout(input.text).advanceWidth * input.fontSize) /
        selected.font.unitsPerEm;
      return (
        glyphWidth +
        Math.max(0, [...input.text].length - 1) * input.letterSpacing
      );
    },
  };
}

function renderOutlinedText(
  fonts: LoadedGuideCoverFonts,
  block: GuideCoverTextBlock,
  color: string,
): string {
  const selected = selectFont(fonts, {
    family: block.family,
    fontSize: block.fontSize,
    fontWeight: block.fontWeight,
    letterSpacing: block.letterSpacing,
    text: "",
  });
  const scale = block.fontSize / selected.font.unitsPerEm;
  const paths: string[] = [];

  for (const [lineIndex, line] of block.lines.entries()) {
    const run = selected.font.layout(line);
    const lineWidth =
      run.advanceWidth * scale +
      Math.max(0, run.glyphs.length - 1) * block.letterSpacing;
    const lineStart =
      block.textAnchor === "end" ? block.x - lineWidth : block.x;
    const baseline = block.y + block.fontSize + lineIndex * block.lineHeight;
    let penX = 0;

    for (const [glyphIndex, glyph] of run.glyphs.entries()) {
      const position = run.positions[glyphIndex];
      if (!position) throw new Error("guide_cover_glyph_position_missing");
      const x =
        lineStart +
        (penX + position.xOffset) * scale +
        glyphIndex * block.letterSpacing;
      const y = baseline - position.yOffset * scale;
      paths.push(
        `<path d="${glyph.path.toSVG()}" transform="translate(${x} ${y}) scale(${scale} ${-scale})"/>`,
      );
      penX += position.xAdvance;
    }
  }

  return `<g fill="${color}">${paths.join("")}</g>`;
}

function contentHash(input: {
  fonts: LoadedGuideCoverFonts;
  normalizedInput: GuideCoverRenderInput;
  rendition: GuideCoverRendition;
  width: number;
  height: number;
}): string {
  const normalized = JSON.stringify({
    rendererVersion: GUIDE_COVER_RENDERER_VERSION,
    fontHashes: {
      inter400: input.fonts.inter400.sha256,
      inter600: input.fonts.inter600.sha256,
      sourceSerif400: input.fonts.sourceSerif400.sha256,
      sourceSerif600: input.fonts.sourceSerif600.sha256,
    },
    rendition: input.rendition,
    width: input.width,
    height: input.height,
    input: input.normalizedInput,
  });
  return createHash("sha256").update(normalized).digest("hex");
}

export async function renderGuideCoverPng(
  input: GuideCoverRenderInput,
  rendition: GuideCoverRendition,
): Promise<RenderGuideCoverPngResult> {
  try {
    const fonts = await loadFonts();
    const layout = layoutGuideCover(input, createMetrics(fonts), rendition);
    if (!layout.ok) return layout;

    const svg = renderGuideCoverSvg(
      layout.value,
      undefined,
      (block, color) => renderOutlinedText(fonts, block, color),
    );
    const resvg = new Resvg(svg, {
      fitTo: { mode: "original" },
      font: {
        defaultFontFamily: "Inter",
        fontFiles: [
          fonts.inter400.path,
          fonts.inter600.path,
          fonts.sourceSerif400.path,
          fonts.sourceSerif600.path,
        ],
        loadSystemFonts: false,
        sansSerifFamily: "Inter",
        serifFamily: "Source Serif 4",
      },
      shapeRendering: 2,
      textRendering: 2,
    });
    const rendered = resvg.render();
    const png = rendered.asPng();

    return {
      ok: true,
      value: {
        contentHash: contentHash({
          fonts,
          normalizedInput: layout.value.normalizedInput,
          rendition,
          width: rendered.width,
          height: rendered.height,
        }),
        filename: RENDITION_FILENAMES[rendition],
        height: rendered.height,
        png,
        pngHash: createHash("sha256").update(png).digest("hex"),
        rendition,
        rendererVersion: GUIDE_COVER_RENDERER_VERSION,
        svg,
        width: rendered.width,
      },
    };
  } catch {
    return { ok: false, error: { code: "cover_render_failed" } };
  }
}
