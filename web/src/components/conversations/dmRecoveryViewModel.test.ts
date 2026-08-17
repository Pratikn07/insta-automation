import { describe, expect, it } from "vitest";
import {
  NO_CONFIRMED_READ_TOOLTIP,
  recoveryStatusView,
} from "./dmRecoveryViewModel";
import type { RecoveryReminderRow } from "../../lib/types";

const NOW = new Date("2026-08-06T12:00:00.000Z");
const ELIGIBLE = new Date("2026-08-06T10:00:00.000Z");

const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const afterEligible = (ms: number) => new Date(ELIGIBLE.getTime() + ms).toISOString();

function row(overrides: Partial<RecoveryReminderRow> = {}): RecoveryReminderRow {
  return {
    id: "rec-1",
    conversationId: "convo-1",
    igUserId: "ig-1",
    username: "sarah",
    name: "Sarah",
    keyword: { id: "kw-1", keyword: "SLEEP" },
    media: { id: "media-1", permalink: null, caption: null },
    triggerKind: "no_confirmed_read",
    status: "waiting",
    cohort: "treatment",
    experimentVersion: null,
    timingArm: null,
    timingLabel: null,
    acceptedAt: hoursAgo(12),
    eligibleAt: ELIGIBLE.toISOString(),
    seenAt: null,
    engagedAt: null,
    firstEngagementKind: null,
    suppressionReason: null,
    sentAt: null,
    attempts: 0,
    lastAttemptAt: null,
    lastErrorCategory: null,
    reviewedAt: null,
    createdAt: hoursAgo(22),
    settingsEvidence: null,
    ...overrides,
  };
}

