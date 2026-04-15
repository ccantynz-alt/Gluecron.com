/**
 * npm-compatible package registry helpers (Block C2).
 *
 * Small, pure helpers used by both the protocol routes and the UI. Keeps
 * the route file itself focused on wiring + DB access.
 */

import type { Package, PackageVersion, PackageTag } from "../db/schema";

export type ParsedPackageName = {
  scope: string | null; // "@acme" (with leading @) or null
  name: string; // "foo"
  full: string; // "@acme/foo" or "foo"
};

/**
 * Parse an npm-style package name. Accepts both "foo" and "@scope/foo".
 * Returns null on malformed input.
 */
export function parsePackageName(raw: string): ParsedPackageName | null {
  if (!raw || typeof raw !== "string") return null;
  // Decode %2F ("@scope%2Fname" — the npm client URL-encodes scoped names)
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();

  const trimmed = decoded.trim();
  if (!trimmed) return null;

  // Disallow slashes / whitespace / control chars in the bare name.
  const safeSegment = /^[a-z0-9][a-z0-9._-]*$/i;

  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/");
    if (slash < 2) return null;
    const scope = trimmed.slice(0, slash); // "@acme"
    const name = trimmed.slice(slash + 1); // "foo"
    const scopeBody = scope.slice(1); // "acme"
    if (!safeSegment.test(scopeBody)) return null;
    if (!safeSegment.test(name)) return null;
    return { scope, name, full: `${scope}/${name}` };
  }

  if (!safeSegment.test(trimmed)) return null;
  return { scope: null, name: trimmed, full: trimmed };
}

/** SHA1 hex of the given bytes (npm legacy shasum). */
export function computeShasum(bytes: Uint8Array): string {
  // Bun.CryptoHasher supports sha1 natively.
  const h = new Bun.CryptoHasher("sha1");
  h.update(bytes);
  return h.digest("hex");
}

/** Subresource-Integrity format: "sha512-<base64 of sha512 digest>". */
export function computeIntegrity(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha512");
  h.update(bytes);
  const digest = h.digest(); // Buffer
  const b64 = Buffer.from(digest).toString("base64");
  return `sha512-${b64}`;
}

/**
 * Resolve the owner+repo that a package's metadata points to.
 * Accepts either the object form `{ url: "...", type: "git" }` or the
 * string shorthand. Returns null if we cannot locate a gluecron URL.
 *
 * Handles:
 *   - "http(s)://host/owner/repo(.git)?"
 *   - "git+https://host/owner/repo.git"
 *   - "git@host:owner/repo.git"
 *   - "github:owner/repo"  → treated as "owner/repo" (still matched)
 */
export function resolveRepoFromPackageJson(
  meta: unknown
): { owner: string; repo: string } | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const repoField = m["repository"];
  let url: string | null = null;

  if (typeof repoField === "string") {
    url = repoField;
  } else if (repoField && typeof repoField === "object") {
    const u = (repoField as Record<string, unknown>)["url"];
    if (typeof u === "string") url = u;
  }

  if (!url) return null;
  return parseRepoUrl(url);
}

/** Lower-level helper also used by the publish route. Exported for tests. */
export function parseRepoUrl(
  urlRaw: string
): { owner: string; repo: string } | null {
  if (!urlRaw || typeof urlRaw !== "string") return null;
  let url = urlRaw.trim();
  if (!url) return null;

  // Strip a "git+" prefix ("git+https://..."").
  if (url.startsWith("git+")) url = url.slice(4);

  // Shorthand "github:owner/repo" — we accept any "host:owner/repo" form and
  // treat the bit after ':' as "owner/repo" if it contains a slash.
  if (/^[a-z0-9_-]+:/i.test(url) && !url.startsWith("http")) {
    const colon = url.indexOf(":");
    const tail = url.slice(colon + 1);
    // SCP-style git@host:owner/repo.git
    if (tail.includes("/")) {
      return splitOwnerRepo(tail);
    }
  }

  // Regular URL form. Accept http(s)://host/owner/repo(.git)?
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+/, "");
    return splitOwnerRepo(path);
  } catch {
    // Fall through to plain "owner/repo" path.
    return splitOwnerRepo(url);
  }
}

function splitOwnerRepo(
  path: string
): { owner: string; repo: string } | null {
  const clean = path.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Build an npm "packument" document (the document you get back from
 * `GET /:name`). Shape roughly follows
 * https://docs.npmjs.com/registry/api.
 *
 * The per-version objects merge the stored `package.json` metadata with the
 * canonical `dist` block so that `npm install` knows where to fetch the
 * tarball from.
 */
export function buildPackument(
  pkg: Package,
  versions: PackageVersion[],
  tags: PackageTag[],
  baseUrl: string
): Record<string, unknown> {
  const fullName = pkg.scope ? `${pkg.scope}/${pkg.name}` : pkg.name;
  const base = baseUrl.replace(/\/+$/, "");

  // versions map
  const versionsOut: Record<string, Record<string, unknown>> = {};
  const timeOut: Record<string, string> = {};

  for (const v of versions) {
    let meta: Record<string, unknown> = {};
    try {
      meta = v.metadata ? JSON.parse(v.metadata) : {};
    } catch {
      meta = {};
    }
    const tarballUrl = `${base}/npm/${encodeURI(fullName)}/-/${pkg.name}-${v.version}.tgz`;
    versionsOut[v.version] = {
      ...meta,
      name: fullName,
      version: v.version,
      dist: {
        tarball: tarballUrl,
        shasum: v.shasum,
        integrity: v.integrity ?? undefined,
      },
      ...(v.yanked ? { _yanked: true, _yankedReason: v.yankedReason } : {}),
    };
    const pub = v.publishedAt instanceof Date
      ? v.publishedAt.toISOString()
      : new Date(v.publishedAt as unknown as string).toISOString();
    timeOut[v.version] = pub;
  }

  // dist-tags
  const distTags: Record<string, string> = {};
  const versionById = new Map(versions.map((v) => [v.id, v]));
  for (const t of tags) {
    const v = versionById.get(t.versionId);
    if (v) distTags[t.tag] = v.version;
  }
  // Fallback: if no "latest" tag, use the most recently published version.
  if (!distTags["latest"] && versions.length > 0) {
    const sorted = [...versions].sort((a, b) => {
      const ad = new Date(a.publishedAt as unknown as string).getTime();
      const bd = new Date(b.publishedAt as unknown as string).getTime();
      return bd - ad;
    });
    distTags["latest"] = sorted[0].version;
  }

  return {
    _id: fullName,
    name: fullName,
    description: pkg.description ?? undefined,
    "dist-tags": distTags,
    versions: versionsOut,
    time: timeOut,
    homepage: pkg.homepage ?? undefined,
    license: pkg.license ?? undefined,
    readme: pkg.readme ?? undefined,
  };
}

/**
 * Tarball filename convention expected by npm clients: `<name>-<version>.tgz`.
 * For scoped packages, the *scope* is part of the URL but NOT the filename.
 */
export function tarballFilename(
  parsed: ParsedPackageName,
  version: string
): string {
  return `${parsed.name}-${version}.tgz`;
}
