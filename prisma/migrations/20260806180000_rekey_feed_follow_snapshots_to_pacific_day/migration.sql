BEGIN;

-- A long unrelated transaction must fail this release attempt instead of
-- leaving it queued indefinitely. Because this is transaction-local, a timeout
-- aborts and rolls back the complete re-key cleanly.
SET LOCAL lock_timeout = '5s';

-- Freeze snapshot writes before reading retained evidence. Waiting collectors
-- resume only after the re-key and invariant are committed.
LOCK TABLE "feed_follow_daily_snapshot" IN ACCESS EXCLUSIVE MODE;

-- Exercise the collision ordering before touching retained evidence: a success
-- beats a later failure, while an all-failure group keeps its latest attempt.
DO $$
DECLARE
  matched_winners integer;
BEGIN
  WITH fixture("media_id", "captured_at", "follows", "status") AS (
    VALUES
      ('success-case', '2026-08-05T18:00:00Z'::timestamptz, 7, 'ok'),
      ('success-case', '2026-08-06T00:05:00Z'::timestamptz, NULL, 'failed'),
      ('failure-case', '2026-08-05T18:00:00Z'::timestamptz, NULL, 'unavailable'),
      ('failure-case', '2026-08-06T00:05:00Z'::timestamptz, NULL, 'failed')
  ),
  ranked AS (
    SELECT DISTINCT ON (
      fixture."media_id",
      (fixture."captured_at" AT TIME ZONE 'America/Los_Angeles')::date
    )
      fixture."media_id",
      fixture."captured_at",
      fixture."status"
    FROM fixture
    ORDER BY
      fixture."media_id",
      (fixture."captured_at" AT TIME ZONE 'America/Los_Angeles')::date,
      (fixture."status" = 'ok') DESC,
      fixture."captured_at" DESC
  )
  SELECT count(*) INTO matched_winners
  FROM ranked
  WHERE
    ("media_id" = 'success-case' AND "captured_at" = '2026-08-05T18:00:00Z'::timestamptz)
    OR
    ("media_id" = 'failure-case' AND "captured_at" = '2026-08-06T00:05:00Z'::timestamptz);

  IF matched_winners <> 2 THEN
    RAISE EXCEPTION 'Pacific feed-follow collision policy verification failed';
  END IF;
END $$;

-- Historical rows contain one retained winner per former UTC day. Re-key that
-- retained evidence to America/Los_Angeles. This cannot restore readings that
-- the former UTC-day upsert already replaced.
CREATE TEMP TABLE "feed_follow_snapshot_pacific_winner" ON COMMIT DROP AS
SELECT DISTINCT ON (source."media_id", source."pacific_day")
  source."media_id",
  source."pacific_day" AS "day",
  source."captured_at",
  source."follows",
  source."status"
FROM (
  SELECT
    snapshot."media_id",
    (snapshot."captured_at" AT TIME ZONE 'America/Los_Angeles')::date AS "pacific_day",
    snapshot."captured_at",
    snapshot."follows",
    snapshot."status"
  FROM "feed_follow_daily_snapshot" AS snapshot
) AS source
ORDER BY
  source."media_id",
  source."pacific_day",
  (source."status" = 'ok') DESC,
  source."captured_at" DESC;

DELETE FROM "feed_follow_daily_snapshot";

INSERT INTO "feed_follow_daily_snapshot"
  ("media_id", "day", "captured_at", "follows", "status")
SELECT "media_id", "day", "captured_at", "follows", "status"
FROM "feed_follow_snapshot_pacific_winner";

-- Fail the migration if the copied result differs from the ranked winners.
DO $$
BEGIN
  IF
    (SELECT count(*) FROM "feed_follow_daily_snapshot") <>
      (SELECT count(*) FROM "feed_follow_snapshot_pacific_winner")
    OR EXISTS (
      SELECT 1
      FROM "feed_follow_snapshot_pacific_winner" AS expected
      LEFT JOIN "feed_follow_daily_snapshot" AS actual
        ON actual."media_id" = expected."media_id"
       AND actual."day" = expected."day"
      WHERE actual."media_id" IS NULL
         OR actual."captured_at" IS DISTINCT FROM expected."captured_at"
         OR actual."follows" IS DISTINCT FROM expected."follows"
         OR actual."status" IS DISTINCT FROM expected."status"
    )
  THEN
    RAISE EXCEPTION 'Pacific feed-follow snapshot backfill verification failed';
  END IF;
END $$;

-- Reject stale workers that resume after cutover with a former UTC-derived key.
ALTER TABLE "feed_follow_daily_snapshot"
ADD CONSTRAINT "feed_follow_daily_snapshot_pacific_day_check"
CHECK ("day" = ("captured_at" AT TIME ZONE 'America/Los_Angeles')::date);

COMMIT;
