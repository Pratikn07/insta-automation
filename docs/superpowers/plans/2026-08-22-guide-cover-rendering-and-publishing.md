# Guide Cover Rendering and Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic, reusable TinySoho cover system and a safe server-only publication pipeline for the four approved categories without exposing drafts or contacting parents.

**Architecture:** Shared pure TypeScript policy, registry, layout, and SVG modules own the approved visual system. PostgreSQL stores reusable categories, resource presentation, immutable suggestions, versioned covers, and orphan cleanup. The server reserves a stable collection edition, rasterizes approved SVG with pinned fonts and Resvg, records the exact external-write intent, uploads a content-hashed public PNG through the service credential, then performs a short concurrency-safe publication transaction.

**Tech Stack:** TypeScript, Node.js 22, Prisma 5/PostgreSQL/Supabase, `@resvg/resvg-js@2.6.2`, `fontkit@2.0.4`, Source Serif 4 and Inter OFL assets, Express, Zod, Vitest.

**Spec:** [TinySoho reusable guide covers and follower gate design](../specs/2026-08-22-tinysoho-guide-covers-and-follower-gate-design.md), approved visual system through publish transaction.

## Global Constraints

- V1 includes exactly `bedtime`, `potty-training`, `recipes`, and `montessori-activities` with the approved keys, palette values, copy defaults, illustration rules, and compositions.
- Published PNGs are deterministic. No image model or remote font service participates in rendering.
- Kicker/collection/visual keys come from a reusable category; creator-editable guide copy never supplies CSS, SVG, HTML, URLs, coordinates, or keys.
- Browser preview and server PNG use the same shared geometry, normalization, line-breaking, and overflow policy.
- Never shrink text below the approved minimum to make invalid copy fit. Return `cover_text_overflow`.
- Drafts remain local/browser-rendered. Only immutable published PNGs enter the existing public bucket.
- Generated objects use new content-hashed paths and are never overwritten.
- Rendering and Storage happen outside all database transactions. Short transactions reserve the edition, record the exact upload intent, and finalize publication; no external call occurs while rows are locked.
- All new database tables are server-owned: enable RLS, revoke `anon` and `authenticated`, index every foreign key, and expose no direct browser policy.
- The authoring flag is assistive. All delivery/rich/follow flags remain off throughout this plan.

---

### Task 1: Pin renderer, font, and asset provenance

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `shared/guide-cover-assets/LICENSES.md`
- Create: `shared/guide-cover-assets/fonts/source-serif-4-latin-400-normal.woff2`
- Create: `shared/guide-cover-assets/fonts/source-serif-4-latin-600-normal.woff2`
- Create: `shared/guide-cover-assets/fonts/inter-latin-400-normal.woff2`
- Create: `shared/guide-cover-assets/fonts/inter-latin-600-normal.woff2`
- Create: `scripts/copy-guide-cover-assets.mjs`
- Create: `src/services/guideCoverAssetContract.test.ts`

**Interfaces:**

- Pin exact production dependencies `@resvg/resvg-js@2.6.2` and `fontkit@2.0.4`; add `@types/fontkit@2.0.9` as a development dependency.
- Font files come from `@fontsource/source-serif-4@5.3.0` and `@fontsource/inter@5.3.0`, with OFL licenses and SHA-256 hashes recorded in `LICENSES.md`.
- `npm run build` copies committed font assets to `dist/shared/guide-cover-assets/fonts`.

- [ ] Write a failing contract test that resolves all four source/dist font paths, checks their recorded SHA-256 values, and rejects a missing or silently changed asset.
- [ ] Run `npm test -- src/services/guideCoverAssetContract.test.ts` and confirm the missing-assets failure.
- [ ] Install the exact dependencies and update the lockfile.
- [ ] Add the four license-cleared WOFF2 files and record source package versions, license, filenames, and hashes.
- [ ] Implement the narrow copy script; it may create only `dist/shared/guide-cover-assets/fonts` and copy the four allowlisted files.
- [ ] Change the root build script to run the asset copy after TypeScript compilation.
- [ ] Rerun the focused test and `npm run build`; verify the compiled runtime resolves the copied assets.
- [ ] Commit with `build: pin TinySoho cover renderer assets`.

