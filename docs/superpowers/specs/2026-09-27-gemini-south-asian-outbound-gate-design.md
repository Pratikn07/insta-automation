# Gemini-backed South Asian outbound gate

**Date:** 2026-09-27
**Status:** Design approved, ready for implementation plan
**Supersedes:** `docs/superpowers/specs/2026-09-21-nvidia-audience-guide-block-design.md`

## Problem

Two separate problems, one fix.

**1. Keyword comment replies have no origin check.** The DM-recovery reminder withholds from
South Asian users at `dmRecoveryPolicy.ts:222`, but `commentHandler`'s keyword auto-reply does
not. Measured over 7 days: **924 public comments went to `south_asian` users** from the keyword
path against 1 from the recovery path. The gate exists; it guards the wrong surface.

**2. The gate that was built for this runs on a provider that fails 69% of the time.**
`GUIDE_AUDIENCE_BLOCK_ENABLED` was on from 2026-09-23T23:20 to 2026-09-25T00:48. In that window
the gate produced 105 decisions: **33 `block`, 72 `defer`** — 71 `provider_timeout` plus 1
`invalid_provider_response` — against an 8,000ms budget. Of 78 classifications NVIDIA returned,
57 were `unknown`/low, 12 `other`/low, 9 `south_asian`/high, and **zero `us_western`**.

Because PR #71 fails **closed**, every defer withheld both the public reply and the DM. Joining
the 60 distinct deferred people to Gemini's verdict on the same accounts:

| Gemini's verdict | People | Should have been sent? |
|---|---|---|
| `us_western` (17 low + 4 high) | 21 | yes |
| `unknown` | 24 | yes |
| `other` | 1 | yes |
| `south_asian` | 14 | no |

**46 of 60 (77%) were silenced wrongly.** Worse, `never_classified_at_all` = 0: all 60 already
had a Gemini `llm_v3` verdict in `ig_users.inferred_origin`, and **35 of 60 (58%) had it at the
exact moment they were deferred**. The gate called NVIDIA, NVIDIA timed out, and it dropped the
person while the answer sat one table over.

## Decision rule

Withhold only on an explicit `south_asian` verdict. Everything else sends.

| State | Decision | Audit row |
|---|---|---|
| stored verdict `south_asian` (high or low) | **block** — no comment reply, no DM | `block` |
| stored verdict `us_western` / `other` / `unknown` | allow | none |
| no stored verdict, live call returns `south_asian` | **block** | `block` |
| no stored verdict, live call returns anything else | allow | none |
| live call times out, throws, or is unreadable | allow | `allow_unverified` |
| `GUIDE_AUDIENCE_BLOCK_ENABLED` off, or Gemini disabled | allow | none |

Example: `@priya_mommy` comments "GUIDE" with a stored `south_asian`/high verdict — no public
reply, no DM, one `block` row. `@sarah.jones` with `us_western`/low — replies and DM go out
unchanged.

Three choices worth stating:

**Both confidences block.** Same call `dmRecoveryPolicy.ts:222` already makes, for the reason
recorded there: on 2,787 classified users, high confidence is 41.9% and adding low takes it to
45.9%. A 4pp difference, and the low-confidence calls are ordinary given names ("Priya",
"Manisha", surname "Khan"), not noise.

**`unknown` sends.** Roughly a fifth of this audience has no usable name. Withholding from them
would cancel most of the feature while looking like a targeting rule.

**Failure sends.** This reverses PR #71. The owner's decision, given the 77% figure above:
better to reach an out-of-market user occasionally than to drop in-market ones.

**No name-screen fallback in this gate.** `resolveAudienceOrigin` falls back to the hardcoded
`inferOrigin()` on a miss. This gate deliberately does not: that screen caught 3 of 50 accounts
where Gemini caught 22, so as a second classifier it can only add false blocks. Recovery keeps
its fallback unchanged.

## Where the verdict comes from

One classifier, one store. The gate reads `ig_users.inferred_origin`, calls Gemini only on a
miss, and writes back to the same column.

```
handleComment
  → rememberUsername          (already happens; refreshes username/name)
  → read ig_users: inferred_origin, origin_confidence, origin_method
      ├─ origin_method = 'llm_v3' and verdict valid → use it          (28% of triggers)
      └─ miss → classifyOrigins([one]), 3,000ms ceiling  (~811ms p50)
                  ├─ verdict → compareAndSetOrigin writes it back
                  └─ fail/timeout → allow, audit allow_unverified
```

### New shared module: `src/services/originVerdictStore.ts`

Three pieces move so the gate and the enrichment worker share one implementation:

| Moves | From | Why |
|---|---|---|
| `readStoredOrigin(person)` | split out of `resolveAudienceOrigin`, `dmRecoveryRepository.ts:250` | the gate needs the cached read **without** the `inferOrigin` fallback |
| `compareAndSetOrigin` | private in `originEnrichmentWorker.ts:102` | the inline path needs the same identity-guarded write |
| `ORIGIN_STILL_DUE` | `originEnrichmentWorker.ts:88` | the predicate `compareAndSetOrigin` depends on |

