import { describe, expect, it, vi } from "vitest";
import {
  candidatesForMode,
  classifyRecoveryCandidates,
  executeRecoveryCommand,
  formatRecoveryAudit,
  parseRecoveryCliArgs,
  type RecoveryAttemptInput,
  type RecoveryExecutionDependencies,
} from "./guide-access-recovery-core.js";

const NOW = new Date("2026-08-24T22:00:00.000Z");
const START = new Date("2026-08-24T16:00:00.000Z");

function attempt(overrides: Partial<RecoveryAttemptInput> = {}): RecoveryAttemptInput {
  return {
    attemptId: "attempt-private",
    conversationId: "conversation-private",
    senderId: "parent-private",
    resourceName: "Bedtime",
    state: "needs_review",
    lastFollowResult: "non_follower",
    followCheckCount: 3,
    followResponseCount: 2,
    messagingWindowExpiresAt: new Date("2026-08-25T16:30:00.000Z"),
    createdAt: new Date("2026-08-24T16:30:00.000Z"),
    updatedAt: new Date("2026-08-24T20:00:00.000Z"),
    hasDelivery: false,
    tokens: [],
    inboundMessages: [],
    ...overrides,
  };
}

describe("guide access recovery classification", () => {
  it("selects only the historical three-check/two-response review without a delivery", () => {
    const audit = classifyRecoveryCandidates([attempt()], NOW, START);
    expect(audit.candidates).toHaveLength(1);
    expect(audit.candidates[0]?.kind).toBe("counter_constraint_review");

    const excluded = classifyRecoveryCandidates([attempt({ hasDelivery: true })], NOW, START);
    expect(excluded.candidates).toHaveLength(0);
    expect(excluded.excluded).toEqual({ delivery_owns_recovery: 1 });
  });

  it("finds an opening tap captured after the old short token expired", () => {
    const audit = classifyRecoveryCandidates([
      attempt({
        state: "awaiting_request",
        lastFollowResult: "unknown",
        followCheckCount: 0,
        followResponseCount: 0,
        tokens: [{
          id: "token-private",
          action: "request_guide",
          status: "expired",
          expiresAt: new Date("2026-08-24T16:40:00.000Z"),
          createdAt: new Date("2026-08-24T16:30:00.000Z"),
        }],
        inboundMessages: [{
          id: "inbound-private",
          eventAt: new Date("2026-08-24T17:00:00.000Z"),
        }],
      }),
    ], NOW, START);
    expect(audit.candidates.map((row) => row.kind)).toEqual(["swallowed_opening_action"]);
  });

  // A token that was already acted on is not evidence of a swallowed tap, whatever its
  // expiry says. This surfaced for real on 2026-08-25: an owner `resendAction` puts the
  // attempt back into `awaiting_request`, and the classifier then re-flagged that parent's
  // long-consumed 10-minute token as needing a replay. Replaying a consumed token cannot
  // help the parent and sends an operator after somebody who has already been handled.
  it.each(["consumed", "cancelled"] as const)(
    "ignores a %s opening token when looking for swallowed taps",
    (status) => {
      const audit = classifyRecoveryCandidates([
        attempt({
          state: "awaiting_request",
          lastFollowResult: "unknown",
          followCheckCount: 0,
          followResponseCount: 0,
          tokens: [{
            id: "token-private",
            action: "request_guide",
            status,
            expiresAt: new Date("2026-08-24T16:40:00.000Z"),
            createdAt: new Date("2026-08-24T16:30:00.000Z"),
          }],
          inboundMessages: [{
            id: "inbound-private",
            eventAt: new Date("2026-08-24T17:00:00.000Z"),
          }],
        }),
      ], NOW, START);
      expect(audit.candidates).toHaveLength(0);
    },
  );

  it("finds logically expired tokens still labelled active", () => {
    const audit = classifyRecoveryCandidates([
      attempt({
        state: "awaiting_follow",
        tokens: [{
          id: "token-private",
          action: "check_follow",
          status: "active",
          expiresAt: new Date("2026-08-24T21:00:00.000Z"),
          createdAt: new Date("2026-08-24T20:00:00.000Z"),
        }],
      }),
    ], NOW, START);
    expect(audit.candidates.map((row) => row.kind)).toEqual(["logically_expired_active_token"]);
  });

  it("excludes terminal and pre-incident attempts from incident repairs", () => {
    const terminal = classifyRecoveryCandidates([
      attempt({ state: "delivered" }),
      attempt({ state: "expired" }),
      attempt({ createdAt: new Date("2026-08-24T15:00:00.000Z") }),
    ], NOW, START);
    expect(terminal.candidates).toHaveLength(0);
    expect(terminal.excluded).toEqual({ outside_incident_window: 1 });
  });

  it("does not select a closed swallowed action for Instagram replay", () => {
    const audit = classifyRecoveryCandidates([
      attempt({
        state: "awaiting_request",
        messagingWindowExpiresAt: new Date("2026-08-24T21:30:00.000Z"),
        tokens: [{
          id: "token-private",
          action: "request_guide",
          status: "expired",
          expiresAt: new Date("2026-08-24T16:40:00.000Z"),
          createdAt: new Date("2026-08-24T16:30:00.000Z"),
        }],
        inboundMessages: [{ id: "inbound-private", eventAt: new Date("2026-08-24T17:00:00.000Z") }],
      }),
    ], NOW, START);
    expect(audit.candidates).toHaveLength(1);
    expect(candidatesForMode(audit, "replay-swallowed-actions")).toHaveLength(0);
  });
});

