import { z } from "zod";

const guideName = z.string().trim().min(1).max(56);

function reviewedGuideName(value: string): string {
  const parsed = guideName.safeParse(value);
  if (!parsed.success) throw new Error("invalid_guide_access_copy");
  return parsed.data;
}

export const guideAccessCopy = {
  nonFollowerGate:
    "Follow @tinysoho for more ideas like this, then tap I'm following and I'll send it over.",
  unavailable: "Unable to confirm right now. Please try again a little later.",
  followLag:
    "Almost there 💛 Instagram may take a moment to update. Check that you're following @tinysoho, wait a little, then tap I'm following once more.",
} as const;

export function guideAccessOpening(name: string): string {
  return `Got it 💛 I've got the ${reviewedGuideName(name)} you asked for. Want me to send it here?`;
}

export function guideAccessWaitingTitle(name: string): string {
  return `Your ${reviewedGuideName(name)} is waiting ✨`;
}
