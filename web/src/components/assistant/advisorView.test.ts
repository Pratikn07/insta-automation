import { describe, expect, it } from "vitest";
import type { AiConnectionStatus } from "@/lib/types";
import {
  MAX_QUESTION_LENGTH,
  askErrorMessage,
  assistantView,
  composerState,
  mergeTurns,
  retryAtOf,
} from "./advisorView";

function status(overrides: Partial<AiConnectionStatus> = {}): AiConnectionStatus {
  return {
    connected: true,
    requiresOpenaiAuth: false,
    account: { email: "owner@example.com", planType: "plus" },
    rateLimits: { usedPercent: 10, resetsAt: null },
    ...overrides,
  };
}

const base = { isLoading: false, error: null, advisorEnabled: true };

describe("assistantView", () => {
  it("loads before anything is known", () => {
    expect(assistantView({ ...base, isLoading: true, status: undefined })).toEqual({
      kind: "loading",
    });
  });

  it("reports an unconfigured environment distinctly from an unreachable one", () => {
    const notConfigured = assistantView({
      ...base,
      error: { body: { error: "ai_not_configured" } },
      status: undefined,
    });
    const unreachable = assistantView({
      ...base,
      error: new Error("network down"),
      status: undefined,
    });
    expect(notConfigured.kind).toBe("unavailable");
    expect(unreachable.kind).toBe("unavailable");
    expect(notConfigured).not.toEqual(unreachable);
  });

  it("asks for a connection before mentioning the rollout flag", () => {
    // Connecting is the action the owner can take; naming the flag first would
    // send them looking for a switch that is not the problem.
    expect(
      assistantView({
        ...base,
        advisorEnabled: false,
        status: status({ connected: false }),
      }),
    ).toEqual({ kind: "disconnected" });
  });

  it("asks for re-authorisation when the session is stale", () => {
    expect(assistantView({ ...base, status: status({ requiresOpenaiAuth: true }) })).toEqual({
      kind: "needs-reauth",
    });
  });

  it("reports disabled only once connected and healthy", () => {
    expect(assistantView({ ...base, advisorEnabled: false, status: status() })).toEqual({
      kind: "disabled",
    });
  });

  it("is ready when connected, authorised and enabled", () => {
    expect(assistantView({ ...base, status: status() })).toEqual({ kind: "ready" });
  });
});

describe("composerState", () => {
  const ready = { ready: true, pending: false };

  it("blocks an empty or whitespace question", () => {
    expect(composerState({ ...ready, text: "" })).toMatchObject({ reason: "empty" });
    expect(composerState({ ...ready, text: "   " })).toMatchObject({ reason: "empty" });
  });

  it("blocks a question over the limit", () => {
    expect(composerState({ ...ready, text: "x".repeat(MAX_QUESTION_LENGTH) })).toMatchObject({
      canSubmit: true,
    });
    expect(composerState({ ...ready, text: "x".repeat(MAX_QUESTION_LENGTH + 1) })).toMatchObject({
      reason: "too_long",
    });
  });

  // One persistent thread: a second concurrent turn would interleave with the first.
  it("blocks a second question while one is in flight", () => {
    expect(composerState({ ready: true, pending: true, text: "hi" })).toMatchObject({
      canSubmit: false,
      reason: "in_flight",
    });
  });

  it("blocks everything when the page is not ready", () => {
    expect(composerState({ ready: false, pending: false, text: "hi" })).toMatchObject({
      reason: "not_ready",
    });
  });

  it("allows an ordinary question", () => {
    expect(composerState({ ...ready, text: "What should I focus on?" })).toEqual({
      canSubmit: true,
      reason: null,
    });
  });
});

describe("askErrorMessage", () => {
  it("names the reset time on a usage limit", () => {
    const at = "2026-08-04T12:00:00.000Z";
    const message = askErrorMessage({ body: { error: "runtime_rate_limited" } }, at);
    expect(message).toContain("usage limit");
    expect(message).toContain(new Date(at).toLocaleTimeString());
  });

  it("still explains a usage limit with no usable reset time", () => {
    const message = askErrorMessage({ body: { error: "runtime_rate_limited" } }, null);
    expect(message).toContain("usage limit");
    expect(message).not.toContain("Invalid Date");
  });

  it("points a disconnected account at reconnecting", () => {
    expect(askErrorMessage({ body: { error: "runtime_unauthorized" } }, null)).toMatch(
      /reconnect/i,
    );
  });

  it("says the question is retained on an unknown failure", () => {
    expect(askErrorMessage(new Error("boom"), null)).toMatch(/try again/i);
  });

  it("never surfaces a raw server message", () => {
    const message = askErrorMessage(
      new Error('relation "ig_token" at postgres://user:pw@host/db'),
      null,
    );
    expect(message).not.toMatch(/postgres:\/\/|ig_token/);
  });
});

describe("retryAtOf", () => {
  it("reads a retryAt the server sent", () => {
    expect(retryAtOf({ body: { retryAt: "2026-08-04T12:00:00.000Z" } })).toBe(
      "2026-08-04T12:00:00.000Z",
    );
  });

  it("is null when absent or the wrong shape", () => {
    expect(retryAtOf({ body: { retryAt: null } })).toBeNull();
    expect(retryAtOf(new Error("boom"))).toBeNull();
    expect(retryAtOf(undefined)).toBeNull();
  });
});

describe("mergeTurns", () => {
  const answer = {
    answer: "a",
    recommendation: "b",
    evidence: [],
    confidence: "medium" as const,
    nextStep: "c",
    nextStepHref: null,
    dataGaps: [],
  };
  const turn = { clientMessageId: "msg-1", question: "What now?", response: answer };

  it("shows a session answer that history has not caught up with", () => {
    // The owner already spent quota on this: it must not vanish while a refetch
    // is in flight.
    const items = mergeTurns([], [turn]);
    expect(items.map((i) => i.role)).toEqual(["user", "assistant"]);
    expect(items[0]?.text).toBe("What now?");
    expect(items[1]?.response).toEqual(answer);
  });

  it("does not duplicate a turn history already contains", () => {
    const history = [
      { role: "user" as const, clientMessageId: "msg-1", text: "What now?", response: null },
      { role: "assistant" as const, clientMessageId: "msg-1", text: null, response: answer },
    ];
    expect(mergeTurns(history, [turn])).toEqual(history);
  });

  it("keeps history order and appends only the new turn", () => {
    const history = [
      { role: "user" as const, clientMessageId: "msg-0", text: "earlier", response: null },
      { role: "assistant" as const, clientMessageId: "msg-0", text: null, response: answer },
    ];
    const items = mergeTurns(history, [turn]);
    expect(items).toHaveLength(4);
    expect(items[0]?.text).toBe("earlier");
    expect(items[2]?.text).toBe("What now?");
  });

  it("tolerates history rows with no clientMessageId", () => {
    const history = [
      { role: "user" as const, clientMessageId: null, text: "orphan", response: null },
    ];
    expect(mergeTurns(history, [turn])).toHaveLength(3);
  });
});
