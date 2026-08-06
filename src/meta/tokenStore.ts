import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  shouldEnvOverride,
  tokenHealth,
  type TokenHealth,
  type TokenTiming,
} from "./tokenStoreCore.js";

// The live Instagram access token, read through a tiny in-process cache.
//
// WHY A CACHE, AND WHY SYNCHRONOUS. Both Graph clients inject the token in an
// axios REQUEST INTERCEPTOR, which runs on every single call (219 media call
// sites alone). Making those async would change axios's behaviour at every call
// site for no benefit, and hitting Postgres per request would be absurd. So the
// getter is synchronous off a cached value, and a background read keeps it warm.
//
// The cache also means a DB blip cannot take the Graph API down: a stale-but-
// valid token still authenticates fine for the ~60 days it is alive.

const CACHE_TTL_MS = 60 * 1000;
const SEED_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000; // Meta's long-lived window

interface CachedToken {
  accessToken: string;
  expiresAt: Date;
  refreshedAt: Date;
  readAt: number;
}

let cache: CachedToken | null = null;
let inflight: Promise<void> | null = null;

/**
 * The token to authenticate Graph calls with.
 *
 * Falls back to `env.IG_ACCESS_TOKEN` whenever the cache is cold — which is the
 * case for the very first calls after boot, and permanently if the DB row is
 * somehow missing. That fallback is deliberate: an app that cannot read its own
 * token table should still be able to serve Instagram traffic.
 */
export function getAccessToken(): string {
  if (cache) {
    // Refresh the cache in the background when stale; never block a request on
    // it. Returning a slightly stale token is harmless (they last ~60 days).
    if (Date.now() - cache.readAt > CACHE_TTL_MS) void warmCache();
    return cache.accessToken;
  }
  void warmCache();
  return env.IG_ACCESS_TOKEN;
}

/** Reads the row into cache. Never throws — logs and leaves the cache as-is. */
async function warmCache(): Promise<void> {
  // Collapse concurrent warms so a burst of requests issues one query.
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const row = await prisma.igToken.findUnique({ where: { id: 1 } });
      if (row) {
        cache = {
          accessToken: row.accessToken,
          expiresAt: row.expiresAt,
          refreshedAt: row.refreshedAt,
          readAt: Date.now(),
        };
      }
    } catch {
      logger.error(
        { errorCode: "ig_token_cache_warm_failed" },
        "ig token cache warm failed; using env fallback",
      );
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Ensures a row exists, and lets a hand-pasted env token rescue a broken one.
 *
 * The subtlety here caused a real bug during development. The obvious rule —
 * "env differs from DB, so env wins" — is WRONG once refreshing works: after the
 * worker rotates the token, the DB legitimately differs from env on every
 * subsequent boot, and a blind override would throw away the refreshed token and
 * reset expiry to a 60-day guess. Observed exactly that: a successful refresh to
 * an expiry of Sep 25 was immediately clobbered by the older env value.
 *
 * But the override still has to exist, because it is the manual recovery path:
 * when a token has actually died, a human re-mints one in the Meta dashboard and
 * pastes it into Railway, and if the DB silently kept priority that recovery
 * would appear to do nothing.
 *
 * Resolution: env only wins when the DB token cannot be saved by refreshing —
 * i.e. it is at/past expiry. A live DB token always beats env.
 */
export async function seedTokenFromEnv(now = new Date()): Promise<void> {
  try {
    const row = await prisma.igToken.findUnique({ where: { id: 1 } });

    if (!row) {
      await prisma.igToken.create({
        data: {
          id: 1,
          accessToken: env.IG_ACCESS_TOKEN,
          // An estimate until the first real refresh replaces it with Meta's
          // own expires_in. Assuming a full 60 days is the optimistic read, but
          // the health alarm surfaces the truth as soon as a refresh lands.
          expiresAt: new Date(now.getTime() + SEED_LIFETIME_MS),
          refreshedAt: now,
        },
      });
      logger.info("ig token row seeded from env");
    } else {
      const override = shouldEnvOverride(
        row.accessToken,
        env.IG_ACCESS_TOKEN,
        row.expiresAt,
        now.getTime(),
      );
      if (override) {
        await prisma.igToken.update({
          where: { id: 1 },
          data: {
            accessToken: env.IG_ACCESS_TOKEN,
            expiresAt: new Date(now.getTime() + SEED_LIFETIME_MS),
            refreshedAt: now,
          },
        });
        logger.warn("ig token replaced from env (stored token had expired)");
      } else if (row.accessToken !== env.IG_ACCESS_TOKEN) {
        // Normal steady state once refreshing works. Not a warning.
        logger.debug("ig token in db differs from env; keeping the live db token");
      }
    }

    cache = null;
    await warmCache();
  } catch {
    // Non-fatal: getAccessToken still falls back to env, so the app boots and
    // serves traffic even if this table is unreachable.
    logger.error({ errorCode: "ig_token_seed_failed" }, "seedTokenFromEnv failed");
  }
}

/** Persists a token Meta just handed back, and busts the cache. */
export async function persistRefreshedToken(
  accessToken: string,
  expiresAt: Date,
  now = new Date(),
): Promise<void> {
  await prisma.igToken.upsert({
    where: { id: 1 },
    create: { id: 1, accessToken, expiresAt, refreshedAt: now },
    update: { accessToken, expiresAt, refreshedAt: now },
  });
  cache = {
    accessToken,
    expiresAt,
    refreshedAt: now,
    readAt: Date.now(),
  };
}

/** Current timing straight from the DB (no cache — callers are not hot paths). */
export async function readTokenTiming(): Promise<TokenTiming | null> {
  const row = await prisma.igToken.findUnique({ where: { id: 1 } });
  if (!row) return null;
  return { expiresAt: row.expiresAt, refreshedAt: row.refreshedAt };
}

/** Health readout for the dashboard alarm; null when no row exists yet. */
export async function readTokenHealth(now = Date.now()): Promise<TokenHealth | null> {
  const timing = await readTokenTiming();
  return timing ? tokenHealth(timing, now) : null;
}

/** Test seam: drops the cached value so the next read hits the DB. */
export function __resetTokenCache(): void {
  cache = null;
  inflight = null;
}
