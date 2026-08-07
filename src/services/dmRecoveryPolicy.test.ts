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
    const eligibleAt = new Date("2026-08-06T18:00:00.000Z");
    const acceptedAt = new Date("2026-08-06T08:00:00.000Z");

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
      conversationCompletedElsewhere: false,
      cancelledAt: null,
      hasRecentSentReminderForPerson: false,
      hasNewerEligibleCandidate: false,
      isSourceCommentAvailable: true,
    };

    // The reason matters as much as the kind. A finalized row that was never
    // read must not be labelled "seen": absence of a read signal is never
    // evidence of a read, and the reason is what feeds experiment denominators
    // and the dashboard.
    it.each([
      ["sent", "already_finalized"],
      ["send_failed", "already_finalized"],
      ["send_uncertain", "already_finalized"],
      ["sending", "already_finalized"],
      ["suppressed", "already_finalized"],
      ["cancelled", "owner_cancelled"],
    ])("suppresses terminal status %s without inventing read evidence", (status, reason) => {
      expect(decideRecovery({ ...baseInput, status, seenAt: null, engagedAt: null })).toEqual({
        kind: "suppress",
        reason,
      });
    });

    it("prevents re-evaluation for terminal status control", () => {
      expect(decideRecovery({ ...baseInput, status: "control" })).toEqual({
        kind: "holdout",
      });
    });

    it("prevents re-evaluation for terminal status tracking_unavailable", () => {
      expect(decideRecovery({ ...baseInput, status: "tracking_unavailable" })).toEqual({
        kind: "suppress",
        reason: "tracking_unavailable",
      });
    });

    it.each([
      ["seen", { seenAt: now }, "seen"],
      ["inbound_reply", { engagedAt: now, firstEngagementKind: "inbound_reply" }, "inbound_reply"],
      ["quick_reply", { engagedAt: now, firstEngagementKind: "quick_reply" }, "quick_reply"],
      ["attachment", { engagedAt: now, firstEngagementKind: "attachment" }, "attachment"],
      ["reaction", { engagedAt: now, firstEngagementKind: "reaction" }, "reaction"],
      ["postback", { engagedAt: now, firstEngagementKind: "postback" }, "postback"],
      ["completed", { conversationCompletedAt: now }, "completed"],
      ["completed_elsewhere", { conversationCompletedAt: now, conversationCompletedElsewhere: true }, "completed_elsewhere"],
      ["owner_cancelled", { cancelledAt: now }, "owner_cancelled"],
    ])("suppresses for %s", (_name, evidence, expectedReason) => {
      expect(decideRecovery({ ...baseInput, ...evidence })).toEqual({
        kind: "suppress",
        reason: expectedReason,
      });
    });

    it("suppresses tracking_unavailable if gate message ID is missing for no_confirmed_read", () => {
      expect(decideRecovery({ ...baseInput, instagramGateMessageId: null })).toEqual({
        kind: "suppress",
        reason: "tracking_unavailable",
      });
    });

    it("suppresses settings_blocked when person has a recent sent reminder in 24h", () => {
      const settingsInput: RecoveryPolicyInput = {
        ...baseInput,
        triggerKind: "settings_blocked",
        hasRecentSentReminderForPerson: true,
      };
      expect(decideRecovery(settingsInput)).toEqual({
        kind: "suppress",
        reason: "person_cooldown",
      });
    });

    it("suppresses settings_blocked when a newer eligible candidate exists for the person", () => {
      const settingsInput: RecoveryPolicyInput = {
        ...baseInput,
        triggerKind: "settings_blocked",
        hasNewerEligibleCandidate: true,
      };
      expect(decideRecovery(settingsInput)).toEqual({
        kind: "suppress",
        reason: "newer_candidate",
      });
    });

    it("evaluates person_cooldown before checking eligibleAt eligibility time", () => {
      const futureEligible = new Date(now.getTime() + 3600_000);
      expect(
        decideRecovery({
          ...baseInput,
          eligibleAt: futureEligible,
          hasRecentSentReminderForPerson: true,
        }),
      ).toEqual({
        kind: "suppress",
        reason: "person_cooldown",
      });
    });

    it("returns wait if not eligible yet and no cooldown/evidence suppresses it", () => {
      const futureEligible = new Date(now.getTime() + 60_000);
      expect(decideRecovery({ ...baseInput, eligibleAt: futureEligible })).toEqual({
        kind: "wait",
      });
    });

    it("sends an overdue reminder after a 29-hour outage", () => {
      const pastEligible = new Date(now.getTime() - 29 * 3600_000);
      expect(decideRecovery({ ...baseInput, eligibleAt: pastEligible })).toEqual({
        kind: "send_no_confirmed_read_reminder",
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

    it("returns send_settings_fallback for settings_blocked trigger when no cooldown or newer candidate exists", () => {
      const settingsInput: RecoveryPolicyInput = {
        ...baseInput,
        triggerKind: "settings_blocked",
        cohort: "treatment",
        eligibleAt: acceptedAt,
      };
      expect(decideRecovery(settingsInput)).toEqual({
        kind: "send_settings_fallback",
      });
    });
  });
});
