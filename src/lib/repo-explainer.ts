/**
 * repo-explainer.ts
 *
 * Core AI analysis engine for the "Explain This Repo" feature.
 * Reads the repo's file tree + key files, then calls the Anthropic API
 * (or falls back to heuristic analysis) to produce a structured JSON result.
 *
 * Never throws — all errors produce a degraded-but-valid result.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repoExplainCache, repositories, users } from "../db/schema";
import { getBlob, getTree, getDefaultBranch, resolveRef } from "../git/repository";
import type { GitTreeEntry } from "../git/repository";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntryPoint {
  file: string;
  role: string;
}

export interface SuggestedIssue {
  title: string;
  description: string;
}

export interface ExplainJobResult {
  summary: string;
  techStack: string[];
  architecture: string;
  entryPoints: EntryPoint[];
  gettingStarted: string;
  healthScore: "Elite" | "Strong" | "Improving" | "Needs Attention";
  suggestedIssues: SuggestedIssue[];
}

export interface ExplainJob {
  id: string;
  repoId: string;
  owner: string;
  repo: string;
  status: "running" | "done" | "failed";
  result?: ExplainJobResult;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

// ---------------------------------------------------------------------------
// In-memory job store (per-process; good enough for a single-process Bun app)
// ---------------------------------------------------------------------------

export const explainJobs = new Map<string, ExplainJob>();

// ---------------------------------------------------------------------------
// File sampling config
// ---------------------------------------------------------------------------

const MAX_TOTAL_CHARS = 80_000;
const MAX_FILES = 50;
const MAX_FILE_SIZE = 8_000; // chars per file (2000 lines * ~40 chars/line avg)

const PRIORITY_ROOT_FILES = [
  "README.md",
  "README",
  "readme.md",
  "Readme.md",
  "README.rst",
  "README.txt",
  "CLAUDE.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "Dockerfile",
  "tsconfig.json",
  "bun.lockb",
  ".env.example",
];

const CANDIDATE_SRC_DIRS = ["src", "lib", "app", "server", "backend", "pkg", "cmd"];

// ---------------------------------------------------------------------------
// DB cache helpers
// ---------------------------------------------------------------------------

export async function getCachedExplainResult(
  repoId: string
): Promise<ExplainJobResult | null> {
  try {
    const [row] = await db
      .select()
      .from(repoExplainCache)
      .where(eq(repoExplainCache.repoId, repoId))
      .limit(1);
    if (!row) return null;
    return row.result as ExplainJobResult;
  } catch {
    return null;
  }
}

async function upsertExplainCache(
  repoId: string,
  result: ExplainJobResult
): Promise<void> {
  try {
    // Try update first
    const existing = await db
      .select({ id: repoExplainCache.id })
      .from(repoExplainCache)
      .where(eq(repoExplainCache.repoId, repoId))
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(repoExplainCache)
        .set({ result, createdAt: new Date() })
        .where(eq(repoExplainCache.id, existing[0].id));
    } else {
      await db.insert(repoExplainCache).values({ repoId, result });
    }
  } catch {
    // Swallow — cache miss is not a fatal error
  }
}

// ---------------------------------------------------------------------------
// Repo resolution helpers
// ---------------------------------------------------------------------------

export async function resolveRepoForExplain(
  owner: string,
  repoName: string
): Promise<{ repoId: string; ownerId: string } | null> {
  try {
    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, owner))
      .limit(1);
    if (!ownerRow) return null;

    const [repoRow] = await db
      .select({ id: repositories.id, ownerId: repositories.ownerId })
      .from(repositories)
      .where(and(eq(repositories.ownerId, ownerRow.id), eq(repositories.name, repoName)))
      .limit(1);
    if (!repoRow) return null;

    return { repoId: repoRow.id, ownerId: repoRow.ownerId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point: kick off an explain job asynchronously
// ---------------------------------------------------------------------------

export function startExplainJob(
  jobId: string,
  owner: string,
  repoName: string,
  repoId: string
): void {
  const job: ExplainJob = {
    id: jobId,
    repoId,
    owner,
    repo: repoName,
    status: "running",
    createdAt: new Date(),
  };
  explainJobs.set(jobId, job);

  // Fire-and-forget
  runExplainJob(job, owner, repoName, repoId).catch(() => {
    const j = explainJobs.get(jobId);
    if (j) {
      j.status = "failed";
      j.error = "Unexpected error during analysis";
      j.completedAt = new Date();
    }
  });
}

async function runExplainJob(
  job: ExplainJob,
  owner: string,
  repoName: string,
  repoId: string
): Promise<void> {
  try {
    const result = await explainRepo(owner, repoName);
    await upsertExplainCache(repoId, result);
    job.result = result;
    job.status = "done";
    job.completedAt = new Date();
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : "Analysis failed";
    job.completedAt = new Date();
  }
}

// ---------------------------------------------------------------------------
// Core analysis function
// ---------------------------------------------------------------------------

export async function explainRepo(
  owner: string,
  repoName: string
): Promise<ExplainJobResult> {
  const branch = await getDefaultBranch(owner, repoName);
  if (!branch) {
    return buildHeuristicResult(owner, repoName, null, []);
  }

  const sha = await resolveRef(owner, repoName, branch);
  if (!sha) {
    return buildHeuristicResult(owner, repoName, null, []);
  }

  const samples = await gatherRepresentativeFiles(owner, repoName, sha);

  const apiKey = config.anthropicApiKey;
  if (apiKey && samples.files.length > 0) {
    try {
      return await callAnthropicForStructuredResult(
        owner,
        repoName,
        samples,
        apiKey
      );
    } catch {
      // Fall through to heuristic
    }
  }

  return buildHeuristicResult(owner, repoName, samples.packageJson, samples.topLevelTree);
}

// ---------------------------------------------------------------------------
// File gathering
// ---------------------------------------------------------------------------

interface SampledFile {
  path: string;
  content: string;
}

interface Samples {
  files: SampledFile[];
  topLevelTree: GitTreeEntry[];
  packageJson: Record<string, unknown> | null;
}

async function gatherRepresentativeFiles(
  owner: string,
  repo: string,
  sha: string
): Promise<Samples> {
  const out: SampledFile[] = [];
  let totalChars = 0;
  const seen = new Set<string>();

  let root: GitTreeEntry[] = [];
  try {
    root = await getTree(owner, repo, sha, "");
  } catch {
    root = [];
  }

  async function tryAdd(path: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    if (totalChars >= MAX_TOTAL_CHARS) return;
    if (seen.has(path)) return;
    seen.add(path);
    try {
      const blob = await getBlob(owner, repo, sha, path);
      if (!blob || blob.isBinary) return;
      if (!blob.content) return;
      const snippet = blob.content.slice(0, Math.min(MAX_FILE_SIZE, MAX_TOTAL_CHARS - totalChars));
      if (!snippet) return;
      out.push({ path, content: snippet });
      totalChars += snippet.length;
    } catch {
      /* skip */
    }
  }

  // 1. Priority root-level files
  for (const name of PRIORITY_ROOT_FILES) {
    if (root.find((e) => e.type === "blob" && e.name === name)) {
      await tryAdd(name);
    }
  }

  // 2. Other manifest/config files at root
  for (const entry of root) {
    if (out.length >= MAX_FILES) break;
    if (entry.type !== "blob") continue;
    if (seen.has(entry.name)) continue;
    if (!looksLikeManifest(entry.name)) continue;
    await tryAdd(entry.name);
  }

  // 3. Entry-point files in common src dirs
  for (const dir of CANDIDATE_SRC_DIRS) {
    if (out.length >= MAX_FILES) break;
    if (totalChars >= MAX_TOTAL_CHARS) break;
    const dirEntry = root.find((e) => e.type === "tree" && e.name === dir);
    if (!dirEntry) continue;
    let children: GitTreeEntry[] = [];
    try {
      children = await getTree(owner, repo, sha, dir);
    } catch {
      children = [];
    }
    const entryNames = [
      "index.ts", "index.tsx", "index.js", "main.ts", "main.tsx", "main.js",
      "app.ts", "app.tsx", "mod.rs", "lib.rs", "__init__.py", "main.py",
      "server.ts", "server.js",
    ];
    for (const name of entryNames) {
      const hit = children.find((e) => e.type === "blob" && e.name === name);
      if (hit) await tryAdd(`${dir}/${name}`);
    }
    for (const child of children) {
      if (out.length >= MAX_FILES) break;
      if (totalChars >= MAX_TOTAL_CHARS) break;
      if (child.type !== "blob") continue;
      if (!isLikelySource(child.name)) continue;
      await tryAdd(`${dir}/${child.name}`);
    }
  }

  // 4. Remaining top-level source files
  for (const entry of root) {
    if (out.length >= MAX_FILES) break;
    if (totalChars >= MAX_TOTAL_CHARS) break;
    if (entry.type !== "blob") continue;
    if (!isLikelySource(entry.name)) continue;
    await tryAdd(entry.name);
  }

  let pkg: Record<string, unknown> | null = null;
  const packageFile = out.find((f) => f.path === "package.json");
  if (packageFile) {
    try {
      pkg = JSON.parse(packageFile.content) as Record<string, unknown>;
    } catch {
      pkg = null;
    }
  }

  return { files: out, topLevelTree: root, packageJson: pkg };
}

