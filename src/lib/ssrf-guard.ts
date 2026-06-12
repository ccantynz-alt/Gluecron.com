/**
 * SSRF guard — P1 security hardening (BUILD_BIBLE §7).
 *
 * Server-side fetches of user-controlled URLs (webhook deliveries, repo
 * mirror upstreams) must not be allowed to reach private / internal
 * address space: cloud metadata endpoints (169.254.169.254), localhost
 * services, RFC1918 LANs, etc.
 *
 * Primary defence is the *synchronous literal check* — `isPrivateAddress()`
 * recognises hostname conventions (localhost, .local, .internal), every
 * private/reserved IPv4 range (including decimal/hex/octal single-integer
 * encodings like `http://2130706433/`), and the private IPv6 forms
 * (::1, ::, fc00::/7, fe80::/10, IPv4-mapped ::ffff:x.x.x.x).
 *
 * `resolvesToPrivate()` adds a best-effort DNS layer: if a public-looking
 * hostname resolves to a private address it can be blocked too. Resolution
 * failures never block — the subsequent connect would fail anyway.
 *
 * Escape hatches (read at call time, never at module load):
 *   - SSRF_ALLOW_PRIVATE=1     — disable blocking entirely (local dev /
 *     self-hosted setups that legitimately mirror internal git servers).
 *   - test env default-allow   — when NODE_ENV/BUN_ENV is "test" (and not
 *     production), blocking is OFF unless SSRF_ENFORCE_IN_TEST=1. Existing
 *     suites spin up Bun.serve() on localhost and must keep passing; the
 *     ssrf-guard suite opts back in via SSRF_ENFORCE_IN_TEST=1.
 */

// ---------------------------------------------------------------------------
// IPv4 parsing — inet_aton-compatible (1–4 parts, decimal/hex/octal).
// ---------------------------------------------------------------------------

/** Parse one IPv4 component: decimal, 0x-hex, or 0-prefixed octal. */
function parseIpv4Part(s: string): number | null {
  if (!/^(0x[0-9a-f]+|[0-9]+)$/.test(s)) return null;
  let v: number;
  if (s.startsWith("0x")) {
    v = parseInt(s.slice(2), 16);
  } else if (s.length > 1 && s.startsWith("0")) {
    // Leading zero → octal (inet_aton semantics, so 0177.0.0.1 = 127.0.0.1).
    if (!/^[0-7]+$/.test(s)) return null;
    v = parseInt(s, 8);
  } else {
    v = parseInt(s, 10);
  }
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse an IPv4 literal into a 32-bit unsigned integer, accepting the
 * 1/2/3/4-part forms inet_aton accepts (so `2130706433`, `0x7f000001`,
 * `0177.0.0.1`, and `127.1` all map to 127.0.0.1). Returns null when the
 * string is not an IPv4 literal (e.g. a normal hostname).
 */
export function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const v = parseIpv4Part(p);
    if (v === null) return null;
    nums.push(v);
  }

  const n = nums.length;
  if (n === 1) {
    if (nums[0]! > 0xffffffff) return null;
    return nums[0]! >>> 0;
  }
  // All but the last part are single octets; the last fills the remainder.
  for (let i = 0; i < n - 1; i++) {
    if (nums[i]! > 0xff) return null;
  }
  const lastMax = [0, 0, 0xffffff, 0xffff, 0xff][n]!;
  if (nums[n - 1]! > lastMax) return null;

  let prefix = 0;
  for (let i = 0; i < n - 1; i++) {
    prefix = prefix * 256 + nums[i]!;
  }
  return (prefix * 2 ** ((5 - n) * 8) + nums[n - 1]!) >>> 0;
}

/** True when a 32-bit IPv4 address falls in a private/reserved range. */
function isPrivateIpv4(ip: number): boolean {
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local/metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (ip === 0xffffffff) return true; // 255.255.255.255 broadcast
  return false;
}

// ---------------------------------------------------------------------------
// IPv6 parsing — 8×16-bit words, with :: compression and embedded IPv4.
// ---------------------------------------------------------------------------

/** Convert colon-separated groups to 16-bit words (embedded IPv4 → 2 words). */
function groupsToWords(groups: string[]): number[] | null {
  const words: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    if (g.includes(".")) {
      // Embedded IPv4 — only valid in the final position.
      if (i !== groups.length - 1) return null;
      const v4 = parseIpv4(g);
      if (v4 === null) return null;
      words.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      words.push(parseInt(g, 16));
    }
  }
  return words;
}

/** Parse an IPv6 literal into 8 words, or null if it isn't one. */
function parseIpv6(input: string): number[] | null {
  let h = input;
  const pct = h.indexOf("%"); // strip zone id (fe80::1%eth0)
  if (pct !== -1) h = h.slice(0, pct);
  if (h.length === 0) return null;

  const dbl = h.split("::");
  if (dbl.length > 2) return null;

  if (dbl.length === 2) {
    const head = dbl[0] === "" ? [] : dbl[0]!.split(":");
    const tail = dbl[1] === "" ? [] : dbl[1]!.split(":");
    const headW = groupsToWords(head);
    const tailW = groupsToWords(tail);
    if (!headW || !tailW) return null;
    const fill = 8 - headW.length - tailW.length;
    if (fill < 1) return null;
    return [...headW, ...new Array(fill).fill(0), ...tailW];
  }

  const words = groupsToWords(h.split(":"));
  if (!words || words.length !== 8) return null;
  return words;
}

