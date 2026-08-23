import { describe, expect, it } from "vitest";
import {
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
      "Follow @tinysoho for more ideas like this, then tap I'm following and I'll send it over.",
    );
  });
});
