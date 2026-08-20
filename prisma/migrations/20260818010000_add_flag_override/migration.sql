-- Flag VALUES only.
--
-- What each flag does, who it affects, and what changes if it is off all live in
-- src/config/flagRegistry.ts, so a description is reviewed in the same commit as
-- the code it describes and the build fails without one. A column here would be a
-- second place to write that down, which nothing would force anyone to fill in.
--
-- A missing row means "no override": the resolver falls through to the deployed
-- environment value. That is deliberate — an empty table must behave exactly like
-- production does today, so shipping this migration changes no behaviour at all.

CREATE TABLE "flag_override" (
    "key" TEXT NOT NULL,
    "value_bool" BOOLEAN,
    "value_percent" INTEGER,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flag_override_pkey" PRIMARY KEY ("key"),

    -- Exactly one, never both and never neither. A row carrying both values does
    -- not say which kind of flag it belongs to, and the resolver would have to
    -- guess; a row carrying neither says nothing at all.
    CONSTRAINT "flag_override_one_value_check"
      CHECK (num_nonnulls("value_bool", "value_percent") = 1),

    CONSTRAINT "flag_override_percent_range_check"
      CHECK ("value_percent" IS NULL OR ("value_percent" BETWEEN 0 AND 100))
);

-- The browser never reaches this table directly. The service-role-backed admin
-- API is the only management path, as with upcoming_automations.
ALTER TABLE "flag_override" ENABLE ROW LEVEL SECURITY;
