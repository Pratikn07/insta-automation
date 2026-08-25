BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Keep the deployed three/two guard active while PostgreSQL validates the expanded
-- five/three policy against existing rows. The entire replacement is atomic, so a lock
-- timeout cannot leave the temporary name behind.
ALTER TABLE "guide_access_attempt"
  ADD CONSTRAINT "guide_access_attempt_follow_counts_check_v2"
  CHECK (
    "follow_check_count" >= 0
    AND "follow_check_count" <= 5
    AND "follow_response_count" >= 0
    AND "follow_response_count" <= 3
  ) NOT VALID;

ALTER TABLE "guide_access_attempt"
  VALIDATE CONSTRAINT "guide_access_attempt_follow_counts_check_v2";

ALTER TABLE "guide_access_attempt"
  DROP CONSTRAINT "guide_access_attempt_follow_counts_check";

ALTER TABLE "guide_access_attempt"
  RENAME CONSTRAINT "guide_access_attempt_follow_counts_check_v2"
  TO "guide_access_attempt_follow_counts_check";

COMMIT;
