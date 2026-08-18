# Maison Editorial Production Readiness QA — 2026-08-16

## Commit Under Test

| | |
| --- | --- |
| Branch | `design/maison-editorial` |
| Gate commit | `b5c2485f64391cd8d178dfb154015b0ce85a6457` |
| Gate run start | 2026-08-18T14:46:03Z |
| Worktree at gate | clean (`git status --short` empty) |

Changes committed **after** the gate run are documentation, the E2E fixture
harness, this report, and its artifacts. No production runtime code changed after
`b5c2485`, so the evidence below still describes the shipped code. The one
exception is an HTML **comment** in `web/index.html` (a stale design brief), which
does not execute.

## Environment and Safety Controls

| Control | Value | Verified |
| --- | --- | --- |
| `GUIDE_DELIVERY_ENABLED` | `false` (schema default, `booleanFlag`) | `src/config/env.ts:149` |
| `GUIDE_DELIVERY_ROLLOUT_PERCENT` | `0` | `src/config/env.ts:150` |
| `GUIDE_DELIVERY_COHORT_IG_USER_IDS` | empty | `src/config/env.ts:154` |
| Guide worker | not started while disabled | `src/server.ts:192` |
| Ownership per trigger | single `guideDeliveryOwner` switch, fails closed to legacy | detector passed |
| QA database | `codex-maison-qa-postgres`, `127.0.0.1:55439`, `insta_contract`, healthy 21h | `docker ps` |
| Local server against production | never started | no server run in this gate |
| Meta messages sent | **none** | no cohort authorized |

The disposable loopback database was used for every database-backed contract. It
was never pointed at production, and production was never written to.

## Measurement Truth

Plan `2026-08-16-maison-measurement-truth.md` Tasks 1–4 were complete before this
plan began. Re-verified indirectly: the full backend suite passes, and Home's
Today's Read correctly **withholds** itself in the visual artifact
("Waiting for two complete settled weeks of follower measurements") because the
fixture does not supply two contiguous settled Pacific windows. The measurement
contract refusing to speak is the behaviour, not a defect.

## Guide Delivery Integrity

| Gate | Result |
| --- | --- |
| Ownership bypass detector | `guide_delivery_bypass_check_passed`, exit 0 |
| Handler ownership point | one `switch` on `guideDeliveryOwner`; `ledger` and `legacy` mutually exclusive |
| Unsafe-log scan (`textSnapshot`/`mediaUrlSnapshot`/`body`) | empty |
| Event payload fields | only `eventIdentity` / `unitEvent` helpers — IDs, trigger kind, unit position/kind, attempt, timestamp |
| Owner review UI | built; renders position, kind, status only. Privacy asserted negatively in `GuideDeliveryReviewCard.test.tsx` |
| Migration | `20260817010000_add_guide_delivery_ledger`, additive |
| Runbook | `docs/guide-delivery-operations.md` |

Guide text limit is 1,000 **Unicode code points** (`[...value].length`). The spec's
three "code unit" claims were corrected — a UTF-16 count charges an emoji twice.

## Recovery and Client Operations

| Property | Evidence |
| --- | --- |
| Reads abort rather than abandon | `requestDeadline.test.ts`, `api.test.ts` (fetch signal asserted aborted with `RequestTimeoutError`) |
| Caller cancellation stays distinguishable from timeout | `api.test.ts` |
| Query retry is once, and only for timeout / transport / 5xx | `main.tsx` `shouldRetryRead` |
| Mutation retry disabled globally | `main.tsx` `mutations: { retry: false }` |
| Dispatch-phase classification | `MutationNotDispatchedError` before fetch, `MutationOutcomeUnknownError` after; 5xx counts as unknown |
| Exactly one dispatch per attempt | asserted in `api.test.ts`; the sole second fetch is a 401 refresh, which proves nothing ran |
| No generic `api()` in production code | scan empty; export removed |
| Every mutation route documented | `docs/client-operation-contracts.md`, 30 routes, each with its own canonical read |
| Unknown outcome offers no retry | `DmRecoveryDrawer.test.tsx` — "Still confirming with Instagram state", no Try again button, one dispatch |
| Creates replay-safe by client UUID | `createReplay.test.ts` + route contracts for resources, keywords, messages, experiments |
| Advisor question idempotent | `advisorService.test.ts`; `advisor_outcome_pending` / `idempotency_conflict` preserved as 409 through all three layers |
| Upload owns one object path | `signedUpload.test.ts`; unknown PUT reconciled by HEAD, only a confirmed 404 permits resend |

