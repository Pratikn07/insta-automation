import { describe, it, expect, vi, beforeEach } from "vitest";

const post = vi.fn();

vi.mock("../meta/geminiClient.js", () => ({
  gemini: { post },
  geminiEnabled: true,
  GeminiDisabledError: class GeminiDisabledError extends Error {
    constructor() {
      super("gemini_disabled");
      this.name = "GeminiDisabledError";
    }
  },
}));
vi.mock("../config/env.js", () => ({ env: { GEMINI_MODEL: "gemini-2.5-flash" } }));

const { classifyOrigins, estimateOriginCostUsd, MAX_ORIGIN_BATCH } = await import(
  "./originClassifier.js"
);

/** Shape a Gemini generateContent response carrying `results`. */
function reply(results: unknown[]) {
  return {
    data: {
      candidates: [{ content: { parts: [{ text: JSON.stringify({ results }) }] } }],
    },
  };
}

const CANDIDATES = [
  { id: "u1", username: "priya_s", name: "Priya Sharma" },
  { id: "u2", username: "emily_r", name: "Emily Robbins" },
];

beforeEach(() => {
  post.mockReset();
});

describe("classifyOrigins", () => {
  it("returns one verdict per account with the model's evidence", async () => {
    post.mockResolvedValue(
      reply([
        { id: "u1", origin: "south_asian", confidence: "high", evidence: "Indian given name Priya" },
        { id: "u2", origin: "us_western", confidence: "low", evidence: "Western surname Robbins" },
      ]),
    );

    const res = await classifyOrigins(CANDIDATES);

    expect(res.verdicts).toEqual([
      { id: "u1", origin: "south_asian", confidence: "high", evidence: "Indian given name Priya" },
      { id: "u2", origin: "us_western", confidence: "low", evidence: "Western surname Robbins" },
    ]);
    expect(res.promptVersion).toBe("llm_v1");
    expect(res.modelId).toBe("gemini-2.5-flash");
  });

  it("asks for a deterministic answer so a re-check cannot drift", async () => {
    post.mockResolvedValue(reply([]));
    await classifyOrigins(CANDIDATES);

    const [, body] = post.mock.calls[0];
    expect(body.generationConfig.temperature).toBe(0);
  });

  // Everything below is untrusted input. A model response that cannot be read
  // must leave the user UNCLASSIFIED, because an unclassified user still gets
  // the cheap name screen — whereas a wrongly-stored `high` silently withholds
  // a public reminder from someone.
  describe("untrusted response handling", () => {
    it("drops a verdict for an id that was never sent", async () => {
      post.mockResolvedValue(
        reply([
          { id: "not-requested", origin: "south_asian", confidence: "high", evidence: "x" },
          { id: "u1", origin: "us_western", confidence: "low", evidence: "ok" },
        ]),
      );

      const res = await classifyOrigins(CANDIDATES);
      expect(res.verdicts.map((v) => v.id)).toEqual(["u1"]);
    });

    it("drops a verdict whose origin is outside the enum", async () => {
      post.mockResolvedValue(
        reply([{ id: "u1", origin: "east_asian", confidence: "high", evidence: "x" }]),
      );

      const res = await classifyOrigins(CANDIDATES);
      expect(res.verdicts).toEqual([]);
    });

    // "high" is the only value that withholds a send, so anything that is not
    // exactly "high" must read as low rather than being coerced upward.
    it.each([["HIGH"], ["definitely"], [true], [null], [undefined]])(
      "treats a malformed confidence %p as low, never high",
      async (confidence) => {
        post.mockResolvedValue(
          reply([{ id: "u1", origin: "south_asian", confidence, evidence: "x" }]),
        );

        const res = await classifyOrigins(CANDIDATES);
        expect(res.verdicts[0]?.confidence).toBe("low");
      },
    );

    it("keeps the first verdict when the model repeats an id", async () => {
      post.mockResolvedValue(
        reply([
          { id: "u1", origin: "south_asian", confidence: "high", evidence: "first" },
          { id: "u1", origin: "us_western", confidence: "high", evidence: "second" },
        ]),
      );

      const res = await classifyOrigins(CANDIDATES);
      expect(res.verdicts).toHaveLength(1);
      expect(res.verdicts[0].evidence).toBe("first");
    });

    it("tolerates a short response rather than inventing the missing rows", async () => {
      post.mockResolvedValue(
        reply([{ id: "u1", origin: "south_asian", confidence: "high", evidence: "x" }]),
      );

      const res = await classifyOrigins(CANDIDATES);
      expect(res.verdicts.map((v) => v.id)).toEqual(["u1"]);
    });

    it("caps a runaway evidence string", async () => {
      post.mockResolvedValue(
        reply([
          { id: "u1", origin: "south_asian", confidence: "high", evidence: "e".repeat(5000) },
        ]),
      );

      const res = await classifyOrigins(CANDIDATES);
      expect(res.verdicts[0].evidence).toHaveLength(200);
    });

    it.each([[[null]], [["a string"]], [[42]]])(
      "drops a non-object row %p",
      async (results) => {
        post.mockResolvedValue(reply(results));
        const res = await classifyOrigins(CANDIDATES);
        expect(res.verdicts).toEqual([]);
      },
    );
  });

  it("makes no request for an empty batch", async () => {
    const res = await classifyOrigins([]);
    expect(post).not.toHaveBeenCalled();
    expect(res.verdicts).toEqual([]);
    expect(res.costUsd).toBe(0);
  });

  it("refuses a batch larger than the ceiling", async () => {
    const many = Array.from({ length: MAX_ORIGIN_BATCH + 1 }, (_, i) => ({
      id: `u${i}`,
      username: null,
      name: null,
    }));
    await expect(classifyOrigins(many)).rejects.toThrow("origin_batch_too_large");
    expect(post).not.toHaveBeenCalled();
  });

  it("sends both name and username, and marks a missing one", async () => {
    post.mockResolvedValue(reply([]));
    await classifyOrigins([{ id: "u1", username: "handle_only", name: null }]);

    const [, body] = post.mock.calls[0];
    const text = body.contents[0].parts[0].text as string;
    expect(text).toContain("id=u1");
    expect(text).toContain("username=handle_only");
    expect(text).toContain("name=(none)");
  });
});

describe("estimateOriginCostUsd", () => {
  it("grows with the batch and stays within the daily budget's order of magnitude", () => {
    const fifty = estimateOriginCostUsd(50);
    expect(fifty).toBeGreaterThan(estimateOriginCostUsd(10));
    // Measured live at ~$0.0035/50. Guard the order of magnitude so a pricing
    // or token-estimate edit cannot quietly make the backfill expensive.
    expect(fifty).toBeLessThan(0.01);
  });
});
