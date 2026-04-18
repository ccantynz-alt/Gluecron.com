import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import app from "../app";

const TEST_REPOS = join(import.meta.dir, "../../.test-repos-api");

beforeAll(async () => {
  process.env.GIT_REPOS_PATH = TEST_REPOS;
  process.env.DATABASE_URL = process.env.DATABASE_URL || "";
  await mkdir(TEST_REPOS, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

describe("API routes", () => {
  it("GET / returns home page", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("gluecron");
  });

  it("GET /api/repos/:owner/:name returns 404 or 503, never 500", async () => {
    const res = await app.request("/api/repos/nobody/nothing");
    // Without DB: 503 (db unreachable). With DB + missing repo: 404.
    // API must degrade gracefully — 500 is NOT acceptable.
    expect([404, 503]).toContain(res.status);
  });

  it("POST /api/repos returns 400 without required fields, never 500", async () => {
    const res = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // Validation happens before DB access — always 400.
    expect(res.status).toBe(400);
  });

  it("GET /api/users/:u/repos returns 404 or 503, never 500", async () => {
    const res = await app.request("/api/users/nobody/repos");
    expect([404, 503]).toContain(res.status);
  });
});

describe("Git HTTP routes", () => {
  it("returns 400 for invalid service", async () => {
    const res = await app.request("/test/repo.git/info/refs?service=invalid");
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent repo", async () => {
    const res = await app.request(
      "/nobody/nothing.git/info/refs?service=git-upload-pack"
    );
    expect(res.status).toBe(404);
  });
});
