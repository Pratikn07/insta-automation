export type UpcomingCaptionInstruction =
  | { kind: "matched"; keyword: string }
  | { kind: "missing" }
  | { kind: "ambiguous"; keywords: string[] };

// The CTA is intentionally narrow: one literal `Comment` verb followed by one
// ASCII letters-and-numbers token. Quotes and punctuation may decorate the
// token, but cannot become part of it.
const COMMENT_INSTRUCTION =
  /\bcomment\b\s*[:\-]?\s*["'“”‘’([{]*\s*([A-Za-z0-9]+)\b/giu;

export function parseUpcomingCaptionInstruction(
  caption: string | null | undefined,
): UpcomingCaptionInstruction {
  if (!caption) return { kind: "missing" };

  const keywords = Array.from(caption.matchAll(COMMENT_INSTRUCTION), (match) =>
    match[1]!.toUpperCase(),
  );

  if (keywords.length === 0) return { kind: "missing" };
  if (keywords.length > 1) return { kind: "ambiguous", keywords };
  return { kind: "matched", keyword: keywords[0]! };
}
