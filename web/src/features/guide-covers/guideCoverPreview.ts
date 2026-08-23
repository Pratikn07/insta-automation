import {
  layoutGuideCover,
  renderGuideCoverSvg,
  type GuideCoverFontMetrics,
  type GuideCoverLayoutResult,
} from "@shared/guideCoverRenderer";

import type { GuideCoverCopy, PresentationCategory } from "./types";

export interface GuideCoverPreviewInput {
  category: PresentationCategory;
  copy: GuideCoverCopy;
  editionNumber: number;
}

export type GuideCoverPreviewResult =
  | {
      ok: true;
      svg: string;
      layout: Extract<GuideCoverLayoutResult, { ok: true }>["value"];
    }
  | Extract<GuideCoverLayoutResult, { ok: false }>;

export function buildGuideCoverPreview(
  input: GuideCoverPreviewInput,
  metrics: GuideCoverFontMetrics,
): GuideCoverPreviewResult {
  const layout = layoutGuideCover(
    {
      categorySlug: input.category.slug,
      editionNumber: input.editionNumber,
      kicker: input.category.defaultKicker,
      collectionLabel: input.category.collectionLabel,
      templateKey: input.category.templateKey,
      paletteKey: input.category.paletteKey,
      illustrationKey: input.category.illustrationKey,
      ...input.copy,
    },
    metrics,
    "dm_cover",
  );

  return layout.ok
    ? { ok: true, svg: renderGuideCoverSvg(layout.value), layout: layout.value }
    : layout;
}

/**
 * Returns null when this environment cannot use a browser canvas. Callers must
 * show that the preview is unavailable rather than presenting unmeasured text.
 */
export function createBrowserGuideCoverMetrics(): GuideCoverFontMetrics | null {
  if (typeof document === "undefined") return null;

  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;

  return {
    measureText({ family, fontSize, fontWeight, letterSpacing, text }) {
      context.font = `${fontWeight} ${fontSize}px "${family}"`;
      const characters = [...text];
      return (
        context.measureText(text).width +
        Math.max(0, characters.length - 1) * letterSpacing
      );
    },
  };
}
