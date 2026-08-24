import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiMutation } from "@/lib/api";
import { useOperationId } from "@/lib/useOperationId";
import { GUIDE_COVER_CATEGORIES } from "@shared/guideCoverRegistry";

import type { PresentationCategory } from "./types";

export interface PresentationCategoryPickerProps {
  categories: PresentationCategory[];
  onSelect: (categoryId: string) => void;
  /** The category currently chosen in the parent, so the dropdown shows it as selected. */
  selectedCategoryId?: string | null;
  disabled?: boolean;
}

interface CategoryCreateResponse {
  category: PresentationCategory;
  replayed: boolean;
}

interface CategoryForm {
  name: string;
  collectionLabel: string;
  kicker: string;
  basedOnCategorySlug: keyof typeof GUIDE_COVER_CATEGORIES;
}

const VISUAL_FAMILIES = Object.values(GUIDE_COVER_CATEGORIES).map((category) => ({
  slug: category.categorySlug,
  name: category.name,
}));

const emptyForm: CategoryForm = {
  name: "",
  collectionLabel: "",
  kicker: "",
  basedOnCategorySlug: "recipes",
};

function statusLabel(status: PresentationCategory["designStatus"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "needs_review":
      return "Needs visual review";
    case "inactive":
      return "Inactive";
  }
}

/**
 * Searches the server's reusable category rows and creates a new row only through
 * the constrained visual-family API. The creator never sees or submits visual
 * keys; the server derives the stable category slug from the human name.
 */
export function PresentationCategoryPicker({
  categories,
  onSelect,
  selectedCategoryId = null,
  disabled = false,
}: PresentationCategoryPickerProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState<CategoryForm>(emptyForm);
  const [addedCategories, setAddedCategories] = useState<PresentationCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { operationId, renew } = useOperationId();

  const visibleCategories = useMemo(() => {
    const byId = new Map(categories.map((category) => [category.id, category]));
    for (const category of addedCategories) byId.set(category.id, category);
    return [...byId.values()];
  }, [addedCategories, categories]);

  const canCreate =
    form.name.trim().length > 0 &&
    form.collectionLabel.trim().length > 0 &&
    form.kicker.trim().length > 0 &&
    !isSaving &&
    !disabled;

  async function createCategory() {
    if (!canCreate) return;

    setError(null);
    setIsSaving(true);
    try {
      const response = await apiMutation<CategoryCreateResponse>("/presentation-categories", {
        method: "POST",
        operationId,
        body: JSON.stringify({
          id: operationId,
          name: form.name,
          collectionLabel: form.collectionLabel,
          defaultKicker: form.kicker,
          basedOnCategorySlug: form.basedOnCategorySlug,
        }),
      });
      setAddedCategories((current) => {
        const index = current.findIndex((category) => category.id === response.category.id);
        if (index < 0) return [...current, response.category];
        return current.map((category, currentIndex) =>
          currentIndex === index ? response.category : category,
        );
      });
      setForm(emptyForm);
      setShowAddForm(false);
      renew();
    } catch {
      // Keep the UUID and form intact: retrying this exact intent must be a replay.
      setError("Could not create category. Retry with the same details.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="space-y-3" aria-label="Presentation category">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Presentation category
      </p>
      {/*
        A native dropdown, not a search palette. With only a handful of collections the
        always-open searchable list was more chrome than the choice needed; a select shows the
        current category in one line and opens the rest on click. Non-ready categories stay in
        the list but disabled, so a half-built collection is visible without being publishable.
        The onChange guard is belt-and-braces — a native `disabled` option cannot be chosen —
        but it also refuses the empty placeholder value.
      */}
      <Select
        aria-label="Presentation category"
        value={selectedCategoryId ?? ""}
        disabled={disabled}
        onChange={(event) => {
          const id = event.target.value;
          const category = visibleCategories.find((candidate) => candidate.id === id);
          if (!id || !category || category.designStatus !== "ready") return;
          onSelect(id);
        }}
      >
        {selectedCategoryId == null && (
          <option value="" disabled>
            Select a category
          </option>
        )}
        {visibleCategories.map((category) => {
          const isReady = category.designStatus === "ready";
          return (
            <option key={category.id} value={category.id} disabled={!isReady}>
              {isReady ? category.name : `${category.name} · ${statusLabel(category.designStatus)}`}
            </option>
          );
        })}
      </Select>

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-expanded={showAddForm}
        aria-controls="presentation-category-add-form"
        onClick={() => {
          setShowAddForm((current) => !current);
          setError(null);
        }}
      >
        Add reusable category
      </Button>

      {showAddForm && (
        <form
          id="presentation-category-add-form"
          className="space-y-3 rounded-lg border border-dashed p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void createCategory();
          }}
        >
          <p className="text-sm text-muted-foreground">
            New categories are reusable, but need visual review before they can be used to
            publish a cover.
          </p>
          <CategoryField label="Category name" htmlFor="presentation-category-name">
            <Input
              id="presentation-category-name"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              maxLength={64}
              disabled={disabled}
              required
            />
          </CategoryField>
          <CategoryField label="Collection label" htmlFor="presentation-category-collection-label">
            <Input
              id="presentation-category-collection-label"
              value={form.collectionLabel}
              onChange={(event) =>
                setForm((current) => ({ ...current, collectionLabel: event.target.value }))
              }
              maxLength={16}
              disabled={disabled}
              required
            />
          </CategoryField>
          <CategoryField label="Kicker" htmlFor="presentation-category-kicker">
            <Input
              id="presentation-category-kicker"
              value={form.kicker}
              onChange={(event) => setForm((current) => ({ ...current, kicker: event.target.value }))}
              maxLength={32}
              disabled={disabled}
              required
            />
          </CategoryField>
          <CategoryField label="Visual family" htmlFor="presentation-category-visual-family">
            <Select
              id="presentation-category-visual-family"
              value={form.basedOnCategorySlug}
              disabled={disabled}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  basedOnCategorySlug: event.target.value as CategoryForm["basedOnCategorySlug"],
                }))
              }
            >
              {VISUAL_FAMILIES.map((family) => (
                <option key={family.slug} value={family.slug}>
                  {family.name}
                </option>
              ))}
            </Select>
          </CategoryField>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={!canCreate}>
            {isSaving ? "Creating category…" : "Create reusable category"}
          </Button>
        </form>
      )}
    </section>
  );
}

function CategoryField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
