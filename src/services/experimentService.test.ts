import { beforeEach, describe, expect, it, vi } from "vitest";

const experimentCreate = vi.fn();
const experimentFindUnique = vi.fn();
const snapshotFindFirst = vi.fn();
const profileFindMany = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    experiment: { create: experimentCreate, findUnique: experimentFindUnique },
    geoDemographicSnapshot: { findFirst: snapshotFindFirst },
    reelContentProfile: { findMany: profileFindMany },
  },
}));

const { createExperiment } = await import("./experimentService.js");

const EXPERIMENT_ID = "40000000-0000-4000-8000-000000000001";

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPERIMENT_ID,
    hypothesis: "Slower hooks reach more US viewers",
    variable: "hook pacing",
    reelMediaIds: ["reel-1"],
    status: "running",
    baselineUsPct: 41,
    measuredUsPct: null,
    startedAt: new Date("2026-08-16T10:00:00.000Z"),
    postedAt: new Date("2026-08-16T09:00:00.000Z"),
    conclusion: null,
    origin: "manual",
    mediaId: null,
    usFitScore: null,
    culturalCues: [],
    baselineEngagedUsPct: null,
    measuredEngagedUsPct: null,
    windowReachShare: null,
    suggestedVerdict: null,
    attributionConfidence: null,
    ...overrides,
  };
}

const input = {
  id: EXPERIMENT_ID,
  hypothesis: "Slower hooks reach more US viewers",
  variable: "hook pacing",
  reelMediaIds: ["reel-1"],
  postedAt: "2026-08-16T09:00:00.000Z",
};

function primaryKeyViolation() {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target: ["id"] },
  });
}

beforeEach(() => {
  experimentCreate.mockReset().mockResolvedValue(stored());
  experimentFindUnique.mockReset().mockResolvedValue(null);
  // A *new* measurement, different from the stored baseline, so a recapture would
  // be visible rather than coincidentally equal.
  snapshotFindFirst.mockReset().mockResolvedValue({ usPct: 58 });
  profileFindMany.mockReset().mockResolvedValue([]);
});

describe("createExperiment replay", () => {
  it("captures the baseline once for a genuine create", async () => {
    const result = await createExperiment(input);

    expect(result.status).toBe("created");
    expect(experimentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: EXPERIMENT_ID, baselineUsPct: 58 }),
    });
  });

  // A baseline is the measurement the experiment is judged against. Re-reading it
  // days later would silently move the goalposts of an experiment already running.
  it("never re-measures the baseline for a replay", async () => {
    experimentFindUnique.mockResolvedValue(stored());

    const result = await createExperiment(input);

    expect(result.status).toBe("replayed");
    expect(experimentCreate).not.toHaveBeenCalled();
    expect(snapshotFindFirst).not.toHaveBeenCalled();
    expect(result.experiment?.baselineUsPct).toBe(41);
  });

  it("keeps the stored baseline when the race lands on the primary key", async () => {
    // Not found on the first look, then the insert loses to a concurrent replay.
    experimentFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(stored());
    experimentCreate.mockRejectedValueOnce(primaryKeyViolation());

    const result = await createExperiment(input);

    expect(result.status).toBe("replayed");
    expect(result.experiment?.baselineUsPct).toBe(41);
  });

  it("reports a conflict when the same UUID carries a different hypothesis", async () => {
    experimentFindUnique.mockResolvedValue(stored({ hypothesis: "Something else" }));

    const result = await createExperiment(input);

    expect(result.status).toBe("conflict");
    expect(experimentCreate).not.toHaveBeenCalled();
  });

  it("reports a conflict when the tested reels differ", async () => {
    experimentFindUnique.mockResolvedValue(stored({ reelMediaIds: ["reel-1", "reel-2"] }));

    expect((await createExperiment(input)).status).toBe("conflict");
  });

  it("treats a reordered reel list as a different experiment", async () => {
    experimentFindUnique.mockResolvedValue(stored({ reelMediaIds: ["reel-2", "reel-1"] }));

    expect(
      (await createExperiment({ ...input, reelMediaIds: ["reel-1", "reel-2"] })).status,
    ).toBe("conflict");
  });
});
