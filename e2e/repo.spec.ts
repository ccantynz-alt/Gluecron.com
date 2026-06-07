/**
 * E2E — Repository flows
 *
 * Covers: create repo, push first commit, file browser shows files,
 * commit list populated, README renders.
 */

import { test, expect } from "@playwright/test";
import {
  uid,
  TEST_PASSWORD,
  pushTestCommit,
  pushFeatureBranch,
  cleanupDir,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Shared state — one user + one repo for the whole suite.
// ---------------------------------------------------------------------------

let owner: string;
let repoName: string;
let tmpDir: string;

test.beforeAll(async ({ browser }) => {
  owner = uid("repouser");
  repoName = uid("myrepo");

  const page = await browser.newPage();

  // Register the test user
  await page.goto("/register");
  await page.fill('input[name="username"]', owner);
  await page.fill('input[name="email"]', `${owner}@test.example`);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|[a-z])/);

  // Create the repository via the web UI
  await page.goto("/new");
  await page.fill('input[name="name"]', repoName);
  await page.click('button[type="submit"]');
  await page.waitForURL(new RegExp(`/${owner}/${repoName}`));

  await page.close();

  // Push an initial commit via git CLI
  tmpDir = await pushTestCommit({
    owner,
    repo: repoName,
    username: owner,
    password: TEST_PASSWORD,
    fileName: "README.md",
    fileContent: `# ${repoName}\n\nThis is the E2E test repo.\n`,
    commitMsg: "Initial commit",
  });
});

test.afterAll(async () => {
  await cleanupDir(tmpDir);
});

// ---------------------------------------------------------------------------
// Repository creation
// ---------------------------------------------------------------------------

test.describe("Repository creation", () => {
  test("new repo page is accessible while logged in", async ({ page }) => {
    // Log in fresh for this test
    await page.goto("/login");
    await page.fill('input[name="username"]', owner);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(dashboard|[a-z])/);

    await page.goto("/new");
    await expect(page.locator('input[name="name"]')).toBeVisible();
  });

  test("created repo homepage is publicly accessible", async ({ page }) => {
    await page.goto(`/${owner}/${repoName}`);
    await expect(page).toHaveURL(new RegExp(`/${owner}/${repoName}`));
    // Page should mention the repo name
    await expect(page.locator("body")).toContainText(repoName);
  });
});

// ---------------------------------------------------------------------------
// File browser
// ---------------------------------------------------------------------------

test.describe("File browser", () => {
  test("README.md appears in the file listing", async ({ page }) => {
    await page.goto(`/${owner}/${repoName}`);
    await expect(page.locator("body")).toContainText("README.md", {
      timeout: 8_000,
    });
  });

  test("README.md content is rendered on repo homepage", async ({ page }) => {
    await page.goto(`/${owner}/${repoName}`);
    // The repo README says "E2E test repo"
    await expect(page.locator("body")).toContainText("E2E test repo", {
      timeout: 8_000,
    });
  });

  test("clicking a file opens the blob view", async ({ page }) => {
    await page.goto(`/${owner}/${repoName}`);
    // Click the README link in the file table
    await page.click('a[href*="README.md"]');
    await expect(page).toHaveURL(new RegExp(`/${owner}/${repoName}/blob`));
    await expect(page.locator("body")).toContainText("E2E test repo");
  });
});

// ---------------------------------------------------------------------------
// Commit list
// ---------------------------------------------------------------------------

test.describe("Commit list", () => {
  test("commits page lists the initial commit", async ({ page }) => {
    await page.goto(`/${owner}/${repoName}/commits`);
    await expect(page.locator("body")).toContainText("Initial commit", {
      timeout: 8_000,
    });
  });

  test("commit detail page loads", async ({ page }) => {
    await page.goto(`/${owner}/${repoName}/commits`);
    // Click the first commit link
    const commitLink = page.locator('a[href*="/commit/"]').first();
    await commitLink.click();
    await expect(page).toHaveURL(new RegExp(`/${owner}/${repoName}/commit/`));
    // Should show the diff or commit message
    await expect(page.locator("body")).toContainText(/Initial commit|README/i);
  });
});

// ---------------------------------------------------------------------------
// Branch support
// ---------------------------------------------------------------------------

test.describe("Branches", () => {
  test("branches page lists main branch", async ({ page }) => {
    await page.goto(`/${owner}/${repoName}/branches`);
    await expect(page.locator("body")).toContainText(/main|master/, {
      timeout: 8_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Additional repo — invalid names
// ---------------------------------------------------------------------------

test.describe("Repo creation validation", () => {
  test("invalid repo name shows error", async ({ page }) => {
    // Log in
    await page.goto("/login");
    await page.fill('input[name="username"]', owner);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(dashboard|[a-z])/);

    await page.goto("/new");
    // Put a name with spaces/special chars that the validator rejects
    await page.fill('input[name="name"]', "invalid repo name!");
    await page.click('button[type="submit"]');

    // Server should send back an error
    const body = page.locator("body");
    await expect(body).toContainText(/invalid|error/i, { timeout: 5_000 });
  });
});