function looksLikeManifest(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".toml") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".json") ||
    lower === "makefile" ||
    lower === "dockerfile" ||
    lower === "procfile"
  );
}

function isLikelySource(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower.endsWith(".py") ||
    lower.endsWith(".rs") ||
    lower.endsWith(".go") ||
    lower.endsWith(".rb") ||
    lower.endsWith(".java") ||
    lower.endsWith(".kt") ||
    lower.endsWith(".swift") ||
    lower.endsWith(".c") ||
    lower.endsWith(".cc") ||
    lower.endsWith(".cpp") ||
    lower.endsWith(".h") ||
    lower.endsWith(".hpp")
  );
}

// ---------------------------------------------------------------------------
// Anthropic API call — structured JSON result
// ---------------------------------------------------------------------------

async function callAnthropicForStructuredResult(
  owner: string,
  repoName: string,
  samples: Samples,
  apiKey: string
): Promise<ExplainJobResult> {
  const treeListing = samples.topLevelTree
    .slice(0, 80)
    .map((e) => (e.type === "tree" ? `${e.name}/` : e.name))
    .join("\n");

  const fileContents = samples.files
    .map((f) => `----- FILE: ${f.path} -----\n${f.content}`)
    .join("\n\n");

  const systemPrompt = `You are a senior software architect. Analyze this codebase and return a JSON object with the following keys (no markdown wrapper, just raw JSON):

{
  "summary": "2-3 sentence plain-English overview of what this project is and does",
  "techStack": ["array", "of", "technology", "names", "detected"],
  "architecture": "Markdown description of the architecture — folder layout, key patterns, data flows. Use bullet points or a short diagram.",
  "entryPoints": [
    {"file": "src/index.ts", "role": "Server entry point — starts the HTTP server"},
    {"file": "src/app.tsx", "role": "Hono app — middleware + route composition"}
  ],
  "gettingStarted": "Step-by-step Markdown guide for a new developer to get the project running locally",
  "healthScore": "one of: Elite | Strong | Improving | Needs Attention",
  "suggestedIssues": [
    {"title": "Short issue title", "description": "1-2 sentence description of the improvement"},
    {"title": "Another issue", "description": "Why this matters for the project"},
    {"title": "Third suggestion", "description": "Concrete actionable task"}
  ]
}

Rules:
- techStack: include runtime, language, framework, DB, and notable libraries
- healthScore: base on code quality signals visible in the files (tests, docs, types, CI)
- suggestedIssues: exactly 3 items, actionable and specific to THIS codebase
- Be specific to what you see in the code — do not invent features
- Return ONLY the JSON object, nothing else`;

  const userContent = `Repository: ${owner}/${repoName}

File tree:
\`\`\`
${treeListing || "(empty)"}
\`\`\`

Key files:
${fileContents}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content?.find((b) => b.type === "text")?.text ?? "";

  // Parse JSON — handle possible ```json fences
  let parsed: ExplainJobResult | null = null;
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    try {
      parsed = JSON.parse(fenced[1]) as ExplainJobResult;
    } catch {
      // fall through
    }
  }
  if (!parsed) {
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        parsed = JSON.parse(braceMatch[0]) as ExplainJobResult;
      } catch {
        // fall through
      }
    }
  }

  if (!parsed) {
    throw new Error("Failed to parse structured JSON from AI response");
  }

  return normalizeResult(parsed, owner, repoName, samples);
}

