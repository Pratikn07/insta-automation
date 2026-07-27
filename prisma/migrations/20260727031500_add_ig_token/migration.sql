-- The live Instagram access token as a single row, so the refresh worker can
-- persist a renewed token (a process cannot rewrite its own Railway env vars).
CREATE TABLE "ig_token" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "access_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "refreshed_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ig_token_pkey" PRIMARY KEY ("id")
);
