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

export function guideAccessWaitingTitle(name: string): string {
  return `Your ${reviewedGuideName(name)} is waiting ✨`;
}
