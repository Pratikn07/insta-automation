import { PrismaClient } from "@prisma/client";

// The live Instagram access token, for the plain-JS probe scripts.
//
// WHY THESE DO NOT READ process.env.IG_ACCESS_TOKEN ANY MORE. That variable is only a
// SEED (see src/config/env.ts): the real token lives in the `ig_token` row and the refresh
// worker rotates it every ~6h, so any copy pasted into a .env file is stale within days.
// Every one of these probes was silently authenticating with a token that had been dead
// since 6 August, and Meta's answer -- code 190, "session has been invalidated" -- reads
// like an account problem rather than "you used the wrong token". Reading the row instead
// means a probe is correct whenever the app itself is.
//
// Importing @prisma/client also populates process.env from the project-root .env, which is
// where these scripts get DATABASE_URL and IG_USER_ID.

/**
 * Reads the current access token from the `ig_token` table.
 *
 * Throws rather than returning something unusable: a probe that prints a confusing Graph
 * error is worse than one that says plainly it has no credentials.
 *
 * @returns {Promise<string>} the live access token
 */
export async function liveToken() {
  const prisma = new PrismaClient();
  try {
    const row = await prisma.igToken.findUnique({ where: { id: 1 } });
    if (!row) {
      throw new Error(
        "ig_token row is missing — start the server once to seed it, or paste a fresh " +
          "token into IG_ACCESS_TOKEN and boot the app.",
      );
    }
    if (row.expiresAt <= new Date()) {
      // Do not throw: a probe may legitimately want to demonstrate the failure. Just be
      // explicit, so nobody spends an hour blaming the account.
      console.warn(
        `WARNING: stored ig_token expired at ${row.expiresAt.toISOString()} — expect code 190.`,
      );
    }
    return row.accessToken;
  } finally {
    await prisma.$disconnect();
  }
}