### Task 2: Implement the shared cover policy and approved registry

**Files:**

- Create: `shared/guideCoverPolicy.ts`
- Create: `shared/guideCoverPolicy.test.ts`
- Create: `shared/guideCoverRegistry.ts`
- Create: `shared/guideCoverRegistry.test.ts`
- Modify: `tsconfig.json`
- Modify: `web/tsconfig.app.json`

**Interfaces:**

- Export validated `GuideCoverDraft`, `GuideCoverRenderInput`, `GuideCoverRendition`, and stable error codes.
- Enforce limits `32/16/56/90/64/240`, two-line headline/support/closing rules, canonical `1200 × 916`, and registered keys only.
- Registry entries contain the exact approved category slug, default kicker, collection label, template/palette/illustration keys, colors, and safe-area geometry.

- [ ] Write failing policy boundary tests for each exact limit, Unicode code-point counting, whitespace normalization, two-line fit, three-digit editions, and markup/control-character rejection.
- [ ] Write failing registry tests asserting every approved palette hex and every exact key from the spec, including the potty imagery exclusions and Montessori right-panel composition.
- [ ] Run both focused tests and confirm the expected missing-module failures.
- [ ] Implement pure modules with no React, Node, Prisma, Supabase, Meta, AI, filesystem, or network imports.
- [ ] Add exhaustiveness checks so an unregistered template/palette/illustration cannot reach rendering.
- [ ] Rerun focused tests and both backend/frontend type builds.
- [ ] Commit with `feat: define approved TinySoho cover system`.

### Task 3: Implement deterministic SVG layout and PNG rendering

**Files:**

- Create: `shared/guideCoverRenderer.ts`
- Create: `shared/guideCoverRenderer.test.ts`
- Create: `src/services/guideCoverPngRenderer.ts`
- Create: `src/services/guideCoverPngRenderer.test.ts`
- Create: `docs/qa/artifacts/2026-08-22-guide-covers/README.md`
- Create: four approved PNG snapshots under `docs/qa/artifacts/2026-08-22-guide-covers/`

**Interfaces:**

- `layoutGuideCover(input, fontMetrics)` returns either normalized layout or `{ error: "cover_text_overflow", field }`.
- `renderGuideCoverSvg(layout, fontFaces)` returns escaped SVG with no external URL references.
- `renderGuideCoverPng(input, rendition)` returns PNG bytes, dimensions, normalized content hash, and storage filename.
- Hash input includes renderer version, font hashes, normalized content, category/edition, registered visual keys, and rendition.

- [ ] Write failing geometry tests for `warm_editorial_corner_v1` and `editorial_right_panel_v1`, including artwork/text safe areas and the right-side Montessori constraint.
- [ ] Add malicious text tests for `<script>`, XML entities, data URLs, bidi/control characters, and overlong unbroken tokens.
- [ ] Add deterministic tests proving identical input yields identical SVG, PNG hash, and bytes; one copy/key/edition change yields a different hash.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement font parsing/measurement with the bundled Source Serif 4/Inter assets; do not use `canvas.measureText` or host fonts.
- [ ] Implement code-native SVG illustrations for the four approved directions and Resvg rasterization for `dm_cover`.
- [x] ~~Implement `generic_card` composition behind a renderer option, but do not publish it until the Meta spike marks it supported.~~ **Spike ruled against it.** Instagram's template image slot centre-crops to ~1:1, so the 1.91:1 source lost its first word on device. `generic_card` is retired unpublished and `square_card` (1200x1200) takes its place, because a square source makes the crop a no-op. See `docs/meta-verification/2026-08-24-guide-gate-capability-results.json`.
- [ ] Generate the four PNG snapshots with approved example copy and inspect them at original resolution.
- [ ] Rerun focused tests on the developer machine and in a clean `npm ci && npm run build` environment; hashes must match.
- [ ] Commit with `feat: render deterministic TinySoho guide covers`.

