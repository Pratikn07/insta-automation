import { describe, expect, it } from "vitest";

import type { GuideCoverFontMetrics } from "@shared/guideCoverRenderer";

import { buildGuideCoverPreview } from "./guideCoverPreview";
import type { GuideCoverCopy, PresentationCategory } from "./types";

const category: PresentationCategory = {
  id: "10000000-0000-4000-8000-000000000001",
  slug: "bedtime",
  name: "Bedtime",
  collectionLabel: "SLEEP",
  defaultKicker: "A TINY WIN FOR TONIGHT",
  templateKey: "warm_editorial_corner_v1",
  paletteKey: "bedtime_blush_v1",
  illustrationKey: "bedtime_window_house_v1",
  designStatus: "ready",
  nextEditionNumber: 18,
  sortOrder: 1,
  createdBy: "creator@tinysoho.com",
  updatedBy: "creator@tinysoho.com",
  createdAt: "2026-08-22T12:00:00.000Z",
  updatedAt: "2026-08-22T12:00:00.000Z",
};

const copy: GuideCoverCopy = {
  headline: "Bedtime can feel softer",
  supportingLine: "A calmer bedtime, one small shift at a time.",
  closingLine: "Prepared for calmer evenings.",
  alternativeDescription: "A TinySoho bedtime guide cover.",
};

const fixedMetrics: GuideCoverFontMetrics = {
  measureText({ family, fontSize, letterSpacing, text }) {
    const factor = family === "Source Serif 4" ? 0.52 : 0.5;
    return (
      [...text].length * fontSize * factor +
      Math.max(0, [...text].length - 1) * letterSpacing
    );
  },
};

describe("buildGuideCoverPreview", () => {
  it("renders an approved category through the shared cover renderer", () => {
    const result = buildGuideCoverPreview({ category, copy, editionNumber: 1 }, fixedMetrics);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.svg).toContain('data-illustration="bedtime_window_house_v1"');
    expect(result.svg).toContain("Bedtime can feel softer");
  });

  it("returns a text overflow validation error instead of a truncated preview", () => {
    const result = buildGuideCoverPreview(
      { category, copy: { ...copy, headline: "W".repeat(40) }, editionNumber: 1 },
      fixedMetrics,
    );

    expect(result).toMatchObject({ ok: false, error: { code: "cover_text_overflow" } });
  });
});
