# Final whole-branch fix report

Date: 2026-08-05

Branch: `feat/owner-approved-drafts-followups`

Fix-wave base: `23189995150de50d5a9cfee9013ec4ff1d451f44`

## Outcome

All five Important findings and the runtime-validator Minor from
`final-review-findings.md` are resolved in this wave.

The final tree keeps owner approval as the only path for AI-generated Instagram
sends, sends the exact trimmed owner text, holds no database transaction across
the Graph call, treats ambiguous delivery as terminal uncertainty, and keeps
Graph/private content out of logs and `EventLog` payloads.

No real Instagram, model, Supabase, OpenAI, or production-database request was
made. Every verification shell explicitly set `AI_SEND_ENABLED=false`. The only
live integration target was a disposable PostgreSQL 17 container bound to
`127.0.0.1`.

## Findings resolved

### Important 1 — stale draft creation and reversed lock order

Root cause:

- Ordinary creation trusted a caller-selected inbound and mutated drafts before
  the insert's eventual thread foreign-key lock.
- The manual collection route read `needsReply` but did not enforce it.
- Follow-up scheduling read the thread without a lock before conversation and
  draft writes, creating the opposite lock order from inbound capture.

Implementation:

- `queueReplyDraft()` is now the one ordinary-creation primitive. In a
  `Serializable` transaction it locks `dm_thread` first with `FOR UPDATE`, then
  validates that a thread exists, has a latest inbound, still needs a reply, and
  (for webhook callers) that the handled inbound is still authoritative.
- Revision allocation, active-draft supersession, and insertion happen only
  after that validation and while the thread lock is held.
- Serialization failures (`P2034`) retry in a fresh transaction at most three
  times. The partial unique index remains a database backstop.
- The collection route delegates only the thread ID; the service derives the
  current inbound and enforces `needsReply` under lock.
- Follow-up scheduling now takes the same thread-before-conversation/draft lock
  order and retains its bounded serializable retry.

RED/GREEN evidence:

- The focused creation tests first produced nine intended failures: missing
  thread-first SQL, stale older-handler acceptance, ignored `needsReply`, missing
  bounded retry, route pre-read, and follow-up lock-order expectations.
- After implementation, the focused creation/API suite passed 118 tests.
- The live PostgreSQL contract independently proved the slow-old-handler/newer-
  inbound race and observed both production creation paths blocked on the thread
  lock before any conversation or draft mutation.

Primary coverage:

- `src/services/replyDraftService.test.ts`
- `src/services/engagementFollowUpService.test.ts`
- `src/api/aiDrafts.routes.test.ts`
- `src/services/replyDraftDatabaseContract.test.ts`

### Important 2 — HTTP 5xx must be uncertain

Root cause:

- The classifier treated every Axios response as proof that Graph rejected the
  send. A 5xx, gateway response, or timeout can occur after handoff, so that
  classification could authorize a duplicate retry.

Implementation:

- Only deterministic HTTP 4xx responses, excluding 408, map to
  `failed / graph_rejected`.
- HTTP 408 maps to `uncertain / graph_timeout`.
- HTTP 5xx maps to `uncertain / graph_server_error`.
- Other response statuses map to
  `uncertain / graph_response_uncertain`.
- Known no-response transport conditions use a closed stable transport-code
  vocabulary. Unknown post-handoff throws map to
  `uncertain / send_outcome_unknown`.
- The approval route answers `202 send_uncertain` and never issues a second send
  for 408, 500, 502, 503, or 504.

RED/GREEN evidence:

- The send/finalization test wave began with 22 intended failures while 130
  pre-existing assertions still passed.
- The completed focused wave passed 151 tests, including classifier tables and
  route-level one-send assertions for 408/5xx responses.

Primary coverage:

- `src/services/replyDraftSendCore.test.ts`
- `src/api/aiDrafts.routes.test.ts`

### Important 3 — strict AI delivery finalization

Root cause:

- Legacy delivery, thread, and audit helpers intentionally swallow persistence
  errors. Chaining those helpers after Graph success allowed an HTTP 200 even if
  outbound history, draft state, thread resolution, or audit persistence had not
  committed.

Implementation:

- `sendTrackedText()` keeps its legacy best-effort default, but accepts
  `history: "deferred"` for the owner-approved AI path.
- The route claims the draft transactionally, looks up the recipient, and calls
  Graph with no transaction open.
- A confirmed Graph message ID is then passed to
  `finalizeApprovedDraftSend()`. Its short strict transaction locks the thread
  then the exact draft, validates the `sending` state and exact approved text,
  inserts the exact outbound `ai_approved` message, performs the guarded
  `sending -> sent` transition, updates thread timestamps, conditionally clears
  `needsReply` only if the handled inbound is still latest, and inserts a
  body-free `ai_reply_sent` audit event.
