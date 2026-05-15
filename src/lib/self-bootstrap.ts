/**
 * Self-bootstrap — fires on boot if Gluecron's own canonical repo
 * doesn't yet exist on disk. Idempotent, safe to call every boot.
 *
 * This closes the chicken-and-egg gap where:
 *   - The site self-hosts on gluecron.com/ccantynz/Gluecron.com.git
 *   - But that bare repo was never initialized on the Fly volume
 *   - So every `git push` to it returned "Repository not found"
 *   - So nothing ever deployed through Gluecron's own canonical path
 *
 * After this boots once, the canonical repo exists, the post-receive
 * hook is installed, and Gluecron is fully self-sufficient — future
 * deploys do not require GitHub Actions, flyctl, or any external tool.
 *
 * Configuration (env vars, all optional):
 *   SELF_BOOTSTRAP_DISABLED=1  — skip entirely
 *   SELF_BOOTSTRAP_OWNER       — default "ccantynz"
 *   SELF_BOOTSTRAP_NAME        — default "Gluecron.com"
 *   SELF_BOOTSTRAP_SOURCE      — default github mirror URL
 *
 * Never throws out of boot. Returns silently on any failure (logged).
 * Run the explicit script (`bun run scripts/self-host-bootstrap.ts`)
 * for verbose output and exit codes.
 */

import { existsSync } from "fs";
import { mkdir, writeFile, chmod, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  runBootstrap,
  sh,
  type BootstrapArgs,
  type BootstrapDeps,
} from "../../scripts/self-host-bootstrap";

const DEFAULT_OWNER = "ccantynz";
const DEFAULT_NAME = "Gluecron.com";
const DEFAULT_SOURCE = "https://github.com/ccantynz-alt/Gluecron.com.git";

export async function maybeSelfBootstrap(): Promise<void> {
  if (process.env.SELF_BOOTSTRAP_DISABLED === "1") {
    return;
  }

  // Lazy imports — these touch the live DB / config, and we want
  // src/lib/self-bootstrap.ts itself to be cheap to import in tests.
  const { db } = await import("../db");
  const schemaMod = await import("../db/schema");
  const { config } = await import("./config");

  const owner = process.env.SELF_BOOTSTRAP_OWNER || DEFAULT_OWNER;
  const name = process.env.SELF_BOOTSTRAP_NAME || DEFAULT_NAME;
  const source = process.env.SELF_BOOTSTRAP_SOURCE || DEFAULT_SOURCE;

  // Fast path: if the bare repo already exists on disk, the bootstrap
  // is a no-op and we skip even the DB roundtrip. The explicit script
  // is still idempotent if you want to re-verify everything.
  const barePath = join(config.gitReposPath, owner, `${name}.git`);
  if (existsSync(join(barePath, "HEAD"))) {
    return;
  }

  const args: BootstrapArgs = { owner, name, source, dryRun: false };

  // Quiet log shim — boot output is precious; only print on completion
  // or failure. The verbose script-mode logs go to stdout when you run
  // scripts/self-host-bootstrap.ts directly.
  const lines: string[] = [];
  const push = (level: string, msg: string) => lines.push(`[${level}] ${msg}`);

  const deps: BootstrapDeps = {
    db,
    schema: {
      users: schemaMod.users,
      repositories: schemaMod.repositories,
      siteAdmins: schemaMod.siteAdmins,
    },
    reposPath: config.gitReposPath,
    sh,
    fsExists: existsSync,
    fsMkdir: mkdir,
    fsWrite: (p, body) => writeFile(p, body, "utf8"),
    fsChmod: chmod,
    fsRm: rm,
    log: {
      say: (m) => push("·", m),
      ok: (m) => push("ok", m),
      warn: (m) => push("warn", m),
      bad: (m) => push("err", m),
      info: (m) => push("info", m),
    },
    tmpRoot: tmpdir(),
  };

  try {
    const result = await runBootstrap(args, deps);
    if (result.ok) {
      console.log(
        `[self-bootstrap] canonical ${owner}/${name} initialized from ${source}`
      );
    } else {
      console.warn(
        `[self-bootstrap] failed: ${result.error || "unknown"} — see scripts/self-host-bootstrap.ts to re-run with verbose output`
      );
      // Print the captured log lines so the operator can diagnose
      // without grepping process state.
      for (const l of lines.slice(-20)) console.warn(`  ${l}`);
    }
  } catch (err) {
    console.warn(
      `[self-bootstrap] crashed: ${(err as Error).message} — boot continues normally`
    );
  }
}
