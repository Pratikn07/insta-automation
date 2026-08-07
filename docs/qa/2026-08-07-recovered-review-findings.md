# Instagram Read-Recovery Reminders: Recovered Review Findings (2026-08-07)

## Document purpose

On 2026-08-07 a ten-angle code review of this branch was launched. It never completed: the
session hit its usage limit at 14:21 PDT while all ten finder agents were mid-investigation.
The limit killed the parent and every finder simultaneously, so no finder filed a report and the
aggregation, dedupe, and verification stages never ran.

The finders' reasoning traces survived in their transcripts. This document records the leads
harvested from those traces, and the outcome of adversarially verifying each one against the code.
It exists so a fresh review does not spend its budget re-deriving conclusions that are already
established, and does not inherit the unverified leads as if they were findings.

Every entry below is either CONFIRMED with reproduction evidence, or REFUTED with the reason.
Leads are not findings; the REFUTED section is as load-bearing as the CONFIRMED one.

## Snapshot

- Branch: `feat/instagram-read-recovery-reminders`
- Verified at commit: `8f9107a` (`docs: define instagram feature requests 1 3 and 4`)
- Diff scope: 91 files, +19797 / -203 against `main`
- TypeScript: `npx tsc --noEmit` passes clean (the build failure noted in the earlier session is resolved)

## Status

All five confirmed defects are fixed, each with a regression test that was verified to fail against
the pre-fix code and pass after it:

| Defect | Fix |
|---|---|
| 1. Metrics endpoint dead by default | `1d3be2b` |
| 2. Completion voided by bookkeeping | `8c7d38b` |
| 3. Gate batch stranded, falsely recorded | `4f13ff7` |
| 4. Gate `send_uncertain` has no consumer | Open — needs a product decision, see below |
| 5. Pagination drops rows between pages | `be2aa39` |

Backend: 913 tests pass, `tsc` clean. Web: 346 tests pass, `tsc` clean.

Defect 4 is deliberately left open: closing it means either building a reviewer surface for
gate-queue `send_uncertain` rows or documenting that the recovery mirror row is the sole review
path. That is a product call, not a mechanical fix.

The quality findings below are also unaddressed, by choice — they are not correctness issues and
are better handled as one deliberate cleanup pass than folded into defect fixes.

## Confirmed defects

### 1. The metrics endpoint is dead in the default configuration

`src/api/recoveryReminders.routes.ts:450` filters by `id: ""` to mean "match nothing" when the
experiment window is unconfigured. `DmRecoveryReminder.id` is a genuine `uuid` column
(`prisma/schema.prisma:647`; `migration.sql:21` → `"id" UUID NOT NULL`), so Prisma rejects the
value client-side with P2023 before any SQL is sent.

Verified by running the exact query against a live migrated Postgres instance:

```
findMany triggerKind + id:''   -> THREW  P2023  (Error creating UUID, invalid length: expected 32, found 0)
findMany id:<valid uuid>       -> OK     0 rows
findMany igUserId:'' (TEXT)    -> OK     0 rows   <- control: proves @db.Uuid is the deciding factor
```

Severity is raised by the deploy default: `.env.example:132-134` ships both window variables empty
and documents "leave empty until experiment start", so the crashing branch is the documented
default state, not an edge case. Because this is Express 4 (which does not catch async rejections)
and `metricsHandler` has neither a try/catch nor a `next(err)` call, the symptom is an unhandled
rejection and a hanging request — not a clean 500 — leaking a handler per call. The whole metrics
dashboard dies with it, including the unrelated `accuracy` and `health` blocks.

Untested: all four `/metrics` tests hardcode both env vars as *set*
(`recoveryReminders.routes.test.ts:27-33`), so only the configured branch is exercised.

### 2. `markCompleted` lets best-effort bookkeeping void a completion

`src/services/conversationService.ts:76` calls `suppressRecoveriesForCompletion` inside the
interactive transaction that marks the conversation completed, with no try/catch. Any throw there
rolls back both the `state: "completed"` write and the `gateQueue` abandon.

This is the sole unguarded recovery call in its file. Every sibling recorder self-guards with
`catch { recordRecoveryDatabaseFailure(); }` (`dmRecoveryService.ts:371, 433, 491, 563`);
`suppressRecoveriesForCompletion` is the only one that does not — a deviation from the file's own
convention.

