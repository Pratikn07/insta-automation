import { describe, it, expect, vi, beforeEach } from "vitest";

const upsert = vi.fn();
const findUnique = vi.fn();
const graphGet = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: { igUser: { upsert, findUnique } } }));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../meta/graphClient.js", () => ({ graph: { get: graphGet } }));
vi.mock("./eventLogger.js", () => ({ describeGraphError: () => ({ category: "test" }) }));

const { rememberUsername, resolveUsername } = await import("./igUserService.js");

/** The four columns retired when the identity behind a verdict changes. */
const CLEARED = {
  inferredOrigin: null,
  originConfidence: null,
  originEvidence: null,
  originCheckedAt: null,
};

beforeEach(() => {
  for (const fn of [upsert, findUnique, graphGet]) fn.mockReset();
  upsert.mockResolvedValue({ id: "ig-1", username: null, name: null });
});

describe("origin verdict lifecycle", () => {
  // The stored verdict is a judgement about one name/username pair. Once that
  // pair changes it describes someone who no longer presents under that name,
  // so it is retired rather than left to gate a send on stale evidence.
  it("retires the verdict when a username changes", async () => {
    findUnique.mockResolvedValue({ username: "old_handle", name: "A Name" });

    await rememberUsername("ig-1", "new_handle", "A Name");

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining(CLEARED) }),
    );
  });

  it("retires the verdict when a display name changes", async () => {
    findUnique.mockResolvedValue({ username: "same_handle", name: "Old Name" });

    await rememberUsername("ig-1", "same_handle", "New Name");

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining(CLEARED) }),
    );
  });

  // Names are re-sent on every webhook, so clearing on an unchanged identity
  // would re-queue the whole audience continuously and spend the daily budget
  // re-deriving answers already held.
  it("keeps the verdict when the identity is unchanged", async () => {
    findUnique.mockResolvedValue({ username: "same_handle", name: "Same Name" });

    await rememberUsername("ig-1", "same_handle", "Same Name");

    const { update } = upsert.mock.calls[0][0];
    expect(update).not.toHaveProperty("originCheckedAt");
    expect(update).not.toHaveProperty("inferredOrigin");
  });

  it("adds no reset for a user being created for the first time", async () => {
    findUnique.mockResolvedValue(null);

    await rememberUsername("ig-1", "new_handle", "New Name");

    const { update } = upsert.mock.calls[0][0];
    expect(update).not.toHaveProperty("originCheckedAt");
  });

  it("retires the verdict on the resolve path too", async () => {
    findUnique.mockResolvedValue({ username: "old_handle", name: "Old Name" });
    graphGet.mockResolvedValue({
      data: { username: "new_handle", name: "New Name", is_user_follow_business: true },
    });

    await resolveUsername("ig-1");

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining(CLEARED) }),
    );
  });
});
