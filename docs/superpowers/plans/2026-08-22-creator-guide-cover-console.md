# Creator Guide-Cover Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the default-off TinySoho creator experience for selecting a reusable presentation category, generating an optional suggestion, editing an exact cover preview, saving a draft, and deliberately approving and publishing it.

**Architecture:** Keep `SequenceEditor` responsible for guide identity and message steps, and mount one isolated `GuideCoverPanel` between those sections. The panel owns cover queries and mutations, while small pure view-model and preview modules own state derivation and the shared SVG renderer. The server remains authoritative for category visual keys, draft revisions, edition allocation, approval, PNG generation, Storage, and publication.

**Tech Stack:** React 19, TypeScript 6, TanStack Query, cmdk, Tailwind CSS, Vitest/Testing Library, Express/Zod, the existing shared TinySoho SVG renderer.

**Spec:** `docs/superpowers/specs/2026-08-22-tinysoho-guide-covers-and-follower-gate-design.md`

## Global Constraints

- `GUIDE_COVER_AUTHORING_ENABLED` remains `false` by default and hides the panel when the API returns `guide_cover_authoring_disabled`.
- The creator never chooses colors, fonts, dimensions, layout measurements, image formats, edition numbers, Storage paths, model names, or prompt versions.
- The creator explicitly saves a cover draft; cover fields do not save on blur.
- AI can suggest only registered category/copy values and can never approve or publish.
- Approval and publication are creator actions; a failed publish never replaces the currently published cover.
- Draft conflicts preserve the creator's local copy and turn the next save into a new UUID-owned draft.
- Browser previews render the same shared layout, palette, illustration, text policy, and bundled font families as publication.
- New categories are reusable and enter `needs_review`; they are shown truthfully but cannot be used to publish until code review marks their visual direction ready.
- No cover action mutates resource messages.

---

### Task 1: Cover console types and deterministic editor state

**Files:**
- Create: `web/src/features/guide-covers/types.ts`
- Create: `web/src/features/guide-covers/guideCoverEditorState.ts`
- Test: `web/src/features/guide-covers/guideCoverEditorState.test.ts`

**Interfaces:**
- Consumes: API rows returned by `GET /presentation-categories` and `GET /resources/:resourceId/presentation`.
- Produces: `PresentationCategory`, `ResourceCoverVersion`, `ResourcePresentationResponse`, `GuideCoverCopy`, `GuideCoverEditorPhase`, `deriveGuideCoverEditorState(response, categories)` and `copyFromCategory(category)`.

- [ ] **Step 1: Write failing tests for empty, draft, approved, published, and conflicted editor states**

```ts
expect(deriveGuideCoverEditorState({ presentation: null, coverVersions: [] }, categories))
  .toMatchObject({ phase: "not_configured", selectedCategory: null, workingCover: null });
expect(deriveGuideCoverEditorState(withDraft, categories))
  .toMatchObject({ phase: "draft", workingCover: { revision: 3 } });
expect(deriveGuideCoverEditorState(withPublished, categories))
  .toMatchObject({ phase: "published", previewEditionNumber: 17 });
```

- [ ] **Step 2: Run the state test and confirm it fails because the modules do not exist**

Run: `cd web && npm test -- src/features/guide-covers/guideCoverEditorState.test.ts`

- [ ] **Step 3: Implement the API types and pure state derivation**

```ts
export function deriveGuideCoverEditorState(
  response: ResourcePresentationResponse,
  categories: PresentationCategory[],
): DerivedGuideCoverEditorState {
  const selectedCategory = categories.find(
    (category) => category.id === response.presentation?.categoryId,
  ) ?? null;
  const workingCover = response.coverVersions.find(
    (cover) => cover.status === "draft" || cover.status === "approved",
  ) ?? response.coverVersions.find((cover) => cover.status === "published") ?? null;
  return {
    selectedCategory,
    workingCover,
    phase: workingCover?.status ?? "not_configured",
    previewEditionNumber:
      response.presentation?.editionNumber ?? selectedCategory?.nextEditionNumber ?? 1,
  };
}
```

- [ ] **Step 4: Run the focused state test and confirm it passes**

Run: `cd web && npm test -- src/features/guide-covers/guideCoverEditorState.test.ts`

- [ ] **Step 5: Commit the state boundary**

```bash
git add web/src/features/guide-covers
git commit -m "feat: model creator cover editor state"
```

### Task 2: Browser-safe exact cover preview

