import { describe, expect, it } from "vitest";
import { classifyInboundHealthSignal } from "./campaignHealthObservation.js";

describe("classifyInboundHealthSignal", () => {
  it.each([
    ["STOP", "opt_out"],
    ["unsubscribe please", "opt_out"],
    ["do not contact me", "opt_out"],
    ["  Stop!  ", "opt_out"],
    ["leave me alone", "negative_reply"],
    ["go away!", "negative_reply"],
  ] as const)("classifies %p as %s", (text, expected) => {
    expect(classifyInboundHealthSignal(text)).toBe(expected);
  });

  it.each([
    "please stop by tomorrow",
    "I cannot stop thinking about this",
    "unstoppable",
    "please leave me alone with the details for now",
    "",
  ])("does not classify the substring case %p", (text) => {
    expect(classifyInboundHealthSignal(text)).toBeNull();
  });
});
