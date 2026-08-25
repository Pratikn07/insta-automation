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
// WHY A CACHE. Both Graph clients inject the token in an axios REQUEST INTERCEPTOR,
// which runs on every single call (219 media call sites alone), and hitting Postgres
// per request would be absurd. So reads come off a cached value kept warm by a
// background refresh.
//
// The cache also means a DB blip cannot take the Graph API down: a stale-but-
// valid token still authenticates fine for the ~60 days it is alive.
//
// WHY THE PRIMARY READ IS ASYNC. This file used to offer only a synchronous getter,
// on the reasoning that "making the interceptors async would change axios's behaviour
// at every call site for no benefit." That was wrong on both halves. Axios supports a
// promise-returning request interceptor natively, so no call site changes; and the
// benefit is real — a synchronous read on a cold cache can only return the env seed,
// which is how every short-lived script ended up authenticating with a token that had
// been dead for weeks (2026-08-25). `resolveAccessToken` awaits the first warm and is
// what the interceptors use. `getAccessToken` remains for warm, hot-path callers.

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

/** Opaque read of the cache binding, so a caller cannot over-narrow it. */
function readCache(): CachedToken | null {
  return cache;
}

/**
 * The token to authenticate a Graph call with, waiting for the cache warm first.
 *
 * PREFER THIS over `getAccessToken` anywhere a wrong token has a consequence. It
 * costs one awaited DB read on the first call of a process and nothing after, and
 * it is what the Graph request interceptors use.
 *
 * WHY IT EXISTS. `getAccessToken` is synchronous, so on a cold cache it can only
 * return the `env.IG_ACCESS_TOKEN` seed. A long-running server barely notices —
 * `seedTokenFromEnv()` warms the cache during boot. A short-lived script never
 * gets that far: it finishes before the background warm lands, so EVERY Graph
 * call it makes authenticates with the seed. On any machine whose `.env` holds an
 * older seed — the normal case, because the live token lives in `ig_token` and
 * rotates itself every 6h — those calls fail with code 190.
 *
 * That failure is not cosmetic. In the guide-access flow a failed follow read
 * becomes `follow_check_unavailable`, which parks the parent in `needs_review`;
 * and because the action token was already consumed by `claimActionEvent`, a
 * retry dedupes on the event receipt and the parent cannot be recovered at all.
 * Verified on 2026-08-25, when the local seed had been dead since 6 August.
 */
export async function resolveAccessToken(): Promise<string> {
  if (cache) {
    if (Date.now() - cache.readAt > CACHE_TTL_MS) void warmCache();
    return cache.accessToken;
  }
  await warmCache();
  // Read through a call, not the closed-over binding: control-flow analysis has
  // already narrowed `cache` to null on this branch and does not know warmCache
  // reassigns it, so a direct `if (cache)` here narrows to `never`.
  const warmed = readCache();
  if (warmed) return warmed.accessToken;
  // Reached only when the table is unreachable or has no row. Still fall back —
  // an app that cannot read its own token table should keep serving Instagram
  // traffic — but never silently, because this is the shape that burned us.
  return seedOrThrow();
}

/**
 * The env seed, or a loud failure.
 *
 * `IG_ACCESS_TOKEN` is optional (see env.ts), so "no cache and no seed" is reachable and
 * means this process has no Instagram credentials at all. Throwing beats returning
 * `undefined` into a query string: Meta answers `access_token=undefined` with a generic
 * 400 that reads like a malformed request, sending the reader after the wrong bug.
 */
function seedOrThrow(): string {
  const seed = env.IG_ACCESS_TOKEN;
  if (seed === undefined) {
    throw new Error(
      "No Instagram access token: the ig_token row is unreadable and IG_ACCESS_TOKEN is unset",
    );
  }
  logger.warn(
    { errorCode: "ig_token_seed_fallback_served" },
    "ig_token unavailable; authenticating with the env seed, which is usually stale",
  );
  return seed;
}

/**
 * The token to authenticate Graph calls with, read synchronously off the cache.
 *
 * Falls back to the `env.IG_ACCESS_TOKEN` seed whenever the cache is cold — which
 * is the case for the very first calls after boot, and permanently if the DB row
 * is somehow missing. That fallback is deliberate: an app that cannot read its own
 * token table should still be able to serve Instagram traffic. It throws when
 * there is no seed either, because at that point there are no credentials at all.
 *
 * UNSAFE IN A SHORT-LIVED PROCESS: the cache is still cold, so this returns the
 * seed. Use `resolveAccessToken` unless you are certain the process is warm.
 */
export function getAccessToken(): string {
  if (cache) {
    // Refresh the cache in the background when stale; never block a request on
    // it. Returning a slightly stale token is harmless (they last ~60 days).
    if (Date.now() - cache.readAt > CACHE_TTL_MS) void warmCache();
    return cache.accessToken;
  }
  void warmCache();
  return seedOrThrow();
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
    const seed = env.IG_ACCESS_TOKEN;

    // Nothing to seed from, which is the normal local case now that the variable is
    // optional. Still warm the cache below so the stored token is ready to use.
    if (seed === undefined) {
      if (!row) {
        logger.error(
          { errorCode: "ig_token_absent" },
          "no ig_token row and no IG_ACCESS_TOKEN seed; Instagram calls will fail",
        );
      }
    } else if (!row) {
      await prisma.igToken.create({
        data: {
          id: 1,
          accessToken: seed,
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
        seed,
        row.expiresAt,
        now.getTime(),
      );
      if (override) {
        await prisma.igToken.update({
          where: { id: 1 },
          data: {
            accessToken: seed,
            expiresAt: new Date(now.getTime() + SEED_LIFETIME_MS),
            refreshedAt: now,
          },
        });
        logger.warn("ig token replaced from env (stored token had expired)");
      } else if (row.accessToken !== seed) {
        // Normal steady state once refreshing works. Not a warning.
        logger.debug("ig token in db differs from env; keeping the live db token");
      }
    }

    cache = null;
    await warmCache();
  } catch {
    // Non-fatal: the token reads still fall back to the env seed, so the app boots
    // and serves traffic even if this table is unreachable. With no seed set they
    // throw instead, which is correct — there is nothing to authenticate with.
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