**Files:**
- Create: `web/src/features/guide-covers/guideCoverPreview.ts`
- Create: `web/src/features/guide-covers/GuideCoverPreview.tsx`
- Test: `web/src/features/guide-covers/guideCoverPreview.test.ts`
- Modify: `web/src/index.css`

**Interfaces:**
- Consumes: `layoutGuideCover`, `renderGuideCoverSvg`, a ready `PresentationCategory`, editable `GuideCoverCopy`, and the server-owned preview edition number.
- Produces: `buildGuideCoverPreview(input, metrics)`, `createBrowserGuideCoverMetrics()`, and `<GuideCoverPreview category copy editionNumber />`.

- [ ] **Step 1: Write a failing preview test for an approved category and an overflow**

```ts
const result = buildGuideCoverPreview({ category, copy, editionNumber: 1 }, fixedMetrics);
expect(result.ok).toBe(true);
if (result.ok) {
  expect(result.svg).toContain('data-illustration="bedtime_window_house_v1"');
  expect(result.svg).toContain("Bedtime can feel softer");
}
expect(buildGuideCoverPreview({ category, copy: tooLong, editionNumber: 1 }, fixedMetrics))
  .toMatchObject({ ok: false, error: { code: "cover_text_overflow" } });
```

- [ ] **Step 2: Run the preview test and confirm it fails because the preview adapter is missing**

Run: `cd web && npm test -- src/features/guide-covers/guideCoverPreview.test.ts`

- [ ] **Step 3: Implement the preview adapter using the shared renderer**

```ts
export function buildGuideCoverPreview(input: PreviewInput, metrics: GuideCoverFontMetrics) {
  const layout = layoutGuideCover({
    categorySlug: input.category.slug,
    editionNumber: input.editionNumber,
    kicker: input.category.defaultKicker,
    collectionLabel: input.category.collectionLabel,
    templateKey: input.category.templateKey,
    paletteKey: input.category.paletteKey,
    illustrationKey: input.category.illustrationKey,
    ...input.copy,
  }, metrics, "dm_cover");
  return layout.ok
    ? { ok: true as const, svg: renderGuideCoverSvg(layout.value), layout: layout.value }
    : layout;
}
```

- [ ] **Step 4: Bundle the pinned Inter and Source Serif 4 files through CSS and implement the responsive preview component**

```css
@font-face {
  font-family: "TinySoho Cover Inter";
  src: url("../../shared/guide-cover-assets/fonts/inter-latin-400-normal.woff2") format("woff2");
  font-weight: 400;
}
```

The component waits for the four cover font faces through `document.fonts.load`, then uses a canvas `measureText` adapter and displays the generated SVG inside an aspect-ratio container. It exposes validation errors as text and never uploads a draft preview.

- [ ] **Step 5: Run the preview tests and web build**

Run: `cd web && npm test -- src/features/guide-covers/guideCoverPreview.test.ts`

Run: `cd web && npm run build`

- [ ] **Step 6: Commit the preview**

```bash
git add web/src/features/guide-covers/guideCoverPreview.ts web/src/features/guide-covers/GuideCoverPreview.tsx web/src/features/guide-covers/guideCoverPreview.test.ts web/src/index.css
git commit -m "feat: preview TinySoho guide covers in browser"
```

### Task 3: Server-derived reusable category creation

**Files:**
- Modify: `src/api/presentationCategories.routes.ts`
- Test: `src/api/presentationCategories.routes.test.ts`
- Create: `web/src/features/guide-covers/PresentationCategoryPicker.tsx`
- Test: `web/src/features/guide-covers/PresentationCategoryPicker.test.tsx`

**Interfaces:**
- Consumes: category name, collection label, kicker, and one approved `basedOnCategorySlug` visual family.
- Produces: an accessible searchable picker and `POST /presentation-categories` requests whose lowercase slug is derived and validated on the server.

- [ ] **Step 1: Write a failing API test proving the server derives `feeding-tips` from `Feeding Tips`**

```ts
await request(app).post("/api/presentation-categories").send({
  id,
  name: "Feeding Tips",
  collectionLabel: "FEEDING",
  defaultKicker: "A LITTLE WIN AT THE TABLE",
  basedOnCategorySlug: "recipes",
}).expect(201);
expect(createOrLoad).toHaveBeenCalledWith(expect.objectContaining({ slug: "feeding-tips" }));
```

- [ ] **Step 2: Run the route test and confirm it fails because `slug` is currently required**

Run: `npm test -- src/api/presentationCategories.routes.test.ts`

- [ ] **Step 3: Implement bounded server slug derivation and retain case-insensitive duplicate protection**

```ts
function categorySlug(name: string): string | null {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return slugSchema.safeParse(slug).success ? slug : null;
}
```

