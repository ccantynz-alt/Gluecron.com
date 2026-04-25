/**
 * Block D6 — AI-generated "Explain this codebase" feature.
 *
 * Given a repo + commit sha, gathers a representative sample of files
 * (README, manifest, top-level and main sources) and asks Claude to
 * produce a concise Markdown overview. Results are cached per-sha in
 * the `codebase_explanations` table so repeat views are free.
 *
 * Exposed functions never throw — any failure returns a safe fallback
 * shape so the route handler can render something sensible.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { codebaseExplanations } from "../db/schema";
import { getBlob, getTree } from "../git/repository";
import type { GitTreeEntry } from "../git/repository";
import {
  MODEL_SONNET,
  extractText,
  getAnthropic,
  isAiAvailable,
} from "./ai-client";

export interface ExplainArgs {
  owner: string;
  repo: string;
  repositoryId: string;
  commitSha: string;
  force?: boolean;
}

export interface ExplainResult {
  summary: string;
  markdown: string;
  model: string;
  cached: boolean;
}

/** Rough budget for total characters collected from the tree. */
const MAX_TOTAL_CHARS = 60_000;
/** Cap on number of files sampled. */
const MAX_FILES = 25;
/** Skip files bigger than this before even reading them. */
const MAX_FILE_SIZE = 32_000;

const FALLBACK: ExplainResult = {
  summary: "",
  markdown: "_Unable to generate explanation._",
  model: "fallback",
  cached: false,
};

/**
 * Read the cached explanation row for a repo + commit, if present.
 * Returns `null` on cache miss or any DB failure.
 */
export async function getCachedExplanation(
  repositoryId: string,
  commitSha: string
): Promise<ExplainResult | null> {
  try {
    const [row] = await db
      .select()
      .from(codebaseExplanations)
      .where(
        and(
          eq(codebaseExplanations.repositoryId, repositoryId),
          eq(codebaseExplanations.commitSha, commitSha)
        )
      )
      .limit(1);
    if (!row) return null;
    return {
      summary: row.summary,
      markdown: row.markdown,
      model: row.model,
      cached: true,
    };
  } catch {
    return null;
  }
}

/**
 * Produce (or return a cached) explanation for a codebase at a commit.
 * Never throws.
 */
export async function explainCodebase(
  args: ExplainArgs
): Promise<ExplainResult> {
  try {
    if (!args.force) {
      const cached = await getCachedExplanation(
        args.repositoryId,
        args.commitSha
      );
      if (cached) return cached;
    }

    // Gather a representative slice of the tree.
    const samples = await gatherRepresentativeFiles(
      args.owner,
      args.repo,
      args.commitSha
    );

    // If we couldn't read any files AND can't call Claude, there's nothing
    // useful to say — return the canonical unable-to-generate marker so the
    // UI can render a friendly message.
    if (samples.files.length === 0 && !isAiAvailable()) {
      return { ...FALLBACK };
    }

    let result: { summary: string; markdown: string; model: string };
    if (isAiAvailable() && samples.files.length > 0) {
      try {
        result = await callClaude(args.owner, args.repo, samples);
      } catch {
        result = buildFallbackMarkdown(args.owner, args.repo, samples);
      }
    } else {
      result = buildFallbackMarkdown(args.owner, args.repo, samples);
    }

    // Best-effort upsert; never let cache writes break the response.
    try {
      await upsertExplanation(
        args.repositoryId,
        args.commitSha,
        result.summary,
        result.markdown,
        result.model
      );
    } catch {
      /* swallow — we still return the fresh result */
    }

    return { ...result, cached: false };
  } catch {
    return { ...FALLBACK };
  }
}

async function upsertExplanation(
  repositoryId: string,
  commitSha: string,
  summary: string,
  markdown: string,
  model: string
): Promise<void> {
  // Try update first; if no rows, insert. Avoids needing onConflict helpers.
  const existing = await db
    .select({ id: codebaseExplanations.id })
    .from(codebaseExplanations)
    .where(
      and(
        eq(codebaseExplanations.repositoryId, repositoryId),
        eq(codebaseExplanations.commitSha, commitSha)
      )
    )
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(codebaseExplanations)
      .set({ summary, markdown, model, generatedAt: new Date() })
      .where(eq(codebaseExplanations.id, existing[0].id));
  } else {
    await db.insert(codebaseExplanations).values({
      repositoryId,
      commitSha,
      summary,
      markdown,
      model,
    });
  }
}

// ---------------------------------------------------------------------------
// Tree sampling
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

const PRIORITY_ROOT_FILES = [
  "README.md",
  "README",
  "readme.md",
  "Readme.md",
  "README.rst",
  "README.txt",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "Dockerfile",
  "tsconfig.json",
];

