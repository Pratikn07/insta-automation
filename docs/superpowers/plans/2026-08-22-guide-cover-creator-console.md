# Guide Cover Creator Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the TinySoho creator select or add a reusable presentation category, generate or edit cover copy, preview the exact cover, and explicitly approve/publish it without managing design-system details.

**Architecture:** The existing Sequence Editor gains an isolated Presentation & cover panel. Typed API clients own all reads/mutations, a shared renderer supplies the exact local preview, and explicit draft/approve/publish state prevents blur-save ambiguity. A provider-neutral server suggestion service uses Gemini only for bounded copy/category suggestions and always degrades to deterministic defaults.

**Tech Stack:** React 19, TanStack Query, React Hook Form/Zod, cmdk, Tailwind CSS, shared TypeScript renderer, Express, Gemini, Vitest, Testing Library, Playwright.

**Spec:** [TinySoho reusable guide covers and follower gate design](../specs/2026-08-22-tinysoho-guide-covers-and-follower-gate-design.md), Creator console experience and AI-assisted suggestion flow.

## Global Constraints

- The creator supplies guide name, purpose, category confirmation, guide-owned copy edits, alternative description, and final approval only.
- Never ask for colors, fonts, coordinates, dimensions, edition numbers, renderer versions, file paths, or model settings.
- Adding a category creates a reusable row; it never stores one-off free text on a resource.
- A category without an approved visual combination is truthfully `Needs visual review` and cannot publish.
- Cover drafts save only through **Save cover draft**. Blur does not publish or silently replace the current published image.
- **Approve & publish** is explicit and reconciles unknown mutation outcomes before a retry.
- AI returns suggestions only. It cannot choose arbitrary visual keys, mutate a stored suggestion, approve, publish, or become required.
- Existing Steps editing and message order behavior must remain unchanged.
- Parent-delivery flags remain off throughout creator rollout/backfill.

---

### Task 1: Add typed presentation/cover clients and reconciliation

**Files:**

- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/api.ts`
- Create: `web/src/lib/guideCovers.ts`
- Create: `web/src/lib/guideCovers.test.ts`
- Modify: `docs/client-operation-contracts.md`

**Interfaces:**

- Add DTOs for category, presentation, suggestion, draft/published cover, render error, and cover status.
- Add `guideCoverApi` methods for every approved creator endpoint using `apiRead`/`apiMutation` only.
- Each create uses a browser-generated UUID as both body ID and operation ID; update/approve/publish use expected revision/status.

- [ ] Write failing tests for DTO validation, stable error mapping, category-create replay, draft-save replay, publish conflict, and unknown publish outcome reconciliation via a subsequent GET.
- [ ] Run `npm --prefix web test -- src/lib/guideCovers.test.ts` and confirm missing-module failure.
- [ ] Implement Zod parsing at the API boundary; reject malformed server responses before they enter form state.
- [ ] Add client-operation contract rows naming which GET proves the result of every unknown mutation outcome.
- [ ] Rerun focused tests and web build.
- [ ] Commit with `feat: add typed guide cover client`.

### Task 2: Build the reusable searchable category combobox

**Files:**

- Create: `web/src/components/guides/PresentationCategoryCombobox.tsx`
- Create: `web/src/components/guides/PresentationCategoryCombobox.test.tsx`
- Create: `web/src/components/guides/AddPresentationCategoryDialog.tsx`
- Create: `web/src/components/guides/AddPresentationCategoryDialog.test.tsx`

**Interfaces:**

- Combobox uses existing `cmdk`, supports search, keyboard navigation, status labels, and **Add category**.
- Add dialog accepts human name, server-proposed slug/label/closest registered visual family, then submits creator confirmation.
- `inactive` categories remain visible for existing assignments but cannot be newly selected.

- [ ] Write failing accessibility tests for label/description, keyboard open/search/select, empty results, current inactive selection, status announcement, and focus return.
- [ ] Write failing add-category tests for case-insensitive duplicate error, normalized server slug, `needs_review` result, exact replay, and cancel-without-write.
- [ ] Run the focused component tests and confirm expected failures.
- [ ] Implement the components using semantic combobox/dialog roles and existing design tokens; do not introduce a second UI framework.
- [ ] Rerun focused tests and web build.
- [ ] Commit with `feat: add reusable presentation category picker`.

### Task 3: Build the exact cover preview and editor state machine

**Files:**

- Create: `web/src/components/guides/GuideCoverPreview.tsx`
- Create: `web/src/components/guides/GuideCoverPreview.test.tsx`
- Create: `web/src/components/guides/GuideCoverEditor.tsx`
- Create: `web/src/components/guides/GuideCoverEditor.test.tsx`
- Modify: `web/src/components/SaveStatus.tsx`

**Interfaces:**

- Preview renders the shared SVG at the canonical aspect ratio and exposes the creator-reviewed alternative description.
- Editor states are `not_configured | draft | needs_attention | approved | publishing | published | publish_failed`.
- Fields show character counts and line-fit errors; save, approve, and publish are distinct transitions.

- [ ] Write failing snapshot/DOM tests for all four approved categories using their example copy, exact aspect ratio, and Montessori right-side composition.
- [ ] Add field-boundary tests, overflow errors, malicious markup escaping, status announcements, and screen-reader descriptions.
- [ ] Write failing editor tests for dirty state, explicit draft save, no blur-save, save conflict, approve, publish, unknown-outcome reconciliation, published immutability, and previous-cover preservation after failure.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement preview as the shared renderer output, not a hand-maintained CSS imitation.
- [ ] Implement the reducer/state machine before connecting API mutations; every async transition must have a stable recoverable state.
- [ ] Rerun focused tests and web build.
- [ ] Commit with `feat: build TinySoho cover editor and preview`.

### Task 4: Integrate Presentation & cover into Sequence Editor

**Files:**

- Modify: `web/src/pages/SequenceEditor.tsx`
- Modify: `web/src/pages/SequenceEditor.test.tsx`
- Modify: `web/src/pages/Sequences.tsx`
- Modify: `web/src/pages/Sequences.test.tsx`

**Interfaces:**

- Insert the panel after guide identity/purpose and before Steps.
- Fetch presentation data independently so a cover API failure does not hide or overwrite guide messages.
- Show list attention for active guides missing category confirmation or published cover when authoring review is enabled.

- [ ] Extend Sequence Editor tests with independent loading/error states, retained local cover draft across resource refetch, and no mutation of messages during cover actions.
- [ ] Add tests proving a message save/refetch does not overwrite cover state and a cover publish does not reorder/refetch message drafts destructively.
- [ ] Add sequence-list attention tests with actionable links and no leakage of private cover copy in list responses.
- [ ] Run focused page tests and confirm expected failures.
- [ ] Integrate the panel behind `GUIDE_COVER_AUTHORING_ENABLED` returned through the flags/API surface; do not read Vite environment flags directly.
- [ ] Rerun focused/full web tests and build.
- [ ] Commit with `feat: add cover authoring to guide editor`.

### Task 5: Implement the provider-neutral suggestion service

**Files:**

- Create: `src/services/guideCoverSuggestionProvider.ts`
- Create: `src/services/guideCoverSuggestionService.ts`
- Create: `src/services/guideCoverSuggestionService.test.ts`
- Create: `src/services/geminiGuideCoverSuggestionProvider.ts`
- Create: `src/services/geminiGuideCoverSuggestionProvider.test.ts`
- Modify: `src/api/resourceCovers.routes.ts`
- Modify: `src/api/resourceCovers.routes.test.ts`

**Interfaces:**

- `PresentationSuggestionProvider.suggest(input)` returns only category slug, four guide-owned text fields, confidence, and bounded warnings.
- Deterministic fallback derives safe editable copy from resource name and category defaults.
- Gemini receives only bounded resource/category/resource-step data from the spec and uses strict JSON schema at temperature zero.

- [ ] Write failing service tests for valid immutable suggestion plus editable draft, unknown category, overflow, HTML/URL, malformed JSON, timeout, quota, disabled provider, and duplicate source hash.
- [ ] Add prompt-boundary tests proving parent IDs, follower state, DM history, Meta tokens, Supabase credentials, media URLs, and full guide bodies are never passed.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement Zod validation and normalized source hashing; store provider/model/prompt version but not raw prompt/output or chain-of-thought.
- [ ] Implement Gemini through the existing server client with a bounded response schema; on any failure return deterministic defaults and a safe warning.
- [ ] Extend the suggestion endpoint tests and prove no provider code imports or invokes publication.
- [ ] Rerun focused/full backend tests and build.
- [ ] Commit with `feat: suggest guide cover copy safely`.

### Task 6: Connect suggestion and reset controls in the editor

**Files:**

- Modify: `web/src/components/guides/GuideCoverEditor.tsx`
- Modify: `web/src/components/guides/GuideCoverEditor.test.tsx`

**Interfaces:**

- **Suggest from guide** loads a suggestion into an editable draft and identifies low confidence/warnings.
- **Reset to category defaults** resets category-owned context and deterministic name-based guide copy only after creator confirmation when dirty.
- Creator edits never mutate the stored suggestion record.

- [ ] Write failing tests for suggestion loading/success/fallback, low-confidence warning, creator edit after suggestion, preserved immutable suggestion ID, disabled-provider state, and reset confirmation.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement the controls with explicit busy/error states and no auto-publish.
- [ ] Rerun focused tests and web build.
- [ ] Commit with `feat: add assisted cover copy workflow`.

### Task 7: Add existing-resource backfill review

**Files:**

- Create: `src/services/guidePresentationBackfill.ts`
- Create: `src/services/guidePresentationBackfill.test.ts`
- Create: `src/api/guidePresentationBackfill.routes.ts`
- Create: `src/api/guidePresentationBackfill.routes.test.ts`
- Modify: `src/api/router.ts`
- Create: `web/src/pages/GuidePresentationBackfill.tsx`
- Create: `web/src/pages/GuidePresentationBackfill.test.tsx`
- Modify: `web/src/AppRoutes.tsx`
- Modify: `web/src/lib/navigation.ts`

**Interfaces:**

- Deterministic high-confidence rules may suggest Recipes from existing `kind=recipes` and Bedtime from unambiguous sleep theme/title; ambiguous rows use the bounded provider.
- Backfill rows are suggestions only until the creator confirms category assignment.
- Queue orders 57 active resources before inactive/orphan drafts and exposes confidence/warnings without guide bodies.

- [ ] Write failing pure tests for deterministic classification, ambiguous fallback, product-link exclusion, no auto-confirmation, and stable normalized source hashes.
- [ ] Write failing route tests for pagination, bulk confirmation with explicit IDs/revisions, conflict, and zero direct publication.
- [ ] Write failing UI tests for review/confirm/edit/skip, status counts, warnings, keyboard labels, and an explicitly reviewed batch publish action.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement the review queue and owner-confirmed writes; never infer active from row existence when keywords determine live use.
- [ ] Keep parent delivery off for unreviewed/unpublished resources.
- [ ] Rerun full backend/web tests and builds.
- [ ] Commit with `feat: add guide presentation backfill review`.

### Task 8: Owner review of representative published covers

**Files:**

- Create: `docs/qa/2026-08-22-guide-cover-authoring-qa.md`
- Add redacted screenshots under: `docs/qa/artifacts/2026-08-22-guide-cover-authoring/`

- [ ] Enable only `GUIDE_COVER_AUTHORING_ENABLED` for the owner environment.
- [ ] Create/review one representative guide in each approved category.
- [ ] Compare browser SVG preview and stored PNG for identical copy/category/edition at original resolution.
- [ ] Verify add-category produces `Needs visual review` until a registered visual combination is confirmed.
- [ ] Verify Gemini disabled/timeout still permits manual deterministic publishing.
- [ ] Verify previous published cover remains visible after a deliberately induced publish failure in a non-production test environment.
- [ ] Complete keyboard/screen-reader checks and capture sanitized screenshots.
- [ ] Record owner approval per category; keep all parent-facing flags off.
- [ ] Commit with `docs: record guide cover authoring QA`.

## Final Verification

- [ ] Run complete backend and web test suites/builds.
- [ ] Run Playwright for the Sequence Editor at desktop and mobile console widths.
- [ ] Confirm the Steps editor regression suite remains unchanged/passing.
- [ ] Confirm no browser request or bundle contains a service credential, unpublished Storage URL, model prompt, or parent data.
- [ ] Confirm every published cover has explicit creator identity/timestamp and every AI suggestion remains non-authoritative.
- [ ] Request whole-branch code/design review before beginning backfill publication.
