# Dashboard speed investigation and fixes (2026-10-12)

## Root cause

The Supabase database ran on the free **Nano** instance after the org moved to Pro. Supabase does not resize compute when the plan changes. Host metrics showed 408 MiB of RAM, 112 MiB available and about 560 MiB in swap while idle. `shared_buffers` was 224 MB, more than half the machine.

Dashboard reports read 100–150 MB of `event_log` pages per run, which could not stay in memory. `EXPLAIN` reported every page as a cache hit, yet scans ran 10–100x slower than their plans, because the "cached" pages were in swap.

| Evidence (Nano) | Value |
|---|---:|
| Funnel cohort query, cold / warm | 7.9–17.7 s / 0.98 s |
| Swapped in / out during one 16 s test | 723 MiB / 520 MiB |
| Reading one day of `event_log` | 7.0 s |
| DB CPU idle while nobody used the site | 94% |
| Production DB time used by workers per 10 min | ~25 s |

Workers and CPU were not the bottleneck; memory was.

Production request times before the fix (5:27–5:39 PM PT): `/api/funnels/guide-follow/drop-off/no-reply` 17.7 s typical and 20 s worst, `/api/funnels/guide-access-metrics` 9.7 s, `/api/stats` 5.6 s, `/api/funnels/guide-follow` 5.6 s typical and 20 s worst.

## Compute upgrade (applied 02:55 UTC, Oct 13)

The project was moved to **Small** (2 GB) through the Management API. It went from `RESIZING` to `ACTIVE_HEALTHY` in about 50 s. The API logged "connection terminated" errors from 02:56:13 to 02:56:23 UTC and none after that.

| Same test after the upgrade | Value |
|---|---:|
| RAM total / available / swap used | 1,835 / 1,360 / 0 MiB |
| Funnel cohort query, cold / warm | 0.39 s / 0.15–0.18 s |
| Reading one day of `event_log` | 0.15–0.19 s |
| Swap-in during the test | 0 MiB |

## Code changes

1. **Stale-while-revalidate caching.** `readThroughCache` gains an optional `staleMs`. After the TTL, the last value keeps being served while one background refresh runs. A failed refresh keeps the old value, and the next read retries.
   - Applied to the guide-follow and link-click funnels, drop-off lists, guide-access metrics and the Insights leaderboard: fresh for 60 s, then served stale for up to 30 minutes.
   - `/api/stats` is unchanged, so queue depths and alerts stay live.
   - Funnel cache keys now use the request (`default`, or the `YYYY-MM-DD` bounds) instead of the minute bucket. Home's default window would otherwise never reuse a stale entry.
   - Drop-off and guide-access metrics had no cache at all before this change.
2. **Leaderboard and Recipe SQL.** Prisma's nested `perfSnapshots: { take: 1 }` fetched every snapshot of every reel (56k rows with `raw` JSON) and dropped all but one per reel in memory. It is replaced by one `LATERAL ... LIMIT 1` probe per reel.
   - `conversionByMedia`, which pulled every `keyword_matched` payload and every conversation into Node (52k rows), is now counted in SQL. The reel detail drawer uses it too.

## Verification

- **Unit tests:** `readThroughCache` (4 new cases), funnel route caching (4 new) and leaderboard caching (1 new).
- **Real-Postgres check:** `src/services/insightsLeaderboardContract.test.ts` runs against Postgres. It pins the newest-snapshot choice, de-duplication, missing-conversation and unattributable-event handling, and capture rate. It passed on the old code, and it fails if the new SQL picks the oldest snapshot or drops the `DISTINCT`.
- **Production read-only comparison, old code vs new:** both outputs match exactly.

| Comparison | Rows | Old | New |
|---|---:|---:|---:|
| Leaderboard (4,159 keyword comments in both) | 280 | 3.9 s | 0.9 s |
| Recipe | — | 3.7 s | 1.4 s |

Both timings were measured from a Mac and include about 0.45 s of round trip per query.

- **Full backend suite against the contract database:** 3,936 of 3,937 passed. The one failure, `guideDeliveryScheduler.test.ts` (SIGTERM shutdown), is timing-sensitive under full-suite load. It passes alone and this branch does not touch it. `tsc --noEmit` is clean.

## Not changed, and why

- **Funnel SQL** (`COHORT_SQL`, drop-off). After the upgrade these take 0.4–1.1 s, and the cache now serves them without waiting. Restricting `ev` to cohort conversations needs new expression indexes on `event_log`. That isn't worth a migration until production timings say so.
- **Worker indexes.** Candidates are `journey_intent(canonical_conversation_id)`, `dm_recovery_reminder(sent_at)` and `ig_users(origin_checked_at)`. They were flagged from cumulative `pg_stat_statements` taken before the upgrade; re-measure before adding them.
- **`event_log` retention.** `webhook_received` is 250k of 572k rows. Pruning it is a data decision.
- **Per-request auth.** `requireAdmin` calls `supabase.auth.getUser` on every request with no cache. This is not measured from production yet.
