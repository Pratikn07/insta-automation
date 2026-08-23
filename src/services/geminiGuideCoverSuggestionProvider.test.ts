import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();

vi.mock("../config/env.js", () => ({
  env: { GEMINI_MODEL: "gemini-test" },
}));
vi.mock("../meta/geminiClient.js", () => ({
  gemini: { post },
  geminiEnabled: true,
  GeminiDisabledError: class GeminiDisabledError extends Error {},
}));

const { createGeminiGuideCoverSuggestionProvider } = await import(
  "./geminiGuideCoverSuggestionProvider.js"
);

const input = {
  resource: {
    name: "Toddler sleep guide",
    description: "A calm bedtime routine.",
    theme: "sleep",
    excerpts: ["Try one predictable cue."],
  },
  categories: [
    {
      id: "10000000-0000-4000-8000-000000000001",
      slug: "bedtime",
      name: "Bedtime",
    },
  ],
  selectedCategorySlug: "bedtime",
};

describe("Gemini guide cover suggestion provider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses a deterministic strict-schema request with only bounded service input", async () => {
    post.mockResolvedValue({
      data: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    categorySlug: "bedtime",
                    headline: "Bedtime can feel softer",
                    supportingLine: "A calmer bedtime, one small shift at a time.",
                    closingLine: "Prepared for calmer evenings.",
                    alternativeDescription: "A warm bedtime guide cover.",
                    confidence: "high",
                    warnings: [],
                  }),
                },
              ],
            },
          },
        ],
      },
    });

    const result = await createGeminiGuideCoverSuggestionProvider().suggest(input);

    expect(result).toMatchObject({ provider: "gemini", model: "gemini-test" });
    const requestBody = post.mock.calls[0]?.[1];
    expect(requestBody.generationConfig).toMatchObject({
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
    });
    const prompt = requestBody.contents[0].parts[0].text as string;
    expect(prompt).toContain(JSON.stringify(input));
    expect(prompt).not.toMatch(/access[_ -]?token|supabase[_ -]?key|follower status/iu);
  });

  it("does not convert malformed provider JSON into a suggestion", async () => {
    post.mockResolvedValue({
      data: { candidates: [{ content: { parts: [{ text: "not-json" }] } }] },
    });

    await expect(
      createGeminiGuideCoverSuggestionProvider().suggest(input),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});
