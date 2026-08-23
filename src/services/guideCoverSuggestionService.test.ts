import { describe, expect, it, vi } from "vitest";

import { createGuideCoverSuggestionService } from "./guideCoverSuggestionService.js";

const RESOURCE_ID = "20000000-0000-4000-8000-000000000001";
const SUGGESTION_ID = "40000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-22T12:00:00.000Z");

const category = {
  id: CATEGORY_ID,
  slug: "bedtime",
  name: "Bedtime",
  collectionLabel: "SLEEP",
  defaultKicker: "A TINY WIN FOR TONIGHT",
  templateKey: "warm_editorial_corner_v1",
  paletteKey: "bedtime_blush_v1",
  illustrationKey: "bedtime_window_house_v1",
  designStatus: "ready",
  sortOrder: 10,
};

function fixture() {
  const resource = {
    id: RESOURCE_ID,
    name: "Toddler sleep guide",
    description: "A calm bedtime routine for toddlers.",
    theme: "sleep",
    messages: [
      { body: "Try one predictable cue before lights out." },
      { body: "Keep the routine calm and repeatable." },
    ],
  };
  const database = {
    resource: { findUnique: vi.fn().mockResolvedValue(resource) },
    presentationCategory: { findMany: vi.fn().mockResolvedValue([category]) },
    resourceCoverSuggestion: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        createdAt: NOW,
      })),
    },
  };
  const provider = {
    suggest: vi.fn().mockResolvedValue({
      categorySlug: "bedtime",
      headline: "Bedtime can feel softer",
      supportingLine: "A calmer bedtime, one small shift at a time.",
      closingLine: "Prepared for calmer evenings.",
      alternativeDescription:
        "Blush TinySoho sleep guide cover with a moonlit house illustration.",
      confidence: "high",
      warnings: [],
      provider: "gemini",
      model: "gemini-test",
      promptVersion: "guide-cover-suggestion-v1",
    }),
  };
  return { database, provider, resource };
}

