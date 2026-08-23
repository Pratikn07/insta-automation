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
 * control was sent is a dead end. Per the spec, the fallback asks for a short
 * `YES`, though the router accepts any genuine reply and never requires `DONE`.
 *
 * Only the call-to-action clause differs between the pairs; the substance is the
 * same copy, as the spec requires. These remain reviewed application constants.
 */
export const guideAccessCopy = {
  nonFollowerGate:
    "Follow @tinysoho for more ideas like this, then tap I'm following and I'll send it over.",
  nonFollowerGateText:
    "Follow @tinysoho for more ideas like this, then reply YES and I'll send it over.",
  unavailable: "Unable to confirm right now. Please try again a little later.",
  followLag:
    "Almost there 💛 Instagram may take a moment to update. Check that you're following @tinysoho, wait a little, then tap I'm following once more.",
  followLagText:
    "Almost there 💛 Instagram may take a moment to update. Check that you're following @tinysoho, wait a little, then reply YES once more.",
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
