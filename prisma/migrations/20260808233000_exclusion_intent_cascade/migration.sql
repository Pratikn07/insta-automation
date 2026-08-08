-- The exclusion's intent FK should CASCADE, not RESTRICT.
--
-- Copied from recovery_candidate without re-reading what it means there. On a candidate,
-- RESTRICT is right: the row is a commitment to post a public comment about that intent,
-- so the intent must not be deletable underneath it. An exclusion is the opposite — a
-- note that we considered an intent and did NOT pick it. Blocking a delete for the sake
-- of a note is wrong, and it makes the exclusion record own the lifetime of the thing it
-- merely describes.
--
-- Surfaced by the parallel contract suites: selection reads every journey_intent in the
-- database, so it wrote exclusions referencing other suites' fixtures, and their cleanup
-- then failed on this constraint.
ALTER TABLE "recovery_selection_exclusion"
  DROP CONSTRAINT "recovery_selection_exclusion_intent_id_fkey";

ALTER TABLE "recovery_selection_exclusion" ADD CONSTRAINT "recovery_selection_exclusion_intent_id_fkey"
  FOREIGN KEY ("intent_id") REFERENCES "journey_intent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same reasoning for the keyword: an exclusion naming a deleted keyword has nothing left
-- to describe, and must not keep that keyword alive.
ALTER TABLE "recovery_selection_exclusion"
  DROP CONSTRAINT "recovery_selection_exclusion_keyword_id_fkey";

ALTER TABLE "recovery_selection_exclusion" ADD CONSTRAINT "recovery_selection_exclusion_keyword_id_fkey"
  FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE CASCADE ON UPDATE CASCADE;
