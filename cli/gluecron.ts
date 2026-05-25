#!/usr/bin/env bun
/**
 * Block G3 — `gluecron` CLI.
 *
 * A dependency-free Bun executable that talks to a Gluecron server using
 * either the REST `/api/*` endpoints or the GraphQL endpoint at `/api/graphql`.
 *
 *   gluecron login                        — store a PAT in ~/.gluecron/config.json
 *   gluecron whoami                       — print the logged-in user
 *   gluecron repo ls                      — list repos for the logged-in user
 *   gluecron repo show <owner/name>       — pretty-print a repo
 *   gluecron repo create <name>           — create a repo for the logged-in user
 *   gluecron issues ls <owner/name>       — list open issues
 *   gluecron gql '<query>'                — run a GraphQL query verbatim
 *
 * Build:   bun build cli/gluecron.ts --compile --outfile gluecron
 * Install: cp gluecron /usr/local/bin/
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommit, runAiCommitMsg } from "./commands/commit";
import { runHook } from "./install-hook";

const VERSION = "0.1.0";
const DEFAULT_HOST = process.env.GLUECRON_HOST || "http://localhost:3000";
const CONFIG_DIR = join(homedir(), ".gluecron");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// ---------- Config ----------

interface Config {
  host: string;
  token?: string;
  username?: string;
  githubToken?: string;
  defaultRepo?: string;
}

export function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<Config>;
      return {
        host: parsed.host || DEFAULT_HOST,
        token: parsed.token,
        username: parsed.username,
        githubToken: parsed.githubToken,
        defaultRepo: parsed.defaultRepo,
      };
    }
  } catch {
    // fall through
  }
  return { host: DEFAULT_HOST };
}

export function saveConfig(cfg: Config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), {
    mode: 0o600,
  });
}

// ---------- HTTP ----------

export async function http(
  cfg: Config,
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  const url = cfg.host.replace(/\/+$/, "") + path;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text };
  }
  if (!res.ok) {
    const msg = json?.error || res.statusText || "request failed";
    throw new Error(`[${res.status}] ${msg}`);
  }
  return json;
}

// ---------- GraphQL Utilities ----------

function sanitizeGraphQLString(input: string): string {
  return input.replace(/["\\]/g, '\\$&');
}

// ---------- Commands ----------

export const HELP = `gluecron CLI v${VERSION}

Usage:
  gluecron login                       Save a personal access token
  gluecron whoami                      Print the logged-in user
  gluecron repo ls [--user <name>]     List repos
  gluecron repo show <owner/name>      Show a repo
  gluecron repo create <name> [--private]
                                       Create a repo
  gluecron issues ls <owner/name>      List open issues
  gluecron gql '<query>'               Run a GraphQL query
  gluecron host [url]                  Get or set the server URL
  gluecron deploy [--repo owner/name] [--workflow id] [--ref branch] [--no-watch]
                                       Trigger a Hetzner deploy via GitHub Actions
  gluecron commit [-a] [-m <msg>] [-y] [--plain]
                                       Commit with an AI-drafted message
  gluecron ai commit-msg               Print an AI commit draft (used by hooks)
  gluecron hook install commit-msg     Install the prepare-commit-msg hook
  gluecron hook uninstall commit-msg   Remove the hook
  gluecron config set <key> <value>    Set a config value (e.g. github-token)
  gluecron version                     Print version
  gluecron help                        Print this help

Env:
  GLUECRON_HOST           override the server URL (default: ${DEFAULT_HOST})
  GLUECRON_GITHUB_TOKEN   GitHub PAT (repo+workflow scopes) for \`deploy\`
`;

export async function cmdLogin(
  cfg: Config,
  prompt: (q: string) => Promise<string>
): Promise<Config> {
  const host =
    (await prompt(`Server URL [${cfg.host}]: `)) || cfg.host;
  const token = await prompt("Personal access token (glc_...): ");
  if (!token) throw new Error("token is required");
  const next: Config = { host, token };
  // Probe /api/user/me to confirm
  const me = await http(next, "GET", "/api/user/me").catch(() => null);
  if (me?.username) next.username = me.username;
  saveConfig(next);
  return next;
}

export async function cmdWhoami(cfg: Config): Promise<string> {
  if (!cfg.token) return "(not logged in)";
  const me = await http(cfg, "GET", "/api/user/me").catch(() => null);
  if (!me?.username) return cfg.username || "(unknown)";
  return `${me.username} (${me.email || "no email"})`;
}

export async function cmdRepoLs(
  cfg: Config,
  user?: string
): Promise<Array<{ owner: string; name: string; visibility: string }>> {
  const username = user || cfg.username;
  if (!username) throw new Error("no user context — log in or pass --user");
  const q = `{ user(username:"${sanitizeGraphQLString(username)}") { repos { name visibility } } }`;
  const r = await http(cfg, "POST", "/api/graphql", { query: q });
  const repos = r?.data?.user?.repos || [];
  return repos.map((x: any) => ({
    owner: username,
    name: x.name,
    visibility: x.visibility,
  }));
}

export async function cmdRepoShow(
  cfg: Config,
  slug: string
): Promise<Record<string, any>> {
  const [owner, name] = slug.split("/");
  if (!owner || !name) throw new Error("expected owner/name");
  const q = `{ repository(owner:"${sanitizeGraphQLString(owner)}", name:"${sanitizeGraphQLString(name)}") {
    name description visibility starCount forkCount
    owner { username }
    issues(state:"open", limit:5) { number title }
  } }`;
  const r = await http(cfg, "POST", "/api/graphql", { query: q });
  return r?.data?.repository || null;
}

export async function cmdRepoCreate(
  cfg: Config,
  name: string,
  isPrivate = false
): Promise<any> {
  if (!cfg.username) throw new Error("log in first (gluecron login)");
  return http(cfg, "POST", "/api/repos", {
    name,
    owner: cfg.username,
    isPrivate,
  });
}

export async function cmdIssuesLs(
  cfg: Config,
  slug: string
): Promise<Array<{ number: number; title: string }>> {
  const [owner, name] = slug.split("/");
  const q = `{ repository(owner:"${sanitizeGraphQLString(owner)}", name:"${sanitizeGraphQLString(name)}") { issues(state:"open", limit:50) { number title } } }`;
  const r = await http(cfg, "POST", "/api/graphql", { query: q });
  return r?.data?.repository?.issues || [];
}

export async function cmdGql(cfg: Config, query: string): Promise<any> {
  return http(cfg, "POST", "/api/graphql", { query });
}

// ---------- Deploy (GitHub Actions workflow_dispatch) ----------

export interface DeployArgs {
  repo: string;            // "owner/name"
  workflow: string;        // file name (e.g. "hetzner-deploy.yml") OR numeric id
  ref: string;             // "main"
  githubToken: string;
}

export interface DeployDispatchResult {
  runId: number;
  runUrl: string;
  htmlUrl: string;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  json?: () => Promise<any>;
}>;

const GITHUB_API = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "gluecron-cli",
  };
}

async function parseBody(res: { text: () => Promise<string> }): Promise<any> {
  const t = await res.text();
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    return { _raw: t };
  }
}

function friendlyGhError(status: number, body: any): string {
  const msg = (body && (body.message || body.error)) || "";
  if (status === 401) {
    return "GitHub auth failed (401). Check your token has `repo` and `workflow` scopes.";
  }
  if (status === 403) {
    return `GitHub forbade the request (403). ${msg || "Token may lack `workflow` scope or you don't have write access."}`;
  }
  if (status === 404) {
    return `Workflow or repo not found (404). ${msg || "Check --repo, --workflow, and that the token can see this repo."}`;
  }
  if (status === 422) {
    return `GitHub rejected the dispatch (422). ${msg || "Branch may not exist, or the workflow has no workflow_dispatch trigger on that ref."}`;
  }
  return `GitHub error [${status}]: ${msg || "request failed"}`;
}

/**
 * Trigger a `workflow_dispatch` on GitHub Actions and resolve the run id.
 *
 * Step 1: POST /repos/:o/:r/actions/workflows/:wf/dispatches  (expects 204)
 * Step 2: GET  /repos/:o/:r/actions/workflows/:wf/runs?event=workflow_dispatch&branch=:ref
 *         and pick the newest run created within the last 60s.
 */
