# Task 8 Report: Segment and Aggregate Reporting in Admin UI

## RED / GREEN

- **RED:** Added focused API assertions for frozen/current audience segments, campaign rollout metadata, and capacity-state query semantics. Added view-model, drawer, and page tests for exhaustive segment labels, drift rendering, shared capacity, and confirmed group pause. The focused runs failed because these fields, labels, dashboard reporting, detail route, and group-pause control did not exist.
- **GREEN:** Implemented the read models and UI, then reran focused tests: backend **38 passed** and web **46 passed**.

## API query semantics

- `GET /historical-recovery/campaigns` exposes `audienceSegment`, `rolloutGroupId`, `rolloutGroupHourlyCap`, and `rolloutGroupSentLastHour`.
- Shared capacity is grouped by `recovery_campaign.rollout_group_id`, not by the currently selected campaign. It counts only ledger rows with `reserved_at > now - 1 hour` and states `reserved`, `dispatch_started`, `sent`, or `uncertain`; `released` is excluded. Ungrouped legacy campaigns report `0`.
- Candidate list returns frozen `audienceSegment` and live `currentAudienceSegment`. The detailed read model does the same, and `GET /historical-recovery/candidates/:id` now exposes that detailed payload to the existing drawer client.

## UI and accessibility

- The view model has a pure exhaustive `audienceSegmentLabel()` mapping. `unknown_no_name` renders exactly **Unknown — no username/display name**, without deriving wording from a username or display name.
- The drawer renders frozen and current audience values as separate labeled fields only when they drift; equal values remain a single legacy-compatible audience field.
- Grouped campaigns show both **Campaign capacity** and **Shared group capacity used**, making the per-campaign rate distinct from the shared rolling-hour boundary.
- **Pause all expanded campaigns** appears only for a campaign with a rollout group and a running sibling. It uses the existing accessible confirmation dialog, submits `POST /historical-recovery/rollout-groups/:id/pause` with the exact reason `Stopped from the dashboard`, disables while pending, invalidates campaigns/candidates on success, and reports mutation errors through the existing toast path. The single-campaign page shows one group control, so sibling rows cannot produce duplicates.

## Verification

- Focused backend: `npx vitest run src/api/historicalRecovery.routes.test.ts src/services/historicalRecoveryCandidateDetail.test.ts` — 38 passed.
- Focused web: view-model, drawer, and page tests — 46 passed.
- Full backend: `npm test` — 1,528 passed, 307 skipped.
- Full web: `npm --prefix web test` — 479 passed.
- Backend build: `npm run build` — passed.
- Prisma: `npx prisma validate` — valid.
- Web lint/build: `npm --prefix web run lint && npm --prefix web run build` — passed.

## Concerns

- Existing test output includes expected error-level log fixtures for unrelated attribution/advisor/AI failure paths; the test commands still exit successfully.
- This task does not alter rollout reservation enforcement or the group-pause service; it reports their existing state and calls the already-established group endpoint.

## Fix Round 1/5

### RED / GREEN

- **RED:** Added route tests for review acknowledgement, UUID/404/idempotent/conflict behavior, and forwarded detail failures; drawer error/retry tests for 401, 404, and generic failures; real pagination-boundary assertions; and jsdom dialog focus/ARIA interaction tests. They failed for the absent route, missing `asOf`, unhandled detail rejection, permanent drawer skeleton, and missing dialog focus management.
- **GREEN:** The focused backend suite passes **39 tests** and the focused UI suites pass **19 tests**. The full backend and web suites also pass.

### API query semantics

- `POST /historical-recovery/candidates/:id/mark-reviewed` is protected by the parent authenticated API router. It validates UUIDs, returns `404` for missing candidates, and returns `204` without writing for an already reviewed candidate.
- It conditionally sets only `reviewedAt` for `send_failed` and `send_uncertain`; it never changes `outcome`. A concurrent successful review is idempotent (`204`); a still-unreviewable current outcome returns `409`; unexpected failures are forwarded to Express error middleware. Successful first reviews record one `historical_recovery_reviewed` audit event.
- `GET /historical-recovery/candidates/:id` preserves `404` but catches service rejections and forwards them to Express, producing the established `500` response without an unhandled promise.
- Candidate-list `asOf` is validated to a `Date`, established by page one, echoed on later pages, and applied as `createdAt <= asOf` to rows and counts (including recovered candidates). The web client sends cursor/asOf only for a concrete next-page parameter and never serializes `undefined`.

### UI behavior and accessibility

- The evidence drawer now replaces failed detail skeletons with an alert tailored for 401, 404, or generic failure plus a Retry action that refetches.
- `ConfirmDialog` has unique `useId` heading/description references, autofocuses an enabled Cancel control (or the dialog when busy), traps Tab and Shift+Tab, retains its existing Escape dismissal, and restores focus to the invoking trigger. Page coverage verifies the group-pause confirmation interaction.

### Verification

- Focused backend: `npx vitest run src/api/historicalRecovery.routes.test.ts` — **39 passed**.
- Focused web: drawer, recovery page, and confirm dialog tests — **19 passed**.
- Full backend: `npm test` — **1,534 passed, 307 skipped**.
- Full web: `npm test` (in `web`) — **485 passed**.
- Backend build: `npm run build` — passed.
- Web lint/build: `npm run lint`; `npm run build` (in `web`) — passed.
- Prisma: `npx prisma validate` — valid.
- `git diff --check` — clean.

### Concerns

- The creation-time cutoff assumes the established append-only candidate selection model; mutable outcomes continue to reflect their current operational state, while no newly selected row can appear mid-pagination.
- The client defensively stops pagination if a malformed response lacks `asOf`, rather than issuing a request with `asOf=undefined`.
