/**
 * Demo seed — idempotently creates a `demo` user plus three public demo repos
 * (`hello-python`, `todo-api`, `design-docs`) each with an initial commit,
 * one open issue, and (for `todo-api`) a closed pull request.
 *
 * Requirements:
 *   - Never throws. Every DB insert + subprocess call is wrapped in try/catch
 *     and errors are pushed into the `errors` array on the result.
 *   - Idempotent. A second call returns `created.user = false`, `repos = []`.
 *   - Fast-path: when the demo user already exists and all three repos are
 *     already recorded in the DB, returns immediately without side effects
 *     (unless `opts.force === true`).
 *   - Imports (never modifies) locked helpers: `hashPassword`, `initBareRepo`,
 *     `bootstrapRepository`.
 *
 * Content builders (`buildHelloPythonFiles`, `buildTodoApiFiles`,
 * `buildDesignDocsFiles`) are pure — they return file-path → file-contents
 * records and are unit-tested directly. They're re-exported via `__test`
 * for convenience.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  repositories,
  issues,
  pullRequests,
} from "../db/schema";
import { hashPassword } from "./auth";
import { initBareRepo, getRepoPath } from "../git/repository";
import { bootstrapRepository } from "./repo-bootstrap";

export const DEMO_USERNAME = "demo" as const;
const DEMO_EMAIL = "demo@gluecron.local";
const DEMO_DISPLAY_NAME = "Demo Account";
const DEMO_AUTHOR_NAME = "Demo";
const DEMO_AUTHOR_EMAIL = "demo@gluecron.local";

export interface DemoSeedResult {
  demoUser: { id: string; username: string } | null;
  repos: Array<{ name: string; url: string }>;
  created: {
    user: boolean;
    repos: string[];
    issues: number;
    prs: number;
  };
  errors: string[];
}

/* ------------------------------------------------------------------------ */
/* Content builders (pure)                                                   */
/* ------------------------------------------------------------------------ */

export function buildHelloPythonFiles(): Record<string, string> {
  return {
    "README.md": `# hello-python

A tiny demo Python app, seeded by GlueCron to showcase the UI.

## Run

\`\`\`bash
pip install -r requirements.txt
python main.py
\`\`\`

This repo belongs to the \`demo\` account. Feel free to browse — it's
regenerated on demand from the demo seeder.
`,
    "main.py": `"""hello-python — demo entrypoint."""


def greet(name: str) -> str:
    return f"Hello, {name}!"


def main() -> None:
    print(greet("GlueCron"))


if __name__ == "__main__":
    main()
`,
    "requirements.txt": `# No third-party deps yet — kept intentionally minimal.
# Add packages below as "name==version" once needed.
`,
  };
}

export function buildTodoApiFiles(): Record<string, string> {
  const pkg = {
    name: "todo-api",
    version: "0.1.0",
    private: true,
    description: "Demo todo API — GlueCron seeded sample",
    main: "src/index.ts",
    scripts: {
      dev: "bun run src/index.ts",
      start: "bun run src/index.ts",
    },
    dependencies: {
      hono: "^4.6.0",
    },
    devDependencies: {
      typescript: "^5.4.0",
    },
  };

  return {
    "README.md": `# todo-api

A minimal Hono-based todo API, seeded by GlueCron as a demo.

## Endpoints

- \`GET /todos\` — list todos
- \`POST /todos\` — create todo
- \`GET /health\` — health probe

## Run

\`\`\`bash
bun install
bun run dev
\`\`\`
`,
    "package.json": JSON.stringify(pkg, null, 2) + "\n",
    "src/index.ts": `import { Hono } from "hono";

type Todo = { id: number; title: string; done: boolean };

const app = new Hono();
const todos: Todo[] = [
  { id: 1, title: "Try GlueCron", done: false },
  { id: 2, title: "Push a commit", done: false },
];

app.get("/health", (c) => c.json({ ok: true }));
app.get("/todos", (c) => c.json(todos));

app.post("/todos", async (c) => {
  const body = await c.req.json<{ title?: string }>();
  if (!body?.title) return c.json({ error: "title required" }, 400);
  const todo: Todo = { id: todos.length + 1, title: body.title, done: false };
  todos.push(todo);
  return c.json(todo, 201);
});

export default app;
`,
  };
}

