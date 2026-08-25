import axios from "axios";
import { logger } from "../lib/logger.js";
import { logEvent, describeGraphError } from "../services/eventLogger.js";
import { getAccessToken, persistRefreshedToken, readTokenTiming } from "./tokenStore.js";
import { isRefreshDue } from "./tokenStoreCore.js";
import { probeTokenLiveness } from "./tokenLiveness.js";

// The worker that keeps the Instagram token alive.
//
// Each successful call resets Meta's 60-day clock to 60 days from NOW, so
// refreshing weekly means the token permanently sits ~53 days from expiry and
// this app never repeats the 2026-07-26 outage.
//
// Deliberately does NOT go through graphClient/insightsGraph: those inject
// access_token as a query param via interceptor, which is what this endpoint
// wants too, but they are also pinned to versioned base URLs
// (/v21.0, /v23.0) and refresh_access_token lives at the UNVERSIONED root.

const REFRESH_URL = "https://graph.instagram.com/refresh_access_token";
const FALLBACK_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;

export type RefreshFailureKind = "too_young" | "expired" | "invalidated" | "unknown";

export interface RefreshOutcome {
  kind: RefreshFailureKind;
  /** Whether this deserves an operator's attention. */
  alarming: boolean;
}

/**
 * Absolute expiry from Meta's `expires_in` seconds.
 *
 * Guards against a missing/zero/negative value: those would either produce an
 * Invalid Date or mark the token instantly expired, tripping the dashboard alarm
 * for no reason.
 */
export function expiryFromExpiresIn(expiresIn: number | undefined, nowMs: number): Date {
  const ms = typeof expiresIn === "number" && expiresIn > 0
    ? expiresIn * 1000
    : FALLBACK_LIFETIME_MS;
  return new Date(nowMs + ms);
}

/**
 * What a refresh failure means, and whether to raise an alarm.
 *
 * The distinction that matters: "must be at least 24 hours old" is NORMAL — every
 * freshly minted token spends its first day rejecting refreshes, and treating
 * that as an error would cry wolf every 6h for a day after each manual re-mint.
 * Everything else is treated as alarming, including unrecognised errors: assuming
 * an unknown failure is benign is how a dying token stays invisible.
 */
export function classifyRefreshOutcome(err: unknown): RefreshOutcome {
  const message = axios.isAxiosError(err)
    ? String(
        (err.response?.data as { error?: { message?: string } } | undefined)?.error?.message ??
          err.message,
      )
    : err instanceof Error
      ? err.message
      : String(err);

  const lower = message.toLowerCase();

  if (lower.includes("24 hours")) return { kind: "too_young", alarming: false };
  if (lower.includes("has expired")) return { kind: "expired", alarming: true };
  if (lower.includes("invalidated")) return { kind: "invalidated", alarming: true };
  return { kind: "unknown", alarming: true };
}

/**
 * One refresh tick. Fully non-throwing — a failure here must never crash the
 * server (mirrors runGateQueueTick and runFollowRecheckTick).
 *
 * On failure the existing token is left untouched: a botched refresh must not
 * destroy a credential that still works.
 */
export async function runTokenRefreshTick(now = new Date()): Promise<void> {
  try {
    const timing = await readTokenTiming();
    if (!timing) {
      // No row yet — seedTokenFromEnv runs at boot, so this only happens if the
      // seed failed. Nothing to refresh against.
      logger.warn("token refresh skipped: no ig_token row");
      return;
    }

    const decision = isRefreshDue(timing, now.getTime());
    if (!decision.due) {
      logger.debug({ reason: decision.reason }, "token refresh not due");
      // Refresh only reaches Meta when due (~weekly), so between refreshes an EARLY
      // invalidation — a password change or revoke, which does not touch expires_at —
      // would go unseen until the next refresh. A cheap /me probe every tick closes
      // that window to hours. Non-throwing, so it can never disturb the tick.
      await probeTokenLiveness();
      return;
    }

    const res = await axios.get(REFRESH_URL, {
      params: { grant_type: "ig_refresh_token", access_token: getAccessToken() },
      timeout: 15_000,
    });

    const data = res.data as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      // A 200 with no token is not something Meta documents; treat it as a
      // failure rather than persisting undefined over a working credential.
      logger.error(
        { errorCode: "token_refresh_missing_access_token" },
        "token refresh returned no access_token",
      );
      await logEvent("ig_token_refresh_failed", { reason: "no_access_token" });
      return;
    }

    const expiresAt = expiryFromExpiresIn(data.expires_in, now.getTime());
    await persistRefreshedToken(data.access_token, expiresAt, now);

    logger.info(
      { expiresAt: expiresAt.toISOString(), expiresIn: data.expires_in },
      "ig token refreshed",
    );
    await logEvent("ig_token_refreshed", {
      expiresAt: expiresAt.toISOString(),
      expiresIn: data.expires_in ?? null,
    });
  } catch (err) {
    const outcome = classifyRefreshOutcome(err);

    if (!outcome.alarming) {
      // Expected for a token under 24h old. Debug-level so it does not read as
      // a problem in the logs.
      logger.debug({ kind: outcome.kind }, "token refresh not yet possible");
      return;
    }

    const detail = describeGraphError(err);
    logger.error({ kind: outcome.kind, ...detail }, "ig token refresh failed");
    await logEvent("ig_token_refresh_failed", {
      kind: outcome.kind,
      ...detail,
    });
    // A refresh that fails because the token is invalidated or expired is the same
    // operator emergency the liveness probe reports. Emit the shared health signal so
    // readTokenHealth turns the dashboard red no matter which path detected it.
    if (outcome.kind === "invalidated" || outcome.kind === "expired") {
      await logEvent("ig_token_invalidated", { source: "refresh", ...detail });
    }
  }
}
