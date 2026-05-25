/**
 * `gluecron hook install commit-msg` / `gluecron hook uninstall commit-msg`
 *
 * Installs a `.git/hooks/prepare-commit-msg` script that calls
 * `gluecron ai commit-msg` and writes the AI-drafted message into the
 * commit-message file — but only when the file is empty (so explicit
 * `-m` and amends are untouched).
 *
 * Idempotent: re-running `install` overwrites the file; `uninstall`
 * only removes a file that carries our marker (so a hand-written hook
 * is never clobbered).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const HOOK_MARKER = "# gluecron-prepare-commit-msg-hook";

/**
 * Body of the hook script. Kept in a separate function so the test
 * suite can assert on the contents without touching the filesystem.
 *
 *   $1 — path to the message file
 *   $2 — source ("message" | "template" | "commit" | "merge" | "squash" | "")
 *   $3 — sha (when amending)
 *
 * We only fire when $2 is empty (a vanilla `git commit` with no -m).
 * Otherwise we leave the message untouched so amends, merges, and
 * `-m "..."` keep their existing behaviour.
 */
export function hookScript(binPath: string): string {
  return `#!/usr/bin/env bash
${HOOK_MARKER}
#
# Installed by \`gluecron hook install commit-msg\`. Calls the gluecron CLI
# to draft a commit message when none was supplied.

set -e

COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"

# Only act on a plain \`git commit\` (no -m, no template, no amend).
if [ -n "$COMMIT_SOURCE" ]; then
  exit 0
fi

# Bail if the user already typed something.
if [ -s "$COMMIT_MSG_FILE" ]; then
  existing=$(grep -v '^#' "$COMMIT_MSG_FILE" | tr -d '[:space:]' || true)
  if [ -n "$existing" ]; then
    exit 0
  fi
fi

DRAFT=$(${binPath} ai commit-msg 2>/dev/null || true)
if [ -n "$DRAFT" ]; then
  # Preserve any trailing comment lines (status summary git appends).
  TRAILER=$(grep '^#' "$COMMIT_MSG_FILE" || true)
  {
    printf '%s\\n' "$DRAFT"
    if [ -n "$TRAILER" ]; then
      printf '\\n'
      printf '%s\\n' "$TRAILER"
    fi
  } > "$COMMIT_MSG_FILE"
fi

exit 0
`;
}

export function findGitDir(cwd: string = process.cwd()): string | null {
  const r = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const dir = (r.stdout || "").trim();
  if (!dir) return null;
  return dir.startsWith("/") ? dir : join(cwd, dir);
}

export interface HookDeps {
  out: (msg: string) => void;
  cwd?: string;
  /** Override the path used inside the generated hook script (defaults to "gluecron"). */
  binPath?: string;
  /** Override findGitDir for tests. */
  findGitDirImpl?: typeof findGitDir;
}

export async function runHookInstall(
  argv: string[],
  deps: HookDeps
): Promise<number> {
  const target = argv[0];
  if (target !== "commit-msg") {
    deps.out("usage: gluecron hook install commit-msg");
    return 1;
  }
  const gitDir = (deps.findGitDirImpl ?? findGitDir)(deps.cwd);
  if (!gitDir) {
    deps.out("error: not a git repository (run from inside a git checkout)");
    return 1;
  }
  const hooksDir = join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "prepare-commit-msg");

  // Refuse to clobber a hand-written hook unless it carries our marker.
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (!existing.includes(HOOK_MARKER)) {
      deps.out(
        `error: ${hookPath} already exists and was not installed by gluecron. ` +
          "Remove it manually if you want gluecron to manage it."
      );
      return 1;
    }
  }

  const bin = deps.binPath || "gluecron";
  writeFileSync(hookPath, hookScript(bin), "utf8");
  chmodSync(hookPath, 0o755);
  deps.out(`installed ${hookPath}`);
  deps.out(
    "next commit with an empty message will auto-fill from the AI draft."
  );
  return 0;
}

export async function runHookUninstall(
  argv: string[],
  deps: HookDeps
): Promise<number> {
  const target = argv[0];
  if (target !== "commit-msg") {
    deps.out("usage: gluecron hook uninstall commit-msg");
    return 1;
  }
  const gitDir = (deps.findGitDirImpl ?? findGitDir)(deps.cwd);
  if (!gitDir) {
    deps.out("error: not a git repository");
    return 1;
  }
  const hookPath = join(gitDir, "hooks", "prepare-commit-msg");
  if (!existsSync(hookPath)) {
    deps.out("nothing to uninstall.");
    return 0;
  }
  const existing = readFileSync(hookPath, "utf8");
  if (!existing.includes(HOOK_MARKER)) {
    deps.out(
      `error: ${hookPath} exists but was not installed by gluecron — refusing to remove.`
    );
    return 1;
  }
  unlinkSync(hookPath);
  deps.out(`removed ${hookPath}`);
  return 0;
}

export async function runHook(
  argv: string[],
  deps: HookDeps
): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "install") return runHookInstall(rest, deps);
  if (sub === "uninstall") return runHookUninstall(rest, deps);
  deps.out("usage: gluecron hook (install|uninstall) commit-msg");
  return 1;
}
