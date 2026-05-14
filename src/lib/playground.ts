/**
 * Block Q3 — Anonymous playground accounts.
 *
 * A visitor hits POST /play and we mint them a temporary account in one
 * round trip: a synthetic email (never delivered), a securely-random
 * password (no one knows), a 24h session, and a public sandbox repo
 * seeded with a starter README + hello file + a couple of issues so
 * Claude has something to do while the visitor is poking around.
 *
 * 24h later the autopilot `playground-purge` task hard-deletes the user
 * row, which CASCADEs through sessions, repos, issues, etc. No data
 * survives.
 *
 * Contract:
 *   - Every exported function NEVER throws. Side-effect failures degrade
 *     to "best-effort" + audit log; the caller always gets a result.
 *   - `createPlaygroundAccount` is the only path that mints a user; it
 *     calls `bootstrapRepository` (gates, branch protection, labels) on
 *     the sandbox so the playground feels identical to a real account.
 *   - `claimPlaygroundAccount` converts a playground user into a real
 *     one: clears the playground flags, sets a real bcrypted password,
 *     swaps in the real email (and resets `emailVerifiedAt=null` so the
 *     verify-email banner appears), kicks off P2's verification email.
 *   - `purgeExpiredPlaygroundAccounts` is the autopilot sweep, capped at
 *     50 users per tick, per-user try/catch'd.
 *
 * Tests in src/__tests__/playground.test.ts.
 */

import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  sessions,
  repositories,
  issues,
  labels as labelsTable,
  issueLabels,
} from "../db/schema";
import {
  hashPassword,
  generateSessionToken,
} from "./auth";
import { initBareRepo, getRepoPath } from "../git/repository";
import { bootstrapRepository } from "./repo-bootstrap";
import { audit } from "./notify";
import { startEmailVerification } from "./email-verification";
import { absoluteUrl } from "./email";

/** Playground accounts live for exactly this long. */
export const PLAYGROUND_TTL_MS = 24 * 60 * 60 * 1000;
/** Default per-tick cap for `purgeExpiredPlaygroundAccounts`. */
export const PLAYGROUND_PURGE_CAP = 50;
/** Max collision retries when generating `guest-<8-hex>` usernames. */
const USERNAME_RETRY_CAP = 5;
/** Public playground sandbox repo name. */
export const SANDBOX_REPO_NAME = "sandbox";
/** Synthetic email domain — never delivered to. */
export const PLAYGROUND_EMAIL_DOMAIN = "playground.gluecron.local";

export interface CreatePlaygroundOpts {
  now?: Date;
  requestIp?: string;
}

export interface CreatePlaygroundResult {
  user: { id: string; username: string; email: string };
  sessionToken: string;
  sampleRepoFullName: string;
}

export interface ClaimPlaygroundArgs {
  email: string;
  password: string;
  username?: string;
}

export interface ClaimPlaygroundResult {
  ok: boolean;
  reason?: string;
}

export interface PurgeResult {
  purged: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Pure check: is this user a playground account? Pulls only the
 * discriminator field so callers can pass any user-shaped object.
 */
export function isPlaygroundAccount(user: {
  isPlayground?: boolean | null;
}): boolean {
  return user?.isPlayground === true;
}

/** Generate a fresh `guest-<8 hex>` candidate username. */
function generateGuestUsername(): string {
  const hex = randomBytes(4).toString("hex"); // 8 chars
  return `guest-${hex}`;
}

/** Build the synthetic email for a playground username. */
function synthEmailFor(username: string): string {
  return `${username}@${PLAYGROUND_EMAIL_DOMAIN}`;
}

// ---------------------------------------------------------------------------
// Git plumbing — write an initial commit to a bare repo (mirror of
// demo-seed's writeInitialCommit). Inlined so the demo seeder stays
// untouched (it's adjacent-locked and we don't want to refactor it for
// a sibling caller).
// ---------------------------------------------------------------------------

async function spawnSafe(
  cmd: string[],
  cwd: string,
  stdin?: string,
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? "pipe" : undefined,
      env: { ...process.env, ...(env || {}) },
    });
    if (stdin !== undefined && proc.stdin) {
      const bytes = new TextEncoder().encode(stdin);
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

async function writePlaygroundInitialCommit(
  repoDir: string,
  files: Record<string, string>,
  authorName: string,
  authorEmail: string
): Promise<{ commitSha: string } | { error: string }> {
  const tmpIndex = `${repoDir}/index.playground.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
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
      const upd = await spawnSafe(
        [
          "git",
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${hashed.stdout},${path}`,
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
    const commit = await spawnSafe(
      ["git", "commit-tree", wt.stdout, "-m", "Initial sandbox commit"],
      repoDir,
      undefined,
      baseEnv
    );
    if (commit.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit.stdout)) {
      await cleanup();
      return { error: `commit-tree failed: ${commit.stderr}` };
    }
    const upr = await spawnSafe(
      ["git", "update-ref", "refs/heads/main", commit.stdout],
      repoDir
    );
    if (upr.exitCode !== 0) {
      await cleanup();
      return { error: `update-ref failed: ${upr.stderr}` };
    }
    await cleanup();
    return { commitSha: commit.stdout };
  } catch (err: any) {
    await cleanup();
    return { error: String(err?.message || err) };
  }
}

