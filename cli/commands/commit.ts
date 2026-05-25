/**
 * `gluecron commit` — wrap `git commit` with an AI-drafted message.
 *
 * Flow:
 *   1. If `-m` is provided, just shell out to git commit verbatim.
 *   2. Otherwise:
 *        a. Stage all if `-a` was passed.
 *        b. Read `git diff --cached`.
 *        c. POST to `/api/v2/ai/commit-message`.
 *        d. Print the proposed subject + body and prompt
 *           [y]es / [e]dit / [n]o.
 *        e. yes  → git commit -m <subject> -m <body>
 *           edit → drop into $EDITOR with the message pre-filled,
 *                  then `git commit -F <tmp>` after the editor exits.
 *           no   → abort.
 *
 * The CLI is dependency-free Bun; we shell out to `git` via Bun.spawnSync.
 * All exported helpers are pure functions so the test suite can exercise
 * them without a real git repository.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommitMessage {
  subject: string;
  body: string;
}

export interface CommitConfig {
  host: string;
  token?: string;
}

// ──────────────────────────── arg parsing ────────────────────────────

export interface CommitArgs {
  stageAll: boolean;
  message?: string;
  bodyExtra?: string;
  style: "conventional" | "plain";
  yes: boolean; // --yes / -y → skip the prompt
}

export function parseCommitArgs(argv: string[]): CommitArgs {
  const args: CommitArgs = {
    stageAll: false,
    style: "conventional",
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-a" || a === "--all") {
      args.stageAll = true;
    } else if (a === "-m" || a === "--message") {
      args.message = argv[++i];
    } else if (a === "-y" || a === "--yes") {
      args.yes = true;
    } else if (a === "--plain") {
      args.style = "plain";
    } else if (a === "--conventional") {
      args.style = "conventional";
    }
  }
  return args;
}

// ──────────────────────────── git wrappers ────────────────────────────

function git(
  argv: string[],
  opts: { input?: string; cwd?: string } = {}
): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync("git", argv, {
    cwd: opts.cwd ?? process.cwd(),
    input: opts.input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    exitCode: r.status ?? 1,
  };
}

export function readStagedDiff(stageAll: boolean): string {
  // -a in `git commit` stages tracked changes before committing. We
  // emulate that by passing `--cached` after a `git add -u` (tracked
  // only — `git add -A` would sweep up untracked, which is NOT what
  // `git commit -a` does).
  if (stageAll) {
    git(["add", "-u"]);
  }
  const r = git(["diff", "--cached"]);
  if (r.exitCode !== 0) return "";
  return r.stdout;
}

// ──────────────────────────── API call ────────────────────────────

export async function requestCommitMessage(
  cfg: CommitConfig,
  diff: string,
  style: "conventional" | "plain",
  fetchImpl: typeof fetch = fetch
): Promise<CommitMessage> {
  const url = cfg.host.replace(/\/+$/, "") + "/api/v2/ai/commit-message";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ diff, style }),
  });
  const text = await res.text();
  let json: { subject?: string; body?: string; error?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Server returned non-JSON [${res.status}]: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(json?.error || `Server returned ${res.status}`);
  }
  return {
    subject: typeof json.subject === "string" ? json.subject : "",
    body: typeof json.body === "string" ? json.body : "",
  };
}

// ──────────────────────────── prompt + editor ────────────────────────────

export function formatProposedMessage(m: CommitMessage): string {
  let out = `\nProposed commit message:\n\n  ${m.subject}\n`;
  if (m.body.trim()) {
    out += "\n";
    for (const line of m.body.split("\n")) {
      out += `  ${line}\n`;
    }
  }
  return out;
}

async function readChar(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string) => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(String(chunk).trim().toLowerCase());
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

export function editInEditor(m: CommitMessage): CommitMessage {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const dir = mkdtempSync(join(tmpdir(), "gluecron-commit-"));
  const file = join(dir, "COMMIT_EDITMSG");
  const seed =
    m.subject +
    (m.body.trim() ? `\n\n${m.body}\n` : "\n") +
    "\n# Edit the commit message above. Lines starting with '#' are ignored.\n";
  writeFileSync(file, seed, "utf8");
  // Bun has no synchronous spawn with TTY inheritance — node:child_process
  // gives it to us cleanly. We block until the editor returns.
  spawnSync(editor, [file], { stdio: "inherit" });
  const raw = readFileSync(file, "utf8");
  const lines = raw
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();
  if (!lines) return m;
  const subject = (lines.split("\n")[0] || "").trim();
  const body = lines.split("\n").slice(1).join("\n").trim();
  return { subject, body };
}

// ──────────────────────────── main command ────────────────────────────

export interface CommitDeps {
  out: (msg: string) => void;
  readChar?: (prompt: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  editorEdit?: (m: CommitMessage) => CommitMessage;
  // Test-only override — lets us bypass the network without a fake fetch.
  generate?: (diff: string, style: "conventional" | "plain") => Promise<CommitMessage>;
}

/**
 * Run `gluecron commit`. Returns the exit code.
 *
 * Pulled out from the dispatcher so the CLI test suite can drive it
 * with synthetic deps and assert on behaviour without spawning git or
 * hitting the network.
 */
