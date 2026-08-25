import { describe, expect, it } from "vitest";
import {
  guideAccessCardTitle,
  guideAccessCopy,
  guideAccessFollowReAsk,
  guideAccessFollowReAskNoun,
  guideAccessFollowReAskText,
  guideAccessFollowReAskTitle,
  guideAccessOpening,
  guideAccessOpeningText,
} from "./guideAccessCopy.js";

describe("guide access copy", () => {
  /**
   * The opening names NO guide, and that is the invariant.
   *
   * It used to interpolate `resources.name`, which on this account IS the keyword — the live set
   * includes WAFFLE, protein, Poop, GUMMY, Play, Sleep and six rows called "Recipe" — so it
   * rendered "I've got the Play you asked for". The card titles were fixed for this; these text
   * variants were not, which is the only reason the strict flow had to be limited to guides that
   * had a cover to render a card from.
   */
  it("names no guide in the opening", () => {
    expect(guideAccessOpening).toBe("Got it 💛 I've got it ready for you. Want me to send it here?");
    expect(guideAccessOpeningText).toBe(
      "Got it 💛 I've got it ready for you. Want me to send it here? Reply YES and I'll send it over.",
    );
  });

  /**
   * Asserted as a property rather than a fixed string, so a future rewrite of this copy cannot
   * quietly reintroduce interpolation. `${` catches a template hole; the keyword list catches a
   * real resource name being pasted in.
   */
  it("cannot reintroduce a guide name into any parent-facing string", () => {
    const parentFacing = [
      guideAccessOpening,
      guideAccessOpeningText,
      guideAccessCardTitle,
      guideAccessCopy.nonFollowerGate,
      guideAccessCopy.nonFollowerGateText,
      guideAccessCopy.nonFollowerGateCard,
      guideAccessCopy.followLag,
      guideAccessCopy.followLagText,
    ];
    for (const copy of parentFacing) {
      expect(copy).not.toMatch(/\$\{/u);
      expect(copy).not.toMatch(/WAFFLE|MealPrep|GUMMY|\bPoop\b|\bPlay\b/u);
    }
  });

  it("uses reviewed deterministic unavailable and follow-lag responses", () => {
    expect(guideAccessCopy.unavailable).toBe(
      "Unable to confirm right now. Please try again a little later.",
    );
    expect(guideAccessCopy.followLag).toBe(
      "Almost there 💛 Instagram may take a moment to update. Check that you're following @tinysoho, wait a little, then tap I'm following once more.",
    );
  });

  it("aligns rich recovery copy with a control and text fallback copy with a reply", () => {
    expect(guideAccessCopy.expiredOpening).toMatch(/Tap below/u);
    expect(guideAccessCopy.expiredOpeningText).toMatch(/Reply YES/u);
    expect(guideAccessCopy.expiredOpeningText).not.toMatch(/\btap\b/iu);
    expect(guideAccessCopy.expiredFollow).toMatch(/Tap below/u);
    expect(guideAccessCopy.expiredFollowText).toMatch(/Reply DONE/u);
    expect(guideAccessCopy.expiredFollowText).not.toMatch(/\btap\b/iu);
    expect(guideAccessCopy.alreadyDelivered).toBe("I've already sent this guide above 💛");
    expect(guideAccessCopy.reviewRequired).toContain("flagged it for TinySoho to review");
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

/**
 * The first re-ask, sent when a parent tapped the gate's button WITHOUT following and Meta
 * answered definitively that they are not a follower. That case used to receive "Instagram may
 * take a moment to update", which tells someone who never followed that they did.
 */
describe("follow re-ask copy", () => {
  const CATEGORIES = ["recipes", "bedtime", "potty-training", "montessori-activities"];

  it("states the situation without asserting what the parent did", () => {
    expect(guideAccessFollowReAskTitle).toBe("One step left 💛");
    // The whole point of the change: no claim about Instagram being slow, and no accusation.
    expect(guideAccessFollowReAskTitle).not.toMatch(/Instagram|moment|can't|cannot/iu);
    expect([...guideAccessFollowReAskTitle].length).toBeLessThanOrEqual(80);
  });

  it("names what else is behind the follow, per category", () => {
    expect(guideAccessFollowReAsk("recipes")).toBe(
      "Follow @tinysoho for more recipes like this, then tap I'm following.",
    );
    expect(guideAccessFollowReAsk("bedtime")).toContain("more bedtime wins like this");
    expect(guideAccessFollowReAsk("potty-training")).toContain("more potty steps like this");
    expect(guideAccessFollowReAsk("montessori-activities")).toContain(
      "more activities like this",
    );
  });

  /**
   * Meta truncates a generic-template subtitle past 80 characters silently, on device, with no
   * error — `nonFollowerGateText` was 81 and that is why this is asserted for every noun rather
   * than checked once for the longest. Counted in code points, as Meta counts characters.
   */
  it("keeps every category's subtitle inside Meta's 80-character cap", () => {
    for (const slug of [...CATEGORIES, undefined, "unknown-category"]) {
      expect([...guideAccessFollowReAsk(slug)].length).toBeLessThanOrEqual(80);
    }
  });

  /**
   * A copy lookup must never be able to cost a parent their guide, so an unrecognised category
   * degrades to a real word that keeps the sentence grammatical.
   */
  it("falls back to a real noun for an unknown or absent category", () => {
    expect(guideAccessFollowReAskNoun(undefined)).toBe("ideas");
    expect(guideAccessFollowReAskNoun("")).toBe("ideas");
    expect(guideAccessFollowReAskNoun("no-such-category")).toBe("ideas");
    expect(guideAccessFollowReAsk("no-such-category")).toContain("more ideas like this");
    expect(() => guideAccessFollowReAsk("no-such-category")).not.toThrow();
  });

  /**
   * Same invariant the existing pairs hold: the card names its button because it has one, the
   * text fallback asks for a reply because it has none. Naming a control that was not sent is a
   * dead end for the parent.
   */
  it("names the button only in the card variant", () => {
    for (const slug of CATEGORIES) {
      expect(guideAccessFollowReAsk(slug)).toMatch(/tap I'm following/u);
      expect(guideAccessFollowReAskText(slug)).toMatch(/reply DONE/u);
      expect(guideAccessFollowReAskText(slug)).not.toMatch(/\btap\b/iu);
    }
  });

  it("carries no guide count, which would drift the moment a guide is published", () => {
    for (const slug of CATEGORIES) {
      expect(guideAccessFollowReAsk(slug)).not.toMatch(/\d/u);
      expect(guideAccessFollowReAskText(slug)).not.toMatch(/\d/u);
    }
  });
});
