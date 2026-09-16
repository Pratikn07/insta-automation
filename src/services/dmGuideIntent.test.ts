import { describe, expect, it } from "vitest";
import {
  classifyDmKeywordIntent,
  classifyOpenRequestReply,
  type ResolvedDmKeyword,
} from "./dmGuideIntent.js";

type TestKeyword = { id: string; keyword: string; resource: { id: string } };

function resolved(
  keyword: string,
  tokenPosition: number,
  overrides: Partial<ResolvedDmKeyword<TestKeyword>> = {},
): ResolvedDmKeyword<TestKeyword> {
  return {
    keyword: {
      id: `keyword-${keyword.toLowerCase()}`,
      keyword,
      resource: { id: `resource-${keyword.toLowerCase()}` },
    },
    matchedToken: keyword,
    tokenPosition,
    inferredFromPost: null,
    ...overrides,
  };
}

describe("classifyDmKeywordIntent", () => {
  it.each([
    ["the bare keyword", ["WAFFLE"]],
    ["a two-token polite ask", ["WAFFLE", "PLEASE"]],
    ["a three-token request", ["SEND", "WAFFLE", "PLEASE"]],
  ])("accepts %s", (_label, tokens) => {
    const waffle = resolved("WAFFLE", tokens.indexOf("WAFFLE"));

    expect(classifyDmKeywordIntent(tokens, [waffle])).toEqual({
      kind: "accepted_short",
      selected: waffle,
      meaningfulTokenCount: tokens.length,
      keywordHitCount: 1,
      distinctGuideCount: 1,
    });
  });

  it.each(["SEND", "SHARE", "GET", "GIVE", "WANT", "NEED"])(
    "accepts a long request containing the %s signal",
    (signal) => {
      const tokens = ["PLEASE", signal, "ME", "THE", "WAFFLE", "RECIPE"];
      const waffle = resolved("WAFFLE", 4);

      expect(classifyDmKeywordIntent(tokens, [waffle])).toMatchObject({
        kind: "accepted_explicit",
        selected: waffle,
      });
    },
  );

  it.each([
    ["CAN I HAVE", ["CAN", "I", "HAVE", "THE", "WAFFLE", "GUIDE"]],
    ["COULD I HAVE", ["COULD", "I", "HAVE", "THE", "WAFFLE", "GUIDE"]],
    ["I WOULD LIKE", ["I", "WOULD", "LIKE", "THE", "WAFFLE", "GUIDE"]],
    ["I'D LIKE", ["ID", "LIKE", "THE", "WAFFLE", "GUIDE"]],
  ])("accepts the long exact request phrase %s", (_label, tokens) => {
    const waffle = resolved("WAFFLE", tokens.indexOf("WAFFLE"));

    expect(classifyDmKeywordIntent(tokens, [waffle])).toMatchObject({
      kind: "accepted_explicit",
      selected: waffle,
    });
  });

  it("rejects the exact production conversational mention", () => {
    const tokens = [
      "THANK",
      "YOU",
      "THIS",
      "LIST",
      "IS",
      "GOLD",
      "IM",
      "ACTUALLY",
      "WORKING",
      "ON",
      "A",
      "FRENCH",
      "ACTIVITY",
      "BOOK",
      "FOR",
      "KIDS",
      "TO",
      "HELP",
      "PARENTS",
      "RAISING",
      "BILINGUAL",
      "KIDS",
      "LOVE",
      "YOUR",
      "PAGE",
    ];
    const activity = resolved("ACTIVITY", 12);

    expect(classifyDmKeywordIntent(tokens, [activity])).toEqual({
      kind: "rejected_conversational",
      meaningfulTokenCount: tokens.length,
      keywordHitCount: 1,
      distinctGuideCount: 1,
    });
  });

  it.each([
    ["DO NOT SEND", ["DO", "NOT", "SEND", "WAFFLE"]],
    ["DON'T SEND", ["DONT", "SEND", "WAFFLE"]],
    ["NO NEED TO SEND", ["NO", "NEED", "TO", "SEND", "WAFFLE"]],
    ["I DO NOT WANT", ["I", "DO", "NOT", "WANT", "WAFFLE"]],
    ["I DON'T WANT", ["I", "DONT", "WANT", "WAFFLE"]],
  ])("lets the negative phrase %s override request signals", (_label, tokens) => {
    const waffle = resolved("WAFFLE", tokens.indexOf("WAFFLE"));

    expect(classifyDmKeywordIntent(tokens, [waffle])).toMatchObject({
      kind: "rejected_negative",
    });
  });

  it("selects the first keyword token and reports distinct guides", () => {
    const waffle = resolved("WAFFLE", 3);
    const recipe = resolved("RECIPE", 4);

    expect(
      classifyDmKeywordIntent(
        ["PLEASE", "SEND", "THE", "WAFFLE", "RECIPE"],
        [waffle, recipe],
      ),
    ).toEqual({
      kind: "accepted_explicit",
      selected: waffle,
      meaningfulTokenCount: 5,
      keywordHitCount: 2,
      distinctGuideCount: 2,
    });
  });

  it("counts two keyword rows for the same guide as one distinct guide", () => {
    const first = resolved("WAFFLE", 1);
    const alias = resolved("RECIPE", 2, {
      keyword: { id: "keyword-recipe", keyword: "RECIPE", resource: { id: "resource-waffle" } },
    });

    expect(classifyDmKeywordIntent(["SEND", "WAFFLE", "RECIPE", "PLEASE"], [first, alias]))
      .toMatchObject({ keywordHitCount: 2, distinctGuideCount: 1 });
  });

  it("returns no_keyword without a resolved hit", () => {
    expect(classifyDmKeywordIntent(["HELLO", "THERE"], [])).toEqual({
      kind: "no_keyword",
      meaningfulTokenCount: 2,
      keywordHitCount: 0,
      distinctGuideCount: 0,
    });
  });
});

describe("classifyOpenRequestReply", () => {
  it.each([
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
    "I'M FOLLOWING",
    "READY",
  ])("accepts the complete confirmation phrase %s", (text) => {
    expect(classifyOpenRequestReply(text, "text")).toEqual({ kind: "accepted_confirmation" });
  });

  it("normalizes surrounding punctuation and emoji", () => {
    expect(classifyOpenRequestReply("  Yes, please! 💛 ", "text")).toEqual({
      kind: "accepted_confirmation",
    });
  });

  it.each([
    "Thank you! This list is gold.",
    "Yes, I already received another list yesterday",
    "I am not ready",
    "Please do not send it",
    "Done with work for today",
  ])("rejects unrelated text containing an affirmative word: %s", (text) => {
    expect(classifyOpenRequestReply(text, "text")).toMatchObject({
      kind: "rejected_reply",
      reason: "unrecognized_text",
    });
  });

  it("rejects blank text", () => {
    expect(classifyOpenRequestReply("   ", "text")).toEqual({
      kind: "rejected_reply",
      reason: "blank_text",
    });
  });

  it.each(["image", "video", "audio", "file", "unknown"] as const)(
    "rejects a %s reply even when a provider body happens to contain text",
    (messageType) => {
      expect(classifyOpenRequestReply("YES", messageType)).toEqual({
        kind: "rejected_reply",
        reason: "non_text",
      });
    },
  );
});
