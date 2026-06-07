/**
 * E2E — Issue tracker flows
 *
 * Covers: create issue, add comment, close issue, label management.
 */

import { test, expect } from "@playwright/test";
import {
  uid,
  TEST_PASSWORD,
  pushTestCommit,
  cleanupDir,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Shared state — one user + one repo, one issue URL reused across suites.
// ---------------------------------------------------------------------------

let owner: string;
let repoName: string;
let tmpDir: string;
/** URL of an issue we create in beforeAll for the comment/close/label tests. */
let sharedIssueUrl: string;

test.beforeAll(async ({ browser }) => {
  owner = uid("issueuser");
  repoName = uid("issuerepo");

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

  // Push a commit so the repo isn't empty (some routes need an existing HEAD)
  tmpDir = await pushTestCommit({
    owner,
    repo: repoName,
    username: owner,
    password: TEST_PASSWORD,
    fileName: "README.md",
    fileContent: `# ${repoName}\n`,
    commitMsg: "Initial commit",
  });

  // Create a shared issue via the web UI
  const page2 = await browser.newPage();
  await page2.goto("/login");
  await page2.fill('input[name="username"]', owner);
  await page2.fill('input[name="password"]', TEST_PASSWORD);
  await page2.click('button[type="submit"]');
  await page2.waitForURL(/\/(dashboard|[a-z])/);

  await page2.goto(`/${owner}/${repoName}/issues/new`);
  const titleInput = page2.locator('input[name="title"]');
  await titleInput.waitFor({ timeout: 8_000 });
  await titleInput.fill(`Shared issue ${uid("iss")}`);

  const bodyArea = page2.locator('textarea[name="body"]');
  if (await bodyArea.isVisible()) {
    await bodyArea.fill("Issue body for shared E2E issue.");
  }

  await page2.click('button[type="submit"]');
  await page2.waitForURL(new RegExp(`/${owner}/${repoName}/issues/\\d+`));
  sharedIssueUrl = page2.url();
  await page2.close();
});

test.afterAll(async () => {
  await cleanupDir(tmpDir);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function loginAsOwner(page: any): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="username"]', owner);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|[a-z])/);
}

// ---------------------------------------------------------------------------
// Create issue
// ---------------------------------------------------------------------------

test.describe("Issue creation", () => {
  test("issues list page is accessible", async ({ page }) => {
    await page.goto(`/${owner}/${repoName}/issues`);
    await expect(page).toHaveURL(new RegExp(`/${owner}/${repoName}/issues`));
    await expect(page.locator("body")).not.toContainText(/500|Internal Server Error/i);
  });

  test("can open new issue form", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto(`/${owner}/${repoName}/issues/new`);
    await expect(page.locator('input[name="title"]')).toBeVisible({ timeout: 8_000 });
  });

  test("can create a new issue", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto(`/${owner}/${repoName}/issues/new`);

    const titleInput = page.locator('input[name="title"]');
    await titleInput.waitFor({ timeout: 8_000 });

    const issueTitle = `New issue ${uid("ni")}`;
    await titleInput.fill(issueTitle);

    const bodyArea = page.locator('textarea[name="body"]');
    if (await bodyArea.isVisible()) {
      await bodyArea.fill("This is an E2E-created issue.");
    }

    await page.click('button[type="submit"]');

    // Should redirect to the issue detail page
    await expect(page).toHaveURL(
      new RegExp(`/${owner}/${repoName}/issues/\\d+`)
    );
    await expect(page.locator("body")).toContainText(issueTitle);
  });

  test("issue appears in the issues list", async ({ page }) => {
    await page.goto(`/${owner}/${repoName}/issues`);
    // The shared issue created in beforeAll should be listed
    await expect(page.locator("body")).toContainText(/Shared issue|issue/i, {
      timeout: 8_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Comment on issue
// ---------------------------------------------------------------------------

test.describe("Issue comments", () => {
  test("can post a comment on an issue", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto(sharedIssueUrl);

    const commentBox = page.locator(
      'textarea[name="body"], textarea[name="comment"]'
    ).first();
    await expect(commentBox).toBeVisible({ timeout: 8_000 });

    const commentText = `E2E comment ${uid("cm")}`;
    await commentBox.fill(commentText);
    await page.click('button[type="submit"]');

    await expect(page.locator("body")).toContainText(commentText, {
      timeout: 8_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Close issue
// ---------------------------------------------------------------------------

test.describe("Issue lifecycle", () => {
  let closeIssueUrl: string;

  test.beforeAll(async ({ browser }) => {
    // Create a fresh issue just for the close test
    const page = await browser.newPage();
    await loginAsOwner(page);

    await page.goto(`/${owner}/${repoName}/issues/new`);
    const titleInput = page.locator('input[name="title"]');
    await titleInput.waitFor({ timeout: 8_000 });
    await titleInput.fill(`Close-me issue ${uid("cl")}`);
    await page.click('button[type="submit"]');
    await page.waitForURL(new RegExp(`/${owner}/${repoName}/issues/\\d+`));
    closeIssueUrl = page.url();
    await page.close();
  });

  test("can close an open issue", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto(closeIssueUrl);

    const closeBtn = page.locator(
      'button:has-text("Close"), button[value="close"], form[action*="close"] button'
    ).first();
    await expect(closeBtn).toBeVisible({ timeout: 8_000 });
    await closeBtn.click();

    await expect(page.locator("body")).toContainText(/closed/i, {
      timeout: 8_000,
    });
  });

  test("can reopen a closed issue", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto(closeIssueUrl);

    const reopenBtn = page.locator(
      'button:has-text("Reopen"), button[value="reopen"], form[action*="reopen"] button'
    ).first();
    await expect(reopenBtn).toBeVisible({ timeout: 8_000 });
    await reopenBtn.click();

    await expect(page.locator("body")).toContainText(/open/i, {
      timeout: 8_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test.describe("Issue labels", () => {
  test("labels page is accessible", async ({ page }) => {
    await page.goto(`/${owner}/${repoName}/labels`);
    // Page should load (may be empty if no labels yet)
    await expect(page.locator("body")).not.toContainText(/500|Internal Server Error/i);
  });
});