// ---------------------------------------------------------------------------
// Heuristic fallback (no API key or API failure)
// ---------------------------------------------------------------------------

function buildHeuristicResult(
  owner: string,
  repoName: string,
  pkg: Record<string, unknown> | null,
  topLevelTree: GitTreeEntry[]
): ExplainJobResult {
  const description =
    pkg && typeof pkg.description === "string" && pkg.description.trim()
      ? pkg.description.trim()
      : `The ${owner}/${repoName} repository.`;

  const techStack = detectTechStackHeuristic(pkg, topLevelTree);
  const scripts =
    pkg && pkg.scripts && typeof pkg.scripts === "object"
      ? Object.keys(pkg.scripts as Record<string, unknown>)
      : [];

  const gettingStartedLines: string[] = [
    "```bash",
    "# Clone the repo",
    `git clone <repo-url> && cd ${repoName}`,
    "",
  ];
  if (scripts.includes("install") || pkg?.dependencies || pkg?.devDependencies) {
    gettingStartedLines.push("# Install dependencies");
    gettingStartedLines.push(pkg ? "bun install  # or npm install" : "# see README");
    gettingStartedLines.push("");
  }
  if (scripts.includes("dev")) {
    gettingStartedLines.push("# Start dev server");
    gettingStartedLines.push("bun dev");
  } else if (scripts.includes("start")) {
    gettingStartedLines.push("bun start");
  } else {
    gettingStartedLines.push("# See README for run instructions");
  }
  gettingStartedLines.push("```");

  const entryPoints: EntryPoint[] = topLevelTree
    .filter((e) => e.type === "blob" && isLikelySource(e.name))
    .slice(0, 5)
    .map((e) => ({ file: e.name, role: "Top-level source file" }));

  return {
    summary: description,
    techStack,
    architecture:
      "Architecture analysis requires an `ANTHROPIC_API_KEY` to be configured. " +
      "The heuristic scan detected the technologies listed in the Tech Stack section.\n\n" +
      "Top-level layout:\n\n" +
      topLevelTree
        .slice(0, 20)
        .map((e) => `- \`${e.name}${e.type === "tree" ? "/" : ""}\``)
        .join("\n"),
    entryPoints: entryPoints.length > 0 ? entryPoints : [
      { file: "See README", role: "Entry point not auto-detected" },
    ],
    gettingStarted: gettingStartedLines.join("\n"),
    healthScore: "Improving",
    suggestedIssues: [
      {
        title: "Add ANTHROPIC_API_KEY for AI-powered analysis",
        description:
          "Set the ANTHROPIC_API_KEY environment variable to enable full AI-powered codebase analysis, architecture diagrams, and smart onboarding suggestions.",
      },
      {
        title: "Add a comprehensive README",
        description:
          "A good README with setup steps, architecture overview, and contributing guidelines helps new developers onboard faster.",
      },
      {
        title: "Add automated tests",
        description:
          "A test suite with good coverage makes it safe to refactor and ship faster with confidence.",
      },
    ],
  };
}