// ---------------------------------------------------------------------------
// Starter sandbox contents
// ---------------------------------------------------------------------------

function buildSandboxFiles(username: string): Record<string, string> {
  return {
    "README.md": `# ${username}/sandbox

Welcome to your **24-hour Gluecron playground**.

This sandbox is a real, public git repo on a real Gluecron account.
Push to it, open issues, label one \`ai:build\` and watch Claude open a
PR. Everything you can do in a paid account, you can do here — for the
next 24 hours.

## Get started

\`\`\`bash
git clone https://gluecron.com/${username}/sandbox.git
cd sandbox
echo "// my first commit" >> src/hello.ts
git commit -am "hello"
git push origin main
\`\`\`

## Keep your work

Click **Save your work** in the yellow banner above (or visit
\`/play/claim\`) to convert this account into a permanent one. Otherwise
this repo, your issues, and everything else here disappears at the end
of the day.

— gluecron
`,
    "src/hello.ts": `/**
 * hello.ts — Gluecron playground starter.
 *
 * Try editing this file in the web editor, or clone the repo and push
 * a change. Label an issue \`ai:build\` and Claude will open a PR.
 */

export function hello(name: string): string {
  return \`Hello, \${name}!\`;
}

if (import.meta.main) {
  console.log(hello("playground"));
}
`,
    ".gitignore": `node_modules/
dist/
*.log
.env
`,
  };
}

/** Sample issues used to demo the autopilot on the user's sandbox. */
function sampleIssues(): Array<{ title: string; body: string; aiBuild?: boolean }> {
  return [
    {
      title: "Add a /goodbye export to src/hello.ts",
      body:
        "Add a `goodbye(name: string): string` export alongside `hello`. " +
        "Label this issue `ai:build` and Claude will open a PR for it " +
        "automatically.",
      aiBuild: true,
    },
    {
      title: "Try the web editor",
      body:
        "Open `src/hello.ts` in the file browser, click **Edit**, change " +
        "the greeting, and commit straight from the browser. No clone " +
        "required.",
    },
  ];
}

// ---------------------------------------------------------------------------
// createPlaygroundAccount
// ---------------------------------------------------------------------------

/**
 * Mint a fresh playground account + 24h session + public sandbox repo.
 * Never throws.
 *
 * Side-effects, all wrapped in try/catch:
 *   1. Insert a `users` row with `is_playground=true`,
 *      `playground_expires_at = now + 24h`, `email_verified_at = now`
 *      (so the playground UI doesn't nag about verifying a fake email).
 *   2. Insert a `sessions` row with a 24h expiry — matches the TTL so
 *      the session won't outlive the account.
 *   3. Create a bare repo on disk (`<username>/sandbox`), seed an
 *      initial commit, insert a `repositories` row.
 *   4. Call `bootstrapRepository` for green-default labels + branch
 *      protection (same as /new).
 *   5. Open 2 sample issues, one of which gets the `ai:build` label so
 *      the autopilot picks it up.
 *
 * Anything failing past step 1 is logged + audited; the caller still
 * gets a session token. The user can recover by hitting /new to create
 * a fresh repo.
 */
