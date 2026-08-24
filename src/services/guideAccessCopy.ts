import { z } from "zod";

const guideName = z.string().trim().min(1).max(56);

function reviewedGuideName(value: string): string {
  const parsed = guideName.safeParse(value);
  if (!parsed.success) throw new Error("invalid_guide_access_copy");
  return parsed.data;
}

/**
 * Two variants of every parent-facing prompt.
 *
 * The `…Text` forms are used whenever the reviewed capability result has not
 * proven the matching rich control. They must never name a button, because in
 * text mode there is none — telling a parent to "tap I'm following" when no such
 * control was sent is a dead end.
 *
 * The word asked for differs by QUESTION, not by path:
 *
 * - Confirming a follow asks for `DONE`, matching the gate copy already live on
 *   the original path. Owner decision, 2026-08-23, overriding the spec's `YES`:
 *   reels and pinned comments already tell people to reply DONE, and two words
 *   for one action is worse than either word. The spec was updated to match.
 * - The opening asks for `YES`, because it answers "Want me to send it here?"
 *   rather than "have you followed?". `DONE` there would answer a question that
 *   was not asked. Nothing on the original path conflicts, since it has no
 *   opening step.
 *
 * Neither word is REQUIRED while a gate is still open: any genuine reply to the current
 * access attempt is accepted. One caveat worth knowing, because it is the only place a word
 * is actually matched — once the internal gate window has lapsed, `messageHandler`'s
 * `DONE_RE` is what recovers the latest request, so after that cutoff a parent who replies
 * `YES` to the opening cannot recover and one who replies `DONE` can. That is a reason the
 * follow ask says DONE, not an argument for the opening to.
 *
 * Only the call-to-action clause differs between the pairs; the substance is the
 * same copy, as the spec requires. These remain reviewed application constants.
 */
export const guideAccessCopy = {
  // "tap below" rather than naming the button, because the card's button label is now
  // per-category ("Send my tiny win", "Send the recipes"...). Copy that names a control is
  // copy that silently goes wrong the moment the control is reworded, and nothing would
  // fail — the card renders, the words just stop matching the button beneath them.
  nonFollowerGate:
    "Follow @tinysoho for more ideas like this, then tap below and I'll send it over.",
  nonFollowerGateText:
    "Follow @tinysoho for more ideas like this, then reply DONE and I'll send it over.",
  // A card subtitle, not a message. Meta caps a generic-template subtitle at 80 characters
  // and `nonFollowerGateText` is 81 — one over, which the payload validator caught rather
  // than Meta silently truncating "over." off the end. Its own string rather than a trimmed
  // copy: the card carries a Visit profile button, so it does not need to spell out
  // "for more ideas like this" the way a bare text message does.
  nonFollowerGateCard: "Follow @tinysoho, then reply DONE and I'll send it over.",
  unavailable: "Unable to confirm right now. Please try again a little later.",
  followLag:
    "Almost there 💛 Instagram may take a moment to update. Check that you're following @tinysoho, wait a little, then tap I'm following once more.",
  followLagText:
    "Almost there 💛 Instagram may take a moment to update. Check that you're following @tinysoho, wait a little, then reply DONE once more.",
} as const;

export function guideAccessOpening(name: string): string {
  return `Got it 💛 I've got the ${reviewedGuideName(name)} you asked for. Want me to send it here?`;
}

export function guideAccessOpeningText(name: string): string {
  return `${guideAccessOpening(name)} Reply YES and I'll send it over.`;
}

/**
 * The card's title. Interpolates NOTHING, deliberately.
 *
 * `guideAccessWaitingTitle` puts the resource's name in the sentence, and on this account a
 * resource name is almost never a name a parent would recognise — it is the keyword. The live
 * set includes WAFFLE, protein, Poop, GUMMY and six different rows called "Recipe". Rendered,
 * that reads "Your WAFFLE is waiting", which is the automation showing its plumbing on the one
 * message half of these parents ever see.
 *
 * The card does not need it. Its cover already carries the authored, human headline — "Banana
 * oat waffles" — set in the guide's own type. Naming the guide again in the title was both a
 * duplicate and the worse of the two names.
 */
