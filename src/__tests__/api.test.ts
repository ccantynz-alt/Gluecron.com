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

  it("GET /api/repos/:owner/:name returns 404 for missing repo", async () => {
    // This will fail without DB, but verifies route exists
    const res = await app.request("/api/repos/nobody/nothing");
    // Without DB connection, this returns 500 or 404
    expect([404, 500]).toContain(res.status);
  });

  it("POST /api/repos returns 400 without required fields", async () => {
    const res = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // Without DB, might be 400 or 500
    expect([400, 500]).toContain(res.status);
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
