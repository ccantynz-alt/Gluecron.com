/**
 * Cross-product health aggregator — fetches the `platform-status` endpoint
 * of each sibling product (Crontech, Gluecron, GateTest) so the admin
 * dashboard can render a single cross-product status panel.
 *
 * Contract (defined in docs/PLATFORM_STATUS.md):
 *
 *   GET <base>/api/platform-status → {
 *     product, version, commit, healthy, timestamp, siblings
 *   }
 *
 * The endpoint is public + CORS-open + non-sensitive so no auth is required.
 * We fetch server-side anyway to centralise timeouts + caching and avoid
 * mixed-content or CORS surprises from admin browsers.
 */

const DEFAULTS = {
  crontech: "https://crontech.ai/api/platform-status",
  gluecron: "https://gluecron.com/api/platform-status",
  gatetest: "https://gatetest.io/api/platform-status",
} as const;

export type SiblingId = keyof typeof DEFAULTS;

export interface SiblingStatus {
  id: SiblingId;
  name: string;
  url: string;
  reachable: boolean;
  healthy: boolean;
  latencyMs: number | null;
  version: string | null;
  commit: string | null;
  timestamp: string | null;
  checkedAt: string;
  error: string | null;
}

const DISPLAY_NAMES: Record<SiblingId, string> = {
  crontech: "Crontech",
  gluecron: "Gluecron",
  gatetest: "GateTest",
};

const TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: SiblingStatus[];
  expiresAt: number;
}
let cache: CacheEntry | null = null;

export function siblingUrls(): Record<SiblingId, string> {
  return {
    crontech: process.env.CRONTECH_STATUS_URL || DEFAULTS.crontech,
    gluecron: process.env.GLUECRON_STATUS_URL || DEFAULTS.gluecron,
    gatetest: process.env.GATETEST_STATUS_URL || DEFAULTS.gatetest,
  };
}

async function fetchOne(id: SiblingId, url: string): Promise<SiblingStatus> {
  const checkedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        id,
        name: DISPLAY_NAMES[id],
        url,
        reachable: true,
        healthy: false,
        latencyMs,
        version: null,
        commit: null,
        timestamp: null,
        checkedAt,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as Partial<{
      healthy: boolean;
      version: string;
      commit: string;
      timestamp: string;
    }>;
    return {
      id,
      name: DISPLAY_NAMES[id],
      url,
      reachable: true,
      healthy: body.healthy === true,
      latencyMs,
      version: typeof body.version === "string" ? body.version : null,
      commit: typeof body.commit === "string" ? body.commit : null,
      timestamp: typeof body.timestamp === "string" ? body.timestamp : null,
      checkedAt,
      error: null,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message =
      err instanceof Error
        ? err.name === "TimeoutError" || err.name === "AbortError"
          ? "timeout"
          : err.message
        : "unreachable";
    return {
      id,
      name: DISPLAY_NAMES[id],
      url,
      reachable: false,
      healthy: false,
      latencyMs: latencyMs >= TIMEOUT_MS ? TIMEOUT_MS : latencyMs,
      version: null,
      commit: null,
      timestamp: null,
      checkedAt,
      error: message,
    };
  }
}

/**
 * Returns the health of all three sibling products. Cached for 30s so
 * admin page reloads don't hammer neighbours. Always resolves — a failed
 * fetch is reported as `{ reachable: false, healthy: false }`.
 */
export async function getSiblingStatuses(options?: {
  force?: boolean;
}): Promise<SiblingStatus[]> {
  const now = Date.now();
  if (!options?.force && cache && cache.expiresAt > now) {
    return cache.value;
  }
  const urls = siblingUrls();
  const ids = Object.keys(urls) as SiblingId[];
  const value = await Promise.all(ids.map((id) => fetchOne(id, urls[id])));
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Test-only — resets the in-memory cache. */
export function __resetSiblingCache(): void {
  cache = null;
}