export const guideAccessCardTitle = "Your guide is waiting ✨";

/**
 * The opening card's title, at the moment the parent has just asked and nothing is required
 * of them yet — so "ready" rather than "waiting".
 *
 * Interpolates nothing, for the same reason as `guideAccessCardTitle`: on this account a
 * resource name is the keyword. The V2 opening rendered "Your MealPrep is ready" on device.
 */
export const guideAccessOpeningCardTitle = "Your guide is ready ✨";

export function guideAccessWaitingTitle(name: string): string {
  return `Your ${reviewedGuideName(name)} is waiting ✨`;
}

/**
 * The first re-ask, for a parent who tapped the gate's button without following.
 *
 * Meta had just answered definitively that they are not a follower, and we replied "Instagram
 * may take a moment to update" — telling someone who never followed that they did, and
 * inviting them to wait out a delay that was not happening. Observed on device 2026-08-24:
 * the gate went out at 14:23:18 and the tap came 11 seconds later, which is not enough time to
 * leave Instagram, follow an account and come back.
 *
 * "One step left" states the situation without asserting what the parent did, so the same
 * words are honest whether they skipped the follow or genuinely hit a propagation delay. The
 * sympathetic "Instagram may take a moment" copy is still sent, but as the SECOND response —
 * most likely explanation first, benefit of the doubt second.
 */
export const guideAccessFollowReAskTitle = "One step left 💛";

/**
 * The noun for "more ___ like this", per category.
 *
 * The re-ask is the message that has to make following worth doing, so it names what else is
 * behind the follow rather than repeating the demand. Per-category for the same reason the
 * card's button label is: the card already knows its category, so naming the thing costs one
 * lookup and stops the copy reading as a template.
 *
 * Deliberately no counts. "29 more recipes" is true today — 30 recipes, 7 sleep, 4 potty and
 * 4 learning guides are published — and wrong the moment a guide is added, while "3 more potty
 * steps" undersells the collection it is trying to sell. Worded abundance stays true.
 */
const FOLLOW_RE_ASK_NOUNS: Record<string, string> = {
  recipes: "recipes",
  bedtime: "bedtime wins",
  "potty-training": "potty steps",
  "montessori-activities": "activities",
};

/**
 * Falls back to "ideas" rather than throwing, and the fallback is a real word so the sentence
 * still reads. An unrecognised category is a cosmetic loss; a copy lookup must never be able to
 * cost a parent their guide.
 */
export function guideAccessFollowReAskNoun(categorySlug?: string): string {
  if (!categorySlug) return "ideas";
  return FOLLOW_RE_ASK_NOUNS[categorySlug] ?? "ideas";
}

/**
 * The card subtitle. Names the button because a card HAS one.
 *
 * Length is `61 + noun`, so the longest ("bedtime wins") is 73 — inside Meta's 80-character
 * subtitle cap. Asserted per noun in the tests rather than trusted to review, because
 * `nonFollowerGateText` was 81 and Meta truncates silently, on device, with no error.
 */
export function guideAccessFollowReAsk(categorySlug?: string): string {
  return `Follow @tinysoho for more ${guideAccessFollowReAskNoun(categorySlug)} like this, then tap I'm following.`;
}

/**
 * The text fallback, for a guide with no published square or a capability that is off.
 *
 * Asks for a reply instead of naming a control, because in text mode there is none. Not
 * subject to the 80-character cap — that applies to a card subtitle, not a message — which is
 * why this one can afford to spell out what happens next.
 */
export function guideAccessFollowReAskText(categorySlug?: string): string {
  return `Follow @tinysoho for more ${guideAccessFollowReAskNoun(categorySlug)} like this, then reply DONE and I'll send it over.`;
}
