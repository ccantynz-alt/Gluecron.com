/**
 * Small helpers for the GitHub import flow (/import).
 *
 * Pure parsing/normalization helpers live at the top of the file.
 * `importOneRepo` at the bottom wraps the clone + DB insert so that both
 * the single-repo and bulk importers can share one code path.
 */

import { and, eq } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { db } from "../db";
import { repositories } from "../db/schema";
import { config } from "../lib/config";

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

/**
 * Strip any secret (token) from a string before it gets returned to the UI
 * or written to logs. Defense in depth: we already avoid putting tokens into
 * messages, but git/HTTP errors may echo the URL we passed in.
 */
export function scrubSecrets(input: string, token: string | null): string {
  if (!input) return input;
  let out = input;
  if (token) out = out.split(token).join("***");
  // Also redact any `https://<creds>@github.com/...` form the URL may leak.
  out = out.replace(
    /https:\/\/[^@\s]+@github\.com/gi,
    "https://***@github.com"
  );
  return out;
}

export interface ImportOneRepoInput {
  cloneUrl: string;
  targetName: string;
  ownerId: string;
  ownerUsername: string;
  token?: string | null;
  description?: string | null;
  isPrivate?: boolean;
  defaultBranch?: string;
}

export type ImportOneRepoStatus = "success" | "skipped-exists" | "failed";

export interface ImportOneRepoResult {
  status: ImportOneRepoStatus;
  name: string;
  notes: string;
}

/**
 * Clone one GitHub repo into this user's namespace and insert the DB row.
 *
 * Resilient: returns a result object instead of throwing, so bulk callers
 * can continue past a failure. Never includes the token in the returned
 * notes — all output is passed through `scrubSecrets`.
 */
export async function importOneRepo(
  input: ImportOneRepoInput
): Promise<ImportOneRepoResult> {
  const {
    cloneUrl,
    targetName,
    ownerId,
    ownerUsername,
    token = null,
    description = null,
    isPrivate = false,
    defaultBranch = "main",
  } = input;

  const safeName = sanitizeRepoName(targetName);

  try {
    // Uniqueness in the caller's namespace (owner+name).
    const [existing] = await db
      .select()
      .from(repositories)
      .where(
        and(eq(repositories.ownerId, ownerId), eq(repositories.name, safeName))
      )
      .limit(1);

    if (existing) {
      return {
        status: "skipped-exists",
        name: safeName,
        notes: "Already exists in your namespace",
      };
    }

    const destPath = join(config.gitReposPath, ownerUsername, `${safeName}.git`);
    await mkdir(join(config.gitReposPath, ownerUsername), { recursive: true });

    const authedCloneUrl = buildCloneUrl(cloneUrl, token);

    const proc = Bun.spawn(
      ["git", "clone", "--bare", "--mirror", authedCloneUrl, destPath],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return {
        status: "failed",
        name: safeName,
        notes: `git clone failed: ${scrubSecrets(stderr, token).slice(0, 200)}`,
      };
    }

    await db.insert(repositories).values({
      name: safeName,
      ownerId,
      description,
      isPrivate,
      defaultBranch: defaultBranch || "main",
      diskPath: destPath,
      starCount: 0,
    });

    return { status: "success", name: safeName, notes: "Cloned + indexed" };
  } catch (err) {
    return {
      status: "failed",
      name: safeName,
      notes: scrubSecrets(String(err), token).slice(0, 200),
    };
  }
}