Two honest limits are recorded in code rather than papered over: `thread/read`'s
per-turn status field is **not** verified against the real app-server, so after a
restart an unanswered turn reports *pending* rather than failed; and a failed read
is never treated as absence.

## Interface and Navigation

Eleven destinations, Home above **Measure / Publish / Audience / System**, from the
single definition in `web/src/lib/navigation.ts`. `/users` is not a destination — it
redirects to `/conversations?lens=people` (`AppRoutes.tsx:37`). `/dm-recovery` is its
own destination and its automatic public-comment behaviour is stated in PRODUCT.md.

Chart marks moved onto the paper palette: every mark clears **3:1** on both paper
surfaces and renders fully opaque. The US series is `#1F5D3F`, deliberately not the
moss accent, so the Accent Scope Rule and the contrast floor both hold.

## Automated Verification

All commands run at `b5c2485`, 2026-08-18.

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `npx prisma validate` | 0 | schema valid |
| 2 | `npm test -- guideDeliveryMigrationContract guideDeliveryRepositoryContract` (disposable DB) | 0 | **2 files, 39 tests, 0 skipped** |
| 3 | `npm test -- --maxWorkers=1` (disposable DB) | 0 | **145 files, 2303 tests, 0 skipped, 0 failed** (91.66s) |
| 4 | `npm run build` | 0 | clean |
| 5 | `npm --prefix web test` | 0 | **57 files, 730 tests** |
| 6 | `npm --prefix web run lint` | 0 | clean |
| 7 | `npm --prefix web run build` | 0 | clean |
| 8 | `npm --prefix web run test:e2e` | 0 | **78 passed** (23.0s) |
| 9 | `npm --prefix codex-runtime test` | 0 | **13 files, 161 tests** |
| 10 | `npm --prefix codex-runtime run build` | 0 | clean |
| 11 | `npm run check:guide-delivery-bypasses` | 0 | `guide_delivery_bypass_check_passed` |
| 12 | `npm run audit:guide-message-lengths` | 0 | **no output — zero over-limit messages** |
| 13 | `git diff --check` | 0 | clean |

**The zero-skip run is the material change.** Without the disposable database the
same suite reports 1956 passed / **347 skipped**; every one of those 347 executed
here. A partial run is not evidence, and the earlier plan's "2,248 tests passed"
was 347 skips wearing a pass.

Command 12 was run **against production, read-only** — the script does one
`findMany` on `resource_message` and disconnects, bounded with
`connection_limit=2`. Running it against the empty QA database would have exited 0
and produced a *false* "no over-limit guides" pass, which is worse than no
evidence. It prints identity, lengths, and the guide's name; never message bodies.

### Static scans

| Scan | Result |
| --- | --- |
| Generic `api<`/`api(` in production | empty |
| `retry: [1-9]` / `mutationFn: apiRead` / `Promise.race` | only explanatory comments in `main.tsx:13` and `requestDeadline.ts:11` |
| White stroke/fill in `DailyAddsChart.tsx` | empty |
| Stale copy sweep | two real hits found and fixed: `index.html`'s moss-tint brief, PRODUCT.md's "12 routes" |

## Controlled Rollout Evidence

**None.** No Instagram user ID was added to any allowlist, `GUIDE_DELIVERY_ENABLED`
was never set true, no deploy occurred, and no Meta message was sent. The two-text,
image-plus-caption, rejection/resume, ambiguous-timeout, and `Already delivered`
cases named in the runbook remain **unexecuted** and require explicit owner
authorization.

## Visual QA

Fixture-only, captured by `web/e2e/visual-qa.spec.ts` at 390×844 (mobile) and
Desktop Chrome. Every response is stubbed at the HTTP boundary by `e2e/main.tsx`;
the local backend was never started and every fixture is synthetic, so no real
follower count or username appears in a committed PNG. Clock pinned to
2026-08-18T06:00:00Z for determinism.

