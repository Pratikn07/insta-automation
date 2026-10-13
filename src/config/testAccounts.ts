import { env } from "./env.js";

/**
 * Instagram accounts the owner tests with. A listed account skips the audience filter and
 * the one-DM-per-journey rule, so every comment it leaves gets a fresh DM; everything else
 * (keyword match, public reply, the send itself, tap tracking) runs exactly as for a parent.
 * Read on every call so a Railway change needs no code change. `??` because test mocks of
 * env.js may omit the key.
 */
export function isTestAccount(igUserId: string): boolean {
  return (env.TEST_IG_USER_IDS ?? "")
    .split(",")
    .some((id) => id.trim() === igUserId);
}