describe("recoveryStatusView", () => {
  it.each([
    [row({ status: "waiting", eligibleAt: hoursFromNow(2) }), "Waiting for read confirmation"],
    [row({ status: "waiting", eligibleAt: hoursAgo(1) }), "No confirmed read"],
    [row({ status: "suppressed", suppressionReason: "seen" }), "Seen—reminder not needed"],
    [row({ status: "suppressed", suppressionReason: "inbound_reply" }), "Replied—reminder not needed"],
    [row({ status: "suppressed", suppressionReason: "reaction" }), "Reacted—reminder not needed"],
    [row({ status: "suppressed", suppressionReason: "completed" }), "Completed—reminder not needed"],
    [
      row({ status: "suppressed", suppressionReason: "person_cooldown" }),
      "Another reminder was recently sent",
    ],
    [row({ status: "sent", sentAt: afterEligible(30_000) }), "Reminder sent"],
    [
      row({ status: "sent", sentAt: afterEligible(19 * 3600_000) }),
      "Reminder sent late after worker delay",
    ],
    [row({ triggerKind: "settings_blocked", status: "waiting" }), "Settings blocked"],
    [row({ status: "control" }), "Control group—reminder intentionally withheld"],
    [
      row({ status: "suppressed", suppressionReason: "audience_out_of_market" }),
      "Withheld by the audience filter",
    ],
    [row({ status: "tracking_unavailable" }), "Tracking unavailable"],
    [row({ status: "cancelled" }), "Cancelled by owner"],
    [row({ status: "send_failed" }), "Couldn’t post public reminder"],
    [row({ status: "send_uncertain" }), "Send outcome uncertain—check Instagram"],
  ])("maps recovery evidence to %#", (input, expected) => {
    expect(recoveryStatusView(input, NOW).label).toBe(expected);
  });

  // The product claim this whole feature rests on. Meta gives no unread signal,
  // so no surface may say a message is unread — only that no read was confirmed.
  it("never claims a message is Unread", () => {
    const statuses: Array<RecoveryReminderRow["status"]> = [
      "waiting", "control", "suppressed", "sending", "sent",
      "send_failed", "send_uncertain", "tracking_unavailable", "cancelled",
    ];
    for (const status of statuses) {
      const view = recoveryStatusView(row({ status }), NOW);
      const text = `${view.label} ${view.description}`;
      expect(text).not.toMatch(/\bUnread\b/);
    }
    expect(NO_CONFIRMED_READ_TOOLTIP).not.toMatch(/\bUnread\b/);
  });

  it("pins the no-confirmed-read explanation exactly", () => {
    expect(NO_CONFIRMED_READ_TOOLTIP).toBe(
      "Meta accepted the DM, but we received no read confirmation. It may be unread, in Requests or Hidden Requests, blocked after acceptance, or read without an available receipt.",
    );
    expect(recoveryStatusView(row({ eligibleAt: hoursAgo(1) }), NOW).description).toBe(
      NO_CONFIRMED_READ_TOOLTIP,
    );
  });

  // A settings rejection is a different fact about a different failure, so it
  // outranks whatever the read evidence happens to say.
  it("gives the settings trigger precedence over read state", () => {
    const view = recoveryStatusView(
      row({ triggerKind: "settings_blocked", status: "waiting", eligibleAt: hoursAgo(5) }),
      NOW,
    );
    expect(view.label).toBe("Settings blocked");
  });

  // Late means later than the worker could reasonably have got to it, not one
  // millisecond past eligibility — otherwise every send looks late.
  it.each([
    ["one second after eligibility", afterEligible(1_000), false],
    ["fifty-nine seconds after", afterEligible(59_000), false],
    ["two minutes after", afterEligible(120_000), true],
  ])("treats a send %s as late=%s", (_label, sentAt, expectedLate) => {
    const view = recoveryStatusView(row({ status: "sent", sentAt }), NOW);
    expect(view.label === "Reminder sent late after worker delay").toBe(expectedLate);
  });

  describe("owner actions", () => {
    it.each(["waiting", "control", "tracking_unavailable", "send_failed"] as const)(
      "allows cancelling an unsent %s item",
      (status) => {
        expect(recoveryStatusView(row({ status }), NOW).canCancel).toBe(true);
      },
    );

    it("never allows cancellation of the v2 no-reminder arm", () => {
      const view = recoveryStatusView(
        row({
          status: "control",
          cohort: "control",
          experimentVersion: "read-recovery-timing-v2",
          timingArm: "no_reminder",
          timingLabel: "No reminder",
        }),
        NOW,
      );

      expect(view.canCancel).toBe(false);
      expect(view.label).toBe("No-reminder experiment arm");
      expect(view.description).toMatch(/intentionally held back for measurement/i);
    });

    it("keeps legacy control cancellation and language unchanged", () => {
      const view = recoveryStatusView(row({ status: "control", cohort: "control" }), NOW);

      expect(view.canCancel).toBe(true);
      expect(view.label).toBe("Control group—reminder intentionally withheld");
    });

    it.each(["sending", "sent", "send_uncertain", "cancelled", "suppressed"] as const)(
      "refuses to cancel %s",
      (status) => {
        expect(recoveryStatusView(row({ status }), NOW).canCancel).toBe(false);
      },
    );

    it.each(["send_failed", "send_uncertain", "tracking_unavailable"] as const)(
      "offers review for %s",
      (status) => {
        const view = recoveryStatusView(row({ status }), NOW);
        expect(view.canMarkReviewed).toBe(true);
        expect(view.attention).toBe(true);
      },
    );

    it("does not offer review for a healthy row", () => {
      expect(recoveryStatusView(row({ status: "sent" }), NOW).canMarkReviewed).toBe(false);
      expect(recoveryStatusView(row({ status: "sent" }), NOW).attention).toBe(false);
    });

    it("stops offering review once it has been reviewed", () => {
      const view = recoveryStatusView(
        row({ status: "send_uncertain", reviewedAt: hoursAgo(1) }),
        NOW,
      );
      expect(view.canMarkReviewed).toBe(false);
    });
  });

  // A row withheld by the filter must not read like an ordinary suppression:
  // an operator auditing verdicts cannot review what they cannot distinguish.
  it("distinguishes an audience withholding from evidence-based suppression", () => {
    const filtered = recoveryStatusView(
      row({ status: "suppressed", suppressionReason: "audience_out_of_market" }),
      NOW,
    );
    const seen = recoveryStatusView(
      row({ status: "suppressed", suppressionReason: "seen" }),
      NOW,
    );

    expect(filtered.label).not.toBe(seen.label);
    expect(filtered.description).not.toBe(seen.description);
    expect(filtered.description).toMatch(/name-based inference, not measured location/);
  });

  it("labels a due treatment row's action state separately from its evidence", () => {
    const view = recoveryStatusView(row({ eligibleAt: hoursAgo(1) }), NOW);
    expect(view.label).toBe("No confirmed read");
    expect(view.actionState).toBe("Reminder ready");
  });
});
