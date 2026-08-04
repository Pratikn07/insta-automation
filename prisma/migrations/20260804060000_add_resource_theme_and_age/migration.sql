-- Routing facets for the guide catalog: what a guide is about, and who it's for.
--
-- Columns rather than prose in `description` because these are FILTERED ON, not
-- read. A parent says "she's 18 months" or "my 3 year old"; the router must
-- narrow candidates in SQL before any LLM sees them. Keeping age in prose would
-- mean handing `Play` — titled "Sensory Play for BABIES" — to a mother of a
-- 3-year-old and trusting the model to notice. A WHERE clause cannot forget.
--
-- Both facets are derived from the author's OWN words, not inferred:
--   Play     "Sensory Play for Babies"
--   Sleep    "from around 2 months old"
--   GUIDE    "COMPLETE 18-24 MONTHS TODDLER GUIDE"
--   Picky    "For Ages 1-3" (cover), "peaks between ages 2-6" (page 2)
--   Pacifier "For toddlers"

-- Coarse bucket, narrowed before the LLM reads any content. Without this the
-- `Car` guide ("when they refuse, stop trying to convince them" — about car
-- seats) surfaces as a candidate for a FEEDING question on keyword overlap
-- alone; a theme mismatch rejects it structurally instead.
-- Values: sleep | eating | behavior | learning. Text, not an enum: the taxonomy
-- is young and a fifth theme should not need a migration.
ALTER TABLE "resources" ADD COLUMN "theme" TEXT;

-- Age window in MONTHS. Months not years because parents state infant age in
-- months ("18 months"), and a single unit avoids conversion bugs at the boundary.
-- A range, not a label like 'toddler': `18 BETWEEN age_min AND age_max` is a
-- clean predicate, whereas matching the word "toddler" is not.
--
-- NULL means "no age stated by the author" — deliberately NOT a guess. Null must
-- read as ELIGIBLE FOR EVERYONE, never as excluded: wrongly narrowing a guide is
-- the worse failure, since it makes real content unreachable (exactly the trap
-- `Picky` was already in). Callers therefore test
--   (age_min_months IS NULL OR :age >= age_min_months)
-- so the recipes and general guides stay available at any age.
ALTER TABLE "resources" ADD COLUMN "age_min_months" INTEGER;
ALTER TABLE "resources" ADD COLUMN "age_max_months" INTEGER;

-- The router's hot path: theme first, then the age window.
CREATE INDEX "resources_theme_age_idx"
  ON "resources" ("theme", "age_min_months", "age_max_months");