const CANDIDATE_SRC_DIRS = ["src", "lib", "app", "server", "backend", "pkg"];

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
      if (blob.size && blob.size > MAX_FILE_SIZE) {
        const snippet = blob.content.slice(0, MAX_FILE_SIZE);
        out.push({ path, content: snippet });
        totalChars += snippet.length;
        return;
      }
      const content = blob.content.slice(
        0,
        Math.max(0, MAX_TOTAL_CHARS - totalChars)
      );
      if (!content) return;
      out.push({ path, content });
      totalChars += content.length;
    } catch {
      /* skip file */
    }
  }

  // 1. Root-level priority files.
  for (const name of PRIORITY_ROOT_FILES) {
    if (root.find((e) => e.type === "blob" && e.name === name)) {
      await tryAdd(name);
    }
  }

  // 2. Any other top-level config-ish blob the priority list missed.
  for (const entry of root) {
    if (out.length >= MAX_FILES) break;
    if (entry.type !== "blob") continue;
    if (seen.has(entry.name)) continue;
    if (!looksLikeManifest(entry.name)) continue;
    await tryAdd(entry.name);
  }

  // 3. Index/main entry files within common source directories.
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
    // Prefer entry-point names at top of that dir.
    const entryNames = [
      "index.ts",
      "index.tsx",
      "index.js",
      "main.ts",
      "main.tsx",
      "main.js",
      "app.ts",
      "app.tsx",
      "mod.rs",
      "lib.rs",
      "__init__.py",
      "main.py",
      "server.ts",
      "server.js",
    ];
    for (const name of entryNames) {
      const hit = children.find((e) => e.type === "blob" && e.name === name);
      if (hit) await tryAdd(`${dir}/${name}`);
    }
    // Pull a few more source files from this directory to give context.
    for (const child of children) {
      if (out.length >= MAX_FILES) break;
      if (totalChars >= MAX_TOTAL_CHARS) break;
      if (child.type !== "blob") continue;
      if (!isLikelySource(child.name)) continue;
      await tryAdd(`${dir}/${child.name}`);
    }
  }

  // 4. As a last resort, pull any remaining top-level source blobs.
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
// Claude prompt + fallback
// ---------------------------------------------------------------------------

async function callClaude(
  owner: string,
  repo: string,
  samples: Samples
): Promise<{ summary: string; markdown: string; model: string }> {
  const client = getAnthropic();
  const treeListing = samples.topLevelTree
    .slice(0, 80)
    .map((e) => (e.type === "tree" ? `${e.name}/` : e.name))
    .join("\n");

  const fileBlob = samples.files
    .map(
      (f) =>
        `----- FILE: ${f.path} -----\n${f.content.slice(0, 10_000)}`
    )
    .join("\n\n");

  const prompt = `You are documenting an open-source repository named "${owner}/${repo}".

Based on the top-level tree and the files below, write a concise, helpful Markdown overview for a new contributor. Use GitHub-flavoured Markdown.

Start with exactly one line: a single-sentence summary of what this project is, on its own (no heading, no bold).

Then the following sections, in order, each as an H2 header:

## What this project does
A short paragraph expanding on the summary. Focus on the user-visible value.

## Architecture
A short paragraph or bullet list describing how the code is organised and which pieces talk to which. Mention the language/runtime.

## Key modules
A bulleted list of the most important files or directories with a one-sentence explanation each. Use backticks for paths.

## Build + run
A short list of commands a developer would run to build and start the project, inferred from the manifest or README. If unsure, say so.

Keep the whole response under ~800 words. Do not invent features that are not visible. Do not include a top-level H1.

Top-level tree:
\`\`\`
${treeListing || "(empty)"}
\`\`\`

Representative files:
${fileBlob}`;

  const { recordAi } = await import("./ai-flywheel");
  const message = await recordAi(
    {
      actionType: "explain",
      model: MODEL_SONNET,
      summary: `explain codebase`,
      metadata: { files: samples.files.length },
    },
    () =>
      client.messages.create({
        model: MODEL_SONNET,
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      })
  );

  const markdown = extractText(message).trim();
  const summary = extractSummary(markdown);
  return { summary, markdown, model: MODEL_SONNET };
}

function extractSummary(markdown: string): string {
  if (!markdown) return "";
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("```")) continue;
    return line.replace(/^[*_>]+|[*_>]+$/g, "").slice(0, 280);
  }
  return "";
}

function buildFallbackMarkdown(
  owner: string,
  repo: string,
  samples: Samples
): { summary: string; markdown: string; model: string } {
  const pkg = samples.packageJson;
  const nameRaw = pkg && typeof pkg.name === "string" ? pkg.name : `${owner}/${repo}`;
  const description =
    pkg && typeof pkg.description === "string" && pkg.description.trim()
      ? pkg.description.trim()
      : `The ${owner}/${repo} repository.`;

  const scripts =
    pkg && pkg.scripts && typeof pkg.scripts === "object"
      ? Object.keys(pkg.scripts as Record<string, unknown>)
      : [];

  const treeLines = samples.topLevelTree
    .slice(0, 40)
    .map((e) => `- \`${e.name}${e.type === "tree" ? "/" : ""}\``);

  const lines: string[] = [];
  lines.push(description);
  lines.push("");
  lines.push("## What this project does");
  lines.push("");
  lines.push(
    pkg
      ? `\`${nameRaw}\` — ${description}`
      : `${description} An automatically-generated overview is shown here because no AI backend is configured.`
  );
  lines.push("");
  lines.push("## Architecture");
  lines.push("");
  lines.push(
    samples.topLevelTree.length > 0
      ? "Top-level layout of the repository:"
      : "(No files found at the default commit.)"
  );
  if (treeLines.length > 0) {
    lines.push("");
    lines.push(...treeLines);
  }
  lines.push("");
  lines.push("## Key modules");
  lines.push("");
  if (samples.files.length === 0) {
    lines.push("- _No representative files could be sampled._");
  } else {
    for (const f of samples.files.slice(0, 10)) {
      lines.push(`- \`${f.path}\``);
    }
  }
  lines.push("");
  lines.push("## Build + run");
  lines.push("");
  if (scripts.length > 0) {
    lines.push("Detected package scripts:");
    lines.push("");
    for (const s of scripts.slice(0, 12)) {
      lines.push(`- \`npm run ${s}\``);
    }
  } else {
    lines.push(
      "No build scripts were detected automatically. See the README for build instructions."
    );
  }

  const markdown = lines.join("\n");
  return { summary: description, markdown, model: "fallback" };
}