| Surface | Desktop | Mobile |
| --- | --- | --- |
| Home + follower chart | [home.png](artifacts/2026-08-16-maison-editorial/desktop/home.png) | [home.png](artifacts/2026-08-16-maison-editorial/mobile/home.png) |
| Conversations, Needs reply | [conversations-needs-reply.png](artifacts/2026-08-16-maison-editorial/desktop/conversations-needs-reply.png) | [conversations-needs-reply.png](artifacts/2026-08-16-maison-editorial/mobile/conversations-needs-reply.png) |
| Conversations, People lens | [conversations-people.png](artifacts/2026-08-16-maison-editorial/desktop/conversations-people.png) | [conversations-people.png](artifacts/2026-08-16-maison-editorial/mobile/conversations-people.png) |
| DM recovery | [dm-recovery.png](artifacts/2026-08-16-maison-editorial/desktop/dm-recovery.png) | [dm-recovery.png](artifacts/2026-08-16-maison-editorial/mobile/dm-recovery.png) |
| Historical recovery | [historical-recovery.png](artifacts/2026-08-16-maison-editorial/desktop/historical-recovery.png) | [historical-recovery.png](artifacts/2026-08-16-maison-editorial/mobile/historical-recovery.png) |
| Assistant | [assistant.png](artifacts/2026-08-16-maison-editorial/desktop/assistant.png) | [assistant.png](artifacts/2026-08-16-maison-editorial/mobile/assistant.png) |

**Partial, and visibly so.** The plan also asked for Sequence Editor, Insights and
Funnels. The E2E harness renders only the surfaces it has scenarios for; a Home
scenario was added for this gate because the follower chart is what this release
repainted. Sequence Editor, Insights and Funnels have **no captured artifact** and
are covered by unit and integration tests only.

### Manual checklist

| Check | Result |
| --- | --- |
| Chart marks legible on paper | Pass — dark green / amber / navy / grey bands all read against `#FFFEF9` |
| Rolling mean visible | Pass — near-ink line across the series (was invisible white) |
| Provisional window marked | Pass — dashed outline on the newest bar, no fade |
| No dark shell anywhere | Pass |
| Correct mobile titles | Pass — from `titleForPath`, single definition |
| Truthful loading / error / empty states | Pass — Today's Read withholds itself with its reason rather than inventing a number |
| Automatic public-action wording | Pass — DM recovery states it publishes automatically; asserted in E2E |
| Guide review visible | Pass — asserted in `Conversations.test.tsx`; not in a screenshot (needs a delivery fixture) |
| Keyboard focus | Pass — 2px moss ring; `ConfirmDialog` traps and restores focus |
| Touch targets | Pass — rail items 44px on coarse pointers |
| Reduced motion | Not verified in this gate |

## Inherited Risk Baseline

Transitive advisories, **not introduced by this branch** and not cleared by it.
These belong to a separate hardening decision.

| Package set | Advisories | Notes |
| --- | --- | --- |
| API (`npm audit --omit=dev`) | 3 (1 low, 2 high) | `axios` high; `form-data` CRLF injection high; `body-parser` DoS via invalid limit low |
| web | 5 (1 moderate, 4 high) | `vite` / `launch-editor` — build tooling, Windows-specific paths; not shipped runtime code |
| codex-runtime | 0 | — |
| `express` | 4.22.2 | — |

Not called clean. Each requires its own decision and none is a blocker for a
disabled-by-default path.

## Final Status

**READY FOR CONTROLLED ROLLOUT**

Every pre-production gate passed: 2303 backend tests with zero skips against the
disposable database, 730 web tests, 78 E2E, 161 runtime, all builds and lint clean,
the ownership detector clean, and the active-guide audit clean against real data.

This verdict means only that the local build is ready to be *considered* for a
controlled cohort. It is **not** `CONTROLLED PATH STABLE`: no Meta cohort has been
authorized or run, so there is no evidence about real delivery behaviour. It is
**not** `LEGACY REMOVAL AUTHORIZED`: `sequenceSender` and the legacy branch remain
in place and may only be removed after a separate named-owner decision following
formally declared controlled stability.

Known gaps, stated rather than buried: three surfaces have no visual artifact,
reduced motion was not verified, and the inherited dependency advisories above are
open.
