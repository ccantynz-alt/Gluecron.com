/**
 * Block J1 — Dependency graph.
 *
 * Parses common manifest files and records each dependency as a row in
 * `repo_dependencies`. Per-reindex we REPLACE the whole set for the repo,
 * so querying the table is always a snapshot.
 *
 * Supported ecosystems:
 *   - npm       → package.json (dependencies + devDependencies)
 *   - pypi      → requirements.txt, pyproject.toml (project.dependencies)
 *   - go        → go.mod (require blocks)
 *   - cargo     → Cargo.toml ([dependencies] + [dev-dependencies])
 *   - rubygems  → Gemfile (gem "name", "version")
 *   - composer  → composer.json (require + require-dev)
 *
 * We deliberately do not resolve transitive dependencies — we only surface
 * what's declared in the manifest files. That's the GitHub "dependency
 * graph" contract: authoritative wrt the repo, not wrt the runtime.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  repoDependencies,
  repositories,
  users,
  type RepoDependency,
} from "../db/schema";
import {
  getBlob,
  getDefaultBranch,
  getTree,
  resolveRef,
  type GitTreeEntry,
} from "../git/repository";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type Ecosystem =
  | "npm"
  | "pypi"
  | "go"
  | "rubygems"
  | "cargo"
  | "composer";

export interface ParsedDep {
  ecosystem: Ecosystem;
  name: string;
  versionSpec: string | null;
  isDev: boolean;
}

/**
 * Filename → (content) → ParsedDep[]. Keys are the basename; we match
 * case-insensitively. `manifestPath` (the full path) is attached at a
 * higher level.
 */
const PARSERS: Record<string, (content: string) => ParsedDep[]> = {
  "package.json": parsePackageJson,
  "requirements.txt": parseRequirementsTxt,
  "pyproject.toml": parsePyprojectToml,
  "go.mod": parseGoMod,
  "cargo.toml": parseCargoToml,
  gemfile: parseGemfile,
  "composer.json": parseComposerJson,
};

// ----------------------------------------------------------------------------
// Individual parsers — each is defensive; one bad file does not abort indexing
// ----------------------------------------------------------------------------

export function parsePackageJson(content: string): ParsedDep[] {
  const out: ParsedDep[] = [];
  let obj: any;
  try {
    obj = JSON.parse(content);
  } catch {
    return out;
  }
  if (!obj || typeof obj !== "object") return out;
  for (const [key, isDev] of [
    ["dependencies", false],
    ["devDependencies", true],
    ["peerDependencies", false],
    ["optionalDependencies", false],
  ] as const) {
    const deps = obj[key];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof name !== "string" || !name) continue;
      out.push({
        ecosystem: "npm",
        name,
        versionSpec: typeof spec === "string" ? spec : null,
        isDev,
      });
    }
  }
  return out;
}

export function parseRequirementsTxt(content: string): ParsedDep[] {
  const out: ParsedDep[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    // Skip editable / url installs
    if (line.startsWith("-e ") || line.startsWith("--") || line.startsWith("git+")) continue;
    // Match "name", "name==1.2.3", "name>=1.0,<2.0", "name[extra]==1.0"
    const m = line.match(
      /^([A-Za-z0-9_][A-Za-z0-9_.\-]*)(?:\[[^\]]+\])?\s*([<>=!~].+)?$/
    );
    if (!m) continue;
    out.push({
      ecosystem: "pypi",
      name: m[1],
      versionSpec: m[2] ? m[2].trim() : null,
      isDev: false,
    });
  }
  return out;
}

export function parsePyprojectToml(content: string): ParsedDep[] {
  const out: ParsedDep[] = [];
  // We only look for `[project]` → `dependencies = [...]` and
  // `[project.optional-dependencies]` → `dev = [...]`. Full TOML parsing
  // is overkill — a regex-over-sections pass is sufficient here.
  const sections = splitTomlSections(content);
  const projectDeps = extractTomlArray(sections.project, "dependencies");
  for (const dep of projectDeps) {
    const parsed = pythonRequirementToDep(dep, false);
    if (parsed) out.push(parsed);
  }
  const optDeps = sections["project.optional-dependencies"] || "";
  for (const line of optDeps.split(/\r?\n/)) {
    const keyMatch = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*\[/);
    if (keyMatch) {
      // Consume until closing ]
      const start = line.indexOf("[");
      const tail = line.slice(start);
      const closeIdx = tail.indexOf("]");
      if (closeIdx > -1) {
        const inner = tail.slice(1, closeIdx);
        for (const item of splitTomlArrayItems(inner)) {
          const parsed = pythonRequirementToDep(item, true);
          if (parsed) out.push(parsed);
        }
      }
    }
  }
  return out;
}

function pythonRequirementToDep(
  raw: string,
  isDev: boolean
): ParsedDep | null {
  const s = raw.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  const m = s.match(
    /^([A-Za-z0-9_][A-Za-z0-9_.\-]*)(?:\[[^\]]+\])?\s*([<>=!~].+)?$/
  );
  if (!m) return null;
  return {
    ecosystem: "pypi",
    name: m[1],
    versionSpec: m[2] ? m[2].trim() : null,
    isDev,
  };
}

