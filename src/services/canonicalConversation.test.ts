import { describe, expect, it, vi } from "vitest";
import {
  operationalConversationWhere,
  resolveCanonicalConversation,
} from "./canonicalConversation.js";

describe("canonical conversation authority", () => {
  it("uses one operational predicate for canonical owners and unreconciled history", () => {
    expect(operationalConversationWhere()).toEqual({
      OR: [{ ownedIntents: { some: {} } }, { canonicalIntentId: null }],
    });
  });

  it.each([
    [null, null, "unreconciled", true],
    ["intent-1", "convo-1", "canonical", true],
    ["intent-1", "canonical-1", "alias", false],
  ] as const)(
    "resolves intent %p owned by %p as %s",
    async (canonicalIntentId, canonicalConversationId, role, mayOwnOperationalWork) => {
      const findUnique = vi.fn().mockResolvedValue({
        id: "convo-1",
        igUserId: "person-1",
        keywordId: "keyword-1",
        state: "awaiting_done",
        completedAt: null,
        canonicalIntentId,
        canonicalIntent: canonicalIntentId
          ? { id: canonicalIntentId, canonicalConversationId, completedAt: null }
          : null,
      });
      const result = await resolveCanonicalConversation(
        { conversation: { findUnique } } as never,
        "convo-1",
      );
      expect(result).toMatchObject({ role, mayOwnOperationalWork });
    },
  );
});