### Task 4: Add cover-authoring schema, constraints, seeds, and security

**Files:**

- Create: `prisma/migrations/20260822010000_add_guide_cover_authoring/migration.sql`
- Modify: `prisma/schema.prisma`
- Create: `src/services/guideCoverMigrationContract.test.ts`

**Interfaces:**

- Add `PresentationCategory`, `ResourcePresentation`, `ResourceCoverSuggestion`, `ResourceCoverVersion`, and `GuideCoverOrphan` models.
- Add enums for category design, cover lifecycle, render lifecycle, suggestion confidence, and orphan cleanup state.
- Seed/upsert the four approved categories with fixed UUIDs and exact registry keys.
- Use `ON DELETE RESTRICT` for used categories/resources and `ON DELETE SET NULL` only for optional suggestion references.

- [ ] Write a failing catalog contract for table/enum names, lowercase mapped identifiers, UUID primary keys, timestamptz audit columns, exact constraints, and foreign-key targets/delete actions.
- [ ] Assert full leading indexes for every foreign key, case-insensitive unique category name/slug behavior, unique `(category_id, edition_number)` when non-null, unique `(resource_id, revision)`, and one partial published cover per resource.
- [ ] Assert published rows require `render_status = ready`, category/edition snapshot, content hash, and DM path; invalid lengths/empty fields fail in PostgreSQL as well as application code.
- [ ] Assert RLS is enabled and `anon`/`authenticated` have no table privileges. Do this even if a current Supabase project no longer auto-exposes newly created public tables.
- [ ] Run the contract test without a database and confirm it is skipped; run it against the disposable local PostgreSQL and confirm failure before the migration exists.
- [ ] Hand-write the additive SQL migration, then mirror it in Prisma schema without allowing Prisma to replace partial indexes or checks.
- [ ] Seed the four categories idempotently in the migration with `ON CONFLICT` that verifies rather than silently changes approved visual keys.
- [ ] Run `prisma migrate deploy`, focused contract tests, `npx prisma validate`, `npx prisma generate`, and `npm run build` against the disposable database.
- [ ] Run the Prisma drift guard and inspect that protected hand-authored indexes/constraints remain intact.
- [ ] Commit with `feat: add guide cover publication schema`.

### Task 5: Implement repositories and server-only Storage access

**Files:**

- Create: `src/services/presentationCategoryRepository.ts`
- Create: `src/services/presentationCategoryRepository.test.ts`
- Create: `src/services/guideCoverRepository.ts`
- Create: `src/services/guideCoverRepository.test.ts`
- Create: `src/services/guideCoverRepositoryContract.test.ts`
- Create: `src/services/guideCoverStorage.ts`
- Create: `src/services/guideCoverStorage.test.ts`
- Modify: `src/lib/supabase.ts`

**Interfaces:**

- Repositories create/load idempotent UUID-owned rows, save mutable drafts under an expected revision, and expose published covers only through an explicit lookup.
- Storage accepts PNG bytes plus the fully derived content-hashed path and uploads with `contentType: image/png`, immutable cache control, and `upsert: false`.
- Browser-facing upload signing is never used for generated covers.

- [ ] Write failing repository tests for create replay, expected-revision conflict, published immutability, category readiness, and safe lookup excluding drafts/failed renders.
- [ ] Write concurrent contract tests for first edition allocation and one-published-cover uniqueness.
- [ ] Write failing Storage tests for exact path derivation, `upsert: false`, immutable cache control, existing-object reconciliation, non-PNG rejection, and safe errors without provider bodies.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement repositories with short transactions and consistent lock order: resource, category when needed, resource presentation, cover version, exact orphan row.
- [ ] Implement a narrow generated-cover Storage boundary using the existing server Supabase client; do not export service credentials or accept a caller-supplied path.
- [ ] Rerun unit/contract tests and build.
- [ ] Commit with `feat: persist and store generated guide covers`.