export function parseGoMod(content: string): ParsedDep[] {
  const out: ParsedDep[] = [];
  // `require (` block or single-line `require foo v1.0.0`
  const blockMatch = content.match(/require\s*\(([\s\S]*?)\)/);
  const lines: string[] = [];
  if (blockMatch) {
    lines.push(...blockMatch[1].split(/\r?\n/));
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const m = rawLine.match(/^\s*require\s+(\S+)\s+(\S+)/);
    if (m) lines.push(`${m[1]} ${m[2]}`);
  }
  for (const rawLine of lines) {
    const line = rawLine.split("//")[0].trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(\S+)(\s+\/\/ indirect)?$/);
    if (!m) continue;
    out.push({
      ecosystem: "go",
      name: m[1],
      versionSpec: m[2],
      isDev: false,
    });
  }
  return out;
}

export function parseCargoToml(content: string): ParsedDep[] {
  const out: ParsedDep[] = [];
  const sections = splitTomlSections(content);
  for (const [header, isDev] of [
    ["dependencies", false],
    ["dev-dependencies", true],
    ["build-dependencies", false],
  ] as const) {
    const body = sections[header];
    if (!body) continue;
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.split("#")[0].trim();
      if (!trimmed) continue;
      // foo = "1.2.3"  OR  foo = { version = "1.2.3" }
      const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
      if (!m) continue;
      const name = m[1];
      const rhs = m[2].trim();
      let versionSpec: string | null = null;
      if (rhs.startsWith('"') || rhs.startsWith("'")) {
        const q = rhs[0];
        const end = rhs.indexOf(q, 1);
        if (end > 0) versionSpec = rhs.slice(1, end);
      } else if (rhs.startsWith("{")) {
        const vm = rhs.match(/version\s*=\s*["']([^"']+)["']/);
        if (vm) versionSpec = vm[1];
      }
      out.push({
        ecosystem: "cargo",
        name,
        versionSpec,
        isDev,
      });
    }
  }
  return out;
}

export function parseGemfile(content: string): ParsedDep[] {
  const out: ParsedDep[] = [];
  let inDevGroup = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    // group :development, :test do
    if (/^group\s+.*(:development|:test)/i.test(line)) {
      inDevGroup = true;
      continue;
    }
    if (/^end\b/.test(line)) {
      inDevGroup = false;
      continue;
    }
    const m = line.match(
      /^gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/
    );
    if (!m) continue;
    out.push({
      ecosystem: "rubygems",
      name: m[1],
      versionSpec: m[2] || null,
      isDev: inDevGroup,
    });
  }
  return out;
}

