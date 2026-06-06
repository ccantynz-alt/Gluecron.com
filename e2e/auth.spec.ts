/**
 * E2E — Auth flows
 *
 * Covers: registration, login, logout, wrong password.
 * Each test creates its own isolated user to avoid cross-test state.
 */

import { test, expect } from "@playwright/test";
import { uid, TEST_PASSWORD } from "./fixtures";

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

test.describe("Registration", () => {
  test("happy path — new user registers and lands on dashboard", async ({ page }) => {
    const username = uid("reg");
    const email = `${username}@test.example`;

    await page.goto("/register");
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    // Expect redirect away from /register
    await expect(page).not.toHaveURL(/\/register/);

    // Should surface the username somewhere on the page (nav, dashboard, etc.)
    await expect(page.locator("body")).toContainText(username, { timeout: 8_000 });
  });

  test("duplicate username — shows error message", async ({ page }) => {
    const username = uid("dup");
    const email = `${username}@test.example`;

    // Register once
    await page.goto("/register");
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(dashboard|[a-z])/);

    // Navigate away, then try registering again with same username
    await page.goto("/register");
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="email"]', `other-${email}`);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    // Should stay on /register (or show an error URL) with an error message
    const body = page.locator("body");
    await expect(body).toContainText(/already|taken|exists/i, { timeout: 5_000 });
  });

  test("missing fields — stays on register page", async ({ page }) => {
    await page.goto("/register");
    // Submit with no data — browser or server should block/redirect back
    await page.click('button[type="submit"]');

    // We either stay on /register or get an error param
    const url = page.url();
    const onRegisterOrError =
      url.includes("/register") ||
      url.includes("error") ||
      (await page.locator(".auth-error, [role=alert]").count()) > 0;
    expect(onRegisterOrError).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test.describe("Login", () => {
  test("happy path — existing user logs in", async ({ page }) => {
    const username = uid("login");
    const email = `${username}@test.example`;

    // Pre-register
    await page.goto("/register");
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(dashboard|[a-z])/);

    // Logout then log back in
    await page.goto("/logout");
    await page.waitForURL(/\/(login|register|)/);

    await page.goto("/login");
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator("body")).toContainText(username, { timeout: 8_000 });
  });

  test("wrong password — shows error, stays on login page", async ({ page }) => {
    const username = uid("badpw");
    const email = `${username}@test.example`;

    // Pre-register
    await page.goto("/register");
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(dashboard|[a-z])/);

    // Logout
    await page.goto("/logout");

    // Try wrong password
    await page.goto("/login");
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', "WrongPassword999!");
    await page.click('button[type="submit"]');

    // Should stay on login or get an error
    const body = page.locator("body");
    await expect(body).toContainText(/invalid|incorrect|wrong|failed/i, {
      timeout: 5_000,
    });
  });

  test("unknown username — shows error", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[name="username"]', "totally_nonexistent_xyz_abc");
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    const body = page.locator("body");
    await expect(body).toContainText(/invalid|not found|incorrect/i, {
      timeout: 5_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

test.describe("Logout", () => {
  test("logged-in user can log out and is redirected", async ({ page }) => {
    const username = uid("lgout");
    const email = `${username}@test.example`;

    await page.goto("/register");
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(dashboard|[a-z])/);

    // Logout
    await page.goto("/logout");
    await page.waitForURL(/\/(login|register|)/);

    // Accessing a protected route should redirect to login
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login/);
  });
});