/** True when an IPv6 literal is loopback/unspecified/ULA/link-local/mapped-private. */
function isPrivateIpv6(host: string): boolean {
  const w = parseIpv6(host);
  if (!w) return false; // not a parseable literal — connect will fail anyway
  if (w.every((x) => x === 0)) return true; // :: unspecified
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
  if ((w[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((w[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // IPv4-mapped ::ffff:a.b.c.d (and the bare ::a.b.c.d compat form).
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0) {
    if (w[5] === 0xffff || (w[5] === 0 && (w[6] !== 0 || w[7]! > 1))) {
      const ip = ((w[6]! << 16) | w[7]!) >>> 0;
      return isPrivateIpv4(ip);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Pure, synchronous check: is `host` a private/internal address or a
 * hostname that conventionally maps to one? Accepts bare hostnames, IPv4
 * literals in any inet_aton encoding, and IPv6 literals (with or without
 * the URL bracket form `[::1]`).
 */
export function isPrivateAddress(host: string): boolean {
  if (!host) return true; // empty host — nothing legitimate to reach
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1); // trailing-dot FQDN form
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.length === 0) return true;

  // Hostname conventions.
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;

  // IPv6 literal.
  if (h.includes(":")) return isPrivateIpv6(h);

  // IPv4 literal (any encoding). Non-literals fall through as public —
  // the optional DNS layer (resolvesToPrivate) covers resolved names.
  const v4 = parseIpv4(h);
  if (v4 !== null) return isPrivateIpv4(v4);

  return false;
}

/**
 * Should private addresses be allowed right now? Read at call time, never
 * cached at module load.
 *
 * - `SSRF_ALLOW_PRIVATE=1` → always allow (local dev / self-hosted).
 * - Test env (NODE_ENV/BUN_ENV "test", and NOT production) → allow unless
 *   `SSRF_ENFORCE_IN_TEST=1`. Belt-and-braces mirrors rate-limit.ts: a
 *   leaked test env var in a production container must not drop the guard.
 */
export function ssrfPrivateAllowed(): boolean {
  if (process.env.SSRF_ALLOW_PRIVATE === "1") return true;
  const isTestEnv =
    process.env.NODE_ENV !== "production" &&
    (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test");
  return isTestEnv && process.env.SSRF_ENFORCE_IN_TEST !== "1";
}

export type PublicUrlResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

export interface PublicUrlOptions {
  /** Explicit override; when omitted, env policy (ssrfPrivateAllowed) applies. */
  allowPrivate?: boolean;
  /** Allowed schemes incl. trailing colon. Default: http/https. */
  schemes?: string[];
}

const DEFAULT_SCHEMES = ["http:", "https:"];

/**
 * Validate a user-supplied URL for server-side fetching. Requires an
 * http/https scheme (callers may widen via `opts.schemes`, e.g. git: for
 * mirrors) and rejects private hosts per `isPrivateAddress()`.
 *
 * Embedded credentials (https://user:pw@host/) are deliberately allowed —
 * mirror upstreams legitimately use them; callers strip them from logs.
 *
 * Never throws.
 */
export function assertPublicUrl(
  raw: string,
  opts?: PublicUrlOptions
): PublicUrlResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }

  const schemes = opts?.schemes ?? DEFAULT_SCHEMES;
  if (!schemes.includes(url.protocol)) {
    return { ok: false, reason: `unsupported scheme ${url.protocol.replace(/:$/, "")}` };
  }

  const allowPrivate = opts?.allowPrivate ?? ssrfPrivateAllowed();
  if (allowPrivate) return { ok: true, url };

  if (!url.hostname) {
    return { ok: false, reason: "missing host" };
  }
  if (isPrivateAddress(url.hostname)) {
    return { ok: false, reason: "private address" };
  }
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// Optional async DNS layer — best-effort, injectable for tests.
// ---------------------------------------------------------------------------

export type DnsResolver = (
  host: string
) => Promise<Array<{ address: string }>>;

async function defaultResolver(host: string) {
  const { lookup } = await import("node:dns/promises");
  return lookup(host, { all: true });
}

/**
 * True when `host` is a private literal OR resolves (A/AAAA) to a private
 * address. Best-effort by design: if resolution fails or times out we do
 * NOT block — the literal check above is the primary defence and a
 * non-resolving host can't be fetched anyway.
 */
export async function resolvesToPrivate(
  host: string,
  resolver: DnsResolver = defaultResolver
): Promise<boolean> {
  if (isPrivateAddress(host)) return true;
  try {
    const records = await resolver(host);
    return records.some((r) => isPrivateAddress(r.address));
  } catch {
    return false;
  }
}
