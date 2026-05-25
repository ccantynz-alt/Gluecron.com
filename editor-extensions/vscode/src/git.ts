/**
 * Pure helpers for resolving the Gluecron owner/repo from a git remote URL.
 *
 * Kept VS-Code-free so the parser is unit-testable from plain node:test
 * (see `src/__tests__/extension.test.ts`).
 */

export interface RepoInfo {
  owner: string;
  repo: string;
  /** Hostname extracted from the remote (e.g. "gluecron.com"). */
  host: string;
}

/**
 * Parse a git remote URL into `{ owner, repo, host }`.
 *
 * Supports:
 *   - https://gluecron.com/owner/repo.git
 *   - https://user:pass@gluecron.com/owner/repo
 *   - http://localhost:3000/owner/repo.git
 *   - git@gluecron.com:owner/repo.git
 *   - ssh://git@gluecron.com:2222/owner/repo.git
 *
 * Returns `null` if the URL can't be parsed into owner/repo.
 *
 * NOTE: this parser does NOT filter by host — the caller decides whether
 * the host matches `gluecron.host`. That keeps the parser host-agnostic
 * and makes self-hosted instances work out of the box.
 */
export function parseGitRemote(url: string): RepoInfo | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SCP-style: git@host:owner/repo[.git]
  const scpMatch = trimmed.match(/^[^@\s]+@([^:\s]+):(.+?)(?:\.git)?\/?$/);
  if (scpMatch) {
    const host = scpMatch[1];
    const path = scpMatch[2];
    const [owner, repo] = splitPath(path);
    if (owner && repo) return { owner, repo, host };
    return null;
  }

  // Anything URL-ish (http/https/ssh/git protocols)
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }
  if (parsed) {
    const host = parsed.host.replace(/:\d+$/, ""); // strip :port for display
    const path = parsed.pathname.replace(/^\/+/, "").replace(/\.git\/?$/, "");
    const [owner, repo] = splitPath(path);
    if (owner && repo) return { owner, repo, host };
  }
  return null;
}

function splitPath(path: string): [string?, string?] {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return [undefined, undefined];
  // The owner/repo are always the LAST two segments — handles nested
  // path prefixes like /git/owner/repo when self-hosted behind a path.
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  return [owner, repo];
}

/**
 * Build a web URL pointing at the file in the Gluecron blob view.
 */
export function buildBlobUrl(
  host: string,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  line?: number
): string {
  const cleanHost = host.replace(/\/+$/, "");
  const cleanPath = filePath.replace(/^\/+/, "");
  const base = `${cleanHost}/${owner}/${repo}/blob/${branch}/${cleanPath}`;
  return typeof line === "number" && line >= 0 ? `${base}#L${line + 1}` : base;
}

/**
 * Whether a remote's host matches the configured Gluecron host.
 *
 * - Exact hostname match (case-insensitive).
 * - "localhost" matches any port-less local-style remote.
 * - Self-hosted users override `gluecron.host` in settings; this helper
 *   reads the configured hostname only — never the protocol or path.
 */
export function isGluecronRemote(remoteHost: string, configuredHost: string): boolean {
  if (!remoteHost) return false;
  let configHostname: string;
  try {
    configHostname = new URL(configuredHost).hostname || configuredHost;
  } catch {
    configHostname = configuredHost.replace(/^[a-z]+:\/\//, "").split("/")[0] || configuredHost;
  }
  return remoteHost.toLowerCase() === configHostname.toLowerCase();
}
