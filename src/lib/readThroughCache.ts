/**
 * A small in-process read-through cache for expensive dashboard aggregates.
 *
 * This exists because of a measured shape, not a general preference for caching:
 * the Postgres instance is CPU-bound (100% buffer-cache hit ratio, yet a fully
 * cached `count(*)` over 126k rows costs ~500ms), the funnel cohort query means
 * ~1.7s, and the API's connection pool is small. Home mounts four panels at once,
 * so the same aggregates were recomputed on every load and queued behind each
 * other for a connection.
 *
 * Two properties matter more than the TTL:
 *
 * 1. It stores the in-flight PROMISE, not the resolved value. Concurrent misses
 *    for one key collapse onto a single query instead of N copies fighting for
 *    the pool — which is the actual failure mode on a cold cache.
 * 2. It never caches a rejection. A cached error would turn one blip into a
 *    TTL-long outage of the panel.
 *
 * Deliberately not a general-purpose cache: no LRU touch-on-read, no stale-while-
 * revalidate, no cross-process sharing. Each API instance keeps its own copy and
 * entries simply expire.
 */

export interface ReadThroughCacheOptions {
  /** How long a computed value may be served before it is recomputed. */
  ttlMs: number;
  /**
   * Cap on distinct keys held at once. Callers key on user-supplied input (a
   * funnel's date window), so the key space is unbounded and needs a ceiling.
   */
  maxEntries?: number;
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
}

const DEFAULT_MAX_ENTRIES = 64;

export function createReadThroughCache<T>(options: ReadThroughCacheOptions): ReadThroughCache<T> {
  const { ttlMs, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = options;
  const entries = new Map<string, Entry<T>>();

  return {
    get(key, load) {
      const existing = entries.get(key);
      if (existing && now() < existing.expiresAt) return existing.value;

      const value = load();
      const entry: Entry<T> = { expiresAt: now() + ttlMs, value };

      // delete-then-set so Map insertion order tracks when each entry was
      // computed, which is what the eviction below assumes.
      entries.delete(key);
      entries.set(key, entry);

      // Failures must not be served for the rest of the TTL. This handler owns
      // its own rejection branch, so the caller still sees the original error and
      // nothing becomes an unhandled rejection.
      void value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });

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
