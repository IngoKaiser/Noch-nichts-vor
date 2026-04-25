/**
 * In-memory cache with TTL. Persists for the lifetime of the serverless
 * function instance (typically minutes to ~1h on Vercel under load).
 *
 * For production scale, swap this out for Vercel KV or Upstash Redis.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<any>>();

export function cacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlSeconds: number): void {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

export function cacheDelete(key: string): void {
  store.delete(key);
}

/**
 * Periodic cleanup of expired entries to prevent unbounded growth.
 * Called opportunistically on each cacheGet/cacheSet — cheap.
 */
let lastCleanup = 0;
export function cacheMaybeCleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return; // at most once per minute
  lastCleanup = now;
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(key);
  }
}
