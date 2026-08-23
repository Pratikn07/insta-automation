import { createHash } from "node:crypto";

import type { PrismaClient, ResourceCoverSuggestion } from "@prisma/client";
import { z } from "zod";

import {
  normalizeGuideCoverText,
  validateGuideCoverDraft,
  type GuideCoverDraft,
} from "../../shared/guideCoverPolicy.js";
import { getGuideCoverCategory } from "../../shared/guideCoverRegistry.js";
import { prisma } from "../lib/prisma.js";
import { createGeminiGuideCoverSuggestionProvider } from "./geminiGuideCoverSuggestionProvider.js";
import type {
  GuideCoverSuggestionProviderInput,
  PresentationSuggestionProvider,
} from "./guideCoverSuggestionProvider.js";

const URL_PATTERN = /(?:https?:\/\/|www\.|mailto:)/iu;
const FALLBACK_PROMPT_VERSION = "guide-cover-deterministic-v1";

const providerSuggestionSchema = z.object({
  categorySlug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/u),
  headline: z.string(),
  supportingLine: z.string(),
  closingLine: z.string(),
  alternativeDescription: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  warnings: z.array(z.string().min(1).max(40)).max(5),
  provider: z.string().min(1).max(32),
  model: z.string().min(1).max(80),
  promptVersion: z.string().min(1).max(40),
});

export type GuideCoverSuggestionDatabase = Pick<
  PrismaClient,
  "resource" | "presentationCategory" | "resourceCoverSuggestion"
>;

export interface CreateGuideCoverSuggestionInput {
  id: string;
  resourceId: string;
  selectedCategoryId: string | null;
}

type SuggestionError =
  | "cover_suggestion_conflict"
  | "cover_suggestion_invalid_input"
  | "cover_suggestion_unavailable"
  | "presentation_category_not_ready"
  | "resource_not_found";

export type GuideCoverSuggestionResult =
  | {
      ok: true;
      replayed: boolean;
      suggestion: ResourceCoverSuggestion;
      draft: GuideCoverDraft & {
        categoryId: string;
        templateKey: string;
        paletteKey: string;
        illustrationKey: string;
      };
    }
  | { ok: false; error: SuggestionError };

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "P2002",
  );
}

function boundedText(value: string | null | undefined, maximum: number): string | null {
  if (!value) return null;
  const normalized = normalizeGuideCoverText(value);
  return normalized ? [...normalized].slice(0, maximum).join("") : null;
}

function deterministicCategorySlug(input: GuideCoverSuggestionProviderInput): string {
  const signal = `${input.resource.theme ?? ""} ${input.resource.name}`.toLowerCase();
  const preferred =
    /potty|toilet|training/u.test(signal) ? "potty-training" :
    /recipe|meal|food|feeding|lunch|dinner/u.test(signal) ? "recipes" :
    /montessori|activity|activities|learning|play/u.test(signal) ? "montessori-activities" :
    /sleep|bedtime|night/u.test(signal) ? "bedtime" : null;
  if (preferred && input.categories.some((category) => category.slug === preferred)) {
    return preferred;
  }
  return input.categories[0]?.slug ?? "";
}

function safeFallbackDraft(resourceName: string, categorySlug: string): GuideCoverDraft {
  const registered = getGuideCoverCategory(categorySlug);
  const base: GuideCoverDraft = registered?.exampleCopy ?? {
    headline: "A tiny win for today",
    supportingLine: "A simple guide for calmer family moments.",
    closingLine: "Made with care by TinySoho.",
    alternativeDescription: "A warm editorial TinySoho guide cover.",
  };
  const named = validateGuideCoverDraft({
    ...base,
    headline: resourceName,
  });
  return named.ok && !URL_PATTERN.test(resourceName) ? named.value : base;
}

