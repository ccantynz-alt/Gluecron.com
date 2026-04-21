/**
 * Smoke test for the public /help quickstart page. Doesn't stub the DB —
 * the route itself doesn't touch the DB, and softAuth tolerates a missing
 * session cookie, so this works in the sandbox.
 */

import { test, expect } from "bun:test";
import app from "../app";

test("/help returns 200 with HTML body containing Getting started", async () => {
  const res = await app.request("/help");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<html");
  expect(body).toContain("Getting started");
});