- [ ] **Step 4: Write a failing picker test for search, selection, keyboard labels, and adding a `needs_review` category**

```tsx
await user.type(screen.getByRole("combobox", { name: "Presentation category" }), "recipe");
await user.click(screen.getByRole("option", { name: /Recipes/ }));
expect(onSelect).toHaveBeenCalledWith(recipes.id);
await user.click(screen.getByRole("button", { name: "Add reusable category" }));
expect(screen.getByText(/needs visual review/i)).toBeVisible();
```

- [ ] **Step 5: Implement the cmdk-based picker and inline add form**

The add form contains `Category name`, `Collection label`, `Kicker`, and `Visual family`; it submits a client UUID as both `id` and `Idempotency-Key`. A created category is rendered with a `Needs visual review` badge and is not selectable for a publishable cover.

- [ ] **Step 6: Run focused route/picker tests and builds**

Run: `npm test -- src/api/presentationCategories.routes.test.ts`

Run: `cd web && npm test -- src/features/guide-covers/PresentationCategoryPicker.test.tsx`

Run: `npm run build`

Run: `cd web && npm run build`

- [ ] **Step 7: Commit category creation and selection**

```bash
git add src/api/presentationCategories.routes.ts src/api/presentationCategories.routes.test.ts web/src/features/guide-covers/PresentationCategoryPicker.tsx web/src/features/guide-covers/PresentationCategoryPicker.test.tsx
git commit -m "feat: add reusable cover category picker"
```

### Task 4: Draft, suggestion, conflict, and lifecycle panel

**Files:**
- Create: `web/src/features/guide-covers/GuideCoverPanel.tsx`
- Test: `web/src/features/guide-covers/GuideCoverPanel.test.tsx`
- Modify: `web/src/lib/types.ts`

**Interfaces:**
- Consumes: `/presentation-categories`, `/resources/:id/presentation`, `/resources/:id/cover-suggestions`, cover-version create/patch, and approve/publish endpoints.
- Produces: `<GuideCoverPanel resourceId resourceName />`, with local copy editing, suggestion provenance, explicit draft save, explicit approve/publish, and stable conflict recovery.

- [ ] **Step 1: Write failing tests for hidden/off, suggestion, save, and local-preview behavior**

```tsx
expect(screen.queryByRole("region", { name: "Presentation and cover" })).not.toBeInTheDocument();
await user.click(await screen.findByRole("button", { name: "Suggest from guide" }));
expect(screen.getByLabelText("Cover headline")).toHaveValue("Bedtime can feel softer");
await user.click(screen.getByRole("button", { name: "Save cover draft" }));
expect(lastCall("/resources/resource-1/cover-versions")).toMatchObject({ method: "POST" });
```

- [ ] **Step 2: Run the panel tests and confirm they fail because the panel does not exist**

Run: `cd web && npm test -- src/features/guide-covers/GuideCoverPanel.test.tsx`

- [ ] **Step 3: Implement queries, editable copy, category defaults, and AI suggestion**

The query for `/presentation-categories` uses `retry: false`. Only a 403 with `guide_cover_authoring_disabled` hides the panel; other failures show a retry state. Suggestion uses one stable `useOperationId` UUID until a known success, applies its returned category/copy locally, and never creates or publishes a cover.

- [ ] **Step 4: Implement explicit draft save with client identity and optimistic revision**

Create uses `POST /resources/:id/cover-versions` with the same UUID in the body and `Idempotency-Key`. Save uses `PATCH /resources/:id/cover-versions/:coverId` with `expectedRevision`. Known success refreshes the presentation and marks the form saved.

- [ ] **Step 5: Write and run a failing two-tab conflict test**

```tsx
apiMutation.mockRejectedValueOnce(new ApiError(409, { error: "cover_revision_conflict" }, "conflict"));
await user.click(screen.getByRole("button", { name: "Save cover draft" }));
expect(screen.getByLabelText("Cover headline")).toHaveValue("My local headline");
expect(screen.getByText(/newer version exists/i)).toBeVisible();
```

- [ ] **Step 6: Implement conflict recovery without overwriting local copy**

On `cover_revision_conflict`, refetch server state but retain all local fields, clear the stale cover identity, and label the next save `Save as new draft`. Do not invalidate or write any `resource-messages` query.

- [ ] **Step 7: Write failing approve/publish lifecycle tests**