describe("guide cover suggestion service", () => {
  it("stores a valid provider suggestion immutably and returns editable defaults", async () => {
    const { database, provider } = fixture();
    const service = createGuideCoverSuggestionService({
      database: database as never,
      provider,
    });

    const result = await service.suggest({
      id: SUGGESTION_ID,
      resourceId: RESOURCE_ID,
      selectedCategoryId: CATEGORY_ID,
    });

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      suggestion: {
        id: SUGGESTION_ID,
        resourceId: RESOURCE_ID,
        suggestedCategoryId: CATEGORY_ID,
        provider: "gemini",
      },
      draft: {
        categoryId: CATEGORY_ID,
        templateKey: category.templateKey,
        paletteKey: category.paletteKey,
        illustrationKey: category.illustrationKey,
        headline: "Bedtime can feel softer",
      },
    });
    expect(database.resourceCoverSuggestion.create).toHaveBeenCalledOnce();
    expect(database.resourceCoverSuggestion.create.mock.calls[0]?.[0].data).not.toHaveProperty(
      "rawPrompt",
    );
  });

  it("passes only bounded guide-owned fields to the provider", async () => {
    const { database, provider } = fixture();
    const service = createGuideCoverSuggestionService({
      database: database as never,
      provider,
    });

    await service.suggest({
      id: SUGGESTION_ID,
      resourceId: RESOURCE_ID,
      selectedCategoryId: null,
    });

    expect(provider.suggest).toHaveBeenCalledWith({
      resource: {
        name: "Toddler sleep guide",
        description: "A calm bedtime routine for toddlers.",
        theme: "sleep",
        excerpts: [
          "Try one predictable cue before lights out.",
          "Keep the routine calm and repeatable.",
        ],
      },
      categories: [
        {
          id: CATEGORY_ID,
          slug: "bedtime",
          name: "Bedtime",
        },
      ],
      selectedCategorySlug: null,
    });
    expect(JSON.stringify(provider.suggest.mock.calls[0]?.[0])).not.toMatch(
      /parent|follower|token|supabase|instagram|mediaUrl|dmHistory/iu,
    );
  });

  it("falls back to deterministic safe copy when provider output contains a URL", async () => {
    const { database, provider } = fixture();
    provider.suggest.mockResolvedValue({
      categorySlug: "bedtime",
      headline: "Visit https://example.com",
      supportingLine: "A calmer bedtime, one small shift at a time.",
      closingLine: "Prepared for calmer evenings.",
      alternativeDescription: "A bedtime guide.",
      confidence: "high",
      warnings: [],
      provider: "gemini",
      model: "gemini-test",
      promptVersion: "guide-cover-suggestion-v1",
    });
    const service = createGuideCoverSuggestionService({
      database: database as never,
      provider,
    });

    const result = await service.suggest({
      id: SUGGESTION_ID,
      resourceId: RESOURCE_ID,
      selectedCategoryId: CATEGORY_ID,
    });

    expect(result).toMatchObject({
      ok: true,
      suggestion: {
        provider: "deterministic",
        warnings: ["ai_invalid_response"],
        headline: "Toddler sleep guide",
      },
    });
  });

  it("falls back without blocking manual authoring when the provider is unavailable", async () => {
    const { database, provider } = fixture();
    provider.suggest.mockRejectedValue(new Error("private provider failure"));
    const service = createGuideCoverSuggestionService({
      database: database as never,
      provider,
    });

    const result = await service.suggest({
      id: SUGGESTION_ID,
      resourceId: RESOURCE_ID,
      selectedCategoryId: CATEGORY_ID,
    });

    expect(result).toMatchObject({
      ok: true,
      suggestion: {
        provider: "deterministic",
        warnings: ["ai_unavailable"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("private provider failure");
  });

  it("falls back when a provider prompt version exceeds the database limit", async () => {
    const { database, provider } = fixture();
    provider.suggest.mockResolvedValue({
      categorySlug: "bedtime",
      headline: "Bedtime can feel softer",
      supportingLine: "A calmer bedtime, one small shift at a time.",
      closingLine: "Prepared for calmer evenings.",
      alternativeDescription: "A bedtime guide.",
      confidence: "high",
      warnings: [],
      provider: "gemini",
      model: "gemini-test",
      promptVersion: "x".repeat(41),
    });
    const service = createGuideCoverSuggestionService({
      database: database as never,
      provider,
    });

    await expect(
      service.suggest({
        id: SUGGESTION_ID,
        resourceId: RESOURCE_ID,
        selectedCategoryId: CATEGORY_ID,
      }),
    ).resolves.toMatchObject({
      ok: true,
      suggestion: {
        provider: "deterministic",
        promptVersion: "guide-cover-deterministic-v1",
        warnings: ["ai_invalid_response"],
      },
    });
  });

  it("replays an immutable suggestion with the same normalized source hash", async () => {
    const { database, provider } = fixture();
    const service = createGuideCoverSuggestionService({
      database: database as never,
      provider,
    });
    const first = await service.suggest({
      id: SUGGESTION_ID,
      resourceId: RESOURCE_ID,
      selectedCategoryId: CATEGORY_ID,
    });
    if (!first.ok) throw new Error("fixture suggestion failed");
    database.resourceCoverSuggestion.findFirst.mockResolvedValue(first.suggestion);
    provider.suggest.mockClear();

    await expect(
      service.suggest({
        id: "40000000-0000-4000-8000-000000000002",
        resourceId: RESOURCE_ID,
        selectedCategoryId: CATEGORY_ID,
      }),
    ).resolves.toMatchObject({ ok: true, replayed: true, suggestion: first.suggestion });
    expect(provider.suggest).not.toHaveBeenCalled();
  });

  it("replays the same client UUID before contacting the provider", async () => {
    const { database, provider } = fixture();
    const service = createGuideCoverSuggestionService({
      database: database as never,
      provider,
    });
    const first = await service.suggest({
      id: SUGGESTION_ID,
      resourceId: RESOURCE_ID,
      selectedCategoryId: CATEGORY_ID,
    });
    if (!first.ok) throw new Error("fixture suggestion failed");
    database.resourceCoverSuggestion.findUnique.mockResolvedValue(first.suggestion);
    database.resourceCoverSuggestion.findFirst.mockResolvedValue(null);
    provider.suggest.mockClear();

    await expect(
      service.suggest({
        id: SUGGESTION_ID,
        resourceId: RESOURCE_ID,
        selectedCategoryId: CATEGORY_ID,
      }),
    ).resolves.toMatchObject({ ok: true, replayed: true, suggestion: first.suggestion });
    expect(provider.suggest).not.toHaveBeenCalled();
  });

  it("rejects a reused client UUID with changed source before contacting the provider", async () => {
    const { database, provider } = fixture();
    database.resourceCoverSuggestion.findUnique.mockResolvedValue({
      id: SUGGESTION_ID,
      resourceId: RESOURCE_ID,
      normalizedSourceHash: "f".repeat(64),
      suggestedCategoryId: CATEGORY_ID,
    });
    const service = createGuideCoverSuggestionService({
      database: database as never,
      provider,
    });

    await expect(
      service.suggest({
        id: SUGGESTION_ID,
        resourceId: RESOURCE_ID,
        selectedCategoryId: CATEGORY_ID,
      }),
    ).resolves.toEqual({ ok: false, error: "cover_suggestion_conflict" });
    expect(provider.suggest).not.toHaveBeenCalled();
    expect(database.resourceCoverSuggestion.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown selected category before calling the provider", async () => {
    const { database, provider } = fixture();
    const service = createGuideCoverSuggestionService({
      database: database as never,
      provider,
    });

    await expect(
      service.suggest({
        id: SUGGESTION_ID,
        resourceId: RESOURCE_ID,
        selectedCategoryId: "10000000-0000-4000-8000-000000000099",
      }),
    ).resolves.toEqual({ ok: false, error: "presentation_category_not_ready" });
    expect(provider.suggest).not.toHaveBeenCalled();
  });
});
