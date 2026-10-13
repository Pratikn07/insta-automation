/**
 * A small in-process read-through cache for expensive dashboard aggregates.
 *
 * This exists because of a measured shape, not a general preference for caching:
 * the funnel and leaderboard reports cost seconds, and the API's connection pool
 * is small. Home mounts several panels at once, so the same aggregates were
 * recomputed on every load and queued behind each other for a connection. (Until
 * Oct 2026 the database ran on a 0.5 GB instance that swapped, which made every
 * one of these 10-100x slower; see docs/qa/2026-10-12-dashboard-speed.md.)
 *
 * Two properties matter more than the TTL:
 *
 * 1. It stores the in-flight PROMISE, not the resolved value. Concurrent misses
 *    for one key collapse onto a single query instead of N copies fighting for
 *    the pool — which is the actual failure mode on a cold cache.
 * 2. It never caches a rejection. A cached error would turn one blip into a
 *    TTL-long outage of the panel.
 *
 * 3. With `staleMs`, an expired value is still served for that long while ONE
 *    background refresh runs, so a page never waits on a report just because the
 *    TTL passed. A failed refresh keeps the old value; the next read retries.
 *
 * Deliberately not a general-purpose cache: no LRU touch-on-read, no cross-process
 * sharing. Each API instance keeps its own copy and entries simply expire.
 */

export interface ReadThroughCacheOptions {
  /** How long a computed value may be served before it is recomputed. */
  ttlMs: number;
  /**
   * Cap on distinct keys held at once. Callers key on user-supplied input (a
   * funnel's date window), so the key space is unbounded and needs a ceiling.
   */
  maxEntries?: number;
  /**
   * How long past `ttlMs` a successfully loaded value may still be served while a
   * background refresh runs. Default 0: an expired value is never served.
   */
  staleMs?: number;
  /** Injectable clock; tests assert TTL behaviour without real timers. */
  now?: () => number;
}

export interface ReadThroughCache<T> {
  /** Returns the cached value for `key`, or awaits `load()` and caches it. */
  get(key: string, load: () => Promise<T>): Promise<T>;
  /** Drops one key, or every key when called with no argument. */
  invalidate(key?: string): void;
  /** Entries currently held, expired or not. */
  readonly size: number;
}

interface Entry<T> {
  expiresAt: number;
  value: Promise<T>;
  /** Set once `value` resolves. Only a value that actually loaded may go stale. */
  settled?: boolean;
  /** A background refresh is in flight, so stale reads start at most one. */
  refreshing?: boolean;
}

const DEFAULT_MAX_ENTRIES = 64;

export function createReadThroughCache<T>(options: ReadThroughCacheOptions): ReadThroughCache<T> {
  const { ttlMs, maxEntries = DEFAULT_MAX_ENTRIES, staleMs = 0, now = () => Date.now() } = options;
  const entries = new Map<string, Entry<T>>();

  function refreshInBackground(key: string, stale: Entry<T>, load: () => Promise<T>): void {
    stale.refreshing = true;
    let next: Promise<T>;
    try {
      next = load();
    } catch (error) {
      next = Promise.reject(error);
    }
    next.then(
      (data) => {
        // Invalidated or replaced while loading: the caller wanted it gone.
        if (entries.get(key) !== stale) return;
        entries.delete(key);
        entries.set(key, { expiresAt: now() + ttlMs, value: Promise.resolve(data), settled: true });
      },
      () => {
        stale.refreshing = false;
      },
    );
  }

  return {
    get(key, load) {
      const existing = entries.get(key);
      if (existing && now() < existing.expiresAt) return existing.value;
      if (existing?.settled && now() < existing.expiresAt + staleMs) {
        if (!existing.refreshing) refreshInBackground(key, existing, load);
        return existing.value;
      }

      const value = load();
      const entry: Entry<T> = { expiresAt: now() + ttlMs, value };

      // delete-then-set so Map insertion order tracks when each entry was
      // computed, which is what the eviction below assumes.
      entries.delete(key);
      entries.set(key, entry);

      // Failures must not be served for the rest of the TTL. This handler owns
      // its own rejection branch, so the caller still sees the original error and
      // nothing becomes an unhandled rejection.
      void value.then(
        () => {
          entry.settled = true;
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        },
      );

      if (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }

      return value;
    },

    invalidate(key) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },

    get size() {
      return entries.size;
    },
  };
}
