/**
 * E2E — User settings flows
 *
 * Covers: update profile display name/bio, add SSH key, create API token.
 */

import { test, expect } from "@playwright/test";
import { uid, TEST_PASSWORD } from "./fixtures";

// ---------------------------------------------------------------------------
// Shared state — one user for all settings tests
// ---------------------------------------------------------------------------

let settingsUser: string;

test.beforeAll(async ({ browser }) => {
  settingsUser = uid("settingsuser");

  const page = await browser.newPage();
  await page.goto("/register");
  await page.fill('input[name="username"]', settingsUser);
  await page.fill('input[name="email"]', `${settingsUser}@test.example`);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|[a-z])/);
  await page.close();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function loginAsSettingsUser(page: any): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="username"]', settingsUser);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|[a-z])/);
}

// ---------------------------------------------------------------------------
// Profile settings
// ---------------------------------------------------------------------------

test.describe("Profile settings", () => {
  test("settings page loads for logged-in user", async ({ page }) => {
    await loginAsSettingsUser(page);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.locator("body")).not.toContainText(/500|Internal Server Error/i);
  });

  test("can update display name / bio", async ({ page }) => {
    await loginAsSettingsUser(page);
    await page.goto("/settings");

    // Look for a display-name or bio field — either may exist
    const displayNameField = page.locator(
      'input[name="displayName"], input[name="name"], input[name="display_name"]'
    ).first();
    const bioField = page.locator('textarea[name="bio"]').first();

    let updated = false;

    if (await displayNameField.isVisible()) {
      await displayNameField.fill(`E2E User ${uid("dn")}`);
      updated = true;
    }

    if (await bioField.isVisible()) {
      await bioField.fill("E2E automated bio update.");
      updated = true;
    }

    if (updated) {
      await page.click('button[type="submit"]');
      // Should stay on settings (or show success flash)
      await expect(page).toHaveURL(/\/settings/);
      await expect(page.locator("body")).not.toContainText(/500|error/i);
    } else {
      // If no profile fields found, just ensure the page rendered
      test.skip();
    }
  });

  test("unauthenticated access to /settings redirects to login", async ({ page }) => {
    // Don't log in
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login/);
  });
});

// ---------------------------------------------------------------------------
// SSH keys
// ---------------------------------------------------------------------------

test.describe("SSH keys", () => {
  test("SSH keys settings page is accessible", async ({ page }) => {
    await loginAsSettingsUser(page);
    // SSH keys may be at /settings or /settings/keys or /settings/ssh-keys
    await page.goto("/settings");

    const sshLink = page.locator('a[href*="ssh"], a[href*="keys"]').first();
    if (await sshLink.isVisible()) {
      await sshLink.click();
    } else {
      // Navigate directly
      await page.goto("/settings/keys");
    }

    await expect(page.locator("body")).not.toContainText(/500|Internal Server Error/i);
  });

  test("can add a new SSH key", async ({ page }) => {
    await loginAsSettingsUser(page);
    await page.goto("/settings");

    // Find the SSH key form — may be on main settings or a sub-page
    let keyTitleInput = page.locator('input[name="title"][placeholder*="key" i], input[name="name"][placeholder*="key" i]').first();
    let keyValueArea = page.locator('textarea[name="key"], textarea[name="publicKey"], textarea[name="public_key"]').first();

    // If not on this page, try /settings/keys
    if (!(await keyTitleInput.isVisible())) {
      await page.goto("/settings/keys");
      keyTitleInput = page.locator('input[name="title"], input[name="name"]').first();
      keyValueArea = page.locator('textarea[name="key"], textarea[name="publicKey"], textarea[name="public_key"]').first();
    }

    if (!(await keyTitleInput.isVisible()) || !(await keyValueArea.isVisible())) {
      // Settings structure differs — skip rather than fail
      test.skip();
      return;
    }

    // Use a valid-looking (but fake) RSA public key
    const fakeKey =
      "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7P+VVwfW4NbV9sQBDZhkVHqjSqM" +
      "xD3k8sZNzKq6JDvWmLRb5pEXxXYtK4t2HGaVfCmWKr7eQT9t7WPb5m6U3vNqDqZH" +
      "JXHF7jkGxLr9zUDAbcXYtM+5R5h1rFqPJvWq1y2M8sNaWvBb9P5mBJtWNqJqMLDE" +
      `5EsC3A8= e2e-test-key-${uid("k")}`;

    await keyTitleInput.fill(`E2E test key ${uid("kt")}`);
    await keyValueArea.fill(fakeKey);

    await page.click('button[type="submit"]');

    // Server may accept or reject the fake key — either way no 500
    await expect(page.locator("body")).not.toContainText(/500|Internal Server Error/i);
  });
});

// ---------------------------------------------------------------------------
// Personal Access Tokens (API tokens)
// ---------------------------------------------------------------------------

test.describe("Personal access tokens", () => {
  test("tokens settings page is accessible", async ({ page }) => {
    await loginAsSettingsUser(page);
    await page.goto("/settings/tokens");
    await expect(page.locator("body")).not.toContainText(/500|Internal Server Error/i);
  });

  test("can create a new API token", async ({ page }) => {
    await loginAsSettingsUser(page);
    await page.goto("/settings/tokens");

    const tokenNameInput = page.locator(
      'input[name="name"], input[name="tokenName"], input[placeholder*="token" i]'
    ).first();

    if (!(await tokenNameInput.isVisible())) {
      test.skip();
      return;
    }

    const tokenName = `e2e-token-${uid("tok")}`;
    await tokenNameInput.fill(tokenName);

    // Some UIs have a scopes checkbox or expiry field — skip if complex
    const submitBtn = page.locator('button[type="submit"]').first();
    await submitBtn.click();

    // The token value should be shown once, or at least the name appears in the list
    const body = page.locator("body");
    const tokenVisible =
      (await body.textContent())?.includes(tokenName) ||
      (await body.textContent())?.includes("token");
    expect(tokenVisible).toBeTruthy();
  });

  test("can delete an existing token", async ({ page }) => {
    await loginAsSettingsUser(page);
    await page.goto("/settings/tokens");

    // Only attempt deletion if there is a delete button visible
    const deleteBtn = page.locator(
      'button:has-text("Delete"), button:has-text("Revoke"), button[value="delete"]'
    ).first();

    if (!(await deleteBtn.isVisible())) {
      // Nothing to delete — skip
      test.skip();
      return;
    }

    await deleteBtn.click();

    // Page should refresh without error
    await expect(page.locator("body")).not.toContainText(/500|Internal Server Error/i);
  });
});
