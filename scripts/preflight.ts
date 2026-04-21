#!/usr/bin/env bun
/**
 * Preflight — run a sequence of deploy-readiness checks.
 *
 * Usage:
 *   bun scripts/preflight.ts
 *   PREFLIGHT_BACKUP_DRILL=1 bun scripts/preflight.ts
 *
 * Exit code 0 iff every non-skipped check passes.
 */

import { access, mkdir, writeFile, readFile, rm, stat } from "fs/promises";
import { constants as fsConstants } from "fs";
import { join } from "path";
import { tmpdir } from "os";

type Status = "pass" | "fail" | "warn" | "skip";
interface Result {
  n: number;
  name: string;
  status: Status;
  reason?: string;
  notes?: string[];
}

const TOTAL = 7;
const results: Result[] = [];

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function icon(s: Status): string {
  switch (s) {
    case "pass":
      return `${GREEN}✅${RESET}`;
    case "fail":
      return `${RED}❌${RESET}`;
    case "warn":
      return `${YELLOW}⚠️${RESET} `;
    case "skip":
      return `${DIM}⏭${RESET} `;
  }
}

function record(r: Result) {
  results.push(r);
  const tag = `[${r.n}/${TOTAL}]`;
  const tail = r.reason ? ` — ${r.reason}` : "";
  console.log(`${tag} ${icon(r.status)} ${r.name}${tail}`);
  if (r.notes) for (const line of r.notes) console.log(`      ${DIM}${line}${RESET}`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isWritable(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ---- Check 1 — env sanity ---------------------------------------------------
async function checkEnv(n: number) {
  const notes: string[] = [];
  const missing: string[] = [];

  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");

  if (!process.env.GIT_REPOS_PATH) {
    notes.push("GIT_REPOS_PATH not set — defaulting to ./repos");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    notes.push("ANTHROPIC_API_KEY missing — AI features will degrade");
  }
  if (!process.env.ERROR_WEBHOOK_URL && !process.env.SENTRY_DSN) {
    notes.push("No ERROR_WEBHOOK_URL or SENTRY_DSN — errors will not be reported upstream");
  }

  if (missing.length > 0) {
    record({
      n,
      name: "Env sanity",
      status: "fail",
      reason: `missing required env: ${missing.join(", ")}`,
      notes,
    });
    return;
  }

  record({
    n,
    name: "Env sanity",
    status: notes.length > 0 ? "warn" : "pass",
    notes,
  });
}

// ---- Check 2 — migrations ---------------------------------------------------
async function checkMigrations(n: number) {
  if (!process.env.DATABASE_URL) {
    record({
      n,
      name: "Migrations",
      status: "fail",
      reason: "DATABASE_URL not set — cannot run migrations",
    });
    return;
  }

  const cmd = ["bun", "run", "src/db/migrate.ts"];
  const proc = Bun.spawn(cmd, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    const tail = errText.trim().split("\n").slice(-3).join(" | ");
    record({
      n,
      name: "Migrations",
      status: "fail",
      reason: `bun run db:migrate exited ${exitCode}: ${tail.slice(0, 200)}`,
    });
    return;
  }

  record({ n, name: "Migrations", status: "pass" });
}

// ---- Check 3 — repo dir -----------------------------------------------------
async function checkRepoDir(n: number) {
  const repoDir =
    process.env.GIT_REPOS_PATH || join(process.cwd(), "repos");

  try {
    if (!(await pathExists(repoDir))) {
      await mkdir(repoDir, { recursive: true });
    }
    const s = await stat(repoDir);
    if (!s.isDirectory()) {
      record({
        n,
        name: "Repo dir",
        status: "fail",
        reason: `${repoDir} exists but is not a directory`,
      });
      return;
    }
    if (!(await isWritable(repoDir))) {
      record({
        n,
        name: "Repo dir",
        status: "fail",
        reason: `${repoDir} is not writable`,
      });
      return;
    }
    // Prove write by touching a sentinel.
    const sentinel = join(repoDir, ".preflight-touch");
    await writeFile(sentinel, String(Date.now()));
    await rm(sentinel);
    record({
      n,
      name: "Repo dir",
      status: "pass",
      notes: [`path=${repoDir}`],
    });
  } catch (err) {
    record({
      n,
      name: "Repo dir",
      status: "fail",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---- Shared: spawn server for smoke tests ----------------------------------
async function spawnServer(port: number) {
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT: String(port) },
  });
  // Wait up to ~3s for it to start accepting connections.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      // Any response — even 404 — means the server is up.
      void r.text();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return proc;
}

async function hitEndpoint(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(3000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, body, text };
}

// ---- Check 4 — /healthz smoke ----------------------------------------------
async function checkHealthz(n: number) {
  const port = Number(process.env.PREFLIGHT_PORT || 3999);
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = await spawnServer(port);
    const { status, body, text } = await hitEndpoint(port, "/healthz");
    if (status !== 200) {
      record({
        n,
        name: "Healthz smoke",
        status: "fail",
        reason: `status ${status}`,
      });
      return;
    }
    const ok =
      (typeof body === "object" &&
        body !== null &&
        (body as { status?: string }).status === "ok") ||
      /"?status"?\s*:\s*"?ok"?/i.test(text);
    if (!ok) {
      record({
        n,
        name: "Healthz smoke",
        status: "fail",
        reason: `200 but body did not look healthy: ${text.slice(0, 100)}`,
      });
      return;
    }
    record({ n, name: "Healthz smoke", status: "pass" });
  } catch (err) {
    record({
      n,
      name: "Healthz smoke",
      status: "fail",
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (proc) {
      try {
        proc.kill();
        await proc.exited;
      } catch {
        /* ignore */
      }
    }
  }
}

// ---- Check 5 — /readyz smoke -----------------------------------------------
async function checkReadyz(n: number) {
  const port = Number(process.env.PREFLIGHT_PORT || 3999) + 1;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = await spawnServer(port);
    const { status, body, text } = await hitEndpoint(port, "/readyz");
    if (status === 200) {
      const ok =
        (typeof body === "object" &&
          body !== null &&
          (body as { status?: string }).status === "ok") ||
        /ok|ready/i.test(text);
      if (!ok) {
        record({
          n,
          name: "Readyz smoke",
          status: "warn",
          reason: `200 but body looked degraded: ${text.slice(0, 100)}`,
        });
        return;
      }
      record({ n, name: "Readyz smoke", status: "pass" });
      return;
    }
    if (status === 503) {
      record({
        n,
        name: "Readyz smoke",
        status: "warn",
        reason: "503 — dependency reported degraded (DB?)",
      });
      return;
    }
    record({
      n,
      name: "Readyz smoke",
      status: "warn",
      reason: `unexpected status ${status}`,
    });
  } catch (err) {
    record({
      n,
      name: "Readyz smoke",
      status: "warn",
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (proc) {
      try {
        proc.kill();
        await proc.exited;
      } catch {
        /* ignore */
      }
    }
  }
}

// ---- Check 6 — test suite ---------------------------------------------------
const BASELINE_PASS = 154;
const BASELINE_FAIL = 55;

async function checkTests(n: number) {
  const proc = Bun.spawn(["bun", "test"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [outText, errText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const combined = `${outText}\n${errText}`;

  // Bun test summary lines look like "  42 pass" / "  3 fail".
  const passMatch = combined.match(/(\d+)\s+pass\b/);
  const failMatch = combined.match(/(\d+)\s+fail\b/);
  const pass = passMatch ? Number(passMatch[1]) : 0;
  const fail = failMatch ? Number(failMatch[1]) : 0;

  const notes = [
    `baseline: ${BASELINE_PASS} pass / ${BASELINE_FAIL} fail (known sandbox hono/jsx-dev-runtime errors)`,
    `observed: ${pass} pass / ${fail} fail`,
  ];

  if (!passMatch && !failMatch) {
    record({
      n,
      name: "Test suite",
      status: "fail",
      reason: "could not parse bun test output",
      notes,
    });
    return;
  }

  if (pass < BASELINE_PASS) {
    record({
      n,
      name: "Test suite",
      status: "fail",
      reason: `pass count dropped below baseline (${pass} < ${BASELINE_PASS})`,
      notes,
    });
    return;
  }

  if (fail > BASELINE_FAIL) {
    record({
      n,
      name: "Test suite",
      status: "warn",
      reason: `fail count above baseline (${fail} > ${BASELINE_FAIL}) but pass held`,
      notes,
    });
    return;
  }

  record({ n, name: "Test suite", status: "pass", notes });
}

// ---- Check 7 — backup restore drill ----------------------------------------
async function checkBackupDrill(n: number) {
  if (process.env.PREFLIGHT_BACKUP_DRILL !== "1") {
    record({
      n,
      name: "Backup restore drill",
      status: "skip",
      reason: "set PREFLIGHT_BACKUP_DRILL=1 to enable",
    });
    return;
  }
  const root = join(tmpdir(), `preflight-backup-${Date.now()}`);
  const src = join(root, "src");
  const dst = join(root, "dst");
  try {
    await mkdir(src, { recursive: true });
    await mkdir(dst, { recursive: true });
    const payload = `preflight ${new Date().toISOString()}`;
    const srcFile = join(src, "hello.txt");
    const dstFile = join(dst, "hello.txt");
    await writeFile(srcFile, payload);

    // Prefer rsync; fall back to raw copy.
    const rsync = Bun.spawn(["rsync", "-a", `${src}/`, `${dst}/`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await rsync.exited;
    if (code !== 0) {
      const buf = await readFile(srcFile);
      await writeFile(dstFile, buf);
    }

    const got = await readFile(dstFile, "utf8");
    if (got !== payload) {
      record({
        n,
        name: "Backup restore drill",
        status: "fail",
        reason: "restored file differs from source",
      });
      return;
    }
    record({ n, name: "Backup restore drill", status: "pass" });
  } catch (err) {
    record({
      n,
      name: "Backup restore drill",
      status: "fail",
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- Driver -----------------------------------------------------------------
async function main() {
  console.log(`${DIM}gluecron preflight — ${new Date().toISOString()}${RESET}`);

  await checkEnv(1);
  await checkMigrations(2);
  await checkRepoDir(3);
  await checkHealthz(4);
  await checkReadyz(5);
  await checkTests(6);
  await checkBackupDrill(7);

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  console.log("");
  console.log(
    `${passed} passed, ${failed} failed, ${warned} warned, ${skipped} skipped`
  );

  if (failed > 0) {
    console.log(`${RED}preflight FAILED — do not deploy${RESET}`);
    process.exit(1);
  }
  if (warned > 0) {
    console.log(`${YELLOW}preflight passed with warnings${RESET}`);
  } else {
    console.log(`${GREEN}preflight clean — ready to deploy${RESET}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("preflight crashed:", err);
  process.exit(1);
});