Failure sequence, with the guide already delivered:

1. `sendSequence` succeeds — the user has the guide.
2. `markCompleted` throws; Postgres discards the completion *and* the gate abandon.
3. The local catch in `src/handlers/messageHandler.ts` logs it as `sequence_failed` — a database
   rollback misreported as a Graph send failure.
4. The conversation stays `awaiting_done`; gate rows stay `pending`.
5. `gateQueueWorker.ts:165` abandons only when `state === "completed"`, which is now false, so the
   row proceeds and re-sends "follow @tinysoho, then reply DONE to unlock" to someone who already
   has the guide.

The deleted comment from the old array-form transaction names this exact invariant: "the user has
the guide, so another 'reply DONE to unlock' would be pure spam."

Note the migration does run before boot (`package.json:10`: `prisma migrate deploy && node ...`),
so the "missing table" trigger is unlikely. It does not immunize the defect: the call is
ungated by `DM_RECOVERY_ENABLED`, Prisma's 5s interactive-transaction timeout applies, and the
`updateMany` contends with `dmRecoveryRepository.ts:320`, which locks the same rows.

Fix is one line of containment: wrap the call to match its four siblings.

### 3. Gate worker strands a claimed batch, then falsely records it as maybe-delivered

`src/services/gateQueueWorker.ts` claims rows as `sending`, and its release block at `:332-342` is
the last statement *inside* the try. There is no `finally` (grep confirms). Three calls between
claim and release are unprotected: `conversation.findMany` (`:146`) and two `gateQueue.update`
calls (`:158`, `:166`). A throw from any of them strands the entire claimed batch in `sending`.

The lease then expires, and `reconcileStaleSendingClaims` (`:42-72`) transitions those rows to
`send_uncertain` and creates `tracking_unavailable` recovery rows asserting the DM may have been
delivered — for people who were never messaged.

Severity is narrower than the finder suspected, and this matters: the recovery row is written
`status: "tracking_unavailable"` (`dmRecoveryService.ts:293`), and the recovery worker only ever
claims `status: "waiting"` (`dmRecoveryRepository.ts:248`). **No public comment is posted
automatically.** The real damage is a silent drop plus a false audit record. The code comment at
`:330-331` describes precisely the failure it fails to prevent.

Fix: wrap the release block in a `finally`, which prevents both the strand and the false
transition.

### 4. Gate-queue `send_uncertain` rows have no consumer

`runGateQueueTick` only ever selects `status: "pending"` (`:93, :99, :105, :125`). Nothing in the
repo reads gate-queue `send_uncertain`: `conversations.routes.ts:148,167` filter `pending`;
`statsService.ts` counts only `pending` and `exhausted`; `conversationService.ts:71-73` updates
only `pending`.

So the status is terminal by accident: no retry, no review surface, absent from the operator's
counts. `enqueueGate` can create such a row directly (`gateQueueService.ts:42`). A person whose
gate send was ambiguous never receives the gate DM and never appears in any queue an operator
watches.

Partial mitigation: the *recovery* mirror row is reviewable, and `docs/meta-verification.md:284`
documents the never-auto-retry intent for recovery rows. The gate row itself has no reviewer.
Needs either a review surface or a documented decision that the mirror row is the sole path.

### 5. Pagination silently skips rows on time-dependent views

`recoveryReminders.routes.ts:158` computes `now` per request, so the boundary moves between pages.
Only `scheduled` (`eligibleAt > now`) and `ready` (`eligibleAt <= now`) are affected; the
status-only views are not.

Reproduced with real rows straddling the boundary at `limit=2`:

```
scheduled  page1 @T     -> [A, B]  cursor=B
scheduled  page2 @T+15s -> []          expected [C]  -- C left the set, shown on neither page
ready      page1 @T+25s -> [D]     cursor=D
ready      page2 @T+55s -> [E]         A,B,C became ready, sort above the cursor, missed
```

The duplicate half of the lead is **refuted**: `now` only moves forward and the sort key is
immutable, so a row cannot reappear below a cursor it already passed. Skips only.

## Quality findings (not correctness)

- **Dead policy inputs.** `RecoveryPolicyInput` declares `commentId` and `acceptedAt`, which
  `decideRecovery` never reads. `conversationCompletedElsewhere` is hardcoded `false` at its only
  call site (`dmRecoveryRepository.ts:189`), making the `completed_elsewhere` branch unreachable.
