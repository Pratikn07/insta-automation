import { describe, expect, it } from "vitest";
import {
  computeFollowUpSchedule,
  isCurrentPromptVersion,
} from "./replyDraftPolicy.js";

describe("reply draft policy", () => {
  it("schedules a follow-up 12 hours after guide delivery within the inbound messaging window", () => {
    const deliveredAt = new Date("2026-08-05T10:00:00.000Z");
    const inboundAt = new Date("2026-08-05T09:45:00.000Z");

    expect(computeFollowUpSchedule({ deliveredAt, inboundAt })).toEqual({
      eligibleAt: new Date("2026-08-05T22:00:00.000Z"),
      expiresAt: new Date("2026-08-06T09:15:00.000Z"),
    });
  });

  it("does not schedule when eligibility falls outside the inbound messaging window", () => {
    const inboundAt = new Date("2026-08-05T09:45:00.000Z");

    expect(
      computeFollowUpSchedule({
        deliveredAt: new Date("2026-08-06T09:00:00.000Z"),
        inboundAt,
      }),
    ).toBeNull();
  });

  it("recognizes only the current prompt version", () => {
    expect(isCurrentPromptVersion(2)).toBe(true);
    expect(isCurrentPromptVersion(null)).toBe(false);
  });
});
