import { describe, expect, it, vi } from "vitest";
import {
  createGuideAudienceAuthorizationService,
  type GuideAudienceAuthorizationRepository,
} from "./guideAudienceAuthorization.js";
import type { AudienceClassificationProvider } from "./nvidiaAudienceClassifier.js";

const USER_ID = "17841400000000001";
const MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";

function makeRepository(
  identity: { id: string; name: string | null; username: string | null } | null = {
    id: USER_ID,
    name: "Kanimozhi",
    username: "kanimozhi_home",
  },
) {
  const repository: GuideAudienceAuthorizationRepository = {
    findCurrentIdentity: vi.fn().mockResolvedValue(identity),
    findCurrentClassification: vi.fn().mockResolvedValue(null),
    createClassification: vi.fn().mockImplementation(async (input) => ({
      ...input,
      id: "10000000-0000-4000-8000-000000000001",
    })),
    createDecision: vi.fn().mockResolvedValue({ id: "20000000-0000-4000-8000-000000000001" }),
  };
  return repository;
}

function makeProvider(
  verdict: {
    origin: "south_asian" | "us_western" | "other" | "unknown";
    confidence: "high" | "low";
    evidence: string;
  },
): AudienceClassificationProvider {
  return {
    classify: vi.fn().mockResolvedValue({
      modelId: MODEL,
      method: "nvidia_guide_audience_v1",
      verdicts: [{ id: USER_ID, ...verdict }],
    }),
  };
}

function makeService(options: {
  repository?: GuideAudienceAuthorizationRepository;
  provider?: AudienceClassificationProvider;
  enabled?: boolean;
} = {}) {
  const repository = options.repository ?? makeRepository();
  const provider =
    options.provider ??
    makeProvider({
      origin: "south_asian",
      confidence: "high",
      evidence: "Tamil given name",
    });
  return {
    repository,
    provider,
    service: createGuideAudienceAuthorizationService({
      repository,
      provider,
      isEnabled: () => options.enabled ?? true,
      configuredModelId: MODEL,
    }),
  };
}

describe("guide audience authorization", () => {
  it.each(["high", "low"] as const)(
    "blocks a current south_asian result at %s confidence before any caller can send",
    async (confidence) => {
      const test = makeService({
        provider: makeProvider({
          origin: "south_asian",
          confidence,
          evidence: "distinctive synthetic cue",
        }),
      });

      await expect(
        test.service.authorizeNewGuideAction({ igUserId: USER_ID, source: "comment" }),
      ).resolves.toMatchObject({ kind: "block" });

      expect(test.repository.createClassification).toHaveBeenCalledOnce();
      expect(test.repository.createDecision).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "block", source: "comment" }),
      );
    },
  );

  it("allows a schema-valid unknown without creating an audit decision", async () => {
    const test = makeService({
      provider: makeProvider({
        origin: "unknown",
        confidence: "low",
        evidence: "generic handle, no cue",
      }),
    });

    await expect(
      test.service.authorizeNewGuideAction({ igUserId: USER_ID, source: "dm" }),
    ).resolves.toMatchObject({ kind: "allow", enforced: true });

    expect(test.repository.createDecision).not.toHaveBeenCalled();
  });

  it("defers and audits when the provider is unavailable instead of allowing unknown", async () => {
    const repository = makeRepository();
    const test = makeService({
      repository,
      provider: { classify: vi.fn().mockRejectedValue(new Error("private provider body")) },
    });

    await expect(
      test.service.authorizeNewGuideAction({ igUserId: USER_ID, source: "redelivery" }),
    ).resolves.toMatchObject({ kind: "defer", reason: "provider_unavailable" });

    expect(repository.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "defer", source: "redelivery" }),
    );
  });

  it("leaves the existing guide path unchanged while enforcement is disabled", async () => {
    const test = makeService({ enabled: false });

    await expect(
      test.service.authorizeNewGuideAction({ igUserId: USER_ID, source: "dm" }),
    ).resolves.toEqual({ kind: "allow", enforced: false });

    expect(test.provider.classify).not.toHaveBeenCalled();
    expect(test.repository.findCurrentIdentity).not.toHaveBeenCalled();
    expect(test.repository.createDecision).not.toHaveBeenCalled();
  });

  it("defers when the identity changes during classification", async () => {
    const repository = makeRepository();
    vi.mocked(repository.findCurrentIdentity)
      .mockResolvedValueOnce({ id: USER_ID, name: "Kanimozhi", username: "old_handle" })
      .mockResolvedValueOnce({ id: USER_ID, name: "Kanimozhi", username: "new_handle" });
    const test = makeService({ repository });

    await expect(
      test.service.authorizeNewGuideAction({ igUserId: USER_ID, source: "quick_reply" }),
    ).resolves.toMatchObject({ kind: "defer", reason: "identity_changed" });

    expect(repository.createClassification).not.toHaveBeenCalled();
    expect(repository.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "defer", source: "quick_reply" }),
    );
  });
});