- The audit contains IDs, actor, approved-text length, and Graph message ID only.
- A missing Graph message ID or any unconfirmed finalization returns
  `202 send_uncertain`. A guarded attempt moves a rolled-back `sending` draft to
  uncertainty; if commit actually succeeded but acknowledgement was lost, the
  guard leaves `sent` authoritative. Neither case automatically resends.

RED/GREEN evidence:

- The same 22-failure RED wave covered deferred history, strict finalization,
  ordering, rollback propagation, missing Graph IDs, and recording uncertainty.
- The focused send/finalization suite passed 151 tests after implementation.
- Tests assert Graph is called before finalization and that the model suggestion
  is never substituted for the exact owner-approved text.

Primary coverage:

- `src/services/dmDeliveryService.test.ts`
- `src/services/replyDraftService.test.ts`
- `src/api/aiDrafts.routes.test.ts`

### Important 4 — branch-wide private-content logging

Root cause:

- `describeGraphError()` returned request bodies, endpoints, provider messages,
  and raw Axios details. For Graph messaging calls those values can contain the
  DM body or access token.
- Several callers logged or persisted that descriptor, and the delivery-history
  fallback logged the raw caught error.

Implementation:

- `describeGraphError()` now returns exactly five runtime keys:
  `category`, `httpStatus`, `graphCode`, `graphSubcode`, and `traceId`.
- Numeric fields accept finite numbers only. Trace IDs accept only the bounded
  identifier grammar `[A-Za-z0-9_-]{1,128}`; all other trace text becomes null.
- Provider messages, request bodies, URLs, Axios codes/errors, tokens, DM text,
  editor text, prompt text, and model output are not returned.
- Graph and Insights interceptors use the shared descriptor. Message, comment,
  webhook, gate retry/experiment, sequence, media, profile, snapshot, token
  refresh, feed-follow, and username callers now log/persist only allowlisted or
  stable metadata.
- The legacy delivery fallback logs stable IDs/source/length plus
  `dm_history_write_failed`, never the caught error or message body.
- `logEvent()` failure logging omits both the raw database error and the event
  payload.
- New lineage responses never expose historical provider messages; the UI shows
  numeric subcodes only and understands both the new and legacy numeric keys.

RED/GREEN evidence:

- The concrete privacy RED used a secret-bearing profile/provider value and
  failed because the raw sentinel reached the logger. The review finding also
  supplied the failing request-body path for the shared descriptor.
- Regression tests use sentinels for a private DM, access token, secret-bearing
  URL, provider message, request body, and arbitrary Axios code.
- The focused privacy suite passed 13 files / 83 tests after the allowlist was
  applied. Full backend coverage also passed.

Primary coverage includes:

- `src/services/eventLogger.test.ts`
- `src/services/dmDeliveryService.test.ts`
- `src/meta/graphClient.test.ts`
- `src/meta/insightsGraphClient.test.ts`
- `src/meta/profileFetcher.test.ts`
- `src/meta/tokenRefresher.test.ts`
- `src/handlers/commentHandler.test.ts`
- `src/handlers/messageHandler.test.ts`
- `src/handlers/webhookRouter.test.ts`
- `src/services/gateQueueWorker.test.ts`
- `src/services/sequenceSender.test.ts`
- `src/api/media.routes.test.ts`

### Important 5 — stale UI action must create for the current inbound

Root cause:

- An ordinary stale draft still enabled **Try another**, but regeneration keeps
  the draft's stale inbound anchor and correctly receives `stale_draft` from the
  backend.

Implementation:

- Regeneration is disabled for every stale draft, ordinary or follow-up.
- When the thread still needs a reply, the drawer shows **Draft a reply** beside
  the stale read-only card.
- That action sends a bodyless POST to the collection endpoint. The backend
  thread-first primitive derives the current inbound under lock.
- The real-component harness refreshes to a new draft anchored to the latest
  inbound; its capture now records the actual method/path/body rather than
  synthetic response metadata.

RED/GREEN evidence:

- On an isolated worktree server the new desktop and mobile E2E assertions both
  failed first because **Try another** was still present (`2 failed`).
- The focused desktop/mobile stale-flow test then passed `2/2`.
- The final full Playwright matrix passed all `30/30` desktop/mobile journeys.

Primary coverage:

- `web/e2e/ai-workflows.spec.ts`
- `web/e2e/main.tsx`
- `web/src/components/conversations/DmThreadDrawer.tsx`
- `web/src/components/conversations/ReplyDraftCard.tsx`

### Minor — runtime response validator

Root cause:

- The private runtime enforced output limits, but the backend response boundary
  accepted unbounded strings/arrays and silently stripped unknown fields.

Implementation:

- Both runtime and backend schemas now require reply/rationale lengths 1–1000,
  at most eight warnings, each at most 300 characters, and reject unknown keys.
