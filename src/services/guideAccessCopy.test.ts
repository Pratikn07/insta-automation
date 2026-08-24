import { describe, expect, it } from "vitest";
import {
  guideAccessCardTitle,
  guideAccessCopy,
  guideAccessOpening,
  guideAccessWaitingTitle,
} from "./guideAccessCopy.js";

describe("guide access copy", () => {
  it("renders the reviewed neutral opening with the guide name", () => {
    expect(guideAccessOpening("toddler sleep guide")).toBe(
      "Got it 💛 I've got the toddler sleep guide you asked for. Want me to send it here?",
    );
  });

  it("keeps guide-name punctuation as text and rejects names outside the reviewed limit", () => {
    expect(guideAccessWaitingTitle('sleep guide", "buttons"')).toBe(
      'Your sleep guide", "buttons" is waiting ✨',
    );
    expect(() => guideAccessOpening("x".repeat(57))).toThrow("invalid_guide_access_copy");
    expect(() => guideAccessOpening("   ")).toThrow("invalid_guide_access_copy");
  });

  it("uses reviewed deterministic unavailable and follow-lag responses", () => {
    expect(guideAccessCopy.unavailable).toBe(
      "Unable to confirm right now. Please try again a little later.",
    );
    expect(guideAccessCopy.followLag).toBe(
      "Almost there 💛 Instagram may take a moment to update. Check that you're following @tinysoho, wait a little, then tap I'm following once more.",
    );
  });

  it("uses the approved non-follower gate copy", () => {
    expect(guideAccessCopy.nonFollowerGate).toBe(
      "Follow @tinysoho for more ideas like this, then tap below and I'll send it over.",
    );
  });

  /**
   * The card's copy must not name its own button.
   *
   * This is the card subtitle, and the card's button label is per-category — "Send my tiny
   * win", "Send the recipes" and so on. Copy that names a control silently stops matching it
   * the moment the control is reworded: the card still renders, the send still succeeds, and
   * the words simply describe a button that is not there. That is precisely how this copy
   * broke when per-category labels landed, so the invariant is asserted rather than
   * remembered.
   *
   * `nonFollowerGateText` is exempt and checked the other way: it is the TEXT fallback, which
   * has no buttons at all, so naming the reply keyword is the only instruction available.
   */
  it("never names a button in copy that accompanies one", () => {
    expect(guideAccessCopy.nonFollowerGate).not.toMatch(/I'm following/u);
    expect(guideAccessCopy.nonFollowerGate).toMatch(/tap below/u);
    // The text fallback must keep naming the reply word, since it has no control to tap.
    expect(guideAccessCopy.nonFollowerGateText).toMatch(/reply DONE/u);
  });

  /**
   * Meta truncates a generic-template subtitle past 80 characters, silently and on device.
   * The plain-text gate is 81, which is exactly why the card has its own string — and why
   * that limit is asserted here rather than discovered by a parent reading a sentence that
   * stops mid-word.
   */
  it("keeps the card subtitle inside Meta's 80-character subtitle limit", () => {
    expect([...guideAccessCopy.nonFollowerGateCard].length).toBeLessThanOrEqual(80);
    expect(guideAccessCopy.nonFollowerGateCard).toMatch(/reply DONE/u);
  });

  /**
   * The card title must never interpolate a resource name. On this account those names are the
   * keywords themselves — WAFFLE, protein, Poop, GUMMY, and six separate rows called "Recipe" —
   * so "Your ${name} is waiting" renders as "Your WAFFLE is waiting" on the one message half of
   * these parents ever see. The cover carries the authored headline instead.
   */
  it("names no guide in the card title", () => {
    expect(guideAccessCardTitle).toBe("Your guide is waiting ✨");
    expect(guideAccessCardTitle).not.toMatch(/\$\{|WAFFLE/u);
    expect([...guideAccessCardTitle].length).toBeLessThanOrEqual(80);
  });
});
