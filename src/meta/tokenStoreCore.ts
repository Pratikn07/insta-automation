// Pure decision logic for keeping the Instagram token alive (no prisma/env
// imports, no Date.now() — time is always passed in, same split as spikeCore).
//
// WHY THIS EXISTS. Instagram Login long-lived tokens last 60 days and this app
// had no refresh path at all, so on 2026-07-26 at 18:12 PDT the token simply ran
// out: every Graph call returned OAuthException 190, followersTotal went null,
// and the snapshot workers stopped accruing data until a human re-minted a token
// in the Meta App Dashboard.
//
// The recovery is not symmetric with the failure. `refresh_access_token` requires
// a token that is still ALIVE — verified against the real expired token, which
// returned 190 from the refresh endpoint too. Once expiry passes there is no
// programmatic way back. So the only durable fix is to refresh well before the
// deadline, on a schedule, forever.

/** Meta rejects refresh_access_token below this age. */
export const MIN_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Refresh at least this often. Each successful refresh resets expiry to 60 days
 * from that moment, so a weekly cadence keeps ~53 days of margin permanently —
 * enough that the app can be down for over a month without the token dying.
 */
const REFRESH_INTERVAL_MS = 7 * DAY_MS;

/** Below this much runway, retry on every tick regardless of recency. */
const URGENT_WINDOW_MS = 14 * DAY_MS;

const WARNING_DAYS = 14;
const CRITICAL_DAYS = 7;

export interface TokenTiming {
  expiresAt: Date;
  refreshedAt: Date;
}

export type RefreshSkipReason = "too_young" | "recently_refreshed";

export type RefreshDecision =
  | { due: true }
  | { due: false; reason: RefreshSkipReason };

export type TokenStatus = "healthy" | "warning" | "critical" | "expired";

export interface TokenHealth {
  daysUntilExpiry: number; // floored, never negative
  expiresAt: string;
  lastRefreshedAt: string;
  status: TokenStatus;
}

/**
 * Whether to call Meta's refresh endpoint on this tick.
 *
 * Deliberately still returns `due` for an already-expired token: the call will
 * fail, and that failure is what raises the alarm. Skipping it would make a dead
 * token look indistinguishable from a healthy one in the logs.
 */
export function isRefreshDue(timing: TokenTiming, nowMs: number): RefreshDecision {
  const ageMs = nowMs - timing.refreshedAt.getTime();

  // Below Meta's floor the call is guaranteed to fail, so it would only produce
  // a misleading error line. Not an alarm — every freshly minted token passes
  // through this state for its first day.
  if (ageMs <= MIN_TOKEN_AGE_MS) return { due: false, reason: "too_young" };

  const runwayMs = timing.expiresAt.getTime() - nowMs;
  if (runwayMs <= URGENT_WINDOW_MS) return { due: true };

  if (ageMs < REFRESH_INTERVAL_MS) return { due: false, reason: "recently_refreshed" };

  return { due: true };
}

/**
 * Countdown + severity for the dashboard alarm.
 *
 * Days are floored, never rounded: 7.9 days of runway must not display as "8
 * days" when it sits inside the critical band. A health readout that rounds in
 * the reassuring direction is worse than none.
 */
export function tokenHealth(timing: TokenTiming, nowMs: number): TokenHealth {
  const runwayMs = timing.expiresAt.getTime() - nowMs;
  const daysUntilExpiry = runwayMs <= 0 ? 0 : Math.floor(runwayMs / DAY_MS);

  // Inclusive bounds: at exactly 7 days of runway you want the loud state, not
  // the mild one. Erring toward the calmer band is how a warning gets ignored.
  let status: TokenStatus;
  if (runwayMs <= 0) status = "expired";
  else if (daysUntilExpiry <= CRITICAL_DAYS) status = "critical";
  else if (daysUntilExpiry <= WARNING_DAYS) status = "warning";
  else status = "healthy";

  return {
    daysUntilExpiry,
    expiresAt: timing.expiresAt.toISOString(),
    lastRefreshedAt: timing.refreshedAt.toISOString(),
    status,
  };
}
