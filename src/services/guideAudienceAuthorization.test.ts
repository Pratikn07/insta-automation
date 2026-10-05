import { describe, expect, it, vi } from "vitest";
import {
  createGuideAudienceAuthorizationService,
  type GuideAudienceAuthorizationServiceDependencies,
} from "./guideAudienceAuthorization.js";

const SUBJECT = {
  id: "ig-1",
  username: "priya_mommy",
  name: "Priya S",
  inferredOrigin: null as string | null,
  originConfidence: null as string | null,
  originMethod: null as string | null,
};

function harness(over: Partial<GuideAudienceAuthorizationServiceDependencies> = {}) {
  const dependencies: GuideAudienceAuthorizationServiceDependencies = {
    repository: {
      findAudienceSubject: vi.fn().mockResolvedValue({ ...SUBJECT }),
      createDecision: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
    classify: vi.fn(),
    persistVerdict: vi.fn().mockResolvedValue(1),
    isEnabled: () => true,
    classifierEnabled: true,
    timeoutMs: 3_000,
    now: () => new Date("2026-09-27T12:00:00.000Z"),
    ...over,
  };
  return {
    service: createGuideAudienceAuthorizationService(dependencies),
    // Read back off the built dependencies, not off the defaults: a mock passed
    // in `over` is the one the service actually calls, so it has to be the one
    // the assertions inspect.
    createDecision: dependencies.repository.createDecision,
    findAudienceSubject: dependencies.repository.findAudienceSubject,
    classify: dependencies.classify,
    persistVerdict: dependencies.persistVerdict,
  };
}

const ACTION = { igUserId: "ig-1", source: "comment" as const, commentId: "c-1" };

describe("guide audience authorization", () => {
  it.each([
    ["south_asian", "high", "block"],
    ["south_asian", "low", "block"],
    ["us_western", "high", "allow"],
    ["us_western", "low", "allow"],
    ["other", "high", "allow"],
    ["other", "low", "allow"],
    ["unknown", "high", "allow"],
    ["unknown", "low", "allow"],
  ])("decides %s/%s as %s from the stored verdict", async (origin, confidence, kind) => {
    const { service, classify } = harness({
      repository: {
        findAudienceSubject: vi.fn().mockResolvedValue({
          ...SUBJECT,
          inferredOrigin: origin,
          originConfidence: confidence,
          originMethod: "llm_v3",
        }),
        createDecision: vi.fn().mockResolvedValue({ id: "audit-1" }),
      },
    });
    expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe(kind);
    expect(classify).not.toHaveBeenCalled();
  });

  it("writes exactly one block row carrying the verdict", async () => {
    const createDecision = vi.fn().mockResolvedValue({ id: "audit-1" });
    const { service } = harness({
      repository: {
        findAudienceSubject: vi.fn().mockResolvedValue({
          ...SUBJECT,
          inferredOrigin: "south_asian",
          originConfidence: "high",
          originMethod: "llm_v3",
        }),
        createDecision,
      },
    });
    await service.authorizeNewGuideAction(ACTION);
    expect(createDecision).toHaveBeenCalledTimes(1);
    expect(createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "block",
        origin: "south_asian",
        confidence: "high",
        source: "comment",
        commentId: "c-1",
        provider: "gemini",
        method: "llm_v3",
      }),
    );
  });

  it("ignores a verdict written by an older prompt version", async () => {
    const { service, classify } = harness({
      repository: {
        findAudienceSubject: vi.fn().mockResolvedValue({
          ...SUBJECT,
          inferredOrigin: "south_asian",
          originConfidence: "high",
          originMethod: "name",
        }),
        createDecision: vi.fn().mockResolvedValue({ id: "audit-1" }),
      },
      classify: vi.fn().mockResolvedValue({
        verdicts: [],
        costUsd: 0,
        modelId: "gemini-2.5-flash",
        promptVersion: "llm_v3",
        finishReason: "STOP",
      }),
    });
    await service.authorizeNewGuideAction(ACTION);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("classifies on a miss, blocks, and writes the verdict back", async () => {
    const { service, classify, persistVerdict, createDecision } = harness({
      classify: vi.fn().mockResolvedValue({
        verdicts: [
          {
            id: "ig-1",
            origin: "south_asian",
            confidence: "high",
            cueKind: "distinctive_cultural",
            audienceSegment: "south_asian",
            evidence: "south asian given name",
          },
        ],
        costUsd: 0.00015,
        modelId: "gemini-2.5-flash",
        promptVersion: "llm_v3",
        finishReason: "STOP",
      }),
    });
    expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("block");
    expect(classify).toHaveBeenCalledWith(
      [{ id: "ig-1", username: "priya_mommy", name: "Priya S" }],
      { timeoutMs: 3_000 },
    );
    expect(persistVerdict).toHaveBeenCalledTimes(1);
    expect(createDecision).toHaveBeenCalledWith(expect.objectContaining({ kind: "block" }));
  });

  it("allows and writes back when the live call returns us_western", async () => {
    const { service, createDecision, persistVerdict } = harness({
      classify: vi.fn().mockResolvedValue({
        verdicts: [
          {
            id: "ig-1",
            origin: "us_western",
            confidence: "high",
            cueKind: "distinctive_cultural",
            audienceSegment: "western",
            evidence: "anglophone given name",
          },
        ],
        costUsd: 0.00015,
        modelId: "gemini-2.5-flash",
        promptVersion: "llm_v3",
        finishReason: "STOP",
      }),
    });
    expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
    expect(persistVerdict).toHaveBeenCalledTimes(1);
    expect(createDecision).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a timeout",
      Object.assign(new Error("timeout of 3000ms exceeded"), {
        isAxiosError: true,
        code: "ECONNABORTED",
      }),
      "provider_timeout",
    ],
    ["any other throw", new Error("boom"), "provider_unavailable"],
  ])("allows on %s and audits it", async (_label, error, deferReason) => {
    const createDecision = vi.fn().mockResolvedValue({ id: "audit-1" });
    const { service } = harness({
      classify: vi.fn().mockRejectedValue(error),
      repository: {
        findAudienceSubject: vi.fn().mockResolvedValue({ ...SUBJECT }),
        createDecision,
      },
    });
    expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
    expect(createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "allow_unverified", deferReason }),
    );
  });

  it("allows on an unreadable response and audits it", async () => {
    const createDecision = vi.fn().mockResolvedValue({ id: "audit-1" });
    const { service } = harness({
      classify: vi.fn().mockResolvedValue({
        verdicts: [],
        costUsd: 0.00015,
        modelId: "gemini-2.5-flash",
        promptVersion: "llm_v3",
        finishReason: "MAX_TOKENS",
      }),
      repository: {
        findAudienceSubject: vi.fn().mockResolvedValue({ ...SUBJECT }),
        createDecision,
      },
    });
    expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
    expect(createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "allow_unverified",
        deferReason: "invalid_provider_response",
      }),
    );
  });

  it("blocks with a null auditId when the audit write fails", async () => {
    const { service } = harness({
      repository: {
        findAudienceSubject: vi.fn().mockResolvedValue({
          ...SUBJECT,
          inferredOrigin: "south_asian",
          originConfidence: "low",
          originMethod: "llm_v3",
        }),
        createDecision: vi.fn().mockRejectedValue(new Error("db down")),
      },
    });
    expect(await service.authorizeNewGuideAction(ACTION)).toEqual({
      kind: "block",
      auditId: null,
    });
  });

  it("allows with no call and no row when the flag is off", async () => {
    const { service, classify, createDecision } = harness({ isEnabled: () => false });
    expect(await service.authorizeNewGuideAction(ACTION)).toEqual({ kind: "allow" });
    expect(classify).not.toHaveBeenCalled();
    expect(createDecision).not.toHaveBeenCalled();
  });

  it("allows with no call when Gemini is disabled and nothing is stored", async () => {
    const { service, classify } = harness({ classifierEnabled: false });
    expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
    expect(classify).not.toHaveBeenCalled();
  });

  // Dash-only placeholders are absent fields, exactly as
  // classifyIdentityPresence already treats them for the enrichment worker.
  it.each([
    ["blank", null, "   "],
    ["dash-only", "-", "---"],
  ])("allows with no call when the identity is %s", async (_label, username, name) => {
    const { service, classify, createDecision } = harness({
      repository: {
        findAudienceSubject: vi.fn().mockResolvedValue({ ...SUBJECT, username, name }),
        createDecision: vi.fn().mockResolvedValue({ id: "audit-1" }),
      },
    });
    expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
    expect(classify).not.toHaveBeenCalled();
    expect(createDecision).not.toHaveBeenCalled();
  });

  it("allows with no call when the person has no row at all", async () => {
    const { service, classify } = harness({
      repository: {
        findAudienceSubject: vi.fn().mockResolvedValue(null),
        createDecision: vi.fn().mockResolvedValue({ id: "audit-1" }),
      },
    });
    expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
    expect(classify).not.toHaveBeenCalled();
  });

  it("allows when the stored read itself throws", async () => {
    const { service } = harness({
      repository: {
        findAudienceSubject: vi.fn().mockRejectedValue(new Error("db down")),
        createDecision: vi.fn().mockResolvedValue({ id: "audit-1" }),
      },
    });
    expect((await service.authorizeNewGuideAction(ACTION)).kind).toBe("allow");
  });
});
