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

/**
 * Which typed replies to an open card count as "yes, send it".
 *
 * A reply must START with a lead phrase and carry nothing after it but polite filler.
 * The old rule matched whole messages against 12 phrases, so "yes send it", "yes pls",
 * "sure" and a misspelled "doen" went to owner review and got nothing: about 55 a month
 * of the 367 rejected replies in the 30 days to 2026-10-13. "Thank you" and "please"
 * alone stay out on purpose (owner's decision): they are not a yes. See
 * docs/superpowers/specs/2026-10-13-typed-reply-word-list-design.md.
 */
const CONFIRMATION_LEADS: readonly (readonly string[])[] = [
  // Yes
  ["YES"], ["YEP"], ["YEAH"], ["SURE"], ["OK"], ["OKAY"],
  ["SEND", "IT"], ["PLEASE", "SEND"], ["SEND"],
  // Done / follow, including the misspellings seen in production
  ["DONE"], ["DOEN"], ["FONE"], ["DOME"],
  ["FOLLOWED"], ["FOLLOWING"], ["I", "FOLLOW"], ["I", "FOLLOWED"],
  ["I", "AM", "FOLLOWING"], ["IM", "FOLLOWING"], ["READY"],
].sort((a, b) => b.length - a.length);

/** The only words allowed after a lead phrase. */
const CONFIRMATION_FILLER = new Set([
  "PLEASE", "PLS", "PLZ", "THANKS", "THANK", "YOU", "U", "THX", "TY",
  "SEND", "IT", "HERE", "NOW", "ME", "SO", "MUCH",
]);

const NEGATIONS = new Set(["NO", "NOT", "DONT", "NOPE", "NAH"]);

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

function isConfirmation(rawText: string, tokens: readonly string[]): boolean {
  // A question is never a yes: "yes but is it dairy free?" needs a person.
  if (rawText.includes("?")) return false;
  if (tokens.some((token) => NEGATIONS.has(token))) return false;
  const lead = CONFIRMATION_LEADS.find((phrase) =>
    phrase.every((token, index) => tokens[index] === token),
  );
  if (!lead) return false;
  return tokens.slice(lead.length).every((token) => CONFIRMATION_FILLER.has(token));
}

export function classifyOpenRequestReply(
  text: string,
  messageType: DmMessageType,
): OpenRequestReplyIntent {
  if (messageType !== "text") return { kind: "rejected_reply", reason: "non_text" };

  const normalized = normalizeReply(text);
  if (!normalized) return { kind: "rejected_reply", reason: "blank_text" };
  if (isConfirmation(text, normalized.split(" "))) return { kind: "accepted_confirmation" };
  return { kind: "rejected_reply", reason: "unrecognized_text" };
}