### Task 6: Implement idempotent approval and publication

**Files:**

- Create: `src/services/guideCoverPublishService.ts`
- Create: `src/services/guideCoverPublishService.test.ts`
- Create: `src/services/guideCoverPublishServiceContract.test.ts`

**Interfaces:**

- `approveCoverVersion(input)` validates category readiness, policy/layout, expected revision/status, and owner identity without uploading.
- `publishCoverVersion(input)` reserves a stable edition, renders, records the exact pre-upload intent, uploads outside a transaction, and publishes exactly one version in a final short transaction.
- Stable outcomes include published, exact replay, conflict, not approved, category not ready, overflow, render failed, and storage outcome unknown.

- [ ] Write failing service tests proving no renderer/Storage call occurs while a transaction is open and the durable intent exists before Storage is contacted.
- [ ] Add tests for exact replay, concurrent first publish, prior-published preservation, failed upload, upload-success/database-failure orphan recording, and no second edition on retry.
- [ ] Add contract tests proving a new publication atomically retires the previous version and a category move cannot happen through ordinary publish.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement approval and publication using content-hashed idempotency and the repository/Storage boundaries.
- [ ] Ensure logs contain only cover/resource IDs, revision, safe status/error code, dimensions, and hash prefix—not copy, URLs, bytes, credentials, or raw exceptions.
- [ ] Rerun focused tests, disposable-Postgres contracts, full backend tests, and build.
- [ ] Commit with `feat: publish immutable guide covers`.

### Task 7: Add authenticated cover/category APIs and deletion safeguards

**Files:**

- Create: `src/api/presentationCategories.routes.ts`
- Create: `src/api/presentationCategories.routes.test.ts`
- Create: `src/api/resourceCovers.routes.ts`
- Create: `src/api/resourceCovers.routes.test.ts`
- Modify: `src/api/router.ts`
- Modify: `src/api/resources.routes.ts`
- Modify: `src/api/resources.routes.test.ts`
- Create: `src/services/guideCoverCollectionMoveService.ts`
- Create: `src/services/guideCoverCollectionMoveService.test.ts`
- Create: `src/services/guideCoverCollectionMoveServiceContract.test.ts`
- Modify: `docs/client-operation-contracts.md`

**Interfaces:**

- Implement the creator endpoints listed in the spec with UUID-owned create operations and `Idempotency-Key` validation.
- Add `POST /api/resources/:id/presentation/move` as the only operation allowed to change a published resource's category.
- Return bucket-relative paths and safe public URLs only for published renditions.
- Stable error codes match the spec and never contain raw renderer/Storage errors.

- [ ] Write failing route tests for list/create/update category, read/save presentation, create/update/approve/publish cover, exact replay, revision conflict, invalid visual key, overflow, and category not ready.
- [ ] Add deletion tests: published cover returns `resource_has_published_cover`; unpublished presentation/drafts are removed in a bounded transaction; no broad Storage prefix deletion occurs.
- [ ] Add failing collection-move tests proving an explicit expected category/revision is required, the old published cover is retired, a new target-category edition is allocated exactly once, and historical cover snapshots keep their old category/edition.
- [ ] Run focused route tests and confirm expected failures.
- [ ] Implement authenticated routers using existing `apiRouter` protection and `asyncRouter` conventions.
- [ ] Implement collection move as a dedicated short transaction with lock order resource, target category, resource presentation, published cover; ordinary presentation update continues to reject a published category change. A post-commit retry returns conflict and reconciles through canonical reads rather than an unsafe replay guess.
- [ ] Add each mutation/reconciliation rule to `docs/client-operation-contracts.md`.
- [ ] Rerun focused/full backend tests and build.
- [ ] Commit with `feat: expose guide cover authoring APIs`.

### Task 8: Reconcile orphaned generated objects without broad deletion

**Files:**