function detectTechStackHeuristic(
  pkg: Record<string, unknown> | null,
  topLevelTree: GitTreeEntry[]
): string[] {
  const stack: string[] = [];
  const names = topLevelTree.map((e) => e.name.toLowerCase());

  if (names.includes("package.json") || names.includes("bun.lockb")) {
    stack.push("TypeScript", "Node.js");
    if (names.includes("bun.lockb")) stack.push("Bun");
  }
  if (names.includes("cargo.toml")) stack.push("Rust");
  if (names.includes("go.mod")) stack.push("Go");
  if (names.includes("pyproject.toml") || names.includes("requirements.txt")) stack.push("Python");
  if (names.includes("gemfile")) stack.push("Ruby");
  if (names.includes("pom.xml") || names.includes("build.gradle")) stack.push("Java");
  if (names.includes("dockerfile")) stack.push("Docker");

  if (pkg) {
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    const dkeys = Object.keys(deps);
    if (dkeys.includes("hono")) stack.push("Hono");
    if (dkeys.includes("react") || dkeys.includes("react-dom")) stack.push("React");
    if (dkeys.includes("next")) stack.push("Next.js");
    if (dkeys.includes("drizzle-orm")) stack.push("Drizzle ORM");
    if (dkeys.some((k) => k.includes("postgres") || k.includes("pg") || k.includes("neon")))
      stack.push("PostgreSQL");
    if (dkeys.includes("sqlite") || dkeys.includes("better-sqlite3"))
      stack.push("SQLite");
    if (dkeys.includes("express")) stack.push("Express");
    if (dkeys.includes("fastify")) stack.push("Fastify");
    if (dkeys.includes("vite")) stack.push("Vite");
    if (dkeys.includes("tailwindcss")) stack.push("Tailwind CSS");
    if (dkeys.some((k) => k.startsWith("@anthropic"))) stack.push("Anthropic Claude");
  }

  return [...new Set(stack)].slice(0, 12);
}

// ---------------------------------------------------------------------------
// Normalize AI result — fill in any missing fields
// ---------------------------------------------------------------------------

function normalizeResult(
  raw: Partial<ExplainJobResult>,
  owner: string,
  repoName: string,
  samples: Samples
): ExplainJobResult {
  const validScores = ["Elite", "Strong", "Improving", "Needs Attention"] as const;

  return {
    summary: typeof raw.summary === "string" && raw.summary
      ? raw.summary
      : `The ${owner}/${repoName} repository.`,
    techStack: Array.isArray(raw.techStack) ? raw.techStack.slice(0, 15) : [],
    architecture: typeof raw.architecture === "string" && raw.architecture
      ? raw.architecture
      : "_Architecture not detected._",
    entryPoints: Array.isArray(raw.entryPoints)
      ? (raw.entryPoints as EntryPoint[]).slice(0, 10)
      : [],
    gettingStarted: typeof raw.gettingStarted === "string" && raw.gettingStarted
      ? raw.gettingStarted
      : "_See README for setup instructions._",
    healthScore:
      validScores.includes(raw.healthScore as typeof validScores[number])
        ? (raw.healthScore as ExplainJobResult["healthScore"])
        : "Improving",
    suggestedIssues: Array.isArray(raw.suggestedIssues)
      ? (raw.suggestedIssues as SuggestedIssue[]).slice(0, 3)
      : [],
  };
}