export function buildDesignDocsFiles(): Record<string, string> {
  return {
    "README.md": `# design-docs

Architecture notes and ADRs for the \`demo\` org's sample project.

Browse:

- [Architecture overview](docs/architecture.md)
- [ADR-001 — Choose Hono for the HTTP layer](docs/adr-001.md)
`,
    "docs/architecture.md": `# Architecture overview

## Goals

- Keep the surface small.
- Prefer boring, well-understood primitives.
- Fast cold-start on Bun.

## Components

- **HTTP layer:** Hono.
- **Data:** PostgreSQL via Drizzle.
- **Jobs:** in-process, cron-driven.

## Non-goals

- Multi-tenant isolation at the data layer.
- Horizontal scale-out (v1 is single-node).
`,
    "docs/adr-001.md": `# ADR-001 — Choose Hono for the HTTP layer

- **Status:** accepted
- **Date:** 2026-01-15

## Context

We need an HTTP framework that runs on Bun natively, has JSX server-side
rendering, and minimal dependencies.

## Decision

Adopt Hono as the HTTP layer.

## Consequences

- Tiny runtime footprint.
- Ecosystem is smaller than Express; we'll write middleware ourselves
  where nothing exists.

## Rollout

Migrate the existing Express routes to Hono over two sprints. Keep the
legacy handler importable until all routes are ported.
`,
  };
}

/* ------------------------------------------------------------------------ */
/* Git plumbing — write an initial commit from a file map                    */
/* ------------------------------------------------------------------------ */

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function spawnSafe(
  cmd: string[],
  cwd: string,
  stdin?: string | Uint8Array,
  env?: Record<string, string>
): Promise<SpawnResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? "pipe" : undefined,
      env: { ...process.env, ...(env || {}) },
    });
    if (stdin !== undefined && proc.stdin) {
      const bytes =
        typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin;
      (proc.stdin as any).write(bytes);
      (proc.stdin as any).end();
    }
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), stderr, exitCode };
  } catch (err: any) {
    return { stdout: "", stderr: String(err?.message || err), exitCode: -1 };
  }
}

/**
 * Write an initial commit to the bare repo at `repoDir` on branch `main`
 * containing the given file map. Uses git plumbing (hash-object + update-index
 * via a transient index + write-tree + commit-tree + update-ref). Mirrors the
 * pattern in `dep-updater.ts` / `createOrUpdateFileOnBranch`. Returns the
 * new commit sha on success.
 */
async function writeInitialCommit(
  repoDir: string,
  files: Record<string, string>,
  message: string,
  authorName: string,
  authorEmail: string
): Promise<{ commitSha: string } | { error: string }> {
  const tmpIndex = `${repoDir}/index.demo-seed.${process.pid}.${Date.now()}.${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const baseEnv = {
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };

  const cleanup = async () => {
    try {
      const { unlink } = await import("fs/promises");
      await unlink(tmpIndex);
    } catch {
      /* ignore */
    }
  };

  try {
    // 1. Hash each file → blob sha, then stage via update-index --cacheinfo.
    for (const [path, contents] of Object.entries(files)) {
      const hashed = await spawnSafe(
        ["git", "hash-object", "-w", "--stdin"],
        repoDir,
        contents
      );
      if (hashed.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(hashed.stdout)) {
        await cleanup();
        return { error: `hash-object failed for ${path}: ${hashed.stderr}` };
      }
      const blobSha = hashed.stdout;

      const upd = await spawnSafe(
        [
          "git",
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${blobSha},${path}`,
        ],
        repoDir,
        undefined,
        baseEnv
      );
      if (upd.exitCode !== 0) {
        await cleanup();
        return { error: `update-index failed for ${path}: ${upd.stderr}` };
      }
    }

    // 2. write-tree → tree sha.
    const wt = await spawnSafe(
      ["git", "write-tree"],
      repoDir,
      undefined,
      baseEnv
    );
    if (wt.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(wt.stdout)) {
      await cleanup();
      return { error: `write-tree failed: ${wt.stderr}` };
    }
    const treeSha = wt.stdout;

    // 3. commit-tree (no parent — initial commit).
    const commit = await spawnSafe(
      ["git", "commit-tree", treeSha, "-m", message],
      repoDir,
      undefined,
      baseEnv
    );
    if (commit.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit.stdout)) {
      await cleanup();
      return { error: `commit-tree failed: ${commit.stderr}` };
    }
    const commitSha = commit.stdout;

    // 4. update-ref refs/heads/main.
    const upd = await spawnSafe(
      ["git", "update-ref", "refs/heads/main", commitSha],
      repoDir
    );
    if (upd.exitCode !== 0) {
      await cleanup();
      return { error: `update-ref failed: ${upd.stderr}` };
    }

    await cleanup();
    return { commitSha };
  } catch (err: any) {
    await cleanup();
    return { error: String(err?.message || err) };
  }
}

