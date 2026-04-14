/**
 * Issue + PR template loader. Looks for the standard locations and
 * returns the first match. Fails silently (returns null) so new-issue /
 * new-PR forms always render — templates are a convenience, not a
 * requirement.
 */

import { getBlob, getDefaultBranch } from "../git/repository";

const ISSUE_PATHS = [
  ".github/ISSUE_TEMPLATE.md",
  ".github/issue_template.md",
  ".gluecron/ISSUE_TEMPLATE.md",
  "ISSUE_TEMPLATE.md",
  "docs/ISSUE_TEMPLATE.md",
];

const PR_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  ".gluecron/PULL_REQUEST_TEMPLATE.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];

const MAX_TEMPLATE_BYTES = 16 * 1024;

async function loadFirst(
  owner: string,
  repo: string,
  ref: string,
  paths: string[]
): Promise<string | null> {
  for (const p of paths) {
    try {
      const blob = await getBlob(owner, repo, ref, p);
      if (blob && !blob.isBinary && blob.content) {
        // Guard against someone committing a 5MB template.
        if (blob.content.length > MAX_TEMPLATE_BYTES) {
          return blob.content.slice(0, MAX_TEMPLATE_BYTES);
        }
        return stripFrontmatter(blob.content);
      }
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * GitHub-style templates can have YAML frontmatter (---\nname: ...\n---).
 * Strip it — we don't use the name/about fields here.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return content;
  return content.slice(end + 4).replace(/^\n+/, "");
}

export async function loadIssueTemplate(
  owner: string,
  repo: string
): Promise<string | null> {
  try {
    const ref = (await getDefaultBranch(owner, repo)) || "HEAD";
    return await loadFirst(owner, repo, ref, ISSUE_PATHS);
  } catch {
    return null;
  }
}

export async function loadPrTemplate(
  owner: string,
  repo: string
): Promise<string | null> {
  try {
    const ref = (await getDefaultBranch(owner, repo)) || "HEAD";
    return await loadFirst(owner, repo, ref, PR_PATHS);
  } catch {
    return null;
  }
}

export { stripFrontmatter as _stripFrontmatterForTest };
