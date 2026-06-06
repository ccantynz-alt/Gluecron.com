/**
 * Shared test helpers for Gluecron E2E tests.
 *
 * All helpers accept a Playwright `Page` instance (or raw fetch for API calls)
 * so they integrate naturally with Playwright's context/browser model.
 */

import { type Page } from "@playwright/test";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/** Default password used for all test accounts. */
export const TEST_PASSWORD = "TestPass123!";

// ---------------------------------------------------------------------------
// Unique ID generator — keeps test data isolated even with parallel shards.
// ---------------------------------------------------------------------------

let _seq = 0;
export function uid(prefix = "u"): string {
  _seq++;
  return `${prefix}${Date.now()}${_seq}`;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Registers a fresh user via the web UI and leaves the page logged in.
 * Returns the username so callers can build repo URLs.
 */
export async function createTestUser(
  page: Page,
  prefix = "tuser"
): Promise<string> {
  const username = uid(prefix);
  const email = `${username}@test.example`;

  await page.goto("/register");
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');

  // After successful registration, server redirects to /dashboard or similar.
  await page.waitForURL(/\/(dashboard|[a-z])/);

  return username;
}

/**
 * Logs an existing user in via the web UI.
 */
export async function loginUser(
  page: Page,
  username: string,
  password = TEST_PASSWORD
): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|[a-z])/);
}

/**
 * Logs the current user out via the UI.
 */
export async function logoutUser(page: Page): Promise<void> {
  // Try the nav logout link first; fall back to direct form POST.
  const logoutLink = page.locator('a[href="/logout"]').first();
  if (await logoutLink.isVisible()) {
    await logoutLink.click();
  } else {
    await page.goto("/logout");
  }
  await page.waitForURL(/\/(login|register|$)/);
}

// ---------------------------------------------------------------------------
// Repository helpers
// ---------------------------------------------------------------------------

/**
 * Creates a repository via the web UI.
 * Assumes the user is already logged in.
 * Returns the repo name.
 */
export async function createTestRepo(
  page: Page,
  owner: string,
  namePrefix = "repo"
): Promise<string> {
  const repoName = uid(namePrefix);

  await page.goto("/new");
  await page.fill('input[name="name"]', repoName);

  // Optional description
  const descField = page.locator('input[name="description"], textarea[name="description"]');
  if (await descField.isVisible()) {
    await descField.fill("E2E test repo");
  }

  await page.click('button[type="submit"]');

  // Should redirect to the new repo page.
  await page.waitForURL(new RegExp(`/${owner}/${repoName}`));

  return repoName;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Clones a repo to a temporary directory, adds a file, and pushes back.
 * Uses HTTP credentials (username + password) embedded in the URL.
 *
 * Returns the temp directory path (caller can clean up).
 */
export async function pushTestCommit(opts: {
  owner: string;
  repo: string;
  username: string;
  password?: string;
  fileName?: string;
  fileContent?: string;
  commitMsg?: string;
  branch?: string;
}): Promise<string> {
  const {
    owner,
    repo,
    username,
    password = TEST_PASSWORD,
    fileName = "README.md",
    fileContent = `# ${repo}\n\nE2E test commit.\n`,
    commitMsg = "Add test file",
    branch = "main",
  } = opts;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-e2e-"));

  const baseUrl = BASE_URL.replace("://", `://${username}:${encodeURIComponent(password)}@`);
  const repoUrl = `${baseUrl}/${owner}/${repo}.git`;

  // git init + set up remote
  await spawnGit(tmpDir, ["init", "-b", branch]);
  await spawnGit(tmpDir, ["remote", "add", "origin", repoUrl]);
  await spawnGit(tmpDir, ["config", "user.email", `${username}@test.example`]);
  await spawnGit(tmpDir, ["config", "user.name", username]);

  // Write file
  await fs.writeFile(path.join(tmpDir, fileName), fileContent, "utf8");

  // Commit and push
  await spawnGit(tmpDir, ["add", "."]);
  await spawnGit(tmpDir, ["commit", "-m", commitMsg]);
  await spawnGit(tmpDir, ["push", "-u", "origin", branch]);

  return tmpDir;
}

/**
 * Pushes a second commit on a new branch (useful for creating PRs).
 * Returns the branch name.
 */
export async function pushFeatureBranch(opts: {
  repoDir: string;
  username: string;
  branchName?: string;
  fileName?: string;
  fileContent?: string;
  commitMsg?: string;
}): Promise<string> {
  const {
    repoDir,
    username,
    branchName = uid("feat-"),
    fileName = "feature.md",
    fileContent = "Feature branch file.\n",
    commitMsg = "Add feature file",
  } = opts;

  await spawnGit(repoDir, ["config", "user.email", `${username}@test.example`]);
  await spawnGit(repoDir, ["config", "user.name", username]);
  await spawnGit(repoDir, ["checkout", "-b", branchName]);

  await fs.writeFile(path.join(repoDir, fileName), fileContent, "utf8");
  await spawnGit(repoDir, ["add", "."]);
  await spawnGit(repoDir, ["commit", "-m", commitMsg]);
  await spawnGit(repoDir, ["push", "-u", "origin", branchName]);

  return branchName;
}

// ---------------------------------------------------------------------------
// Internal: spawn a git subprocess
// ---------------------------------------------------------------------------

async function spawnGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      // Suppress interactive prompts
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "echo",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${exitCode}):\n${stderr}\n${stdout}`
    );
  }

  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

export async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}
