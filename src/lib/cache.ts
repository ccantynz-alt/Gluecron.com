/**
 * In-memory LRU cache with TTL expiration.
 *
 * Used for caching git operations, session lookups,
 * and other hot-path data to avoid redundant subprocess
 * spawns and database roundtrips.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Delete first to update position
    this.cache.delete(key);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Invalidate all keys matching a prefix.
   * Useful for clearing all cached data for a repo after a push.
   */
  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// --- Shared cache instances ---

/** Git operation cache — trees, branches, commits, blobs (5 min TTL, 2000 entries) */
export const gitCache = new LRUCache<unknown>(2000, 5 * 60 * 1000);

/** Session cache — maps session tokens to user objects (2 min TTL, 500 entries) */
export const sessionCache = new LRUCache<unknown>(500, 2 * 60 * 1000);

/**
 * Cache-through helper — returns cached value or runs the factory,
 * caches the result, and returns it.
 *
 * Does NOT cache empty arrays or null — avoids stale empty results
 * when a repo is freshly created or still receiving its first push.
 */
export async function cached<T>(
  cache: LRUCache<T>,
  key: string,
  factory: () => Promise<T>
): Promise<T> {
  const existing = cache.get(key);
  if (existing !== undefined) return existing;

  const value = await factory();

  // Only cache non-empty results
  if (value !== null && value !== undefined) {
    if (Array.isArray(value) && value.length === 0) {
      // Don't cache empty arrays — repo may just be initializing
    } else {
      cache.set(key, value);
    }
  }

  return value;
}

/**
 * Invalidate all cached data for a repository.
 * Call this after pushes, merges, or any repo-mutating operation.
 */
export function invalidateRepoCache(owner: string, repo: string): void {
  gitCache.invalidatePrefix(`${owner}/${repo}:`);
}