/* ------------------------------------------------------------------------ */
/* Seed orchestration                                                        */
/* ------------------------------------------------------------------------ */

interface DemoRepoSpec {
  name: string;
  description: string;
  files: Record<string, string>;
  issueTitle: string;
  issueBody?: string;
  seedClosedPr?: { title: string; body?: string };
}

function demoRepoSpecs(): DemoRepoSpec[] {
  return [
    {
      name: "hello-python",
      description: "Tiny Python demo app seeded by GlueCron.",
      files: buildHelloPythonFiles(),
      issueTitle: "Add rate limiting",
      issueBody:
        "The `/greet` endpoint has no rate limiting. We should add a simple token-bucket.",
    },
    {
      name: "todo-api",
      description: "Minimal Hono todo API, seeded as a demo.",
      files: buildTodoApiFiles(),
      issueTitle: "Dark mode broken on mobile",
      issueBody:
        "On iOS Safari, the dark-mode toggle flickers to light for ~200ms on first paint.",
      seedClosedPr: {
        title: "feat: add /health endpoint",
        body: "Adds a trivial liveness probe at `GET /health` returning `{ ok: true }`.",
      },
    },
    {
      name: "design-docs",
      description: "Architecture notes + ADRs for the demo project.",
      files: buildDesignDocsFiles(),
      issueTitle: "Clarify ADR-001 rollout section",
      issueBody:
        "The rollout section of ADR-001 mentions 'two sprints' — we should pin a concrete date range.",
    },
  ];
}

async function findDemoUser(): Promise<{ id: string; username: string } | null> {
  try {
    const [row] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.username, DEMO_USERNAME))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

