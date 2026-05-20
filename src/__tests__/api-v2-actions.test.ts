/**
 * API v2 — Actions / Workflows REST surface (addendum group 3).
 *
 * Covers the five GitHub-compatible endpoints added in `src/routes/api-v2.ts`:
 *
 *   POST /api/v2/repos/:owner/:repo/actions/workflows/:filename/dispatches
 *   GET  /api/v2/repos/:owner/:repo/actions/workflows/:filename/runs
 *   GET  /api/v2/repos/:owner/:repo/actions/runs/:run_id
 *   GET  /api/v2/repos/:owner/:repo/actions/runs/:run_id/logs
 *   POST /api/v2/repos/:owner/:repo/actions/runs/:run_id/cancel
 *
 * Auth/validation checks run without a database; the deeper end-to-end
 * flows (dispatch → list → cancel → logs zip) are DB-gated via the standard
 * HAS_DB pattern so the suite stays green on machines without Postgres.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import { randomBytes } from "crypto";
import app from "../app";
import { clearRateLimitStore } from "../middleware/rate-limit";
import { initBareRepo, getRepoPath } from "../git/repository";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const TEST_REPOS = join(
  import.meta.dir,
  "../../.test-repos-api-v2-actions-" + Date.now()
);

beforeAll(async () => {
  process.env.GIT_REPOS_PATH = TEST_REPOS;
  process.env.DATABASE_URL = process.env.DATABASE_URL || "";
  clearRateLimitStore();
  await rm(TEST_REPOS, { recursive: true, force: true });
  await mkdir(TEST_REPOS, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_REPOS, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiUrl(path: string): string {
  return `/api/v2${path}`;
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  await new Response(proc.stdout).text();
  await proc.exited;
}

async function seedBareRepoWithCommit(owner: string, name: string) {
  await initBareRepo(owner, name);
  const bare = getRepoPath(owner, name);
  const work = join(TEST_REPOS, "_work_" + randomBytes(4).toString("hex"));
  await mkdir(work, { recursive: true });
  await run(["git", "clone", bare, work], TEST_REPOS);
  await run(["git", "config", "user.email", "test@gluecron.com"], work);
  await run(["git", "config", "user.name", "Test User"], work);
  await run(["git", "checkout", "-B", "main"], work);
  await Bun.write(join(work, "README.md"), "# hi\n");
  await run(["git", "add", "-A"], work);
  await run(["git", "commit", "-m", "seed"], work);
  await run(["git", "push", "-u", "origin", "main"], work);
  await rm(work, { recursive: true, force: true });
}

// SHA-256 hex for the API-token loader. Matches src/middleware/api-auth.ts.
async function sha256Hex(s: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(s);
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// 1. Auth/validation — no DB required
// ---------------------------------------------------------------------------

describe("API v2 actions — auth + validation (no DB)", () => {
  it("POST /actions/workflows/:f/dispatches without auth returns 401", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/actions/workflows/ci.yml/dispatches"),
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ ref: "main" }),
      }
    );
    expect(res.status).toBe(401);
  });

  it("POST /actions/runs/:id/cancel without auth returns 401", async () => {
    const res = await app.request(
      apiUrl(
        "/repos/nobody/nothing/actions/runs/00000000-0000-0000-0000-000000000000/cancel"
      ),
      { method: "POST", headers: jsonHeaders() }
    );
    expect(res.status).toBe(401);
  });

  it("GET /actions/workflows/:f/runs on missing repo returns 404 or 500", async () => {
    const res = await app.request(
      apiUrl("/repos/nobody/nothing/actions/workflows/ci.yml/runs")
    );
    expect([404, 500]).toContain(res.status);
  });

  it("GET /actions/runs/:id on missing repo returns 404 or 500", async () => {
    const res = await app.request(
      apiUrl(
        "/repos/nobody/nothing/actions/runs/00000000-0000-0000-0000-000000000000"
      )
    );
    expect([404, 500]).toContain(res.status);
  });

  it("GET /actions/runs/:id/logs on missing repo returns 404 or 500", async () => {
    const res = await app.request(
      apiUrl(
        "/repos/nobody/nothing/actions/runs/00000000-0000-0000-0000-000000000000/logs"
      )
    );
    expect([404, 500]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end with a real DB + seeded bare repo
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("API v2 actions — DB-backed flows", () => {
  it("dispatch → list → get → cancel → logs.zip", async () => {
    const { db } = await import("../db");
    const {
      users,
      repositories,
      apiTokens,
      workflows,
      workflowRuns,
      workflowJobs,
    } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");

    const stamp = randomBytes(4).toString("hex");
    const username = `actuser-${stamp}`;
    const reponame = `actrepo-${stamp}`;

    // ── user + bare repo ──
    const [u] = await db
      .insert(users)
      .values({
        username,
        email: `${username}@test.local`,
        passwordHash: "x",
      })
      .returning();
    expect(u).toBeDefined();
    if (!u) return;

    await seedBareRepoWithCommit(username, reponame);

    const [r] = await db
      .insert(repositories)
      .values({
        name: reponame,
        ownerId: u.id,
        diskPath: getRepoPath(username, reponame),
        defaultBranch: "main",
      })
      .returning();
    expect(r).toBeDefined();
    if (!r) return;

    // ── workflow row (parsed.on includes workflow_dispatch as a string) ──
    const parsed = {
      name: "CI",
      on: ["push", "workflow_dispatch"],
      jobs: [{ name: "build", runsOn: "default", steps: [{ name: "x", run: "echo hi" }] }],
    };
    const [wf] = await db
      .insert(workflows)
      .values({
        repositoryId: r.id,
        name: "CI",
        path: ".gluecron/workflows/ci.yml",
        yaml: "name: CI\non: [push, workflow_dispatch]\njobs:\n  build:\n    steps:\n      - run: echo hi\n",
        parsed: JSON.stringify(parsed),
        onEvents: JSON.stringify(parsed.on),
      })
      .returning();
    expect(wf).toBeDefined();
    if (!wf) return;

    // ── PAT with `repo` scope ──
    const tokenPlain = "glc_" + randomBytes(32).toString("hex");
    const tokenHash = await sha256Hex(tokenPlain);
    await db.insert(apiTokens).values({
      userId: u.id,
      name: `test-${stamp}`,
      tokenHash,
      tokenPrefix: tokenPlain.slice(0, 12),
      scopes: "repo",
    });
    const bearer = { Authorization: `Bearer ${tokenPlain}` };

    // ── 1. dispatch the workflow ──
    const disp = await app.request(
      apiUrl(
        `/repos/${username}/${reponame}/actions/workflows/ci.yml/dispatches`
      ),
      {
        method: "POST",
        headers: jsonHeaders(bearer),
        body: JSON.stringify({ ref: "main" }),
      }
    );
    expect(disp.status).toBe(204);

    // The run should now exist; pull it back via the list endpoint.
    const list = await app.request(
      apiUrl(
        `/repos/${username}/${reponame}/actions/workflows/ci.yml/runs`
      ),
      { headers: bearer }
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as any;
    expect(listBody.total_count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(listBody.workflow_runs)).toBe(true);
    const runEntry = listBody.workflow_runs[0];
    expect(runEntry.id).toBeDefined();
    expect(runEntry.head_branch).toBe("main");
    expect(runEntry.event).toBe("workflow_dispatch");
    expect(runEntry.html_url).toContain(
      `/${username}/${reponame}/actions/runs/${runEntry.id}`
    );

    // ── 2. fetch the run by id ──
    const single = await app.request(
      apiUrl(`/repos/${username}/${reponame}/actions/runs/${runEntry.id}`),
      { headers: bearer }
    );
    expect(single.status).toBe(200);
    const singleBody = (await single.json()) as any;
    expect(singleBody.id).toBe(runEntry.id);
    expect(singleBody.name).toBe("CI");

    // Cross-repo isolation: a different (seeded) repo should not see this run.
    const otherRepoName = `other-${stamp}`;
    await seedBareRepoWithCommit(username, otherRepoName);
    const [r2] = await db
      .insert(repositories)
      .values({
        name: otherRepoName,
        ownerId: u.id,
        diskPath: getRepoPath(username, otherRepoName),
        defaultBranch: "main",
      })
      .returning();
    expect(r2).toBeDefined();
    const cross = await app.request(
      apiUrl(`/repos/${username}/${otherRepoName}/actions/runs/${runEntry.id}`),
      { headers: bearer }
    );
    expect(cross.status).toBe(404);

    // ── 3. attach a job with logs, then download the zip ──
    await db.insert(workflowJobs).values({
      runId: runEntry.id,
      name: "build",
      jobOrder: 0,
      runsOn: "default",
      status: "success",
      conclusion: "success",
      steps: JSON.stringify([{ name: "x", exitCode: 0 }]),
      logs: "hello from build job\n",
    });
    const logs = await app.request(
      apiUrl(
        `/repos/${username}/${reponame}/actions/runs/${runEntry.id}/logs`
      ),
      { headers: bearer }
    );
    expect(logs.status).toBe(200);
    expect(logs.headers.get("content-type")).toContain("application/zip");
    const bytes = new Uint8Array(await logs.arrayBuffer());
    // PKZIP local file header magic — `PK\x03\x04`.
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);

    // ── 4. cancel a queued run ──
    const cancel = await app.request(
      apiUrl(
        `/repos/${username}/${reponame}/actions/runs/${runEntry.id}/cancel`
      ),
      { method: "POST", headers: jsonHeaders(bearer) }
    );
    expect(cancel.status).toBe(202);

    const [after] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runEntry.id))
      .limit(1);
    expect(after?.status).toBe("cancelled");
    expect(after?.conclusion).toBe("cancelled");
    expect(after?.finishedAt).not.toBeNull();

    // Re-cancelling a terminal run is a 409 Conflict.
    const reCancel = await app.request(
      apiUrl(
        `/repos/${username}/${reponame}/actions/runs/${runEntry.id}/cancel`
      ),
      { method: "POST", headers: jsonHeaders(bearer) }
    );
    expect(reCancel.status).toBe(409);
  });

  it("dispatch on a workflow without workflow_dispatch returns 422", async () => {
    const { db } = await import("../db");
    const { users, repositories, apiTokens, workflows } = await import(
      "../db/schema"
    );

    const stamp = randomBytes(4).toString("hex");
    const username = `actuser-422-${stamp}`;
    const reponame = `actrepo-422-${stamp}`;

    const [u] = await db
      .insert(users)
      .values({
        username,
        email: `${username}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;
    await seedBareRepoWithCommit(username, reponame);
    const [r] = await db
      .insert(repositories)
      .values({
        name: reponame,
        ownerId: u.id,
        diskPath: getRepoPath(username, reponame),
        defaultBranch: "main",
      })
      .returning();
    if (!r) return;

    // Only `push` — no workflow_dispatch.
    const parsed = {
      name: "push-only",
      on: ["push"],
      jobs: [{ name: "build", runsOn: "default", steps: [{ name: "x", run: "echo hi" }] }],
    };
    await db.insert(workflows).values({
      repositoryId: r.id,
      name: "push-only",
      path: ".gluecron/workflows/push.yml",
      yaml: "name: push-only\non: push\njobs:\n  build:\n    steps:\n      - run: echo hi\n",
      parsed: JSON.stringify(parsed),
      onEvents: JSON.stringify(parsed.on),
    });

    const tokenPlain = "glc_" + randomBytes(32).toString("hex");
    const tokenHash = await sha256Hex(tokenPlain);
    await db.insert(apiTokens).values({
      userId: u.id,
      name: `test-${stamp}`,
      tokenHash,
      tokenPrefix: tokenPlain.slice(0, 12),
      scopes: "repo",
    });

    const res = await app.request(
      apiUrl(
        `/repos/${username}/${reponame}/actions/workflows/push.yml/dispatches`
      ),
      {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${tokenPlain}` }),
        body: JSON.stringify({ ref: "main" }),
      }
    );
    expect(res.status).toBe(422);
  });

  it("dispatch with a missing required input returns 422 with details", async () => {
    const { db } = await import("../db");
    const { users, repositories, apiTokens, workflows } = await import(
      "../db/schema"
    );

    const stamp = randomBytes(4).toString("hex");
    const username = `actuser-inp-${stamp}`;
    const reponame = `actrepo-inp-${stamp}`;

    const [u] = await db
      .insert(users)
      .values({
        username,
        email: `${username}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;
    await seedBareRepoWithCommit(username, reponame);
    const [r] = await db
      .insert(repositories)
      .values({
        name: reponame,
        ownerId: u.id,
        diskPath: getRepoPath(username, reponame),
        defaultBranch: "main",
      })
      .returning();
    if (!r) return;

    // Mapping-shaped `on` with workflow_dispatch.inputs — the only place an
    // inputs schema can live.
    const parsed = {
      name: "needs-input",
      on: {
        workflow_dispatch: {
          inputs: {
            target: { type: "string", required: true, description: "required" },
            level: { type: "string", required: false, default: "info" },
          },
        },
      },
      jobs: [{ name: "build", runsOn: "default", steps: [{ name: "x", run: "echo" }] }],
    };
    await db.insert(workflows).values({
      repositoryId: r.id,
      name: "needs-input",
      path: ".gluecron/workflows/dispatch.yml",
      yaml: "name: needs-input\non:\n  workflow_dispatch:\n    inputs:\n      target:\n        required: true\njobs:\n  build:\n    steps:\n      - run: echo\n",
      parsed: JSON.stringify(parsed),
      onEvents: JSON.stringify(["workflow_dispatch"]),
    });

    const tokenPlain = "glc_" + randomBytes(32).toString("hex");
    const tokenHash = await sha256Hex(tokenPlain);
    await db.insert(apiTokens).values({
      userId: u.id,
      name: `test-${stamp}`,
      tokenHash,
      tokenPrefix: tokenPlain.slice(0, 12),
      scopes: "repo",
    });

    const bad = await app.request(
      apiUrl(
        `/repos/${username}/${reponame}/actions/workflows/dispatch.yml/dispatches`
      ),
      {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${tokenPlain}` }),
        body: JSON.stringify({ ref: "main", inputs: {} }),
      }
    );
    expect(bad.status).toBe(422);
    const badBody = (await bad.json()) as any;
    expect(Array.isArray(badBody.details)).toBe(true);
    expect(badBody.details.join("\n")).toMatch(/target/);

    // Supplying the required input clears the gate (the run enqueue itself
    // is what we're verifying, not the worker — so 204 is the contract).
    const good = await app.request(
      apiUrl(
        `/repos/${username}/${reponame}/actions/workflows/dispatch.yml/dispatches`
      ),
      {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${tokenPlain}` }),
        body: JSON.stringify({ ref: "main", inputs: { target: "prod" } }),
      }
    );
    expect(good.status).toBe(204);
  });
});