export function parseComposerJson(content: string): ParsedDep[] {
  const out: ParsedDep[] = [];
  let obj: any;
  try {
    obj = JSON.parse(content);
  } catch {
    return out;
  }
  if (!obj || typeof obj !== "object") return out;
  for (const [key, isDev] of [
    ["require", false],
    ["require-dev", true],
  ] as const) {
    const deps = obj[key];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!name || name === "php") continue;
      out.push({
        ecosystem: "composer",
        name,
        versionSpec: typeof spec === "string" ? spec : null,
        isDev,
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// TOML helpers — intentionally minimal
// ----------------------------------------------------------------------------

function splitTomlSections(content: string): Record<string, string> {
  const out: Record<string, string> = { __root__: "" };
  let current = "__root__";
  for (const rawLine of content.split(/\r?\n/)) {
    const headerMatch = rawLine.match(/^\s*\[([^\]]+)\]\s*$/);
    if (headerMatch) {
      current = headerMatch[1].trim();
      if (!out[current]) out[current] = "";
      continue;
    }
    out[current] = (out[current] || "") + rawLine + "\n";
  }
  // Also expose `project` when it appears at the root.
  if (!out["project"] && out["__root__"]) {
    const m = out["__root__"].match(/\[project\]([\s\S]*)/);
    if (m) out["project"] = m[1];
  }
  return out;
}

function extractTomlArray(body: string | undefined, key: string): string[] {
  if (!body) return [];
  const start = body.search(new RegExp(`^\\s*${key}\\s*=\\s*\\[`, "m"));
  if (start < 0) return [];
  const open = body.indexOf("[", start);
  if (open < 0) return [];
  const close = findMatchingBracket(body, open);
  if (close < 0) return [];
  const inner = body.slice(open + 1, close);
  return splitTomlArrayItems(inner);
}

function findMatchingBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "[") depth++;
    else if (s[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTomlArrayItems(inner: string): string[] {
  // Strip newlines + split by commas; handle simple quoted strings.
  const items: string[] = [];
  let cur = "";
  let inQ: string | null = null;
  for (const ch of inner) {
    if (inQ) {
      cur += ch;
      if (ch === inQ) inQ = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQ = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      if (cur.trim()) items.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) items.push(cur);
  return items.map((s) => s.trim()).filter(Boolean);
}

// ----------------------------------------------------------------------------
// File detection + tree walk
// ----------------------------------------------------------------------------

const MANIFEST_BASENAMES = new Set(Object.keys(PARSERS));
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_MANIFESTS = 200;

export function isManifestPath(path: string): boolean {
  const base = path.split("/").pop()?.toLowerCase() || "";
  return MANIFEST_BASENAMES.has(base);
}

export function parseManifest(
  path: string,
  content: string
): ParsedDep[] {
  const base = path.split("/").pop()?.toLowerCase() || "";
  const parser = PARSERS[base];
  if (!parser) return [];
  try {
    return parser(content);
  } catch {
    return [];
  }
}

async function walkManifestPaths(
  owner: string,
  repo: string,
  ref: string
): Promise<Array<{ path: string; size?: number }>> {
  const out: Array<{ path: string; size?: number }> = [];
  const queue: string[] = [""];
  while (queue.length && out.length < MAX_MANIFESTS) {
    const dir = queue.shift()!;
    let entries: GitTreeEntry[] = [];
    try {
      entries = await getTree(owner, repo, ref, dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = dir ? `${dir}/${e.name}` : e.name;
      if (e.type === "tree") {
        const base = e.name.toLowerCase();
        if (
          base === "node_modules" ||
          base === ".git" ||
          base === "dist" ||
          base === "build" ||
          base === "vendor" ||
          base === "target" ||
          base === "__pycache__"
        ) {
          continue;
        }
        queue.push(p);
      } else if (e.type === "blob") {
        if (!isManifestPath(p)) continue;
        if (e.size !== undefined && e.size > MAX_MANIFEST_BYTES) continue;
        out.push({ path: p, size: e.size });
        if (out.length >= MAX_MANIFESTS) break;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Reindex + queries
// ----------------------------------------------------------------------------

export async function indexRepositoryDependencies(
  repositoryId: string
): Promise<
  | {
      indexed: number;
      manifests: number;
      commitSha: string;
    }
  | null
> {
  try {
    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (!repo) return null;

    const [owner] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, repo.ownerId))
      .limit(1);
    if (!owner) return null;

    const defaultBranch =
      (await getDefaultBranch(owner.username, repo.name)) || "main";
    const head = await resolveRef(owner.username, repo.name, defaultBranch);
    if (!head) return null;

    const manifests = await walkManifestPaths(
      owner.username,
      repo.name,
      head
    );

    const rows: Array<Omit<RepoDependency, "id" | "indexedAt">> = [];
    for (const f of manifests) {
      const blob = await getBlob(owner.username, repo.name, head, f.path).catch(
        () => null
      );
      if (!blob) continue;
      const content =
        typeof blob === "string"
          ? blob
          : new TextDecoder().decode(blob as any);
      const deps = parseManifest(f.path, content);
      for (const dep of deps) {
        rows.push({
          repositoryId,
          ecosystem: dep.ecosystem,
          name: dep.name,
          versionSpec: dep.versionSpec,
          manifestPath: f.path,
          isDev: dep.isDev,
          commitSha: head,
        });
      }
    }

    await db
      .delete(repoDependencies)
      .where(eq(repoDependencies.repositoryId, repositoryId));

    // Insert in chunks to stay under parameter limits.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      if (slice.length) await db.insert(repoDependencies).values(slice);
    }

    return {
      indexed: rows.length,
      manifests: manifests.length,
      commitSha: head,
    };
  } catch (err) {
    console.error("[deps] indexRepositoryDependencies:", err);
    return null;
  }
}

export async function listDependenciesForRepo(
  repositoryId: string
): Promise<RepoDependency[]> {
  try {
    return await db
      .select()
      .from(repoDependencies)
      .where(eq(repoDependencies.repositoryId, repositoryId))
      .orderBy(desc(repoDependencies.ecosystem), desc(repoDependencies.name));
  } catch {
    return [];
  }
}

export interface EcosystemSummary {
  ecosystem: string;
  count: number;
}

export async function summarizeDependencies(
  repositoryId: string
): Promise<EcosystemSummary[]> {
  const rows = await listDependenciesForRepo(repositoryId);
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.ecosystem, (counts.get(r.ecosystem) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([ecosystem, count]) => ({ ecosystem, count }))
    .sort((a, b) => b.count - a.count);
}

/** Look up reverse deps — which repos list this package? (Network graph.) */
export async function repositoriesDependingOn(
  ecosystem: string,
  name: string,
  limit = 50
): Promise<
  Array<{
    repositoryId: string;
    versionSpec: string | null;
    manifestPath: string;
  }>
> {
  try {
    const rows = await db
      .select({
        repositoryId: repoDependencies.repositoryId,
        versionSpec: repoDependencies.versionSpec,
        manifestPath: repoDependencies.manifestPath,
      })
      .from(repoDependencies)
      .where(
        and(
          eq(repoDependencies.ecosystem, ecosystem),
          eq(repoDependencies.name, name)
        )
      )
      .limit(limit);
    return rows;
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------
// Test-only exports
// ----------------------------------------------------------------------------

export const __internal = {
  splitTomlSections,
  extractTomlArray,
  splitTomlArrayItems,
  pythonRequirementToDep,
};
