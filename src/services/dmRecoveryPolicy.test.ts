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
      instagramGateMessageId: "mid.gate.123",
      seenAt: null,
      engagedAt: null,
      firstEngagementKind: null,
      conversationCompletedAt: null,
      cancelledAt: null,
      hasRecentSentReminderForPerson: false,
      hasNewerEligibleCandidate: false,
      isSourceCommentAvailable: true,
      audienceOrigin: "unknown",
      audienceOriginConfidence: "low",
      westernOnly: false,
    };

    describe("out-of-market audience", () => {
      const western = { ...baseInput, westernOnly: true };

      it("withholds a public reminder from a high-confidence South-Asian origin", () => {
        expect(
          decideRecovery({
            ...western,
            audienceOrigin: "south_asian",
            audienceOriginConfidence: "high",
          }),
        ).toEqual({ kind: "suppress", reason: "audience_out_of_market" });
      });

      it("applies to the settings fallback too — it is the same public comment", () => {
        expect(
          decideRecovery({
            ...western,
            triggerKind: "settings_blocked",
            audienceOrigin: "south_asian",
            audienceOriginConfidence: "high",
          }),
        ).toEqual({ kind: "suppress", reason: "audience_out_of_market" });
      });

      // inferOrigin leaves ~70% of this audience `unknown`. Withholding those
      // would cancel most of the feature while looking like a targeting rule.
      it("still sends to an unknown origin rather than silently disabling itself", () => {
        expect(
          decideRecovery({ ...western, audienceOrigin: "unknown", audienceOriginConfidence: "low" }),
        ).toEqual({ kind: "send_no_confirmed_read_reminder" });
      });

      // A low-confidence south_asian call cannot happen today, but the guard is
      // written on confidence rather than on origin alone, so a future bio pass
      // that starts emitting low-confidence calls cannot quietly widen this.
      it("does not withhold on a low-confidence South-Asian call", () => {
        expect(
          decideRecovery({
            ...western,
            audienceOrigin: "south_asian",
            audienceOriginConfidence: "low",
          }),
        ).toEqual({ kind: "send_no_confirmed_read_reminder" });
      });

      it("sends to a Western origin", () => {
        expect(
          decideRecovery({ ...western, audienceOrigin: "us_western", audienceOriginConfidence: "low" }),
        ).toEqual({ kind: "send_no_confirmed_read_reminder" });
      });

      it("ignores origin entirely while DM_RECOVERY_WESTERN_ONLY is off", () => {
        expect(
          decideRecovery({
            ...baseInput,
            westernOnly: false,
            audienceOrigin: "south_asian",
            audienceOriginConfidence: "high",
          }),
        ).toEqual({ kind: "send_no_confirmed_read_reminder" });
      });

      // Read evidence is the stronger, truer statement about this row, and the
      // dashboard counts suppression reasons — a read that got relabelled as a
      // market decision would corrupt the experiment's read-rate denominator.
      it("reports read evidence ahead of the market decision", () => {
        expect(
          decideRecovery({
            ...western,
            audienceOrigin: "south_asian",
            audienceOriginConfidence: "high",
            seenAt: new Date("2026-08-06T17:00:00.000Z"),
          }),
        ).toEqual({ kind: "suppress", reason: "seen" });
      });
    });

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
      // A sibling journey's completion never reaches the policy: the completion
      // transaction stamps those rows terminal with `completed_elsewhere`
      // directly, so anything still live here completed on its own journey.
      // `suppressRecoveriesForCompletion` owns that reason and is tested for it.
      ["completed", { conversationCompletedAt: now }, "completed"],
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
