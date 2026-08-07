import type { Conversation } from "../../lib/types";

/**
 * Why a journey shows no read state.
 *
 * Read tracking began on a specific date. A journey that opened before it has no
 * receipts because none were ever collected — which is a different fact from a
 * tracked journey whose receipt never arrived. Saying so keeps the older half of
 * the table from reading as a wall of failures.
 */
export const PREDATES_TRACKING_TEXT =
  "Read status unavailable—journey predates read tracking.";

export type JourneyRowMarkers = {
  /** Secondary line under the row, or null when there is nothing to explain. */
  note: string | null;
  /** Set when a recovery reminder exists for this journey. */
  recovery: { label: string; pending: boolean } | null;
};

/**
 * Pure: the same conversation always produces the same markers.
 *
 * Deliberately says nothing about whether a message was read. Meta exposes no
 * unread signal, so a journey row may report that a reminder is scheduled or
 * that tracking was unavailable — never that someone did not read something.
 */
export function journeyRowMarkers(c: Conversation): JourneyRowMarkers {
  const note = c.readTracking === "predates_tracking" ? PREDATES_TRACKING_TEXT : null;

  if (!c.recovery) return { note, recovery: null };

  // Sent is a fact about the past; everything else is a statement about what is
  // still going to happen, and the row has to be honest about which it is.
  if (c.recovery.sentAt !== null) {
    return { note, recovery: { label: "Reminder sent", pending: false } };
  }

  switch (c.recovery.status) {
    case "waiting":
    case "sending":
      return { note, recovery: { label: "Reminder scheduled", pending: true } };
    case "control":
      return { note, recovery: { label: "Control—no reminder", pending: false } };
    case "send_failed":
    case "send_uncertain":
    case "tracking_unavailable":
      return { note, recovery: { label: "Reminder needs review", pending: false } };
    default:
      // cancelled, suppressed, and anything added later: a reminder existed but
      // will not arrive, and the row should not imply one is coming.
      return { note, recovery: { label: "No reminder", pending: false } };
  }
}