- Create: `src/services/guideCoverOrphanCleanup.ts`
- Create: `src/services/guideCoverOrphanCleanup.test.ts`
- Create: `src/services/guideCoverOrphanCleanupContract.test.ts`
- Create: `src/services/guideCoverOrphanCleanupScheduler.ts`
- Create: `src/services/guideCoverOrphanCleanupScheduler.test.ts`
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `src/server.ts`

**Interfaces:**

- The worker claims a bounded batch of recorded exact object paths, deletes only those paths, and checkpoints success/failure with capped attempts.
- Add conservative `GUIDE_COVER_ORPHAN_BATCH` and `GUIDE_COVER_ORPHAN_INTERVAL_MS` settings; `WORKERS_ENABLED=false` starts no scheduler.

- [ ] Write failing worker tests for exact-path deletion, batch limit, claim lease, transient retry, exhausted review, already-missing success, and unknown delete outcome.
- [ ] Add a destructive-target guard test rejecting empty paths, prefixes, globs, traversal, non-content-hashed paths, and more than the claimed allowlisted objects.
- [ ] Write concurrent PostgreSQL tests proving two workers cannot claim the same orphan and expired claims reconcile without duplicating a delete call in-process.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement claim/checkpoint transactions around—never across—the Supabase delete call; an uncertain delete is reconciled by checking only the exact object path before any retry.
- [ ] Start the scheduler only inside the existing background-worker boundary and stop it during server shutdown.
- [ ] Rerun focused/full backend tests and build.
- [ ] Commit with `feat: reconcile orphaned guide cover objects`.

### Task 9: Register the hidden authoring flag and run foundation verification

**Files:**

- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `src/config/flagRegistry.ts`
- Modify: `src/config/flagRegistry.test.ts`
- Modify: `src/config/flagCallSites.test.ts`

**Interfaces:**

- Add `GUIDE_COVER_AUTHORING_ENABLED` defaulting to false.
- Registry group is `assistive`, `pageMayEnable: true`, `pageMayStop: true`.
- APIs return `403 { error: "guide_cover_authoring_disabled" }` when off, except published-cover read used later by server delivery.

- [ ] Add failing env/registry tests for the new flag and its plain-language description.
- [ ] Run focused flag tests and confirm failure.
- [ ] Add the flag with `booleanFlag(false)` and read it through `flagService`, never directly from `env` at operation call sites.
- [ ] Prove turning it off blocks creator mutations but never removes an existing published cover.
- [ ] Run complete backend tests/build, frontend build, disposable-Postgres migration contracts, font/hash snapshots, and a secret scan of web output.
- [ ] Confirm `GUIDE_COVER_DELIVERY_ENABLED`, `GUIDE_RICH_GATE_ENABLED`, and `GUIDE_FOLLOW_GATE_V2_ENABLED` do not exist or remain false; this plan contacts no parents.
- [ ] Commit with `feat: gate guide cover authoring foundation`.

### Task 10: Publish the square rendition (NOT STARTED — added 2026-08-23)

The renderer produces `square_card` (1200x1200) and its geometry is locked with tests,
but **nothing can publish it yet and nothing sends it.** This task is what closes that
gap, and it is a schema task before it is a service task.

**Verified against production, 2026-08-23** — read these before designing the migration,
because two of the three are easy to miss and one of them fails silently:

1. `guide_cover_orphan_rendition_check` is
   `CHECK (rendition = ANY (ARRAY['dm_cover','generic_card']))`. It does not allow
   `square_card`, so orphan recording — which happens *before* the upload — rejects the
   row and publication cannot proceed. This is the hard stop, and it fails loudly.
2. `guide_cover_orphan_storage_path_check` derives the filename with
   `CASE rendition WHEN 'dm_cover' THEN 'dm' ELSE 'generic' END`. **The `ELSE` is the
   trap.** Widen the rendition CHECK in (1) and this constraint will happily accept a
   square stored at `generic.png` — no error, wrong filename, and the two renditions now
   share a path namespace. Whatever (1) allows, this CASE must name explicitly.