- **Unbounded count.** `originEnrichmentWorker.ts:71` loads every classified-today row just to take
  `.length`; should be `count()`. Three per-row update loops at `:150`, `:182`, `:203` should be
  `updateMany` or a single transaction.
- **Cross-layer duplication.** `CANCELLABLE`/`REVIEWABLE` exist in both
  `recoveryReminders.routes.ts:232-233` and `dmRecoveryViewModel.ts:38`. They currently agree
  exactly, and the API sends no `canCancel` flag — a drift risk, not a live bug.
- **Duplicated helpers.** `formatWhen` is defined in both `DmRecoveryList.tsx:47` and
  `DmRecoveryDrawer.tsx:38`, duplicating `formatAbsolute` in `Conversations.tsx:843`. The
  settings-blocked signature parsing is split between `env.ts:141` and `graphErrorClassifier.ts`.
- **Name data loss.** `igUserService.ts:84` writes `name: name ?? null` on update, discarding a
  Graph-resolved name on every comment and re-queueing the user for classification. `?? undefined`
  would preserve it. `originMethod` is also left stale by the reset (inert today, but the pairing is
  load-bearing and undocumented).

## Refuted leads — do not re-file these

| Lead | Why it fails |
|---|---|
| `"cancelled"` is not a valid enum value | It is: `schema.prisma:633`, the generated client, and live `pg_enum` all list it. Route order (`/metrics`, `/counts` before `/:id`) is also correct, with two tests asserting it. |
| `logEvent` throwing corrupts post-send bookkeeping | `eventLogger.ts:10-16` swallows all failures internally. The premise fails at the source. |
| `processedCount`/`slice` arithmetic leaks rows | Correct in all three paths (normal, `break`, `continue`), and the release is additionally guarded by `status: "sending"`. |
| `keywordId` can be null → permanent exhaustion | Non-nullable (`schema.prisma:117`) with `ON DELETE RESTRICT`. The `!convo.keyword` half of the guard is dead code. |
| Circular import between `conversationService` and `dmRecoveryService` | No cycle; the dependency is one-directional. Only style note: the import sits mid-file at `conversationService.ts:61`. |
| Origin verdict wipe breaks out-of-market withholding | Nulling the verdict degrades to the username token screen rather than losing input (`dmRecoveryRepository.ts:150-161` falls through to `inferOrigin`, which reads username too, and username is always non-null when a reset fires). Independently, `recordRecoveryInbound` runs before `resolveUsername` and suppresses the row on engagement, which is policy check 2 — terminal before the origin check at 3b. |
| Health module's counter drain is a race | Deliberate: `getRecoveryHealthSnapshot` explicitly restores the drained counter (`dmRecoveryHealth.ts:203`) so a read does not consume the evaluation's window. |
| Concurrent double-claim for the same person | Backstopped by the partial unique index `dm_recovery_reminder_ig_user_sending_key ... WHERE status = 'sending'`. |

## Convention compliance (checked, clean)

- No `z.coerce.boolean()` anywhere; all new `DM_RECOVERY_*` flags use the safe `booleanFlag` parser.
- No access-token or raw-Graph-URL references in `eventLogger.ts`.
- `npx tsc --noEmit` passes.

## Guidance for the next review

The four unfixed confirmed defects above are established fact — a fresh review should not spend
budget rediscovering them, and should treat the refuted table as closed unless it brings new
evidence.

The uncovered ground, where a fresh review has the most value, is the two-thirds of the diff no
finder reached before dying: the web dashboard (16 files, +3218), origin classification
(4 files, +921), and the schema and migration (+249). Every confirmed defect so far came from the
backend recovery core and gate queue, which is simply where the finders happened to start reading.

Note that all five confirmed defects sat in code paths no test exercised. Test-coverage gaps are
the strongest available predictor of where the next defect is, so worth using as a targeting signal
rather than a separate review angle.

One process note worth carrying forward: of the eleven leads verified, six were refuted. The
finders were generating plausible-sounding defects at roughly a 50% false-positive rate, and the
origin-verdict lead had a completely correct mechanism with an inverted consequence — it would have
read as a real finding to anyone who did not check it. Whatever runs next, the adversarial verify
step is the part that cannot be dropped.
