export type UpcomingCaptionInstruction =
  | { kind: "matched"; keyword: string }
  | { kind: "missing" }
  | { kind: "ambiguous"; keywords: string[] };

// Match the first alphanumeric token after each literal `Comment` verb. A
// configured trigger list lets us recognize two-word phrases without mistaking
// ordinary CTA copy such as "Comment SLEEP to receive" for the keyword "SLEEP TO".
const COMMENT_INSTRUCTION =
  /\bcomment\b\s*[:\-]?\s*(["'“‘([{]*)\s*([A-Za-z0-9]+)\b/giu;

function normalizeKeyword(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function secondTokenAfter(caption: string, offset: number, quoted: boolean): string | null {
  const remainder = caption.slice(offset);
  const match = quoted
    ? remainder.match(/^\s+([A-Za-z0-9]+)\s*["'”’]/u)
    : remainder.match(/^\s+([A-Za-z0-9]+)\b/u);
  return match?.[1]?.toUpperCase() ?? null;
}

function resolveInstruction(
  first: string,
  second: string | null,
  quoted: boolean,
  knownKeywords: Set<string> | null,
): string {
  if (knownKeywords) {
    const phrase = second ? `${first} ${second}` : null;
    if (phrase && knownKeywords.has(phrase)) return phrase;

    const compactPhrase = second ? `${first}${second}` : null;
    const compactPhraseMatch = compactPhrase
      ? [...knownKeywords].find((keyword) => keyword.replace(/\s+/g, "") === compactPhrase)
      : undefined;
    if (compactPhraseMatch) return compactPhraseMatch;

    if (knownKeywords.has(first)) return first;

    const compactSingleMatch = [...knownKeywords].find(
      (keyword) => keyword.replace(/\s+/g, "") === first,
    );
    if (compactSingleMatch) return compactSingleMatch;
  }

  // Without a configured trigger to disambiguate, a multiword phrase must be
  // quoted. This preserves existing captions such as "Comment SLEEP now".
  return quoted && second ? `${first} ${second}` : first;
}

export function parseUpcomingCaptionInstruction(
  caption: string | null | undefined,
  expectedKeywords?: readonly string[],
): UpcomingCaptionInstruction {
  if (!caption) return { kind: "missing" };

  const knownKeywords = expectedKeywords
    ? new Set(expectedKeywords.map(normalizeKeyword))
    : null;
  const keywords = Array.from(caption.matchAll(COMMENT_INSTRUCTION), (match) => {
    const first = match[2]!.toUpperCase();
    const endOfFirst = match.index! + match[0].length;
    const opening = match[1]!;
    const quoted = /["'“‘]/u.test(opening);
    const second = secondTokenAfter(caption, endOfFirst, quoted);
    return resolveInstruction(first, second, quoted, knownKeywords);
  });

  if (keywords.length === 0) return { kind: "missing" };
  if (keywords.length > 1) return { kind: "ambiguous", keywords };
  return { kind: "matched", keyword: keywords[0]! };
}
