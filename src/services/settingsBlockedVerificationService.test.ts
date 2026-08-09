import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const findUnique = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    settingsBlockedVerification: { findFirst, findUnique },
  },
}));

const {
  SettingsBlockedVerificationError,
  resolveActiveSettingsBlockedVerification,
  validateSettingsBlockedVerificationEvidence,
} = await import("./settingsBlockedVerificationService.js");

const NOW = new Date("2026-08-08T12:00:00.000Z");
const ACTIVE_RECORD = {
  id: "10000000-0000-4000-8000-000000000017",
  version: "settings-proof-2026-08-08-v1",
  graphCode: 10,
  graphSubcode: 12345,
  semanticCategory: "settings_blocked",
  verifiedAt: new Date("2026-08-08T10:00:00.000Z"),
  validUntil: new Date("2026-09-08T10:00:00.000Z"),
  evidenceReference: "meta-sandbox/settings-proof-2026-08-08-v1",
  evidenceSha256: "a".repeat(64),
  active: true,
  retiredAt: null,
};

const METADATA = {
  category: "graph_response" as const,
  httpStatus: 400,
  graphCode: 10,
  graphSubcode: 12345,
  transportCode: null,
  fbtraceId: null,
};

beforeEach(() => {
  findFirst.mockReset();
  findUnique.mockReset();
  findFirst.mockResolvedValue(ACTIVE_RECORD);
  findUnique.mockResolvedValue(ACTIVE_RECORD);
});

describe("resolveActiveSettingsBlockedVerification", () => {
  it("returns only the immutable safe evidence for an active exact signature", async () => {
    const evidence = await resolveActiveSettingsBlockedVerification(METADATA, NOW);

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        graphCode: 10,
        graphSubcode: 12345,
        active: true,
        retiredAt: null,
      },
      orderBy: [{ verifiedAt: "desc" }, { id: "asc" }],
    });
    expect(evidence).toEqual({
      verificationId: ACTIVE_RECORD.id,
      verificationVersion: ACTIVE_RECORD.version,
      graphCode: 10,
      graphSubcode: 12345,
      classifiedAt: NOW,
      verifiedAt: ACTIVE_RECORD.verifiedAt,
      validUntil: ACTIVE_RECORD.validUntil,
      evidenceReference: ACTIVE_RECORD.evidenceReference,
      evidenceSha256: ACTIVE_RECORD.evidenceSha256,
    });
    expect(evidence).not.toHaveProperty("verifierIdentity");
    expect(evidence).not.toHaveProperty("controlledAccountContext");
  });

  it.each([
    [{ ...METADATA, graphCode: null }, "verification_missing"],
    [{ ...METADATA, graphSubcode: null }, "verification_missing"],
    [{ ...METADATA, graphCode: 10.5 }, "verification_missing"],
  ])("rejects malformed or incomplete Graph evidence", async (metadata, reason) => {
    await expect(resolveActiveSettingsBlockedVerification(metadata, NOW)).rejects.toMatchObject({
      reason,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("rejects an unknown exact signature", async () => {
    findFirst.mockResolvedValue(null);

    await expect(resolveActiveSettingsBlockedVerification(METADATA, NOW)).rejects.toMatchObject({
      reason: "verification_missing",
    });
  });

  it("rejects a stale record even if it was left active", async () => {
    findFirst.mockResolvedValue({
      ...ACTIVE_RECORD,
      validUntil: new Date("2026-08-08T11:59:59.999Z"),
    });

    await expect(resolveActiveSettingsBlockedVerification(METADATA, NOW)).rejects.toMatchObject({
      reason: "verification_stale",
    });
  });

  it("rejects a future-dated verification", async () => {
    findFirst.mockResolvedValue({
      ...ACTIVE_RECORD,
      verifiedAt: new Date("2026-08-08T12:00:01.000Z"),
    });

    await expect(resolveActiveSettingsBlockedVerification(METADATA, NOW)).rejects.toMatchObject({
      reason: "verification_mismatch",
    });
  });
});

describe("validateSettingsBlockedVerificationEvidence", () => {
  const evidence = {
    verificationId: ACTIVE_RECORD.id,
    verificationVersion: ACTIVE_RECORD.version,
    graphCode: 10,
    graphSubcode: 12345,
    classifiedAt: NOW,
    verifiedAt: ACTIVE_RECORD.verifiedAt,
    validUntil: ACTIVE_RECORD.validUntil,
    evidenceReference: ACTIVE_RECORD.evidenceReference,
    evidenceSha256: ACTIVE_RECORD.evidenceSha256,
  };

  it("accepts an exact active record", async () => {
    await expect(validateSettingsBlockedVerificationEvidence(evidence, NOW)).resolves.toEqual(
      evidence,
    );
  });

  it.each([
    [{ active: false, retiredAt: new Date("2026-08-08T11:00:00Z") }, "verification_retired"],
    [{ validUntil: new Date("2026-08-08T11:59:59Z") }, "verification_stale"],
    [{ graphSubcode: 99999 }, "verification_mismatch"],
    [{ evidenceSha256: "b".repeat(64) }, "verification_mismatch"],
  ])("rejects invalid persisted evidence", async (recordOverride, reason) => {
    findUnique.mockResolvedValue({ ...ACTIVE_RECORD, ...recordOverride });

    await expect(
      validateSettingsBlockedVerificationEvidence(evidence, NOW),
    ).rejects.toMatchObject({ reason });
  });

  it("uses a typed error without leaking raw provider evidence", () => {
    const error = new SettingsBlockedVerificationError("verification_missing");
    expect(error.message).toBe("settings_blocked_verification_rejected:verification_missing");
    expect(JSON.stringify(error)).not.toContain("provider");
  });
});
