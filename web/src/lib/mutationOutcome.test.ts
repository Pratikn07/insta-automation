import { describe, expect, it } from "vitest";
import {
  MutationNotDispatchedError,
  MutationOutcomeUnknownError,
  createOperationId,
} from "./mutationOutcome";

describe("createOperationId", () => {
  it("produces a distinct UUID per call", () => {
    const ids = new Set(Array.from({ length: 100 }, () => createOperationId()));

    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});

describe("mutation outcome errors", () => {
  it("names the operation without carrying the request that produced it", () => {
    const unknown = new MutationOutcomeUnknownError("/ai/drafts/1/approve", "op-1");

    expect(unknown.code).toBe("mutation_outcome_unknown");
    expect(unknown.path).toBe("/ai/drafts/1/approve");
    expect(unknown.operationId).toBe("op-1");
    // The body could be an approved reply to a real person. It is never attached
    // to an error that may reach a log or a toast.
    expect(JSON.stringify(unknown)).not.toContain("body");
    expect(Object.keys(unknown)).not.toContain("init");
  });

  it("distinguishes a request that never left the browser", () => {
    const notDispatched = new MutationNotDispatchedError("/keywords");

    expect(notDispatched.code).toBe("mutation_not_dispatched");
    // The whole point of the distinction: this one is safe to repeat.
    expect(notDispatched).not.toBeInstanceOf(MutationOutcomeUnknownError);
  });

  it("keeps operationId optional for an unkeyed operation", () => {
    expect(new MutationOutcomeUnknownError("/x", undefined).operationId).toBeUndefined();
  });
});