- The backend schema retains the required nullable `modelId` response field.

RED/GREEN evidence:

- Backend boundary tests first failed all six new invalid-response cases.
- The runtime's unexpected-field case separately failed before `.strict()`.
- Focused GREEN: backend runtime-boundary suite `27 passed`; runtime schema suite
  `15 passed`.

Primary coverage:

- `src/services/codexRuntimeClient.test.ts`
- `codex-runtime/src/schemas.test.ts`

## Live fully migrated PostgreSQL proof

The opt-in database contract was run against a disposable
`postgres:17-alpine` container named `insta-final-fix-pg-contract`.

- Binding: `127.0.0.1:55439 -> 5432`; no non-loopback listener.
- Schema setup: the contract ran `prisma migrate deploy` against the disposable
  database before assertions.
- Migration proof: `_prisma_migrations` reported `19` rows, `19` finished and
  not rolled back, matching all 19 checked-in `migration.sql` files.
- Result: `src/services/replyDraftDatabaseContract.test.ts` passed `9/9` in
  4.13 seconds.
- The nine contracts include production-function slow-old/new-inbound behavior,
  observed thread-lock blocking before ordinary draft mutation, observed
  thread-lock blocking before follow-up conversation/draft writes, real
  concurrent approval/retry claims, timezone schema parity, and database-clock
  follow-up/prompt-policy races.
- The exact disposable container was removed afterward, Docker reports no
  container by that name, and port 55439 has no listener.

Docker Desktop was already running when verification began, but its engine socket
was wedged and timed out even on `_ping`. Docker Desktop's own restart command
restored the engine. It remains running, matching the pre-existing application
state; no pre-existing container was removed or addressed by name.

The first live command exited before collecting tests because the shell omitted
six required inert application variables. The valid rerun supplied dummy local
test values, retained `AI_SEND_ENABLED=false`, and is the `9/9` result above.

## Final verification

All application test, build, lint, and live-contract commands below ran on the
final source tree with `AI_SEND_ENABLED=false`.

| Gate | Result |
| --- | --- |
| Backend Vitest with inert local-only environment | 43 files passed, 1 skipped; 510 tests passed, 9 skipped |
| Private runtime Vitest | 13 files passed; 149 tests passed |
| Web Vitest | 19 files passed; 248 tests passed |
| Full Playwright desktop/mobile matrix on isolated port 5187 | 30 tests passed |
| Live fully migrated PostgreSQL contract | 1 file passed; 9 tests passed |
| Backend build (`prisma generate && tsc`) | passed |
| Private runtime build (`tsc`) | passed |
| Web production build (`tsc -b && vite build`) | passed; 2306 modules transformed |
| ESLint on every changed web/E2E file | passed with zero findings |
| `git diff --check` | passed |

One intentionally documented baseline gate remains non-zero:

- Repository-wide web `npm run lint` reports nine pre-existing errors in five
  untouched files: `AiConnectionCard.tsx`, `AppShell.tsx`, `button.tsx`,
  `Insights.tsx`, and `SequenceEditor.tsx`.
- `git diff --exit-code HEAD -- <those five files>` returns zero, proving this
  wave did not modify them.
- The changed-file lint command is green. Those unrelated baseline refactors
  were not folded into this security/concurrency fix wave.

The first final backend-suite invocation also exited during environment parsing
because the shell lacked required test variables; 15 suites collected zero
tests. The valid rerun used inert loopback/dummy values and produced the
`510 passed` result above. No test assertion failed in that aborted invocation.

## Binding-constraint audit

- `@openai/codex` remains exactly pinned at `0.146.0` in both runtime package
  manifests/locks.
- `AI_SEND_ENABLED` still defaults to false and `.env.example` keeps it false.
- No AI worker imports or calls `sendTrackedText`; the only AI-generated send
  remains the authenticated approval route.
- Existing gate/guide worker uses of `sendTrackedText` remain legacy automation,
  not AI-generated content.
- The approval route passes the exact claimed, trimmed `approvedText` once to
  Instagram and the strict finalizer records that same value.
- No transaction spans recipient lookup or Graph network I/O.
- Existing 12-hour follow-up eligibility, 23-hour-30-minute expiration,
  new-inbound supersession, delayed-webhook ordering, feature flags, credentials,
  keyword automation, guide delivery, and advisor behavior remain covered by the
  full suites.

## Self-review and remaining concerns

The full production diff and the new/changed tests were re-read after the final
GREEN runs. The review specifically checked lock order, retry bounds, stale
anchors, exact approved text, transaction boundaries, guarded status changes,
ambiguous-send behavior, raw logging/persistence, runtime strictness, and
desktop/mobile stale actions.

No unresolved Critical, Important, or Minor issue remains for the six reported
findings. The only known non-green repository gate is the unchanged nine-error
web lint baseline documented above.
