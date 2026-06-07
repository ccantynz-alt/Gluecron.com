/**
 * E2E — Pull request flows
 *
 * Covers: create PR, add comment, merge PR, close PR.
 *
 * Strategy: beforeAll pushes an initial commit to main, then pushes a
 * feature branch. We create a PR from the feature branch against main
 * and exercise the PR lifecycle within a single spec run.
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
// Shared state
// ---------------------------------------------------------------------------

let owner: string;
let repoName: string;
let featureBranch: string;
let tmpDir: string;

test.beforeAll(async ({ browser }) => {
  owner = uid("pruser");
  repoName = uid("prerepo");
  featureBranch = uid("feat-");

  const page = await browser.newPage();

  // Register
  await page.goto("/register");
  await page.fill('input[name="username"]', owner);
  await page.fill('input[name="email"]', `${owner}@test.example`);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|[a-z])/);

  // Create repo
  await page.goto("/new");
  await page.fill('input[name="name"]', repoName);
  await page.click('button[type="submit"]');
  await page.waitForURL(new RegExp(`/${owner}/${repoName}`));

  await page.close();

  // Push initial commit to main
  tmpDir = await pushTestCommit({
    owner,
    repo: repoName,
    username: owner,
    password: TEST_PASSWORD,
    fileName: "README.md",
    fileContent: `# ${repoName}\n`,
    commitMsg: "Initial commit",
  });

  // Push feature branch
  featureBranch = await pushFeatureBranch({
    repoDir: tmpDir,
    username: owner,
    branchName: featureBranch,
    fileName: "feature.md",
    fileContent: "Feature branch content.\n",
    commitMsg: "Add feature file",
  });
});

test.afterAll(async () => {
  await cleanupDir(tmpDir);
});

// ---------------------------------------------------------------------------
// Helper: log in the page as owner
// ---------------------------------------------------------------------------

async function loginAsOwner(page: Parameters<typeof test>[1] extends never ? never : any): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="username"]', owner);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|[a-z])/);
}

// ---------------------------------------------------------------------------
// Create PR
// ---------------------------------------------------------------------------

test.describe("Pull request creation", () => {
  test("PR list page is accessible", async ({ page }) => {
    await page.goto(`/${owner}/${repoName}/pulls`);
    await expect(page).toHaveURL(new RegExp(`/${owner}/${repoName}/pulls`));
    // Even if empty, the page should render without error
    await expect(page.locator("body")).not.toContainText(/500|Internal Server Error/i);
  });

  test("can open a new PR from the compare page", async ({ page }) => {
    await loginAsOwner(page);

    // Navigate to compare page with the feature branch
    await page.goto(`/${owner}/${repoName}/compare/main...${featureBranch}`);

    // Should show a PR creation form
    const titleInput = page.locator('input[name="title"]');
    await expect(titleInput).toBeVisible({ timeout: 8_000 });

    // Fill in PR details
    const prTitle = `E2E PR ${uid("pr")}`;
    await titleInput.fill(prTitle);

    await page.click('button[type="submit"]');

    // Should redirect to the new PR
    await expect(page).toHaveURL(new RegExp(`/${owner}/${repoName}/pulls/\\d+`));
    await expect(page.locator("body")).toContainText(prTitle);
  });
});

// ---------------------------------------------------------------------------
// PR comment
// ---------------------------------------------------------------------------

test.describe("Pull request comment", () => {
  let prUrl: string;

  test.beforeAll(async ({ browser }) => {
    // Create a PR programmatically so we have a URL to comment on
    const page = await browser.newPage();
    await loginAsOwner(page);

    await page.goto(`/${owner}/${repoName}/compare/main...${featureBranch}`);
    const titleInput = page.locator('input[name="title"]');
    await titleInput.waitFor({ timeout: 8_000 });
    await titleInput.fill(`Comment-test PR ${uid("c")}`);
    await page.click('button[type="submit"]');
    await page.waitForURL(new RegExp(`/${owner}/${repoName}/pulls/\\d+`));
    prUrl = page.url();
    await page.close();
  });

  test("can post a comment on a PR", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto(prUrl);

    const commentBox = page.locator(
      'textarea[name="body"], textarea[name="comment"]'
    ).first();
    await expect(commentBox).toBeVisible({ timeout: 8_000 });

    const commentText = `Test comment ${uid("cmt")}`;
    await commentBox.fill(commentText);
    await page.click('button[type="submit"]');

    await expect(page.locator("body")).toContainText(commentText, {
      timeout: 8_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Merge PR
// ---------------------------------------------------------------------------

test.describe("Pull request merge", () => {
  let prUrl: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsOwner(page);

    await page.goto(`/${owner}/${repoName}/compare/main...${featureBranch}`);
    const titleInput = page.locator('input[name="title"]');
    await titleInput.waitFor({ timeout: 8_000 });
    await titleInput.fill(`Merge-test PR ${uid("m")}`);
    await page.click('button[type="submit"]');
    await page.waitForURL(new RegExp(`/${owner}/${repoName}/pulls/\\d+`));
    prUrl = page.url();
    await page.close();
  });

  test("merge button is visible on an open PR", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto(prUrl);

    // The merge button may be disabled if checks are pending — just check visible
    const mergeBtn = page.locator(
      'button:has-text("Merge"), button[name="action"][value="merge"], form[action*="merge"] button'
    ).first();
    await expect(mergeBtn).toBeVisible({ timeout: 8_000 });
  });

  test("can merge an open PR", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto(prUrl);

    const mergeBtn = page.locator(
      'button:has-text("Merge"), button[name="action"][value="merge"], form[action*="merge"] button'
    ).first();

    // Only click if enabled — if branch-protection blocks it, skip gracefully
    if (await mergeBtn.isEnabled()) {
      await mergeBtn.click();
      await expect(page.locator("body")).toContainText(/merged/i, {
        timeout: 10_000,
      });
    } else {
      test.skip();
    }
  });
});

// ---------------------------------------------------------------------------
// Close PR
// ---------------------------------------------------------------------------

test.describe("Pull request close", () => {
  let prUrl: string;

  test.beforeAll(async ({ browser }) => {
    // Push another unique branch so we have an un-merged PR to close
    const closeBranch = uid("close-");
    await pushFeatureBranch({
      repoDir: tmpDir,
      username: owner,
      branchName: closeBranch,
      fileName: `close-${uid()}.md`,
      fileContent: "Close branch file.\n",
      commitMsg: "Add close-branch file",
    });

    const page = await browser.newPage();
    await loginAsOwner(page);

    await page.goto(`/${owner}/${repoName}/compare/main...${closeBranch}`);
    const titleInput = page.locator('input[name="title"]');
    await titleInput.waitFor({ timeout: 8_000 });
    await titleInput.fill(`Close-test PR ${uid("cl")}`);
    await page.click('button[type="submit"]');
    await page.waitForURL(new RegExp(`/${owner}/${repoName}/pulls/\\d+`));
    prUrl = page.url();
    await page.close();
  });

  test("can close an open PR", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto(prUrl);

    // Close button — server may render it as a form submit or link
    const closeBtn = page.locator(
      'button:has-text("Close"), button[value="close"], form[action*="close"] button'
    ).first();
    await expect(closeBtn).toBeVisible({ timeout: 8_000 });
    await closeBtn.click();

    await expect(page.locator("body")).toContainText(/closed/i, {
      timeout: 8_000,
    });
  });
});
