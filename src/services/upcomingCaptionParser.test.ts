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

  it("does not treat a longer word beginning with comment as an instruction", () => {
    expect(parseUpcomingCaptionInstruction("Commentary SLEEP is useful"))
      .toEqual({ kind: "missing" });
  });
});