export async function createPlaygroundAccount(
  opts: CreatePlaygroundOpts = {}
): Promise<CreatePlaygroundResult> {
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + PLAYGROUND_TTL_MS);

  // 1. Mint a unique username (with retry on collision).
  let username: string | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < USERNAME_RETRY_CAP; attempt++) {
    const candidate = generateGuestUsername();
    try {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, candidate))
        .limit(1);
      if (!existing) {
        username = candidate;
        break;
      }
    } catch (err) {
      lastErr = err;
      // If the DB select fails, try a different name — but stop after
      // the cap and surface the issue via the audit log.
    }
  }
  if (!username) {
    console.error("[playground] could not allocate guest username:", lastErr);
    // Fallback — wildly unlikely collision after 5 tries. Use the
    // attempt-time random tail anyway; the unique constraint will reject
    // on insert if we collide.
    username = `guest-${randomBytes(6).toString("hex")}`;
  }

  // 2. Insert the user row. This is the only step that, if it fails,
  //    forces us to abort.
  const email = synthEmailFor(username);
  let userId: string;
  try {
    // Random unguessable password — caller cannot password-login until
    // they claim the account.
    const rand = randomBytes(32).toString("hex");
    const passwordHash = await hashPassword(rand);
    const [inserted] = await db
      .insert(users)
      .values({
        username,
        email,
        passwordHash,
        isPlayground: true,
        playgroundExpiresAt: expiresAt,
        emailVerifiedAt: now, // suppress verify-email banner
      })
      .returning({ id: users.id });
    if (!inserted) throw new Error("user insert returned no row");
    userId = inserted.id;
  } catch (err) {
    console.error("[playground] user insert failed:", err);
    // Fail-loud here: caller cannot recover without a user. Return a
    // shape that the route will detect and surface as a friendly error.
    return {
      user: { id: "", username, email },
      sessionToken: "",
      sampleRepoFullName: `${username}/${SANDBOX_REPO_NAME}`,
    };
  }

  // 3. Issue the session. 24h matches the playground TTL.
  let sessionToken = "";
  try {
    sessionToken = generateSessionToken();
    await db.insert(sessions).values({
      userId,
      token: sessionToken,
      expiresAt,
    });
  } catch (err) {
    console.error("[playground] session insert failed:", err);
  }

  // 4. Sandbox repo (best-effort).
  const fullName = `${username}/${SANDBOX_REPO_NAME}`;
  await ensureSandboxRepo({
    userId,
    username,
    repoName: SANDBOX_REPO_NAME,
  });

  // 5. Audit.
  try {
    await audit({
      userId,
      action: "playground.created",
      targetType: "user",
      targetId: userId,
      metadata: {
        username,
        expiresAt: expiresAt.toISOString(),
        ip: opts.requestIp || null,
      },
    });
  } catch (err) {
    console.error("[playground] audit insert failed:", err);
  }

  return {
    user: { id: userId, username, email },
    sessionToken,
    sampleRepoFullName: fullName,
  };
}

/**
 * Bootstrap a sandbox repo for the playground user. Mirrors the body
 * of POST /new but inlined here so we don't accidentally couple to
 * route-internal redirects. Each step is try/catch'd.
 */