export async function runCommit(
  argv: string[],
  cfg: CommitConfig,
  deps: CommitDeps
): Promise<number> {
  const args = parseCommitArgs(argv);

  // Fast path: -m provided → straight pass-through to git.
  if (args.message) {
    const gitArgs = ["commit"];
    if (args.stageAll) gitArgs.push("-a");
    gitArgs.push("-m", args.message);
    if (args.bodyExtra) gitArgs.push("-m", args.bodyExtra);
    const r = spawnSync("git", gitArgs, { stdio: "inherit" });
    return r.status ?? 1;
  }

  // Pull the staged diff (after auto-adding tracked changes if -a).
  const diff = readStagedDiff(args.stageAll);
  if (!diff.trim()) {
    deps.out(
      "error: nothing to commit. Stage changes with `git add` (or pass -a)."
    );
    return 1;
  }

  // Ask the API for a message — or use the supplied generator (tests).
  let proposed: CommitMessage;
  try {
    proposed = deps.generate
      ? await deps.generate(diff, args.style)
      : await requestCommitMessage(cfg, diff, args.style, deps.fetchImpl);
  } catch (err) {
    deps.out(`error: ${(err as Error).message}`);
    return 1;
  }

  if (!proposed.subject.trim()) {
    deps.out("error: AI returned an empty subject. Try again or pass -m.");
    return 1;
  }

  deps.out(formatProposedMessage(proposed));

  // Skip prompt when --yes was passed (CI / scripted commits).
  let choice: string;
  if (args.yes) {
    choice = "y";
  } else {
    const rc = deps.readChar ?? readChar;
    choice = await rc("Commit with this message? [y/e/n]: ");
  }

  if (choice === "n" || choice === "no") {
    deps.out("Aborted.");
    return 1;
  }

  let final = proposed;
  if (choice === "e" || choice === "edit") {
    final = (deps.editorEdit ?? editInEditor)(proposed);
    if (!final.subject.trim()) {
      deps.out("Aborted — empty subject after edit.");
      return 1;
    }
  }

  // Commit. We use two `-m` arguments so git formats the body the usual
  // way (separated by a blank line from the subject).
  const commitArgs = ["commit", "-m", final.subject];
  if (final.body.trim()) {
    commitArgs.push("-m", final.body);
  }
  const r = spawnSync("git", commitArgs, { stdio: "inherit" });
  return r.status ?? 1;
}

// ──────────────────────────── `gluecron ai commit-msg` ────────────────────────────
//
// Used by the prepare-commit-msg hook. Reads diff from stdin (or runs
// `git diff --cached`), asks the API for a message, prints just
// `<subject>\n\n<body>` on stdout. No prompts, no edit flow.

export interface AiCommitMsgDeps {
  out: (msg: string) => void;
  fetchImpl?: typeof fetch;
  generate?: (diff: string, style: "conventional" | "plain") => Promise<CommitMessage>;
  // Allow tests to supply an explicit diff (so we don't have to mock stdin).
  diff?: string;
}

export async function runAiCommitMsg(
  cfg: CommitConfig,
  deps: AiCommitMsgDeps
): Promise<number> {
  const diff = deps.diff ?? readStagedDiff(false);
  if (!diff.trim()) {
    return 1; // hook will fall back to git's default empty message.
  }
  try {
    const msg = deps.generate
      ? await deps.generate(diff, "conventional")
      : await requestCommitMessage(cfg, diff, "conventional", deps.fetchImpl);
    if (!msg.subject.trim()) return 1;
    if (msg.body.trim()) {
      deps.out(`${msg.subject}\n\n${msg.body}`);
    } else {
      deps.out(msg.subject);
    }
    return 0;
  } catch {
    return 1;
  }
}