`readStoredOrigin` returns `{ origin: Origin; confidence: "high" | "low" } | null` — `null`
meaning "no current-method verdict", which is what makes the caller's next step explicit rather
than implied by a fallback value. `resolveAudienceOrigin` becomes
`readStoredOrigin(p) ?? inferOrigin(...)`. Recovery behavior is unchanged.

The gate loads the person with one `findUnique` on `ig_users` selecting `id`, `username`, `name`,
`inferredOrigin`, `originConfidence`, `originMethod`. A row absent entirely is treated as a miss,
not an error: `rememberUsername` runs first on the comment path, so absence means a DM-only
sender we have never resolved.

### Timeout: 3,000ms, one attempt, no retry

Measured single-candidate latency on this account: n=8, min 661ms, **p50 811ms**, p90 and max
both **1,327ms**, 8 for 8 successful, every response `finishReason=STOP`. A batch of 8 took
1,808–1,929ms.

3,000ms is 2.3x the slowest observed call. 2,000ms would be 1.5x and would start cutting off
calls that were about to succeed — and every cutoff sends to a South Asian user anyway.
`server.ts:69` acks Meta with `res.sendStatus(200)` *before* `dispatchWebhook`, so the wait can
never trip a webhook timeout; it costs only a slightly later DM.

No retry. A retry inside a 3s ceiling splits the same budget, and `originEnrichmentWorker`
stamps the person within ~19s (median) regardless, so their next interaction reads a real
verdict.

`classifyOrigins` has no timeout parameter today. The ceiling is added as an injectable
deadline so timeout tests do not wait 3 real seconds.

### Why this is cheap and warm

- **Warm from the first request.** All 17,809 `ig_users` rows carry an `llm_v3` verdict. 28.0%
  of comment triggers already have one at the moment they fire (3,533 triggers / 3,006 distinct
  people over 7 days, 14.9% repeat rate); 100% are stamped eventually. A fresh table starts at 0%.
- **Volume is small.** Over 14 days, `keyword_matched` + `message_received` averaged 34.8/hr,
  p50 30, p95 81.3, peak 142/hr = 2.37/min. At ~72% miss that is ~1.7 live calls/min, ~0.8s
  each — about a 2% duty cycle.
- **Cost ~$0.09/day.** ~600 live calls/day at `estimateOriginCostUsd(1)` ≈ $0.00015.
- **The daily budget already counts it.** `spentTodayUsd()` counts `ig_users` rows where
  `originCheckedAt` is today and `originMethod = llm_v3` (`originEnrichmentWorker.ts:77`).
  Inline writes set exactly those fields, so inline spend lands in the existing guard with no
  new code.

### Identity changes invalidate themselves

`originResetIfIdentityChanged` (`igUserService.ts:51`) nulls the verdict on a username or name
change, and rides the `rememberUsername` upsert that runs immediately before the gate.
`compareAndSetOrigin` then refuses to write unless `id` + `username` + `name` still match.

This is the protection PR #71's `identity_hash` column was built to provide. Its spec justified
a separate table because NVIDIA wrote a *different* `method` than Gemini, so sharing the column
would have made recovery decisions stale. With Gemini writing `llm_v3` on both paths there is no
provenance conflict, and the guide gate and the recovery gate then agree by construction because
they read one column.

## Data model

`guide_audience_decision` has no `origin` or `confidence` column — the verdict lived only on
`guide_audience_classification`, reachable through `classification_id` (nullable FK,
`onDelete: SetNull`). So the table drop cannot come first without blinding the audit trail.

Two migrations. The drop is the only irreversible step and is not needed to stop the replies.

**M1 — ships with the code. Purely additive.**
- `guide_audience_decision`: add `origin GuideAudienceOrigin?`, `confidence GuideAudienceConfidence?`
- `GuideAudienceDecisionKind`: add `allow_unverified`

`ALTER TYPE ... ADD VALUE` cannot use the new value in the transaction that adds it, so M1 must
not also insert a row using `allow_unverified`.

**M2 — follow-up, after the new path has run in production.**
- drop `guide_audience_decision.classification_id`
- drop table `guide_audience_classification`

`defer` stays in `GuideAudienceDecisionKind` but is never written again: the 72 historical rows
mean "withheld", and reusing the value would make new rows mean the opposite.

`GuideAudienceDeferReason` stays and is reused on `allow_unverified` rows — `provider_timeout`,
`provider_unavailable`, `invalid_provider_response` now record *why there was no verdict and we
sent anyway*. `identity_unavailable`, `identity_changed` and `persistence_failed` become
unreachable and stay in the enum for the historical rows.

The comment at `schema.prisma:960` states these values *"must never be reused for the
Gemini-based historical-recovery fields on IgUser."* That now describes the opposite of the
design and is corrected, not left to mislead.

## Wiring