3. `resource_cover_version_ready_render_check` pins `generic_storage_path` to exactly
   `guide-cover/{resource}/{version}/{hash}/generic.png`. So reusing that column for the
   square forces the `generic.png` filename; a `square.png` filename requires a new
   column and a change here.

One constraint the storage layout must keep, verified the hard way on 2026-08-23: **Meta
caches a template's `image_url` by URL.** Uploading new bytes to a path that has already
been fetched leaves Instagram rendering its cached copy — accepted with a 200, looking
correct, showing a cover two revisions old. The existing
`guide-cover/{resource}/{version}/{contentHash}/{filename}` layout already prevents this,
because new bytes mean a new hash means a new URL. Treat that hash as load-bearing for
correctness and not merely for idempotency: any "simplification" to a stable per-resource
path would serve every parent a permanently stale cover with no error raised anywhere.

And one code-side consequence that leaks storage rather than erroring:
`validateGuideCoverObjectIdentity` in `src/services/guideCoverCleanupStorage.ts` maps only
`dm_cover -> dm` and `generic_card -> generic`, returning `null` for anything else, which
makes the identity invalid and makes cleanup **refuse to delete**. Today that is the safe
direction — an unpublishable square cannot be wrongly deleted. The moment squares can be
published, it inverts: every orphaned square becomes permanently unreclaimable. This
mapping has to be widened in the same change as the constraints, not after.

- [ ] Decide the column question: reuse `generic_storage_path` (forces the `generic.png`
      filename, retires the name in place) or add `square_storage_path` (clearer, one more
      column and constraint). Prefer whichever leaves no path shared between two renditions.
- [ ] Write the migration contract test FIRST, asserting a `square_card` orphan row is
      accepted, that its path uses the square filename and not `generic.png`, and that the
      old `generic_card` values still validate for historical rows.
- [ ] Widen `validateGuideCoverObjectIdentity` and prove a published square is claimable by
      cleanup — the assertion that matters is a successful delete, not a valid identity.
- [ ] Render and store both renditions in `publishCoverVersion`, preserving its existing
      guarantees: durable intent before Storage, upload outside the transaction, exact
      replay on retry, and no second edition. Two uploads means two orphan claims and a
      partial-success path that did not exist before — cover it explicitly.
- [ ] Resolve the square's public URL at send time and pass it as `coverUrl` instead of the
      `""` placeholder in `guideAccessActionService`'s default `sendFollowerGate`.
- [ ] Add the missing `private_generic` branch to `sendGuideInitialPrivateReply`. The
      payload builder already supports the case and nothing reaches it. This is the branch
      that lets one message carry artwork and a control together, which is the only shape
      available on the comment path, where Meta permits exactly one private reply.
- [ ] Only then spend a fresh comment on the `private_generic` capability case, so the one
      irreversible attempt verifies the real send path rather than the payload builder.
- [ ] Keep `GUIDE_RICH_GATE_ENABLED` false throughout. Enabling it needs the inbound
      webhook shape confirmed against the guide-action router and a duplicate tap shown to
      be idempotent — neither of which the spike observed.

## Final Verification

- [ ] Run `npm ci`, `npm test`, and `npm run build` in a clean checkout.
- [ ] Run every migration contract with `DATABASE_URL=MIGRATION_TEST_DATABASE_URL` pointing to a disposable loopback PostgreSQL database and `MIGRATION_TEST_DATABASE_DISPOSABLE=true`.
- [ ] Run `npm --prefix web ci`, `npm --prefix web test`, and `npm --prefix web run build`.
- [ ] Compare all four PNGs with the approved mock directions at original resolution.
- [ ] Verify public Storage contains only published content-hashed PNGs and no draft object.
- [ ] Verify the Vite bundle contains no Supabase service key, Meta token, filesystem path, or unpublished cover text.
- [ ] Request whole-branch code review and resolve all Critical/Important findings before enabling the authoring flag.
