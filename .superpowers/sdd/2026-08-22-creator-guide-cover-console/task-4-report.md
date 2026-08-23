# Task 4 report: Creator guide-cover panel

## Status

Implemented the central `GuideCoverPanel` for authoring, suggesting, explicitly saving,
recovering conflicted/uncertain drafts, approving, and publishing guide covers. The panel is
not mounted into `SequenceEditor`; that remains Task 5.

## RED evidence

All production behavior was driven by observed failures:

1. `cd web && npm test -- src/features/guide-covers/GuideCoverPanel.test.tsx`
   - Failed before implementation because `./GuideCoverPanel` did not exist.
2. The draft-recovery batch failed 3 tests before recovery code existed:
   - intended copy could not be confirmed as saved after an unknown PATCH;
   - unchanged canonical state did not unlock a safe retry;
   - `cover_revision_conflict` did not preserve copy or offer `Save as new draft`.
3. The lifecycle/preview batch failed 6 tests before the lifecycle action existed:
   - no `Approve and publish` action;
   - no truthful Approved retry state;
   - no dirty, missing-draft, invalid-preview, or unavailable-preview gating.
4. The failed-reconciliation-read regression failed 1 test because TanStack retained stale data
   after the GET failed and the panel incorrectly left its normal read state.
5. The uncertain-lifecycle batch failed 3 tests before canonical reconciliation:
   - unknown approval did not continue after GET confirmed Approved;
   - unknown publication was labelled as a definite failure;
   - a canonically completed publication was not shown as Published.
6. The busy-state regression failed 1 test because editable copy/category controls remained
   enabled while an explicit save was in flight.

Each batch was rerun green before proceeding.

## Implementation

- `GuideCoverPanel.tsx`
  - Reads `/presentation-categories` with `retry: false` and the resource presentation.
  - Hides only for `403 guide_cover_authoring_disabled`; other initial read failures retain a
    labelled retry surface.
  - Keeps category/copy/suggestion provenance local until explicit draft save.
  - Uses stable suggestion and create UUIDs, renewing only after known success.
  - POSTs UUID-owned drafts and PATCHes saved drafts with `expectedRevision`.
  - Reconciles unknown PATCH outcomes with a canonical GET. Matching copy becomes a known
    success, unchanged state allows a safe retry, failed reads require `Check save status`, and
    divergence becomes local conflict/new-draft recovery.
  - Preserves all local fields and clears stale cover identity for `cover_revision_conflict`.
  - Gates publication on saved draft identity, clean local copy, ready category, and a ready
    exact preview.
  - Calls approve then publish with the same expected revision. A failed publish leaves the UI
    truthfully Approved and retries publish only. Unknown lifecycle outcomes reconcile by GET.
  - Does not read, mutate, invalidate, or write any `/messages` resource/query.
  - Provides labelled fields, counters, errors/notices, disabled controls, and busy states.
- `GuideCoverPreview.tsx`
  - Added an optional `onStatusChange` contract so the panel can distinguish loading, ready,
    invalid, and unavailable exact previews without duplicating renderer logic.
- `PresentationCategoryPicker.tsx`
  - Added an optional disabled state so category intent cannot change during an in-flight owner
    action.
- `types.ts`
  - Added only feature-local cover API response and preview-status types. `web/src/lib/types.ts`
    was intentionally not modified because no global consumer needs a re-export.

## GREEN verification

Fresh final commands on the committed implementation tree:

```text
cd web && npm test -- src/features/guide-covers/GuideCoverPanel.test.tsx
Test Files  1 passed (1)
Tests       22 passed (22)

cd web && npm test
Test Files  70 passed (70)
Tests       912 passed (912)

cd web && npm run lint
eslint .
exit 0

cd web && npm run build
tsc -b && vite build
2412 modules transformed
exit 0

git diff --cached --check
exit 0
```

The build retains Vite's existing advisory that the main bundle is larger than 500 kB; it is a
warning, not a failure.

## Files

- Created `web/src/features/guide-covers/GuideCoverPanel.tsx`
- Created `web/src/features/guide-covers/GuideCoverPanel.test.tsx`
- Modified `web/src/features/guide-covers/GuideCoverPreview.tsx` (Task 4 preview-status bridge)
- Modified `web/src/features/guide-covers/PresentationCategoryPicker.tsx` (Task 4 busy-state lock)
- Modified `web/src/features/guide-covers/types.ts`
- Created this report

## Commit

- `22645b3 feat: author and publish guide covers`
- This report is committed separately after the implementation hash is known.

## Self-review

- Confirmed no mutation occurs on field blur.
- Confirmed suggestion calls only the suggestion endpoint and edits local state.
- Confirmed create body `id` equals the `Idempotency-Key` operation ID.
- Confirmed PATCH uses the saved identity/revision and cannot retry an unresolved unknown outcome.
- Confirmed explicit and unknown divergence paths preserve every local copy field.
- Confirmed conflict recovery's next save is POST with a new UUID-owned draft identity.
- Confirmed approve/publish order and identical `expectedRevision` bodies.
- Confirmed publication is blocked for dirty copy, missing saved draft, non-ready category,
  invalid preview, and unavailable preview.
- Confirmed failure after approval displays Approved and does not imply the previous published
  cover changed.
- Confirmed no cover action accesses `/messages` or a message query key.
- Confirmed query hydration uses a keyed editor initializer rather than overwriting local state
  on later refetches.

## Concerns / handoff

- Task 5 still needs to mount the panel in `SequenceEditor` and provide browser-level layout QA.
- The Vite bundle-size advisory remains unchanged and is outside Task 4 scope.
- No delivery flag, authoring flag default, Instagram account, or message content was changed.
