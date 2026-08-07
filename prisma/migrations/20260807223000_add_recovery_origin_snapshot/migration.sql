-- Snapshot the audience-origin verdict onto the reminder row.
--
-- The policy reads origin live from `ig_users` at send time, and `ig_users` is
-- mutable: a verdict is retired when the name it came from changes, and the
-- enrichment worker rewrites rows continuously. That is fine for deciding a
-- send, but it makes the experiment unmeasurable after the fact.
--
-- Control rows are the acute case. They are stamped terminal at creation and
-- never re-evaluated, so they carry no record of what the origin filter would
-- have said about them. Without a snapshot there is no way to compare
-- "treatment people who were in-market" against "control people who were
-- in-market" — the two arms hold different populations and the measured lift
-- reads low.
--
-- Nullable because the classifier is asynchronous: a person may be unclassified
-- when their reminder is created and resolved ten hours later. A null here means
-- "not yet known at creation", which is recoverable from ig_users; it does not
-- mean "no verdict".
ALTER TABLE "dm_recovery_reminder"
  ADD COLUMN "audience_origin" TEXT,
  ADD COLUMN "audience_origin_confidence" TEXT;

-- The metrics comparison filters both arms on these two columns, so it reads
-- them for every row in the experiment window.
CREATE INDEX "dm_recovery_reminder_audience_origin_idx"
  ON "dm_recovery_reminder" ("audience_origin", "audience_origin_confidence");
