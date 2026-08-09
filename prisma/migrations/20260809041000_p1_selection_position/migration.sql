-- Persist inclusion order so approval can recompute the exact reviewed hash after the
-- batched insert. Nullable for legacy campaigns; new selection and approval require a
-- dense zero-based position.
ALTER TABLE "recovery_candidate"
  ADD COLUMN "selection_position" INTEGER,
  ADD CONSTRAINT "recovery_candidate_selection_position_check"
    CHECK ("selection_position" IS NULL OR "selection_position" >= 0);

CREATE UNIQUE INDEX "recovery_candidate_campaign_id_selection_position_key"
  ON "recovery_candidate" ("campaign_id", "selection_position");