export async function triggerWorkflowDispatch(
  args: DeployArgs,
  opts: { fetchImpl?: FetchLike; now?: () => number } = {}
): Promise<DeployDispatchResult> {
  const f: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const [owner, name] = args.repo.split("/");
  if (!owner || !name) throw new Error("expected --repo owner/name");
  if (!args.githubToken) {
    throw new Error(
      "no GitHub token — set GLUECRON_GITHUB_TOKEN or run `gluecron config set github-token <token>`"
    );
  }

  const dispatchedAt = (opts.now ?? Date.now)();
  const dispatchUrl = `${GITHUB_API}/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(args.workflow)}/dispatches`;
  const dispatchRes = await f(dispatchUrl, {
    method: "POST",
    headers: { ...ghHeaders(args.githubToken), "content-type": "application/json" },
    body: JSON.stringify({ ref: args.ref }),
  });
  if (dispatchRes.status !== 204) {
    const body = await parseBody(dispatchRes);
    throw new Error(friendlyGhError(dispatchRes.status, body));
  }

  // GitHub does not return the run id on dispatch — query for the latest run.
  const runsUrl =
    `${GITHUB_API}/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(args.workflow)}/runs` +
    `?event=workflow_dispatch&branch=${encodeURIComponent(args.ref)}&per_page=5`;
  // Try a handful of times — the run may take a moment to register.
  let lastErr: string | null = null;
  for (let i = 0; i < 6; i++) {
    const r = await f(runsUrl, { method: "GET", headers: ghHeaders(args.githubToken) });
    if (!r.ok) {
      const body = await parseBody(r);
      lastErr = friendlyGhError(r.status, body);
      break;
    }
    const body = await parseBody(r);
    const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    // Pick the newest run created at/after the dispatch moment (minus 5s slack).
    const slack = dispatchedAt - 5_000;
    const candidate = runs.find((rn: any) => {
      const t = Date.parse(rn?.created_at || "");
      return Number.isFinite(t) && t >= slack;
    }) ?? runs[0];
    if (candidate?.id) {
      return {
        runId: Number(candidate.id),
        runUrl: candidate.url,
        htmlUrl: candidate.html_url ||
          `https://github.com/${owner}/${name}/actions/runs/${candidate.id}`,
      };
    }
    // Wait a beat and retry; the test path injects a synchronous fetchImpl so
    // this loop completes immediately when the run is registered on first try.
    if (i < 5) await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(lastErr || "workflow dispatched but could not locate the run id");
}

export interface DeployJobStep {
  name: string;
  status: string;          // queued | in_progress | completed
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DeployRunStatus {
  status: string;          // queued | in_progress | completed
  conclusion: string | null;
  steps: DeployJobStep[];
}

export async function fetchRunStatus(
  args: { repo: string; runId: number; githubToken: string },
  opts: { fetchImpl?: FetchLike } = {}
): Promise<DeployRunStatus> {
  const f: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const [owner, name] = args.repo.split("/");
  const r = await f(
    `${GITHUB_API}/repos/${owner}/${name}/actions/runs/${args.runId}/jobs`,
    { method: "GET", headers: ghHeaders(args.githubToken) }
  );
  if (!r.ok) {
    const body = await parseBody(r);
    throw new Error(friendlyGhError(r.status, body));
  }
  const body = await parseBody(r);
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
  // Flatten across jobs — for the hetzner-deploy workflow there's just one.
  const steps: DeployJobStep[] = [];
  let status = "queued";
  let conclusion: string | null = null;
  for (const j of jobs) {
    status = j.status || status;
    conclusion = j.conclusion ?? conclusion;
    for (const s of j.steps || []) {
      steps.push({
        name: s.name,
        status: s.status,
        conclusion: s.conclusion ?? null,
        startedAt: s.started_at ?? null,
        completedAt: s.completed_at ?? null,
      });
    }
  }
  return { status, conclusion, steps };
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function durationSec(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.max(0, Math.round((tb - ta) / 1000));
}

export async function watchDeploy(
  args: { repo: string; runId: number; githubToken: string; startedAt: number },
  out: (msg: string) => void,
  opts: {
    fetchImpl?: FetchLike;
    pollMs?: number;
    maxPolls?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {}
): Promise<{ ok: boolean; conclusion: string | null }> {
  const pollMs = opts.pollMs ?? 3_000;
  const maxPolls = opts.maxPolls ?? 240;             // ~12min default
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const seen = new Map<string, { startedLogged: boolean; completedLogged: boolean }>();

  for (let i = 0; i < maxPolls; i++) {
    const st = await fetchRunStatus(args, { fetchImpl: opts.fetchImpl });
    for (const step of st.steps) {
      // Skip GitHub's implicit "Set up job"/"Complete job" noise if you like;
      // for now we surface everything.
      const key = step.name;
      const prev = seen.get(key) ?? { startedLogged: false, completedLogged: false };
      const clock = fmtClock(now() - args.startedAt);
      if (!prev.startedLogged && (step.status === "in_progress" || step.status === "completed")) {
        out(`   ${clock}  ${step.name} (in progress)`);
        prev.startedLogged = true;
      }
      if (!prev.completedLogged && step.status === "completed") {
        const d = durationSec(step.startedAt, step.completedAt);
        const tail = d != null ? `completed in ${d}s` : `completed`;
        out(`   ${clock}  ${step.name} (${tail})`);
        prev.completedLogged = true;
      }
      seen.set(key, prev);
    }
    if (st.status === "completed") {
      return { ok: st.conclusion === "success", conclusion: st.conclusion };
    }
    await sleep(pollMs);
  }
  return { ok: false, conclusion: "timeout" };
}

// ---------- Command Handlers ----------

async function handleHostCmd(cfg: Config, rest: string[], out: (msg: string) => void): Promise<number> {
  if (rest[0]) {
    cfg.host = rest[0];
    saveConfig(cfg);
  }
  out(cfg.host);
  return 0;
}

async function handleLoginCmd(cfg: Config, out: (msg: string) => void): Promise<number> {
  const { default: readline } = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const next = await cmdLogin(cfg, (q) => rl.question(q));
    out(`Logged in as ${next.username || "(unknown)"}`);
    return 0;
  } finally {
    rl.close();
  }
}

async function handleRepoCmd(cfg: Config, rest: string[], out: (msg: string) => void): Promise<number> {
  const sub = rest[0];
  if (sub === "ls") {
    return handleRepoLsCmd(cfg, rest, out);
  }
  if (sub === "show") {
    return handleRepoShowCmd(cfg, rest, out);
  }
  if (sub === "create") {
    return handleRepoCreateCmd(cfg, rest, out);
  }
  out("usage: gluecron repo (ls|show|create)");
  return 1;
}

async function handleRepoLsCmd(cfg: Config, rest: string[], out: (msg: string) => void): Promise<number> {
  const userFlagIdx = rest.indexOf("--user");
  const user = userFlagIdx >= 0 && userFlagIdx + 1 < rest.length ? rest[userFlagIdx + 1] : undefined;
  const repos = await cmdRepoLs(cfg, user);
  for (const r of repos) {
    out(`  ${r.owner}/${r.name} · ${r.visibility}`);
  }
  return 0;
}

async function handleRepoShowCmd(cfg: Config, rest: string[], out: (msg: string) => void): Promise<number> {
  const repo = await cmdRepoShow(cfg, rest[1]);
  if (!repo) {
    out("(not found)");
    return 1;
  }
  out(JSON.stringify(repo, null, 2));
  return 0;
}

async function handleRepoCreateCmd(cfg: Config, rest: string[], out: (msg: string) => void): Promise<number> {
  const isPrivate = rest.includes("--private");
  const name = rest.find((x, i) => i > 0 && !x.startsWith("--"));
  if (!name) {
    out("usage: gluecron repo create <name> [--private]");
    return 1;
  }
  const r = await cmdRepoCreate(cfg, name, isPrivate);
  out(JSON.stringify(r, null, 2));
  return 0;
}

async function handleIssuesCmd(cfg: Config, rest: string[], out: (msg: string) => void): Promise<number> {
  if (rest[0] !== "ls" || !rest[1]) {
    out("usage: gluecron issues ls <owner/name>");
    return 1;
  }
  const issues = await cmdIssuesLs(cfg, rest[1]);
  for (const i of issues) {
    out(`  #${i.number} ${i.title}`);
  }
  return 0;
}

async function handleGqlCmd(cfg: Config, rest: string[], out: (msg: string) => void): Promise<number> {
  if (!rest[0]) {
    out("usage: gluecron gql '<query>'");
    return 1;
  }
  const r = await cmdGql(cfg, rest.join(" "));
  out(JSON.stringify(r, null, 2));
  return 0;
}

function readFlag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i >= 0 && i + 1 < rest.length) return rest[i + 1];
  return undefined;
}

export async function handleConfigCmd(
  cfg: Config,
  rest: string[],
  out: (msg: string) => void
): Promise<number> {
  if (rest[0] !== "set" || !rest[1]) {
    out("usage: gluecron config set <key> <value>");
    return 1;
  }
  const key = rest[1];
  const value = rest[2];
  if (value === undefined) {
    out("usage: gluecron config set <key> <value>");
    return 1;
  }
  switch (key) {
    case "github-token":
      cfg.githubToken = value;
      break;
    case "default-repo":
      cfg.defaultRepo = value;
      break;
    case "host":
      cfg.host = value;
      break;
    case "token":
      cfg.token = value;
      break;
    default:
      out(`unknown config key: ${key}`);
      return 1;
  }
  saveConfig(cfg);
  out(`ok: ${key} saved`);
  return 0;
}

export async function handleDeployCmd(
  cfg: Config,
  rest: string[],
  out: (msg: string) => void,
  opts: {
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    pollMs?: number;
    maxPolls?: number;
    now?: () => number;
  } = {}
): Promise<number> {
  const repo = readFlag(rest, "--repo") || cfg.defaultRepo || "ccantynz/Gluecron.com";
  const workflow = readFlag(rest, "--workflow") || "hetzner-deploy.yml";
  const ref = readFlag(rest, "--ref") || "main";
  const noWatch = rest.includes("--no-watch");
  const githubToken =
    readFlag(rest, "--gh-token") ||
    process.env.GLUECRON_GITHUB_TOKEN ||
    cfg.githubToken ||
    "";

  if (!githubToken) {
    out(
      "error: no GitHub token — set GLUECRON_GITHUB_TOKEN or run `gluecron config set github-token <token>`"
    );
    return 1;
  }

  const startedAt = (opts.now ?? Date.now)();
  out(`> Triggering ${workflow} on ${repo}@${ref}`);
  let result: DeployDispatchResult;
  try {
    result = await triggerWorkflowDispatch(
      { repo, workflow, ref, githubToken },
      { fetchImpl: opts.fetchImpl, now: opts.now }
    );
  } catch (err) {
    out(`error: ${(err as Error).message}`);
    return 1;
  }
  out(`> Workflow run dispatched: ${result.htmlUrl}`);

  if (noWatch) return 0;

  out("> Watching deploy status...");
  const watchResult = await watchDeploy(
    { repo, runId: result.runId, githubToken, startedAt },
    out,
    {
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      pollMs: opts.pollMs,
      maxPolls: opts.maxPolls,
      now: opts.now,
    }
  );
  const elapsed = Math.round(((opts.now ?? Date.now)() - startedAt) / 1000);
  if (watchResult.ok) {
    out(`> Deploy succeeded in ${elapsed}s.`);
    return 0;
  }
  out(`! Deploy ${watchResult.conclusion || "failed"} after ${elapsed}s.`);
  return 1;
}

// ---------- Dispatcher ----------

export async function dispatch(argv: string[], out = console.log): Promise<number> {
  const cfg = loadConfig();
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(HELP);
    return 0;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    out(VERSION);
    return 0;
  }

  try {
    switch (cmd) {
      case "host":
        return await handleHostCmd(cfg, rest, out);
      case "login":
        return await handleLoginCmd(cfg, out);
      case "whoami":
        out(await cmdWhoami(cfg));
        return 0;
      case "repo":
        return await handleRepoCmd(cfg, rest, out);
      case "issues":
        return await handleIssuesCmd(cfg, rest, out);
      case "gql":
        return await handleGqlCmd(cfg, rest, out);
      case "deploy":
        return await handleDeployCmd(cfg, rest, out);
      case "commit":
        return await runCommit(rest, { host: cfg.host, token: cfg.token }, { out });
      case "ai":
        if (rest[0] === "commit-msg") {
          return await runAiCommitMsg(
            { host: cfg.host, token: cfg.token },
            { out }
          );
        }
        out("usage: gluecron ai commit-msg");
        return 1;
      case "hook":
        return await runHook(rest, { out });
      case "config":
        return await handleConfigCmd(cfg, rest, out);
      default:
        out(`unknown command: ${cmd}\n`);
        out(HELP);
        return 1;
    }
  } catch (err) {
    out(`error: ${(err as Error).message}`);
    return 1;
  }
}

// Entry
if (import.meta.main) {
  const code = await dispatch(process.argv.slice(2));
  process.exit(code);
}