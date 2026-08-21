import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const $transaction = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: { $transaction } }));

const {
  SettingsBlockedVerificationAdminError,
  activateSettingsBlockedVerification,
  retireSettingsBlockedVerification,
} = await import("./settingsBlockedVerificationAdminService.js");

const NOW = new Date("2026-08-08T12:00:00Z");
const TARGET = {
  id: "10000000-0000-4000-8000-000000000017",
  version: "settings-proof-v1",
  graphCode: 10,
  graphSubcode: 12345,
  semanticCategory: "settings_blocked",
  verifiedAt: new Date("2026-08-08T10:00:00Z"),
  validUntil: new Date("2026-09-08T10:00:00Z"),
  evidenceReference: "meta-sandbox/settings-proof-v1",
  evidenceSha256: "a".repeat(64),
  active: false,
  retiredAt: null,
  retirementReason: null,
};

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(TARGET);
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  update.mockReset().mockResolvedValue({ ...TARGET, active: false });
  $transaction.mockReset().mockImplementation(async (callback) =>
    callback({ settingsBlockedVerification: { findUnique, updateMany, update } }),
  );
});

describe("activateSettingsBlockedVerification", () => {
  it("retires the old exact-signature record and conditionally activates the target", async () => {
    await activateSettingsBlockedVerification(TARGET.id, "owner@example.com", NOW);

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        graphCode: 10,
        graphSubcode: 12345,
        active: true,
        retiredAt: null,
        id: { not: TARGET.id },
      },
      data: {
        active: false,
        retiredAt: NOW,
        retirementReason: `superseded_by:${TARGET.id}:owner@example.com`,
      },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: TARGET.id,
        active: false,
        retiredAt: null,
        validUntil: { gt: NOW },
      },
      data: { active: true },
    });
  });

  it.each([
    [{ validUntil: NOW }, "verification_stale"],
    [{ retiredAt: NOW, retirementReason: "old" }, "verification_retired"],
    [{ semanticCategory: "unknown" }, "verification_invalid"],
    [{ evidenceSha256: "not-a-hash" }, "verification_invalid"],
    [{ verifiedAt: new Date("2026-08-08T12:00:01Z") }, "verification_invalid"],
  ])("blocks invalid activation", async (override, reason) => {
    findUnique.mockResolvedValue({ ...TARGET, ...override });

    await expect(
      activateSettingsBlockedVerification(TARGET.id, "owner@example.com", NOW),
    ).rejects.toMatchObject({ reason });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("surfaces a lost activation race as a conflict", async () => {
    updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });

    await expect(
      activateSettingsBlockedVerification(TARGET.id, "owner@example.com", NOW),
    ).rejects.toMatchObject({ reason: "verification_conflict" });
  });

  it("maps a serializable retry conflict to the safe conflict code", async () => {
    $transaction.mockRejectedValue({ code: "P2034" });

    await expect(
      activateSettingsBlockedVerification(TARGET.id, "owner@example.com", NOW),
    ).rejects.toMatchObject({ reason: "verification_conflict" });
  });

  it("maps a raw-query 40001 to the same safe conflict code", async () => {
    $transaction.mockRejectedValue(new Error(
        "Raw query failed. Code: `40001`. Message: `could not serialize access due to concurrent update`",
      ));

    await expect(
      activateSettingsBlockedVerification(TARGET.id, "owner@example.com", NOW),
    ).rejects.toMatchObject({ reason: "verification_conflict" });
  });
});

describe("retireSettingsBlockedVerification", () => {
  it("requires a bounded non-empty reason and retires only an active record", async () => {
    update.mockResolvedValue({ ...TARGET, active: false, retiredAt: NOW });

    await retireSettingsBlockedVerification(
      TARGET.id,
      "controlled verification expired",
      "owner@example.com",
      NOW,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: TARGET.id, active: true, retiredAt: null },
      data: {
        active: false,
        retiredAt: NOW,
        retirementReason: "controlled verification expired (owner@example.com)",
      },
    });
  });

  it("rejects a blank reason before opening a transaction", async () => {
    await expect(
      retireSettingsBlockedVerification(TARGET.id, "   ", "owner@example.com", NOW),
    ).rejects.toBeInstanceOf(SettingsBlockedVerificationAdminError);
    expect($transaction).not.toHaveBeenCalled();
  });
});