function validProviderDraft(value: z.infer<typeof providerSuggestionSchema>): GuideCoverDraft | null {
  const draft = {
    headline: value.headline,
    supportingLine: value.supportingLine,
    closingLine: value.closingLine,
    alternativeDescription: value.alternativeDescription,
  };
  if (Object.values(draft).some((field) => URL_PATTERN.test(field))) return null;
  const validated = validateGuideCoverDraft(draft);
  return validated.ok ? validated.value : null;
}

function draftFromSuggestion(
  suggestion: ResourceCoverSuggestion,
  category: {
    id: string;
    templateKey: string;
    paletteKey: string;
    illustrationKey: string;
  },
) {
  return {
    categoryId: category.id,
    templateKey: category.templateKey,
    paletteKey: category.paletteKey,
    illustrationKey: category.illustrationKey,
    headline: suggestion.headline,
    supportingLine: suggestion.supportingLine,
    closingLine: suggestion.closingLine,
    alternativeDescription: suggestion.alternativeDescription,
  };
}

export function createGuideCoverSuggestionService(options: {
  database?: GuideCoverSuggestionDatabase;
  provider?: PresentationSuggestionProvider;
} = {}) {
  const database = options.database ?? prisma;
  const provider = options.provider ?? createGeminiGuideCoverSuggestionProvider();

  return {
    async suggest(input: CreateGuideCoverSuggestionInput): Promise<GuideCoverSuggestionResult> {
      if (!input.id || !input.resourceId) {
        return { ok: false, error: "cover_suggestion_invalid_input" };
      }
      let resource;
      let categories;
      try {
        [resource, categories] = await Promise.all([
          database.resource.findUnique({
            where: { id: input.resourceId },
            select: {
              id: true,
              name: true,
              description: true,
              theme: true,
              messages: {
                orderBy: { order: "asc" },
                take: 6,
                select: { body: true },
              },
            },
          }),
          database.presentationCategory.findMany({
            where: { designStatus: "ready" },
            orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          }),
        ]);
      } catch {
        return { ok: false, error: "cover_suggestion_unavailable" };
      }
      if (!resource) return { ok: false, error: "resource_not_found" };
      const selected = input.selectedCategoryId
        ? categories.find((category) => category.id === input.selectedCategoryId)
        : null;
      if (input.selectedCategoryId && !selected) {
        return { ok: false, error: "presentation_category_not_ready" };
      }
      if (categories.length === 0) {
        return { ok: false, error: "presentation_category_not_ready" };
      }

      const providerInput: GuideCoverSuggestionProviderInput = {
        resource: {
          name: boundedText(resource.name, 120) ?? "TinySoho guide",
          description: boundedText(resource.description, 500),
          theme: boundedText(resource.theme, 40),
          excerpts: resource.messages
            .map((message) => boundedText(message.body, 240))
            .filter((value): value is string => value !== null),
        },
        categories: categories.map((category) => ({
          id: category.id,
          slug: category.slug,
          name: category.name,
        })),
        selectedCategorySlug: selected?.slug ?? null,
      };
      const normalizedSourceHash = createHash("sha256")
        .update(JSON.stringify(providerInput))
        .digest("hex");

      try {
        // A client-owned UUID is an idempotency key. Resolve it before any paid
        // provider call so a conflicting retry cannot consume AI quota.
        const existingById = await database.resourceCoverSuggestion.findUnique({
          where: { id: input.id },
        });
        if (existingById) {
          if (
            existingById.resourceId !== input.resourceId ||
            existingById.normalizedSourceHash !== normalizedSourceHash
          ) {
            return { ok: false, error: "cover_suggestion_conflict" };
          }
          const category = categories.find(
            (candidate) => candidate.id === existingById.suggestedCategoryId,
          );
          if (!category) return { ok: false, error: "presentation_category_not_ready" };
          return {
            ok: true,
            replayed: true,
            suggestion: existingById,
            draft: draftFromSuggestion(existingById, category),
          };
        }

        const existing = await database.resourceCoverSuggestion.findFirst({
          where: { resourceId: input.resourceId, normalizedSourceHash },
          orderBy: { createdAt: "asc" },
        });
        if (existing) {
          const category = categories.find(
            (candidate) => candidate.id === existing.suggestedCategoryId,
          );
          if (!category) return { ok: false, error: "presentation_category_not_ready" };
          return {
            ok: true,
            replayed: true,
            suggestion: existing,
            draft: draftFromSuggestion(existing, category),
          };
        }
      } catch {
        return { ok: false, error: "cover_suggestion_unavailable" };
      }

      let parsedProvider: z.infer<typeof providerSuggestionSchema> | null = null;
      let fallbackWarning = "ai_unavailable";
      try {
        const parsed = providerSuggestionSchema.safeParse(await provider.suggest(providerInput));
        if (parsed.success) {
          const categoryAllowed = categories.some(
            (category) => category.slug === parsed.data.categorySlug,
          );
          const selectedHonored = !selected || selected.slug === parsed.data.categorySlug;
          if (categoryAllowed && selectedHonored && validProviderDraft(parsed.data)) {
            parsedProvider = parsed.data;
          } else {
            fallbackWarning = "ai_invalid_response";
          }
        } else {
          fallbackWarning = "ai_invalid_response";
        }
      } catch {
        // Manual deterministic authoring remains available when AI is disabled,
        // times out, exhausts quota, or returns malformed JSON.
      }

      const categorySlug =
        parsedProvider?.categorySlug ??
        selected?.slug ??
        deterministicCategorySlug(providerInput);
      const category = categories.find((candidate) => candidate.slug === categorySlug);
      if (!category) return { ok: false, error: "presentation_category_not_ready" };
      const copy = parsedProvider
        ? validProviderDraft(parsedProvider)!
        : safeFallbackDraft(providerInput.resource.name, category.slug);
      const data = {
        id: input.id,
        resourceId: input.resourceId,
        suggestedCategoryId: category.id,
        ...copy,
        confidence: parsedProvider?.confidence ?? ("low" as const),
        warnings: parsedProvider?.warnings ?? [fallbackWarning],
        provider: parsedProvider?.provider ?? "deterministic",
        model: parsedProvider?.model ?? "none",
        promptVersion: parsedProvider?.promptVersion ?? FALLBACK_PROMPT_VERSION,
        normalizedSourceHash,
      };

      try {
        const suggestion = await database.resourceCoverSuggestion.create({ data });
        return {
          ok: true,
          replayed: false,
          suggestion,
          draft: draftFromSuggestion(suggestion, category),
        };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          return { ok: false, error: "cover_suggestion_unavailable" };
        }
        const sameSource = await database.resourceCoverSuggestion.findFirst({
          where: { resourceId: input.resourceId, normalizedSourceHash },
          orderBy: { createdAt: "asc" },
        });
        if (sameSource) {
          const replayCategory = categories.find(
            (candidate) => candidate.id === sameSource.suggestedCategoryId,
          );
          if (!replayCategory) {
            return { ok: false, error: "presentation_category_not_ready" };
          }
          return {
            ok: true,
            replayed: true,
            suggestion: sameSource,
            draft: draftFromSuggestion(sameSource, replayCategory),
          };
        }
        const existing = await database.resourceCoverSuggestion.findUnique({
          where: { id: input.id },
        });
        if (
          !existing ||
          existing.resourceId !== input.resourceId ||
          existing.normalizedSourceHash !== normalizedSourceHash
        ) {
          return { ok: false, error: "cover_suggestion_conflict" };
        }
        return {
          ok: true,
          replayed: true,
          suggestion: existing,
          draft: draftFromSuggestion(existing, category),
        };
      }
    },
  };
}

export type GuideCoverSuggestionService = ReturnType<
  typeof createGuideCoverSuggestionService
>;
