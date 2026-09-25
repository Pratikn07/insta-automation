import { describe, expect, it } from "vitest";
import { parseUpcomingCaptionInstruction } from "./upcomingCaptionParser.js";

describe("parseUpcomingCaptionInstruction", () => {
  it.each([
    ["Comment HIGHCHAIR", "HIGHCHAIR"],
    ["comment highchair", "HIGHCHAIR"],
    ["Save this. Comment ‘HighChair’!", "HIGHCHAIR"],
    ["Comment: \"MEAL2\".", "MEAL2"],
    ["COMMENT (POTTY)", "POTTY"],
  ])("extracts one alphanumeric CTA from %j", (caption, expected) => {
    expect(parseUpcomingCaptionInstruction(caption)).toEqual({
      kind: "matched",
      keyword: expected,
    });
  });

  it.each([
    ["Comment HIGH CHAIR", "HIGH CHAIR", ["HIGH CHAIR"]],
    ["Comment ‘High Chair’!", "HIGH CHAIR", undefined],
    ["Comment \"HIGH CHAIR\" to get the guide", "HIGH CHAIR", undefined],
  ])("extracts an exact two-word CTA from %j", (caption, expected, knownKeywords) => {
    expect(parseUpcomingCaptionInstruction(caption, knownKeywords)).toEqual({
      kind: "matched",
      keyword: expected,
    });
  });

  it("does not absorb ordinary CTA copy into an existing one-word keyword", () => {
    expect(parseUpcomingCaptionInstruction("Comment SLEEP to receive the guide", ["SLEEP"])).toEqual({
      kind: "matched",
      keyword: "SLEEP",
    });
  });

  it.each(["", "Save this for later", "Comments are open", "Comment 🥑"])(
    "rejects a caption without a valid CTA: %j",
    (caption) => {
      expect(parseUpcomingCaptionInstruction(caption)).toEqual({ kind: "missing" });
    },
  );

  it("rejects multiple Comment KEYWORD instructions even when the words agree", () => {
    expect(
      parseUpcomingCaptionInstruction("Comment SLEEP now. Or comment SLEEP below."),
    ).toEqual({ kind: "ambiguous", keywords: ["SLEEP", "SLEEP"] });
  });

  it("reports every normalized word when multiple instructions disagree", () => {
    expect(parseUpcomingCaptionInstruction("Comment SLEEP. Comment POTTY."))
      .toEqual({ kind: "ambiguous", keywords: ["SLEEP", "POTTY"] });
  });

  it("reports every normalized phrase when multiple instructions are present", () => {
    expect(parseUpcomingCaptionInstruction("Comment HIGH CHAIR. Comment POTTY.", ["HIGH CHAIR", "POTTY"]))
      .toEqual({ kind: "ambiguous", keywords: ["HIGH CHAIR", "POTTY"] });
  });

  it("does not treat a longer word beginning with comment as an instruction", () => {
    expect(parseUpcomingCaptionInstruction("Commentary SLEEP is useful"))
      .toEqual({ kind: "missing" });
  });
});
