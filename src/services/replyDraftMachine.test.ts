import { describe, expect, it } from "vitest";
import {
  ACTIVE_DRAFT_STATUSES,
  canTransition,
  isApprovable,
} from "./replyDraftMachine.js";

describe("reply draft transitions", () => {
  it.each([
    ["queued", "generating"],
    ["generating", "pending_approval"],
    ["generating", "generation_failed"],
    ["pending_approval", "sending"],
    ["pending_approval", "dismissed"],
    ["pending_approval", "superseded"],
    ["sending", "sent"],
    ["sending", "send_failed"],
    ["sending", "send_uncertain"],
    ["send_failed", "sending"],
    ["send_uncertain", "sending"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ["queued", "sent"],
    ["pending_approval", "sent"],
    ["sent", "sending"],
    ["dismissed", "sending"],
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("makes only a current pending draft approvable", () => {
    expect(isApprovable("pending_approval")).toBe(true);
    expect(isApprovable("generating")).toBe(false);
    expect(isApprovable("send_failed")).toBe(false);
  });

  // `sent` is the terminal success state: a delivered Instagram message cannot be
  // un-delivered, so nothing may move out of it.
  it("treats sent, dismissed and superseded as terminal", () => {
    for (const terminal of ["sent", "dismissed", "superseded"] as const) {
      for (const to of [
        "queued",
        "generating",
        "pending_approval",
        "sending",
        "sent",
        "send_failed",
      ] as const) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  // A generation failure is surfaced to the owner, never retried by a worker, so
  // the only ways out are the owner regenerating (a NEW revision) or dismissing.
  it("lets a failed generation be dismissed or superseded but never sent", () => {
    expect(canTransition("generation_failed", "dismissed")).toBe(true);
    expect(canTransition("generation_failed", "superseded")).toBe(true);
    expect(canTransition("generation_failed", "sending")).toBe(false);
    expect(canTransition("generation_failed", "pending_approval")).toBe(false);
  });

  it("never allows a transition to itself", () => {
    for (const status of [
      "queued",
      "generating",
      "pending_approval",
      "sending",
      "sent",
    ] as const) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  // Must match the migration's partial unique index exactly, or the database
  // permits two live drafts on one thread while the code assumes one.
  it("defines the active statuses guarded by the partial unique index", () => {
    expect([...ACTIVE_DRAFT_STATUSES]).toEqual(["queued", "generating", "pending_approval"]);
  });

  it("excludes sending from the active set so a claim survives a new inbound", () => {
    // A draft mid-flight to Instagram must NOT be superseded — its outcome is
    // still unknown, and rewriting it would lose the audit trail.
    expect(ACTIVE_DRAFT_STATUSES).not.toContain("sending");
  });
});
