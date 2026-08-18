import { describe, expect, it } from "vitest";
import { MutationOutcomeUnknownError } from "./mutationOutcome";
import { isUnknownOutcome, outcomeMessage } from "./unknownOutcome";

describe("isUnknownOutcome", () => {
  it("recognises only a dispatched-but-unresolved mutation", () => {
    expect(isUnknownOutcome(new MutationOutcomeUnknownError("/x", "op-1"))).toBe(true);
    expect(isUnknownOutcome(new Error("boom"))).toBe(false);
    expect(isUnknownOutcome(null)).toBe(false);
  });
});

describe("outcomeMessage", () => {
  it("refuses to call an unknown outcome a failure", () => {
    const message = outcomeMessage(
      new MutationOutcomeUnknownError("/recovery-reminders/1/cancel", undefined),
      "Cancel failed.",
    );

    expect(message).not.toMatch(/failed/i);
    expect(message).toMatch(/Still confirming/i);
  });

  it("passes a definite failure through unchanged", () => {
    expect(outcomeMessage(new Error("boom"), "Cancel failed.")).toBe("Cancel failed.");
  });
});