async function ensureSandboxRepo(args: {
  userId: string;
  username: string;
  repoName: string;
}): Promise<void> {
  let diskPath = "";
  try {
    diskPath = await initBareRepo(args.username, args.repoName);
  } catch (err) {
    console.error("[playground] initBareRepo failed:", err);
    return;
  }

  // Seed the bare repo with a starter commit if main isn't already
  // resolvable (it shouldn't be on a fresh init).
  try {
    const repoDir = getRepoPath(args.username, args.repoName);
    const head = await spawnSafe(
      ["git", "rev-parse", "--verify", "refs/heads/main"],
      repoDir
    );
    if (head.exitCode !== 0) {
      const wrote = await writePlaygroundInitialCommit(
        repoDir,
        buildSandboxFiles(args.username),
        "Gluecron Playground",
        `${args.username}@playground.gluecron.local`
      );
      if ("error" in wrote) {
        console.error(
          "[playground] writeInitialCommit failed:",
          wrote.error
        );
      }
    }
  } catch (err) {
    console.error("[playground] sandbox seed failed:", err);
  }

  // Insert the DB row.
  let repoId: string | null = null;
  try {
    const [inserted] = await db
      .insert(repositories)
      .values({
        name: args.repoName,
        ownerId: args.userId,
        description:
          "Your 24-hour Gluecron playground sandbox. Push, open issues, watch Claude.",
        isPrivate: false, // public — part of the demo
        defaultBranch: "main",
        diskPath,
      })
      .returning({ id: repositories.id });
    if (inserted) repoId = inserted.id;
  } catch (err) {
    console.error("[playground] repo insert failed:", err);
  }

  if (!repoId) return;

  // Green-defaults — labels, branch protection, welcome issue.
  try {
    await bootstrapRepository({
      repositoryId: repoId,
      ownerUserId: args.userId,
      defaultBranch: "main",
      // We add our own playground-flavoured issues below; skip the
      // generic welcome issue so the issue list isn't cluttered.
      skipWelcomeIssue: true,
    });
  } catch (err) {
    console.error("[playground] bootstrapRepository failed:", err);
  }

  // Sample issues — one labelled `ai:build` so the autopilot picks it
  // up within the next tick or two.
  let aiBuildLabelId: string | null = null;
  try {
    // Fetch the bootstrap-created `ai:build` label if any seeder added
    // it; otherwise create our own.
    const [existing] = await db
      .select({ id: labelsTable.id })
      .from(labelsTable)
      .where(
        and(
          eq(labelsTable.repositoryId, repoId),
          eq(labelsTable.name, "ai:build")
        )
      )
      .limit(1);
    if (existing) {
      aiBuildLabelId = existing.id;
    } else {
      const [created] = await db
        .insert(labelsTable)
        .values({
          repositoryId: repoId,
          name: "ai:build",
          color: "#8c6dff",
          description: "Autopilot — open a draft PR for this issue.",
        })
        .returning({ id: labelsTable.id });
      if (created) aiBuildLabelId = created.id;
    }
  } catch (err) {
    console.error("[playground] ai:build label ensure failed:", err);
  }

  for (const issue of sampleIssues()) {
    try {
      const [inserted] = await db
        .insert(issues)
        .values({
          repositoryId: repoId,
          authorId: args.userId,
          title: issue.title,
          body: issue.body,
          state: "open",
        })
        .returning({ id: issues.id });
      if (inserted && issue.aiBuild && aiBuildLabelId) {
        try {
          await db.insert(issueLabels).values({
            issueId: inserted.id,
            labelId: aiBuildLabelId,
          });
        } catch (err) {
          console.error(
            "[playground] issue label insert failed:",
            err
          );
        }
      }
    } catch (err) {
      console.error("[playground] sample issue insert failed:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// claimPlaygroundAccount
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Convert a playground user into a real one. Idempotent in the sense
 * that calling it on an already-claimed (real) account returns
 * `{ok:false, reason:"not_a_playground_account"}`.
 *
 * Validation:
 *   - email looks like an email and is not taken by another user;
 *   - password is at least 8 chars;
 *   - username (if provided) matches `^[a-zA-Z0-9_-]+$`, 2..39 chars,
 *     not taken by another user.
 *
 * Side effects:
 *   - users row patched: is_playground=false, playground_expires_at=null,
 *     email=<new>, email_verified_at=null (force re-verify), password_hash=
 *     bcrypt(<new>), optional new username.
 *   - audit `playground.claimed`.
 *   - fire-and-forget `startEmailVerification` on the new email.
 */
export async function claimPlaygroundAccount(
  userId: string,
  args: ClaimPlaygroundArgs
): Promise<ClaimPlaygroundResult> {
  // ── Validate args ──────────────────────────────────────────────────
  const email = (args.email || "").trim();
  const password = args.password || "";
  const newUsername = args.username ? args.username.trim() : null;

  if (!EMAIL_RE.test(email)) {
    return { ok: false, reason: "invalid_email" };
  }
  if (password.length < 8) {
    return { ok: false, reason: "password_too_short" };
  }
  if (newUsername !== null) {
    if (!USERNAME_RE.test(newUsername) || newUsername.length < 2 || newUsername.length > 39) {
      return { ok: false, reason: "invalid_username" };
    }
  }

  // ── Load existing user + verify is-playground ──────────────────────
  let existing: {
    id: string;
    username: string;
    email: string;
    isPlayground: boolean;
  } | null = null;
  try {
    const [row] = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        isPlayground: users.isPlayground,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    existing = row ?? null;
  } catch (err) {
    console.error("[playground] claim load user failed:", err);
    return { ok: false, reason: "lookup_failed" };
  }
  if (!existing) return { ok: false, reason: "user_not_found" };
  if (!existing.isPlayground) {
    return { ok: false, reason: "not_a_playground_account" };
  }

  // ── Uniqueness checks ──────────────────────────────────────────────
  try {
    const [byEmail] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (byEmail && byEmail.id !== userId) {
      return { ok: false, reason: "email_taken" };
    }
  } catch (err) {
    console.error("[playground] claim email check failed:", err);
    return { ok: false, reason: "lookup_failed" };
  }

  if (newUsername !== null && newUsername !== existing.username) {
    try {
      const [byUsername] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, newUsername))
        .limit(1);
      if (byUsername && byUsername.id !== userId) {
        return { ok: false, reason: "username_taken" };
      }
    } catch (err) {
      console.error("[playground] claim username check failed:", err);
      return { ok: false, reason: "lookup_failed" };
    }
  }

  // ── Apply the update ───────────────────────────────────────────────
  const passwordHash = await hashPassword(password);
  const patch: Record<string, unknown> = {
    isPlayground: false,
    playgroundExpiresAt: null,
    email,
    emailVerifiedAt: null,
    passwordHash,
    updatedAt: new Date(),
  };
  if (newUsername !== null && newUsername !== existing.username) {
    patch.username = newUsername;
  }

  try {
    await db.update(users).set(patch).where(eq(users.id, userId));
  } catch (err) {
    console.error("[playground] claim update failed:", err);
    return { ok: false, reason: "update_failed" };
  }

  // ── Verification email (fire-and-forget) + audit ───────────────────
  try {
    await audit({
      userId,
      action: "playground.claimed",
      targetType: "user",
      targetId: userId,
      metadata: {
        previousUsername: existing.username,
        newUsername: (patch.username as string) ?? existing.username,
        email,
        loginUrl: absoluteUrl("/login"),
      },
    });
  } catch (err) {
    console.error("[playground] claim audit failed:", err);
  }

  // Don't block the claim on the email send.
  startEmailVerification(userId, email).catch((err) => {
    console.error("[playground] claim verification email failed:", err);
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// purgeExpiredPlaygroundAccounts
// ---------------------------------------------------------------------------

/**
 * Autopilot sweep — hard-delete every playground account whose TTL has
 * elapsed. CASCADEs from `users.id` clean up sessions + repositories +
 * issues + everything else. Capped at 50 users per tick. Each deletion
 * is try/catch'd so one FK violation can't stall the queue.
 *
 * Never throws. Returns `{ purged, errors }` for the tick log line.
 */
export async function purgeExpiredPlaygroundAccounts(
  opts: { now?: Date; cap?: number } = {}
): Promise<PurgeResult> {
  const now = opts.now ?? new Date();
  const cap = Math.max(1, opts.cap ?? PLAYGROUND_PURGE_CAP);

  let candidates: Array<{ id: string; username: string }> = [];
  try {
    candidates = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(
        and(
          eq(users.isPlayground, true),
          isNotNull(users.playgroundExpiresAt),
          lt(users.playgroundExpiresAt, now)
        )
      )
      .limit(cap);
  } catch (err) {
    console.error("[playground] purge candidate query failed:", err);
    return { purged: 0, errors: 1 };
  }

  let purged = 0;
  let errors = 0;
  for (const c of candidates) {
    try {
      const deleted = await db
        .delete(users)
        .where(eq(users.id, c.id))
        .returning({ id: users.id });
      if (deleted.length > 0) {
        purged += 1;
        try {
          await audit({
            userId: null,
            action: "playground.purged",
            targetType: "user",
            targetId: c.id,
            metadata: { username: c.username },
          });
        } catch (err) {
          console.error(
            `[playground] purge audit failed for user=${c.id} (${c.username}):`,
            err
          );
        }
      }
    } catch (err) {
      errors += 1;
      console.error(
        `[playground] purge failed for user=${c.id} (${c.username}):`,
        err
      );
    }
  }

  return { purged, errors };
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test = {
  PLAYGROUND_TTL_MS,
  PLAYGROUND_PURGE_CAP,
  USERNAME_RETRY_CAP,
  generateGuestUsername,
  synthEmailFor,
  buildSandboxFiles,
  sampleIssues,
};