async function findDemoRepo(
  ownerId: string,
  name: string
): Promise<{ id: string } | null> {
  try {
    const [row] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(eq(repositories.ownerId, ownerId), eq(repositories.name, name))
      )
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Idempotently create the demo user + three demo repos. Never throws.
 */
export async function ensureDemoContent(opts?: {
  force?: boolean;
}): Promise<DemoSeedResult> {
  const force = !!opts?.force;
  const result: DemoSeedResult = {
    demoUser: null,
    repos: [],
    created: { user: false, repos: [], issues: 0, prs: 0 },
    errors: [],
  };

  const specs = demoRepoSpecs();

  // 1. Fast-path — demo user + all three repos already exist and !force.
  if (!force) {
    const existing = await findDemoUser();
    if (existing) {
      let allPresent = true;
      for (const spec of specs) {
        const repo = await findDemoRepo(existing.id, spec.name);
        if (!repo) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) {
        result.demoUser = existing;
        result.repos = specs.map((s) => ({
          name: s.name,
          url: `/${DEMO_USERNAME}/${s.name}`,
        }));
        return result;
      }
    }
  }

  // 2. Resolve or create the demo user.
  let demoUser = await findDemoUser();
  if (!demoUser) {
    try {
      // Random password → login effectively disabled.
      const randBytes = crypto.getRandomValues(new Uint8Array(32));
      const randomPassword = Array.from(randBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const passwordHash = await hashPassword(randomPassword);
      const [inserted] = await db
        .insert(users)
        .values({
          username: DEMO_USERNAME,
          email: DEMO_EMAIL,
          displayName: DEMO_DISPLAY_NAME,
          passwordHash,
        })
        .returning({ id: users.id, username: users.username });
      if (inserted) {
        demoUser = inserted;
        result.created.user = true;
      }
    } catch (err: any) {
      result.errors.push(
        `create demo user: ${String(err?.message || err)}`
      );
    }
  }

  if (!demoUser) {
    // Can't proceed without a user row.
    return result;
  }
  result.demoUser = demoUser;

  // 3. For each spec: ensure bare repo + initial commit + DB row + bootstrap
  //    + one open issue (+ closed PR on todo-api).
  for (const spec of specs) {
    result.repos.push({
      name: spec.name,
      url: `/${DEMO_USERNAME}/${spec.name}`,
    });

    const existingRepo = await findDemoRepo(demoUser.id, spec.name);
    if (existingRepo && !force) {
      continue;
    }

    // Create bare repo on disk (ok if already present — initBareRepo is
    // git init --bare which is idempotent).
    let diskPath: string;
    try {
      diskPath = await initBareRepo(DEMO_USERNAME, spec.name);
    } catch (err: any) {
      result.errors.push(
        `initBareRepo(${spec.name}): ${String(err?.message || err)}`
      );
      continue;
    }

    // Write initial commit only if HEAD doesn't already resolve.
    const repoDir = getRepoPath(DEMO_USERNAME, spec.name);
    const headCheck = await spawnSafe(
      ["git", "rev-parse", "--verify", "refs/heads/main"],
      repoDir
    );
    if (headCheck.exitCode !== 0) {
      const wrote = await writeInitialCommit(
        repoDir,
        spec.files,
        "Initial commit",
        DEMO_AUTHOR_NAME,
        DEMO_AUTHOR_EMAIL
      );
      if ("error" in wrote) {
        result.errors.push(
          `writeInitialCommit(${spec.name}): ${wrote.error}`
        );
        // Continue — we still want the DB row so the UI can show it.
      }
    }

    // Insert DB row (skip if it already exists — e.g. partial prior run).
    let repoId: string | null = existingRepo?.id ?? null;
    if (!repoId) {
      try {
        const [inserted] = await db
          .insert(repositories)
          .values({
            name: spec.name,
            ownerId: demoUser.id,
            description: spec.description,
            isPrivate: false,
            defaultBranch: "main",
            diskPath,
          })
          .returning({ id: repositories.id });
        if (inserted) {
          repoId = inserted.id;
          result.created.repos.push(spec.name);
        }
      } catch (err: any) {
        result.errors.push(
          `insert repo(${spec.name}): ${String(err?.message || err)}`
        );
      }
    }

    if (!repoId) continue;

    // Green-ecosystem bootstrap (labels, settings, branch protection, welcome
    // issue). Wrapped — bootstrap internally tolerates duplicates but we
    // don't want any surprise throw to poison the seeder.
    try {
      await bootstrapRepository({
        repositoryId: repoId,
        ownerUserId: demoUser.id,
      });
    } catch (err: any) {
      result.errors.push(
        `bootstrapRepository(${spec.name}): ${String(err?.message || err)}`
      );
    }

    // One open issue per repo.
    try {
      await db.insert(issues).values({
        repositoryId: repoId,
        authorId: demoUser.id,
        title: spec.issueTitle,
        body: spec.issueBody ?? null,
        state: "open",
      });
      result.created.issues += 1;
    } catch (err: any) {
      result.errors.push(
        `insert issue(${spec.name}): ${String(err?.message || err)}`
      );
    }

    // Closed PR on todo-api.
    if (spec.seedClosedPr) {
      try {
        await db.insert(pullRequests).values({
          repositoryId: repoId,
          authorId: demoUser.id,
          title: spec.seedClosedPr.title,
          body: spec.seedClosedPr.body ?? null,
          state: "closed",
          baseBranch: "main",
          headBranch: "demo/health-endpoint",
          closedAt: new Date(),
        });
        result.created.prs += 1;
      } catch (err: any) {
        result.errors.push(
          `insert PR(${spec.name}): ${String(err?.message || err)}`
        );
      }
    }
  }

  return result;
}

/* ------------------------------------------------------------------------ */
/* Test-only exports                                                         */
/* ------------------------------------------------------------------------ */

export const __test = {
  buildHelloPythonFiles,
  buildTodoApiFiles,
  buildDesignDocsFiles,
  demoRepoSpecs,
};