Call sites stay where PR #71 put them. The gate in `commentHandler` sits **before** the public
reply, which is what satisfies "no reply comment"; `mayStartGuideAction` covers the three
`messageHandler` paths (inside `deliverOwnedGuide`, the keyword branch, the open-request branch).
Also touched by PR #71 and carried along: `guideAccessActionService.ts`,
`guideActionOutcomeService.ts`, `guideActionRouter.ts`, `guideDeliveryService.ts`.

What changes is the direction of failure:

```
today:   catch { log; return; }        → withhold        (fail closed)
becomes: catch { log; return true; }   → send, audited   (fail open)
```

`authorizeNewGuideAction` returns `allow | block`. The `defer` kind is removed from the return
type.

### Environment

Removed: `NVIDIA_API_KEY`, `NVIDIA_AUDIENCE_MODEL`, `NVIDIA_AUDIENCE_TIMEOUT_MS`,
`NVIDIA_AUDIENCE_RECOVERY_TIMEOUT_MS`. The `NVIDIA_API_KEY` variable is also removed from the
Railway `api` service.

Added: `GUIDE_AUDIENCE_TIMEOUT_MS`, declared exactly like the variable it replaces —
`z.coerce.number().int().min(500).max(30_000).default(3_000)`.

Kept: `GUIDE_AUDIENCE_BLOCK_ENABLED`, via `booleanFlag(false)` — never `coerce.boolean`.

## Deleted

| File | Lines | Why |
|---|---|---|
| `src/services/nvidiaAudienceClassifier.ts` + test | 244 + 188 | provider replaced |
| `src/services/guideAudienceTimeoutRecovery.ts` + test | 303 + 252 | see below |
| `scripts/guide-audience-timeout-recovery.ts` | 230 | " |
| `scripts/guide-audience-timeout-recovery-core.ts` | 239 | " |
| `scripts/guide-audience-timeout-recovery.test.ts` | 182 | " |

The `AudienceClassificationProvider` interface and `createTimeoutRetryingAudienceClassifier` go
with the NVIDIA classifier. One implementation remains, so the seam is dead weight.

The timeout-recovery subsystem is **completed one-off incident work**. Its window is hardcoded
to `2026-09-23T23:54Z` → `2026-09-24T03:45Z` and its cohort covers only 50 of the 72 defers. It
ran: 6 `guide_audience_timeout_recovery_run` events and 32
`guide_audience_timeout_recovery_outcome` events on 2026-09-25, **all 32 `guide_opening_sent`**.
Its 24-hour private-reply window has since closed, fail-open produces no new defers to feed it,
and its types reference `classificationId` and `classificationOrigin` — so M2 cannot compile
while it exists.

## Testing

**Unit.** All four origins x both confidences against the decision rule; cache hit; cache miss
driving a live call; timeout → allow + `allow_unverified`; throw → same; unreadable response →
same; flag off → allow with no row written.

**Contract** (`insta-contract-pg`, postgres/disposable, db `contract`, port 5433 — not the
recipe in docs). A `block` writes exactly one decision row carrying `origin` and `confidence`.
`compareAndSetOrigin` refuses to write after a username change. Note that leftover rows in the
disposable QA Postgres and a stale generated Prisma client both fail as consistent contract
assertions; re-run one file before suspecting the change.

**Handler.** A `south_asian` commenter produces **zero** outbound calls — asserted at the Graph
client, not at a mocked service. The last five Critical bugs on a comparable branch all sat
exactly where tests mocked the boundary.

`guideAudienceAuthorization.test.ts` (154 lines), `guideAudienceAuthorizationRepository.test.ts`
(88), `guideAudiencePolicy.integration.test.ts` (238) and
`guideAudienceAuthorizationMigrationContract.test.ts` (61) all assert fail-closed `defer`
behavior and need rewriting, not deleting.

## Rollout

1. Confirm `GUIDE_AUDIENCE_BLOCK_ENABLED` is `false` on the Railway `api` service, then merge M1
   plus the code. Vercel and Railway both deploy from `main` on merge; never run `railway up`.
   `flag_override` is empty, so the env value is what takes effect.
2. Flip the flag. Watch `guide_audience_decision` for an hour.
3. Expected: ~42% `block` among classified users, near-zero `allow_unverified`. NVIDIA's
   comparable figure was 69% failure.
4. If `allow_unverified` exceeds a few percent, the Gemini call is the problem, not the policy —
   raise `GUIDE_AUDIENCE_TIMEOUT_MS` before changing anything else.
5. Ship M2 once step 3 holds.

## Non-goals

- No change to the DM-recovery reminder's own gate. `DM_RECOVERY_WESTERN_ONLY` and
  `dmRecoveryPolicy.ts:222` stay exactly as they are.
- No new dashboard surface. The decision table is read by SQL.
- No change to `originEnrichmentWorker`'s batch schedule, budget, or prompt version.
- No backfill of the 924 comments already sent. They are sent.
- No per-user country lookup. Meta exposes none; origin stays an explicit name-based proxy.
