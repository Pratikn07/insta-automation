import { describe, expect, it, vi } from "vitest";
import { createGuideAudienceAuthorizationRepository } from "./guideAudienceAuthorizationRepository.js";

const USER_ID = "17841400000000001";
const IDENTITY_HASH = "a".repeat(64);
const METHOD = "nvidia_guide_audience_v1";

describe("guide audience authorization repository", () => {
  it("reads only the classification for the exact current identity snapshot", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000001",
      igUserId: USER_ID,
      identityHash: IDENTITY_HASH,
      origin: "unknown",
      confidence: "low",
      evidence: "generic handle, no cue",
      provider: "nvidia",
      modelId: "nvidia/nemotron-3.5-lightning-30b-a3b",
      method: METHOD,
      classifiedAt: new Date("2026-09-21T12:00:00.000Z"),
    });
    const repository = createGuideAudienceAuthorizationRepository({
      guideAudienceClassification: { findUnique },
      guideAudienceDecision: { create: vi.fn() },
    } as never);

    await expect(
      repository.findCurrentClassification({
        igUserId: USER_ID,
        identityHash: IDENTITY_HASH,
        method: METHOD,
      }),
    ).resolves.toMatchObject({ origin: "unknown", confidence: "low" });

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        igUserId_identityHash_method: {
          igUserId: USER_ID,
          identityHash: IDENTITY_HASH,
          method: METHOD,
        },
      },
      select: {
        id: true,
        igUserId: true,
        identityHash: true,
        origin: true,
        confidence: true,
        evidence: true,
        provider: true,
        modelId: true,
        method: true,
        classifiedAt: true,
      },
    });
  });

  it("writes a decision without raw profile values or provider bodies", async () => {
    const create = vi.fn().mockResolvedValue({ id: "20000000-0000-4000-8000-000000000001" });
    const repository = createGuideAudienceAuthorizationRepository({
      guideAudienceClassification: { findUnique: vi.fn() },
      guideAudienceDecision: { create },
    } as never);

    await repository.createDecision({
      igUserId: USER_ID,
      identityHash: IDENTITY_HASH,
      kind: "block",
      source: "comment",
      commentId: "17899900000000001",
      classificationId: "10000000-0000-4000-8000-000000000001",
      provider: "nvidia",
      modelId: "nvidia/nemotron-3.5-lightning-30b-a3b",
      method: METHOD,
    });

    const input = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(input).toMatchObject({
      igUserId: USER_ID,
      identityHash: IDENTITY_HASH,
      kind: "block",
      source: "comment",
      commentId: "17899900000000001",
    });
    expect(JSON.stringify(input)).not.toContain("display-name");
    expect(JSON.stringify(input)).not.toContain("provider-response");
  });
});
