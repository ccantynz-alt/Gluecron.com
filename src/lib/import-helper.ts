/**
 * Small helpers for the GitHub import flow (/import).
 *
 * Kept in its own file so we can stay inside the rule that says we may
 * only edit src/routes/import.tsx and add a helper here. No DB or git
 * process coupling — this is pure parsing/normalization.
 */

export interface ParsedGithubUrl {
  owner: string;
  repo: string;
}

/**
 * Parse a GitHub URL into { owner, repo }. Accepts:
 *   - https://github.com/foo/bar
 *   - https://github.com/foo/bar.git
 *   - http://github.com/foo/bar/
 *   - git@github.com:foo/bar.git
 *   - github.com/foo/bar
 *   - foo/bar
 *
 * Returns null if the URL cannot be parsed.
 */
export function parseGithubUrl(raw: string): ParsedGithubUrl | null {
  const input = (raw || "").trim();
  if (!input) return null;

  // SSH form: git@github.com:owner/repo(.git)?
  const ssh = input.match(/^git@github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (ssh) return { owner: ssh[1], repo: stripDotGit(ssh[2]) };

  // HTTP(S) / bare host form
  const http = input.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i
  );
  if (http) return { owner: http[1], repo: stripDotGit(http[2]) };

  // owner/repo shorthand
  const short = input.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (short) return { owner: short[1], repo: stripDotGit(short[2]) };

  return null;
}

function stripDotGit(name: string): string {
  return name.replace(/\.git$/i, "");
}

/**
 * Repository names on gluecron follow GitHub's rough rules: letters,
 * digits, hyphens, underscores, dots. We normalize by replacing anything
 * else with a hyphen so an imported repo is always addressable.
 */
export function sanitizeRepoName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "imported-repo";
}

/**
 * Build the clone URL that `git clone --bare --mirror` will use. When a
 * token is supplied we inject it so private repos are reachable.
 */
export function buildCloneUrl(cloneUrl: string, token: string | null): string {
  if (!token) return cloneUrl;
  return cloneUrl.replace("https://github.com/", `https://${token}@github.com/`);
}
