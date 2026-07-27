import { describe, expect, it } from "vitest";
import {
  MIN_TOKEN_AGE_MS,
  isRefreshDue,
  shouldEnvOverride,
  tokenHealth,
  type TokenTiming,
} from "./tokenStoreCore.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const NOW = Date.parse("2026-07-27T03:00:00.000Z");

/** A token refreshed `agoDays` ago that expires `inDays` from now. */
function timing(agoDays: number, inDays: number): TokenTiming {
  return {
    refreshedAt: new Date(NOW - agoDays * DAY),
    expiresAt: new Date(NOW + inDays * DAY),
  };
}

describe("isRefreshDue", () => {
  it("refuses a token younger than Meta's 24h floor", () => {
    // Meta rejects refresh_access_token outright below 24h, so calling would
    // just burn a request and log a scary-looking error.
    const d = isRefreshDue(timing(0.5, 59.5), NOW);
    expect(d.due).toBe(false);
    expect(d.reason).toBe("too_young");
  });

  it("treats exactly 24h old as still too young, one ms later as eligible", () => {
    // Runway is deliberately urgent (10d) in both cases so AGE is the only thing
    // deciding the outcome — with a far expiry the recently_refreshed rule would
    // mask the boundary being tested.
    const at24h: TokenTiming = {
      refreshedAt: new Date(NOW - MIN_TOKEN_AGE_MS),
      expiresAt: new Date(NOW + 10 * DAY),
    };
    // At the boundary Meta's own clock may disagree with ours by milliseconds;
    // staying on the safe side costs one 6-hourly tick.
    expect(isRefreshDue(at24h, NOW)).toEqual({ due: false, reason: "too_young" });

    const past24h: TokenTiming = {
      refreshedAt: new Date(NOW - MIN_TOKEN_AGE_MS - 1),
      expiresAt: new Date(NOW + 10 * DAY),
    };
    expect(isRefreshDue(past24h, NOW).due).toBe(true);
  });

  it("keeps the 24h floor ahead of urgency — a day-old token cannot be forced", () => {
    // Even with expiry imminent, Meta will refuse below 24h. This ordering is
    // what stops a nearly-dead token from generating an error every 6 hours.
    expect(isRefreshDue(timing(0.9, 0.5), NOW)).toEqual({
      due: false,
      reason: "too_young",
    });
  });

  it("skips a token refreshed this week that is still far from expiring", () => {
    // Nothing to gain: the clock already reads ~55 days out.
    const d = isRefreshDue(timing(3, 55), NOW);
    expect(d.due).toBe(false);
    expect(d.reason).toBe("recently_refreshed");
  });

  it("refreshes once a week even when expiry is comfortably far away", () => {
    // The whole point is to keep resetting the 60-day clock; waiting until the
    // deadline is close is how you end up with no margin for an outage.
    expect(isRefreshDue(timing(8, 52), NOW).due).toBe(true);
  });

  it("refreshes when expiry is near even if we just refreshed", () => {
    // A near expiry with a recent refresh means refreshes are not extending the
    // clock — keep trying rather than sitting out the last two weeks.
    expect(isRefreshDue(timing(1.5, 10), NOW).due).toBe(true);
  });

  it("still attempts a refresh on an already-expired token", () => {
    // It will almost certainly fail (verified against the real dead token), but
    // the failure is what surfaces the alarm. Silently skipping hides it.
    expect(isRefreshDue(timing(61, -1), NOW).due).toBe(true);
  });
});

describe("tokenHealth", () => {
  it("reports a fresh 60-day token as healthy", () => {
    const h = tokenHealth(timing(0, 60), NOW);
    expect(h.status).toBe("healthy");
    expect(h.daysUntilExpiry).toBe(60);
  });

  it("warns from 14 days out", () => {
    // Inclusive: exactly 14 days is already the warning band.
    expect(tokenHealth(timing(46, 14), NOW).status).toBe("warning");
    expect(tokenHealth(timing(45, 15), NOW).status).toBe("healthy");
  });

  it("escalates to critical from 7 days out", () => {
    expect(tokenHealth(timing(53, 7), NOW).status).toBe("critical");
    expect(tokenHealth(timing(52, 8), NOW).status).toBe("warning");
  });

  it("reports an elapsed expiry as expired, not as a negative countdown", () => {
    const h = tokenHealth(timing(61, -2), NOW);
    expect(h.status).toBe("expired");
    expect(h.daysUntilExpiry).toBe(0);
  });

  it("rounds days DOWN so a warning never reads rosier than reality", () => {
    // 7.9 days must not present as 8 ("still fine") when it is inside the
    // critical band.
    const h = tokenHealth(timing(52, 7.9), NOW);
    expect(h.daysUntilExpiry).toBe(7);
    expect(h.status).toBe("critical");
  });

  it("passes through the timestamps so the UI can show when it last refreshed", () => {
    const t = timing(2, 58);
    const h = tokenHealth(t, NOW);
    expect(h.expiresAt).toBe(t.expiresAt.toISOString());
    expect(h.lastRefreshedAt).toBe(t.refreshedAt.toISOString());
  });
});

describe("shouldEnvOverride", () => {
  const alive = new Date(NOW + 55 * DAY);
  const dead = new Date(NOW - DAY);

  it("does NOT clobber a live refreshed token that merely differs from env", () => {
    // The bug this function exists to prevent: once the worker rotates the
    // token, the DB differs from env on every boot. A blind "env wins" rule
    // threw away a real refresh (expiry Sep 25) and reset it to a guess.
    expect(shouldEnvOverride("IGAA_refreshed", "IGAA_env_original", alive, NOW)).toBe(false);
  });

  it("lets env rescue a stored token that has expired", () => {
    // The manual recovery path: a human re-mints in the Meta dashboard and
    // pastes into Railway. If the dead DB row kept priority, that fix would
    // appear to do nothing.
    expect(shouldEnvOverride("IGAA_dead", "IGAA_fresh_from_dashboard", dead, NOW)).toBe(true);
  });

  it("is a no-op when the two already agree", () => {
    expect(shouldEnvOverride("IGAA_same", "IGAA_same", dead, NOW)).toBe(false);
    expect(shouldEnvOverride("IGAA_same", "IGAA_same", alive, NOW)).toBe(false);
  });

  it("treats the exact expiry instant as dead", () => {
    expect(shouldEnvOverride("IGAA_a", "IGAA_b", new Date(NOW), NOW)).toBe(true);
  });
});
