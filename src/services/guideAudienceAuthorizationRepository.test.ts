import { describe, expect, it, vi } from "vitest";
import { createGuideAudienceAuthorizationRepository } from "./guideAudienceAuthorizationRepository.js";

const USER_ID = "17841400000000001";
const IDENTITY_HASH = "a".repeat(64);
const METHOD = "llm_v3";

describe("guide audience authorization repository", () => {
  it("reads the identity and the stored verdict in one query", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: USER_ID,
      username: "priya_mommy",
      name: "Priya S",
      inferredOrigin: "south_asian",
      originConfidence: "high",
      originMethod: METHOD,
    });
    const repository = createGuideAudienceAuthorizationRepository({
      igUser: { findUnique },
      guideAudienceDecision: { create: vi.fn() },
    } as never);

    await expect(repository.findAudienceSubject(USER_ID)).resolves.toMatchObject({
      inferredOrigin: "south_asian",
      originConfidence: "high",
      originMethod: METHOD,
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: {
        id: true,
        username: true,
        name: true,
        inferredOrigin: true,
        originConfidence: true,
        originMethod: true,
      },
    });
  });

  it("returns null for a person we have never resolved", async () => {
    const repository = createGuideAudienceAuthorizationRepository({
      igUser: { findUnique: vi.fn().mockResolvedValue(null) },
      guideAudienceDecision: { create: vi.fn() },
    } as never);

    await expect(repository.findAudienceSubject(USER_ID)).resolves.toBeNull();
  });

  it("writes a decision without raw profile values or provider bodies", async () => {
    const create = vi.fn().mockResolvedValue({ id: "20000000-0000-4000-8000-000000000001" });
    const repository = createGuideAudienceAuthorizationRepository({
      igUser: { findUnique: vi.fn() },
      guideAudienceDecision: { create },
    } as never);

    await repository.createDecision({
      igUserId: USER_ID,
      identityHash: IDENTITY_HASH,
      kind: "block",
      source: "comment",
      commentId: "17899900000000001",
      origin: "south_asian",
      confidence: "high",
      provider: "gemini",
      modelId: "gemini-2.5-flash",
      method: METHOD,
    });

    const input = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(input).toMatchObject({
      igUserId: USER_ID,
      identityHash: IDENTITY_HASH,
      kind: "block",
      source: "comment",
      commentId: "17899900000000001",
      origin: "south_asian",
      confidence: "high",
      provider: "gemini",
    });
    expect(JSON.stringify(input)).not.toContain("display-name");
    expect(JSON.stringify(input)).not.toContain("provider-response");
  });

  // Prisma rejects `undefined` in a create for a column it must set explicitly,
  // so every optional field has to arrive as an explicit null.
  it("maps every omitted optional field to an explicit null", async () => {
    const create = vi.fn().mockResolvedValue({ id: "20000000-0000-4000-8000-000000000002" });
    const repository = createGuideAudienceAuthorizationRepository({
      igUser: { findUnique: vi.fn() },
      guideAudienceDecision: { create },
    } as never);

    await repository.createDecision({
      igUserId: USER_ID,
      identityHash: IDENTITY_HASH,
      kind: "allow_unverified",
      source: "dm",
      deferReason: "provider_timeout",
      provider: "gemini",
      modelId: "gemini-2.5-flash",
      method: METHOD,
    });

    expect(create.mock.calls[0]?.[0]?.data).toMatchObject({
      kind: "allow_unverified",
      deferReason: "provider_timeout",
      origin: null,
      confidence: null,
      conversationId: null,
      commentId: null,
      inboundMessageId: null,
      resourceId: null,
    });
  });
});
