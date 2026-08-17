import { describe, expect, it } from "vitest";
import { journeyRowMarkers, PREDATES_TRACKING_TEXT } from "./journeyRowMarkers";
import type { Conversation, ConversationRecoverySummary } from "../../lib/types";

function convo(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "convo-1",
    igUserId: "ig-1",
    keywordId: "kw-1",
    state: "awaiting_done",
    createdAt: "2026-08-06T00:00:00.000Z",
    completedAt: null,
    keyword: { id: "kw-1", keyword: "SLEEP" },
    username: "sarah",
    ...overrides,
  } as Conversation;
}

function recovery(o: Partial<ConversationRecoverySummary> = {}): ConversationRecoverySummary {
  return {
    id: "rec-1",
    status: "waiting",
    triggerKind: "no_confirmed_read",
    eligibleAt: "2026-08-06T10:00:00.000Z",
    sentAt: null,
    ...o,
  };
}

describe("journeyRowMarkers", () => {
  it("explains an old journey's missing read state instead of leaving it blank", () => {
    expect(journeyRowMarkers(convo({ readTracking: "predates_tracking" })).note).toBe(
      PREDATES_TRACKING_TEXT,
    );
  });

  it.each(["tracked", "not_available", undefined] as const)(
    "adds no note for readTracking=%s",
    (readTracking) => {
      expect(journeyRowMarkers(convo({ readTracking })).note).toBeNull();
    },
  );

  it("shows nothing when no reminder exists for the journey", () => {
    expect(journeyRowMarkers(convo()).recovery).toBeNull();
  });

  it.each([
    ["waiting", "Reminder scheduled", true],
    ["sending", "Reminder scheduled", true],
    ["control", "Control—no reminder", false],
    ["send_failed", "Reminder needs review", false],
    ["send_uncertain", "Reminder needs review", false],
    ["tracking_unavailable", "Reminder needs review", false],
    ["cancelled", "No reminder", false],
    ["suppressed", "No reminder", false],
  ] as const)("labels a %s reminder as %s", (status, label, pending) => {
    const markers = journeyRowMarkers(convo({ recovery: recovery({ status }) }));
    expect(markers.recovery).toEqual({ label, pending });
  });

  // A sent reminder is a fact about the past. Reading the status alone would
  // call a sent-then-cancelled row "no reminder", which is the opposite of what
  // happened to that person.
  it("reports a reminder that was actually sent, whatever the status now says", () => {
    const markers = journeyRowMarkers(
      convo({ recovery: recovery({ status: "cancelled", sentAt: "2026-08-06T11:00:00.000Z" }) }),
    );
    expect(markers.recovery).toEqual({ label: "Sent publicly", pending: false });
  });

  // The product's central claim: Meta exposes no unread signal, so no surface
  // may say a message went unread.
  it("never claims a message is unread", () => {
    const statuses = [
      "waiting", "sending", "control", "send_failed",
      "send_uncertain", "tracking_unavailable", "cancelled", "suppressed",
    ] as const;
    for (const status of statuses) {
      for (const readTracking of ["tracked", "predates_tracking", "not_available"] as const) {
        const m = journeyRowMarkers(convo({ readTracking, recovery: recovery({ status }) }));
        expect(`${m.note ?? ""} ${m.recovery?.label ?? ""}`).not.toMatch(/\bunread\b/i);
      }
    }
  });
});
