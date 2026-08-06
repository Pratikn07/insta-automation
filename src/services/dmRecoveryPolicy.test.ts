import { describe, expect, it } from "vitest";
import {
  assignRecoveryCohort,
  decideRecovery,
  renderRecoveryCopy,
  type RecoveryPolicyInput,
} from "./dmRecoveryPolicy.js";

describe("DM recovery policy", () => {
  describe("renderRecoveryCopy", () => {
    it("renders the exact approved copy for no_confirmed_read", () => {
      expect(renderRecoveryCopy("no_confirmed_read", "PROTEIN")).toBe(
        "I sent your guide 💛 Check your DMs/Requests. If you don’t see it, DM @tinysoho “PROTEIN”.",
      );
    });

    it("renders the exact approved copy for settings_blocked", () => {
      expect(renderRecoveryCopy("settings_blocked", "SLEEP")).toBe(
        "I couldn’t send your DM 💛 Your message-request settings blocked it. DM @tinysoho “SLEEP”.",
      );
    });

    it("throws if keywordSnapshot is empty", () => {
      expect(() => renderRecoveryCopy("no_confirmed_read", "")).toThrow(
        "invalid_keyword_snapshot",
      );
    });
  });

  describe("assignRecoveryCohort", () => {
    it("is deterministic for the same igUserId and experiment version", () => {
      const cohort1 = assignRecoveryCohort("ig-user-123", "read-recovery-v1", 10);
      const cohort2 = assignRecoveryCohort("ig-user-123", "read-recovery-v1", 10);
      expect(cohort1).toBe(cohort2);
    });

    it("distributes roughly 10% to control over large sample", () => {
      const sampleSize = 10_000;
      let controlCount = 0;
      for (let i = 0; i < sampleSize; i++) {
        const cohort = assignRecoveryCohort(`ig-user-${i}`, "read-recovery-v1", 10);
        if (cohort === "control") controlCount++;
      }
      expect(controlCount).toBeGreaterThanOrEqual(900);
      expect(controlCount).toBeLessThanOrEqual(1100);
    });
  });

  describe("decideRecovery policy evaluation", () => {
    const now = new Date("2026-08-06T18:00:00.000Z");
    const eligibleAt = new Date("2026-08-06T18:00:00.000Z"); // eligible at now
    const acceptedAt = new Date("2026-08-06T08:00:00.000Z"); // 10 hours ago

    const baseInput: RecoveryPolicyInput = {
      now,
      triggerKind: "no_confirmed_read",
      status: "waiting",
      cohort: "treatment",
      eligibleAt,
      acceptedAt,
      instagramGateMessageId: "mid.gate.123",
      commentId: "comment-123",
      seenAt: null,
      engagedAt: null,
      firstEngagementKind: null,
      conversationCompletedAt: null,
      cancelledAt: null,
      hasRecentSentReminderForPerson: false,
      hasNewerEligibleCandidate: false,
      isSourceCommentAvailable: true,
    };

    it("returns wait if current time is before eligibleAt", () => {
      const futureEligible = new Date(now.getTime() + 60_000);
      expect(decideRecovery({ ...baseInput, eligibleAt: futureEligible })).toEqual({
        kind: "wait",
      });
    });

    it.each([
      ["seen", { seenAt: now }],
      ["inbound_reply", { engagedAt: now, firstEngagementKind: "inbound_reply" }],
      ["reaction", { engagedAt: now, firstEngagementKind: "reaction" }],
      ["postback", { engagedAt: now, firstEngagementKind: "postback" }],
      ["completed", { conversationCompletedAt: now }],
      ["owner_cancelled", { cancelledAt: now }],
    ])("suppresses for %s", (reason, evidence) => {
      expect(decideRecovery({ ...baseInput, ...evidence })).toEqual({
        kind: "suppress",
        reason,
      });
    });

    it("suppresses if source comment is unavailable", () => {
      expect(decideRecovery({ ...baseInput, isSourceCommentAvailable: false })).toEqual({
        kind: "suppress",
        reason: "source_unavailable",
      });
    });

    it("suppresses for person_cooldown if person had recent sent reminder in 24h", () => {
      expect(decideRecovery({ ...baseInput, hasRecentSentReminderForPerson: true })).toEqual({
        kind: "suppress",
        reason: "person_cooldown",
      });
    });

    it("suppresses for newer_candidate if a newer eligible candidate exists for the person", () => {
      expect(decideRecovery({ ...baseInput, hasNewerEligibleCandidate: true })).toEqual({
        kind: "suppress",
        reason: "newer_candidate",
      });
    });

    it("returns holdout if cohort is control", () => {
      expect(decideRecovery({ ...baseInput, cohort: "control" })).toEqual({
        kind: "holdout",
      });
    });

    it("returns send_no_confirmed_read_reminder when eligible and in treatment cohort", () => {
      expect(decideRecovery(baseInput)).toEqual({
        kind: "send_no_confirmed_read_reminder",
      });
    });

    it("returns send_settings_fallback immediately for verified settings_blocked trigger", () => {
      const settingsInput: RecoveryPolicyInput = {
        ...baseInput,
        triggerKind: "settings_blocked",
        cohort: "not_applicable",
        eligibleAt: acceptedAt,
      };
      expect(decideRecovery(settingsInput)).toEqual({
        kind: "send_settings_fallback",
      });
    });

    it("returns suppress source_unavailable if gate message ID is missing for no_confirmed_read", () => {
      expect(decideRecovery({ ...baseInput, instagramGateMessageId: null })).toEqual({
        kind: "suppress",
        reason: "source_unavailable",
      });
    });
  });
});
