import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const update = vi.fn();
const classifyOrigins = vi.fn();
const logEvent = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { igUser: { findMany, update } },
}));
const loggerError = vi.fn();
vi.mock("../lib/logger.js", () => ({
  logger: { error: loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../meta/geminiClient.js", () => ({ geminiEnabled: true }));
vi.mock("./eventLogger.js", () => ({ logEvent }));

const env = {
  DM_RECOVERY_ORIGIN_LLM_ENABLED: true,
  DM_RECOVERY_ORIGIN_BATCH_SIZE: 25,
  GEMINI_DAILY_BUDGET_USD: 5,
};
vi.mock("../config/env.js", () => ({ env }));

vi.mock("./originClassifier.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, classifyOrigins };
});

const { runOriginEnrichmentTick, _resetOriginSpendState } = await import(
  "./originEnrichmentWorker.js"
);
const { ORIGIN_PROMPT_VERSION } = await import("./originClassifier.js");

beforeEach(() => {
  // Spend that left no row behind is tracked in module state; without this a
  // budget test would starve every test after it.
  _resetOriginSpendState();
  loggerError.mockReset();
  for (const fn of [findMany, update, classifyOrigins, logEvent]) fn.mockReset();
  env.DM_RECOVERY_ORIGIN_LLM_ENABLED = true;
  env.GEMINI_DAILY_BUDGET_USD = 5;
  findMany.mockResolvedValue([]);
  update.mockResolvedValue({});
  classifyOrigins.mockResolvedValue({ verdicts: [], costUsd: 0 });
});

/** findMany is used for both the spend probe and the due query, in that order. */
function arrange(due: Array<{ id: string; username: string | null; name: string | null }>, spentRows = 0) {
  findMany
    .mockResolvedValueOnce(Array.from({ length: spentRows }, (_, i) => ({ id: `s${i}` })))
    .mockResolvedValueOnce(due);
}

describe("runOriginEnrichmentTick", () => {
  it("persists a verdict against the current prompt version", async () => {
    arrange([{ id: "u1", username: "priya_s", name: "Priya Sharma" }]);
    classifyOrigins.mockResolvedValue({
      verdicts: [
        { id: "u1", origin: "south_asian", confidence: "high", evidence: "Indian given name Priya" },
      ],
      costUsd: 0.0001,
    });

    const res = await runOriginEnrichmentTick();

    expect(res.classified).toBe(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        inferredOrigin: "south_asian",
        originConfidence: "high",
        originMethod: ORIGIN_PROMPT_VERSION,
        originEvidence: "Indian given name Priya",
        originCheckedAt: expect.any(Date),
      }),
    });
  });

  // A person with no name and no username cannot be classified by any method,
  // so paying the model to answer "unknown" is waste. They are still stamped,
  // so the due query does not return them on every tick forever.
  it("stamps a user with nothing to classify without calling the model", async () => {
    arrange([{ id: "u1", username: null, name: null }]);

    const res = await runOriginEnrichmentTick();

    expect(classifyOrigins).not.toHaveBeenCalled();
    expect(res.skippedNoSignal).toBe(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({ inferredOrigin: "unknown", originConfidence: "low" }),
    });
  });

  it("treats a placeholder dash as no signal", async () => {
    arrange([{ id: "u1", username: "-", name: "-" }]);

    const res = await runOriginEnrichmentTick();

    expect(classifyOrigins).not.toHaveBeenCalled();
    expect(res.skippedNoSignal).toBe(1);
  });

  it("classifies a user who has only a username", async () => {
    arrange([{ id: "u1", username: "reshmamurugan_", name: null }]);

    await runOriginEnrichmentTick();

    expect(classifyOrigins).toHaveBeenCalledWith([
      { id: "u1", username: "reshmamurugan_", name: null },
    ]);
  });

  // Leaving originCheckedAt null is what returns the row to a later tick. The
  // user keeps the name-token fallback until then, rather than being recorded
  // as checked-and-unknown on the strength of a response that never came.
  // The model answered and declined to place u2. Leaving it unstamped meant the
  // query returned it again every two minutes forever, re-billing the same row
  // once the backlog drained. `unknown` never withholds, so this errs toward
  // sending, and a prompt-version bump re-runs it.
  it("stamps a user the model declined to place, rather than retrying forever", async () => {
    arrange([
      { id: "u1", username: "a_name", name: "A Name" },
      { id: "u2", username: "b_name", name: "B Name" },
    ]);
    classifyOrigins.mockResolvedValue({
      verdicts: [{ id: "u1", origin: "unknown", confidence: "low", evidence: "no cue" }],
      costUsd: 0.0001,
    });

    const res = await runOriginEnrichmentTick();

    expect(res.classified).toBe(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "u2" },
      data: expect.objectContaining({
        inferredOrigin: "unknown",
        originConfidence: "low",
        originCheckedAt: expect.any(Date),
      }),
    });
  });

  // An unreadable response is not a statement about these people, so they are
  // left for a later tick — but the call was still billed, and a row-derived
  // budget cannot see spend that produced no row.
  it("does not stamp anyone when the whole batch came back unusable", async () => {
    arrange([{ id: "u1", username: "a_name", name: "A Name" }]);
    classifyOrigins.mockResolvedValue({ verdicts: [], costUsd: 0.0035 });

    const res = await runOriginEnrichmentTick();

    expect(res.classified).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("counts an unreadable batch toward the daily budget", async () => {
    env.GEMINI_DAILY_BUDGET_USD = 0.003; // below the 0.0035 the failed call cost
    arrange([{ id: "u1", username: "a_name", name: "A Name" }]);
    classifyOrigins.mockResolvedValue({ verdicts: [], costUsd: 0.0035 });

    await runOriginEnrichmentTick();

    // The first call left no row behind, so the row-derived figure still reads
    // zero. Without process-local tracking the guard would keep paying for the
    // same failure indefinitely.
    arrange([{ id: "u1", username: "a_name", name: "A Name" }]);
    const second = await runOriginEnrichmentTick();

    expect(second.skipped).toBe("budget");
  });

  it("never logs raw error text", async () => {
    arrange([{ id: "u1", username: "a_name", name: "A Name" }]);
    classifyOrigins.mockRejectedValue(new Error("SECRET-SENTINEL"));

    await runOriginEnrichmentTick();

    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("SECRET-SENTINEL");
  });

  describe("guards", () => {
    it("no-ops when the feature switch is off", async () => {
      env.DM_RECOVERY_ORIGIN_LLM_ENABLED = false;
      const res = await runOriginEnrichmentTick();
      expect(res.skipped).toBe("disabled");
      expect(findMany).not.toHaveBeenCalled();
    });

    it("stops before spending past the daily budget", async () => {
      // Enough already-classified rows today to exceed the $5 budget.
      arrange([{ id: "u1", username: "x", name: "X" }], 100_000);
      const res = await runOriginEnrichmentTick();
      expect(res.skipped).toBe("budget");
      expect(classifyOrigins).not.toHaveBeenCalled();
    });

    it("reports no work rather than calling the model with an empty batch", async () => {
      arrange([]);
      const res = await runOriginEnrichmentTick();
      expect(res.skipped).toBe("no_work");
      expect(classifyOrigins).not.toHaveBeenCalled();
    });

    // Enrichment is an optimisation over a working fallback, so a failure here
    // must never propagate into whatever triggered the tick.
    it("swallows a model failure instead of throwing", async () => {
      arrange([{ id: "u1", username: "x", name: "X" }]);
      classifyOrigins.mockRejectedValue(new Error("gemini exploded"));

      await expect(runOriginEnrichmentTick()).resolves.toMatchObject({ classified: 0 });
    });
  });

  it("takes the newest users first, who are the ones with a reminder ticking", async () => {
    arrange([]);
    await runOriginEnrichmentTick();

    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { originCheckedAt: null },
        orderBy: { createdAt: "desc" },
        take: 25,
      }),
    );
  });
});