describe("guide access recovery CLI safety", () => {
  it("defaults to a read-only audit", () => {
    expect(parseRecoveryCliArgs([])).toEqual({ mode: "audit", apply: false, sendInstagram: false });
  });

  it("performs no writes when run with no arguments", async () => {
    const writes = [vi.fn(), vi.fn(), vi.fn()];
    const output = await executeRecoveryCommand(parseRecoveryCliArgs([]), {
      load: vi.fn().mockResolvedValue({ candidates: [], excluded: {} }),
      normalizeTokenStatus: writes[0]!,
      releaseCounterReviews: writes[1]!,
      replaySwallowedAction: writes[2]!,
    });
    expect(output).toContain("Selected candidates: 0");
    writes.forEach((write) => expect(write).not.toHaveBeenCalled());
  });

  it("requires an exact count and actor before any write", () => {
    expect(() => parseRecoveryCliArgs(["--mode", "normalize-token-status", "--apply"]))
      .toThrow("--expected-count");
    expect(() => parseRecoveryCliArgs([
      "--mode", "normalize-token-status", "--apply", "--expected-count", "1",
    ])).toThrow("--actor");
  });

  it("requires an extra explicit flag before contacting Instagram", () => {
    expect(() => parseRecoveryCliArgs([
      "--mode", "replay-swallowed-actions", "--apply", "--expected-count", "1", "--actor", "owner",
    ])).toThrow("--send-instagram");
  });

  it("hard-fails count drift before opening a write path", async () => {
    const write = vi.fn();
    const dependencies = {
      load: vi.fn().mockResolvedValue({ candidates: [], excluded: {} }),
      normalizeTokenStatus: write,
      releaseCounterReviews: vi.fn(),
      replaySwallowedAction: vi.fn(),
    } satisfies RecoveryExecutionDependencies;
    await expect(executeRecoveryCommand({
      mode: "normalize-token-status",
      apply: true,
      sendInstagram: false,
      actor: "owner",
      expectedCount: 1,
    }, dependencies)).rejects.toThrow("candidate count drift");
    expect(write).not.toHaveBeenCalled();
  });

  it("prints resource aggregates but never private journey identifiers", () => {
    const audit = classifyRecoveryCandidates([attempt()], NOW, START);
    const output = formatRecoveryAudit(audit);
    expect(output).toContain("Bedtime: 1");
    for (const forbidden of ["attempt-private", "conversation-private", "parent-private"]) {
      expect(output).not.toContain(forbidden);
    }
  });

  it("stops a replay batch immediately on an uncertain outcome", async () => {
    const candidate = {
      ...classifyRecoveryCandidates([attempt()], NOW, START).candidates[0]!,
      kind: "swallowed_opening_action" as const,
      tokenId: "token-private",
      inboundMessageId: "inbound-private",
      inboundEventAt: NOW,
    };
    const replay = vi.fn().mockResolvedValue("needs_review");
    await expect(executeRecoveryCommand({
      mode: "replay-swallowed-actions",
      apply: true,
      expectedCount: 2,
      actor: "owner",
      sendInstagram: true,
    }, {
      load: vi.fn().mockResolvedValue({ candidates: [candidate, { ...candidate, attemptId: "second" }], excluded: {} }),
      normalizeTokenStatus: vi.fn(),
      releaseCounterReviews: vi.fn(),
      replaySwallowedAction: replay,
    })).rejects.toThrow("uncertain outcome");
    expect(replay).toHaveBeenCalledTimes(1);
  });
});
