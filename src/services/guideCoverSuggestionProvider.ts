export interface GuideCoverSuggestionProviderInput {
  resource: {
    name: string;
    description: string | null;
    theme: string | null;
    excerpts: string[];
  };
  categories: Array<{ id: string; slug: string; name: string }>;
  selectedCategorySlug: string | null;
}

/** Provider output is untrusted; the service validates every field. */
export interface PresentationSuggestionProvider {
  suggest(input: GuideCoverSuggestionProviderInput): Promise<unknown>;
}