```tsx
await user.click(screen.getByRole("button", { name: "Approve and publish" }));
expect(paths()).toEqual([
  "/resources/resource-1/cover-versions/cover-1/approve",
  "/resources/resource-1/cover-versions/cover-1/publish",
]);
expect(paths().some((path) => path.startsWith("/messages"))).toBe(false);
```

- [ ] **Step 8: Implement approval then publication with truthful states**

Disable publishing while local changes are dirty or preview validation fails. The action calls approve first, then publish using the same expected revision. Show `Approved` if publication fails after approval, `Published` on known success, and preserve any prior published cover on all errors.

- [ ] **Step 9: Run the complete panel tests and web build**

Run: `cd web && npm test -- src/features/guide-covers/GuideCoverPanel.test.tsx`

Run: `cd web && npm run build`

- [ ] **Step 10: Commit the authoring panel**

```bash
git add web/src/features/guide-covers/GuideCoverPanel.tsx web/src/features/guide-covers/GuideCoverPanel.test.tsx web/src/lib/types.ts
git commit -m "feat: author and publish guide covers"
```

### Task 5: Sequence editor integration and end-to-end console QA

**Files:**
- Modify: `web/src/pages/SequenceEditor.tsx`
- Modify: `web/src/pages/SequenceEditor.test.tsx`
- Create: `web/e2e/guide-cover-authoring.spec.ts`

**Interfaces:**
- Consumes: `<GuideCoverPanel resourceId resourceName />`.
- Produces: the approved `Presentation & cover` panel between guide identity and Steps without changing the existing message editor or phone preview.

- [ ] **Step 1: Write a failing integration test for placement and message isolation**

```tsx
expect(await screen.findByRole("region", { name: "Presentation and cover" }))
  .toBeInTheDocument();
expect(screen.getByText("Presentation & cover").compareDocumentPosition(screen.getByText("Steps")))
  .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
```

- [ ] **Step 2: Run the SequenceEditor test and confirm the panel is absent**

Run: `cd web && npm test -- src/pages/SequenceEditor.test.tsx`

- [ ] **Step 3: Mount the panel after guide identity and before the existing steps grid**

```tsx
<GuideCoverPanel resourceId={id} resourceName={name} />
<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">…</div>
```

- [ ] **Step 4: Add a browser journey covering category → suggestion → edit → save → approve/publish**

The Playwright route fixtures return enabled category/presentation data and capture mutations. The test asserts accessible labels, premium preview visibility at mobile and desktop sizes, explicit action order, and zero `/messages` mutations from cover actions.

- [ ] **Step 5: Run focused, full, and build verification**

Run: `cd web && npm test -- src/pages/SequenceEditor.test.tsx src/features/guide-covers`

Run: `cd web && npm test`

Run: `cd web && npm run lint`

Run: `cd web && npm run build`

Run: `npm test`

Run: `npm run build`

- [ ] **Step 6: Visually inspect the creator panel at desktop and mobile sizes**

Run the local console with `GUIDE_COVER_AUTHORING_ENABLED=true`, capture both breakpoints, and compare the browser SVG to the approved category PNGs in `docs/qa/artifacts/2026-08-22-guide-covers/`. Do not enable delivery or contact a Meta account.

- [ ] **Step 7: Commit the integration**

```bash
git add web/src/pages/SequenceEditor.tsx web/src/pages/SequenceEditor.test.tsx web/e2e/guide-cover-authoring.spec.ts
git commit -m "feat: add guide cover creator console"
```

### Task 6: Final safety review and handoff

**Files:**
- Modify only files required by review findings.

**Interfaces:**
- Consumes: the complete creator console change.
- Produces: a clean feature branch with review evidence and production authoring/delivery flags still off.

- [ ] **Step 1: Review requirements line by line**

Confirm category search/add, truthful `needs_review`, suggestion fallback, local copy editing, exact shared preview, explicit save, approve/publish order, conflict preservation, message isolation, accessibility, and default-off behavior.

- [ ] **Step 2: Request independent code review**

Review Critical and Important findings for correctness, secrets, unsafe browser data, destructive category/publish behavior, stale revisions, unknown mutation outcomes, preview drift, and accessibility.

- [ ] **Step 3: Fix accepted findings with a failing regression test first**

Run each new focused test in red, apply the minimal correction, then run it green.

- [ ] **Step 4: Run fresh final verification**

Run: `git diff --check`

Run: `cd web && npm test && npm run lint && npm run build`

Run: `npm test && npm run build && npx prisma validate`

- [ ] **Step 5: Commit review fixes and report deployment boundary**

Commit only after verification. Report the branch and commit IDs, that authoring remains default-off, that delivery remains off, and that no Instagram parent was contacted.
