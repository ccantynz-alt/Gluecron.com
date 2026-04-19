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

const VERSION = "0.1.0";
const DEFAULT_HOST = process.env.GLUECRON_HOST || "http://localhost:3000";
const CONFIG_DIR = join(homedir(), ".gluecron");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// ---------- Config ----------

interface Config {
  host: string;
  token?: string;
  username?: string;
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
  gluecron version                     Print version
  gluecron help                        Print this help

Env:
  GLUECRON_HOST  override the server URL (default: ${DEFAULT_HOST})
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