import { useEffect, useMemo, useState } from "react";

import {
  buildGuideCoverPreview,
  createBrowserGuideCoverMetrics,
} from "./guideCoverPreview";
import type { GuideCoverCopy, PresentationCategory } from "./types";

type PreviewAvailability = "loading" | "ready" | "unavailable";

const COVER_FONT_REQUESTS = [
  "400 16px Inter",
  "600 16px Inter",
  "400 16px 'Source Serif 4'",
  "600 16px 'Source Serif 4'",
] as const;

function previewErrorMessage(code: string, field: string): string {
  if (code === "cover_text_overflow") {
    return `${field} does not fit on this cover. Shorten it before saving.`;
  }

  return `${field} needs a valid value before this cover can be previewed.`;
}

export interface GuideCoverPreviewProps {
  category: PresentationCategory;
  copy: GuideCoverCopy;
  editionNumber: number;
}

export function GuideCoverPreview({
  category,
  copy,
  editionNumber,
}: GuideCoverPreviewProps) {
  const [availability, setAvailability] = useState<PreviewAvailability>(() => (
    typeof document !== "undefined" && document.fonts ? "loading" : "unavailable"
  ));

  useEffect(() => {
    let cancelled = false;
    const fonts = typeof document === "undefined" ? undefined : document.fonts;

    if (!fonts) return undefined;

    Promise.all(COVER_FONT_REQUESTS.map((request) => fonts.load(request)))
      .then(() => {
        if (!cancelled) setAvailability("ready");
      })
      .catch(() => {
        if (!cancelled) setAvailability("unavailable");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const result = useMemo(() => {
    if (availability !== "ready") return null;

    const metrics = createBrowserGuideCoverMetrics();
    return metrics ? buildGuideCoverPreview({ category, copy, editionNumber }, metrics) : null;
  }, [availability, category, copy, editionNumber]);

  if (availability === "loading") {
    return (
      <div className="guide-cover-preview" aria-busy="true" aria-live="polite">
        Preparing an exact cover preview…
      </div>
    );
  }

  if (availability === "unavailable" || !result) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Exact cover preview is unavailable because this browser cannot measure the cover fonts.
      </p>
    );
  }

  if (!result.ok) {
    return <p className="text-sm text-destructive" role="alert">{previewErrorMessage(result.error.code, result.error.field)}</p>;
  }

  return (
    <div
      className="guide-cover-preview"
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}
