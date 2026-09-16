import type { DmMessageType } from "@prisma/client";

export type ResolvedDmKeyword<T> = {
  keyword: T;
  matchedToken: string;
  tokenPosition: number;
  inferredFromPost: string | null;
};

type IntentCounts = {
  meaningfulTokenCount: number;
  keywordHitCount: number;
  distinctGuideCount: number;
};

export type DmKeywordIntent<T> =
  | (IntentCounts & {
      kind: "accepted_short" | "accepted_explicit";
      selected: ResolvedDmKeyword<T>;
    })
  | (IntentCounts & {
      kind: "rejected_negative" | "rejected_conversational" | "no_keyword";
    });

export type OpenRequestReplyIntent =
  | { kind: "accepted_confirmation" }
  | { kind: "rejected_reply"; reason: "non_text" | "blank_text" | "unrecognized_text" };

const REQUEST_SIGNALS = new Set(["SEND", "SHARE", "GET", "GIVE", "WANT", "NEED"]);

const REQUEST_PHRASES = [
  ["CAN", "I", "HAVE"],
  ["COULD", "I", "HAVE"],
  ["I", "WOULD", "LIKE"],
  ["ID", "LIKE"],
] as const;

const NEGATIVE_PHRASES = [
  ["DO", "NOT", "SEND"],
  ["DONT", "SEND"],
  ["NO", "NEED", "TO", "SEND"],
  ["I", "DO", "NOT", "WANT"],
  ["I", "DONT", "WANT"],
] as const;

const CONFIRMATION_PHRASES = new Set([
  "YES",
  "YES PLEASE",
  "PLEASE SEND",
  "SEND",
  "SEND IT",
  "SEND IT PLEASE",
  "DONE",
  "FOLLOWED",
  "I FOLLOWED",
  "I AM FOLLOWING",
  "IM FOLLOWING",
  "READY",
]);

function containsPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - phrase.length; start += 1) {
    if (phrase.every((token, offset) => tokens[start + offset] === token)) return true;
  }
  return false;
}

function intentCounts<T extends { resource: { id: string } }>(
  meaningfulTokens: readonly string[],
  matches: readonly ResolvedDmKeyword<T>[],
): IntentCounts {
  return {
    meaningfulTokenCount: meaningfulTokens.length,
    keywordHitCount: matches.length,
    distinctGuideCount: new Set(matches.map((match) => match.keyword.resource.id)).size,
  };
}

export function classifyDmKeywordIntent<T extends { resource: { id: string } }>(
  meaningfulTokens: readonly string[],
  matches: readonly ResolvedDmKeyword<T>[],
): DmKeywordIntent<T> {
  const counts = intentCounts(meaningfulTokens, matches);
  if (matches.length === 0) return { kind: "no_keyword", ...counts };

  if (NEGATIVE_PHRASES.some((phrase) => containsPhrase(meaningfulTokens, phrase))) {
    return { kind: "rejected_negative", ...counts };
  }

  const selected = [...matches].sort((a, b) => a.tokenPosition - b.tokenPosition)[0]!;
  if (meaningfulTokens.length <= 3) {
    return { kind: "accepted_short", selected, ...counts };
  }

  const hasRequestSignal =
    meaningfulTokens.some((token) => REQUEST_SIGNALS.has(token)) ||
    REQUEST_PHRASES.some((phrase) => containsPhrase(meaningfulTokens, phrase));

  if (hasRequestSignal) {
    return { kind: "accepted_explicit", selected, ...counts };
  }

  return { kind: "rejected_conversational", ...counts };
}

function normalizeReply(text: string): string {
  return text
    .split(/\s+/)
    .map((token) => token.toUpperCase().replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .join(" ");
}

export function classifyOpenRequestReply(
  text: string,
  messageType: DmMessageType,
): OpenRequestReplyIntent {
  if (messageType !== "text") return { kind: "rejected_reply", reason: "non_text" };

  const normalized = normalizeReply(text);
  if (!normalized) return { kind: "rejected_reply", reason: "blank_text" };
  if (CONFIRMATION_PHRASES.has(normalized)) return { kind: "accepted_confirmation" };
  return { kind: "rejected_reply", reason: "unrecognized_text" };
}
