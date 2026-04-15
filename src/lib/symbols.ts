/**
 * Block I8 — Symbol / xref navigation.
 *
 * A pragmatic regex-based top-level symbol extractor. Runs per-language,
 * catches the common definition shapes (function / class / interface /
 * type / const). References are computed at lookup-time by grepping the
 * repository's tree for the symbol name, so this module persists only
 * definitions. Never throws into request path.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { codeSymbols, repositories, users } from "../db/schema";
import { getBlob, getTree, getDefaultBranch, resolveRef } from "../git/repository";
import type { CodeSymbol } from "../db/schema";
import type { GitTreeEntry } from "../git/repository";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "variable";

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  signature: string;
}

type Rule = { kind: SymbolKind; re: RegExp };

// ---------- Language detection ----------

const EXT_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  py: "py",
  rs: "rs",
  go: "go",
  rb: "rb",
  java: "java",
  kt: "kt",
  swift: "swift",
};

export function detectLanguage(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return EXT_LANG[ext] ?? null;
}

// ---------- Per-language rules ----------

const RULES: Record<string, Rule[]> = {
  ts: [
    {
      kind: "function",
      re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: "function",
      re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
    },
    {
      kind: "function",
      re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*:\s*[^=]+=\s*(?:async\s*)?\(/,
    },
    {
      kind: "class",
      re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: "interface",
      re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: "type",
      re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
    },
    {
      kind: "const",
      re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
    },
  ],
  py: [
    { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/ },
    { kind: "class", re: /^\s*class\s+([A-Za-z_][\w]*)\s*[:(]/ },
    { kind: "const", re: /^([A-Z_][A-Z0-9_]*)\s*=/ },
  ],
  rs: [
    { kind: "function", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
    { kind: "class", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/ },
    { kind: "interface", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/ },
    { kind: "type", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][\w]*)\s*=/ },
    { kind: "const", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*:/ },
  ],
  go: [
    { kind: "function", re: /^\s*func(?:\s+\([^)]*\))?\s+([A-Za-z_][\w]*)\s*\(/ },
    { kind: "class", re: /^\s*type\s+([A-Za-z_][\w]*)\s+struct\b/ },
    { kind: "interface", re: /^\s*type\s+([A-Za-z_][\w]*)\s+interface\b/ },
    { kind: "type", re: /^\s*type\s+([A-Za-z_][\w]*)\s+\w/ },
    { kind: "const", re: /^\s*const\s+([A-Za-z_][\w]*)\s*=/ },
  ],
  rb: [
    { kind: "function", re: /^\s*def\s+(?:self\.)?([A-Za-z_][\w?!=]*)/ },
    { kind: "class", re: /^\s*class\s+([A-Z][\w]*)/ },
  ],
  java: [
    {
      kind: "class",
      re: /^\s*(?:public|private|protected)?\s*(?:abstract\s+|final\s+)?class\s+([A-Z][\w]*)/,
    },
    {
      kind: "interface",
      re: /^\s*(?:public|private|protected)?\s*interface\s+([A-Z][\w]*)/,
    },
  ],
  kt: [
    { kind: "function", re: /^\s*(?:public|private|internal)?\s*fun\s+([A-Za-z_][\w]*)/ },
    { kind: "class", re: /^\s*(?:public|private|internal)?\s*class\s+([A-Z][\w]*)/ },
  ],
  swift: [
    { kind: "function", re: /^\s*(?:public|private|fileprivate|internal)?\s*func\s+([A-Za-z_][\w]*)/ },
    { kind: "class", re: /^\s*(?:public|private|fileprivate|internal)?\s*class\s+([A-Z][\w]*)/ },
    { kind: "interface", re: /^\s*(?:public|private|fileprivate|internal)?\s*protocol\s+([A-Z][\w]*)/ },
  ],
};

// ---------- Extractor ----------

/** Pure — extract top-level symbol definitions from a single file. */
export function extractSymbols(
  content: string,
  lang: string
): ExtractedSymbol[] {
  const rules = RULES[lang];
  if (!rules) return [];
  const out: ExtractedSymbol[] = [];
  const seen = new Set<string>();
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 500) continue; // skip minified lines
    for (const rule of rules) {
      const m = line.match(rule.re);
      if (m && m[1]) {
        const key = `${rule.kind}:${m[1]}:${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          name: m[1],
          kind: rule.kind,
          line: i + 1,
          signature: line.trim().slice(0, 240),
        });
        break; // one match per line
      }
    }
  }
  return out;
}

// ---------- Indexer ----------

const INDEXABLE_MAX_BYTES = 1_000_000; // skip files over 1MB
const MAX_FILES = 2_000; // cap per reindex

async function walkCodePaths(
  owner: string,
  repo: string,
  ref: string,
  maxFiles = MAX_FILES
): Promise<Array<{ path: string; size?: number }>> {
  const out: Array<{ path: string; size?: number }> = [];
  const queue: string[] = [""];
  while (queue.length && out.length < maxFiles) {
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
          base === ".next" ||
          base === ".turbo" ||
          base === "target" ||
          base === "__pycache__"
        ) {
          continue;
        }
        queue.push(p);
      } else if (e.type === "blob") {
        if (!detectLanguage(p)) continue;
        if (e.size !== undefined && e.size > INDEXABLE_MAX_BYTES) continue;
        out.push({ path: p, size: e.size });
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

/** Walks the repo tree at HEAD, extracts symbols, replaces the prior set. */
export async function indexRepositorySymbols(
  repositoryId: string
): Promise<{ indexed: number; files: number; commitSha: string } | null> {
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

    const files = await walkCodePaths(owner.username, repo.name, head);

    const rows: Array<Omit<CodeSymbol, "id" | "createdAt">> = [];
    let processed = 0;

    for (const f of files) {
      const lang = detectLanguage(f.path);
      if (!lang) continue;
      try {
        const blob = await getBlob(owner.username, repo.name, head, f.path);
        if (!blob || blob.isBinary) continue;
        const syms = extractSymbols(blob.content, lang);
        for (const s of syms) {
          rows.push({
            repositoryId: repo.id,
            commitSha: head,
            name: s.name,
            kind: s.kind,
            path: f.path,
            line: s.line,
            signature: s.signature,
          });
        }
        processed++;
      } catch {
        // skip unreadable files
      }
    }

    // Replace the prior index (DELETE + batched INSERTs).
    await db.delete(codeSymbols).where(eq(codeSymbols.repositoryId, repo.id));
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      await db.insert(codeSymbols).values(rows.slice(i, i + BATCH));
    }

    return { indexed: rows.length, files: processed, commitSha: head };
  } catch (err) {
    console.error("[symbols] indexRepositorySymbols error:", err);
    return null;
  }
}

/** Find definitions of a symbol name within a repo. */
export async function findDefinitions(
  repositoryId: string,
  name: string
): Promise<CodeSymbol[]> {
  try {
    return await db
      .select()
      .from(codeSymbols)
      .where(
        and(eq(codeSymbols.repositoryId, repositoryId), eq(codeSymbols.name, name))
      );
  } catch {
    return [];
  }
}

/** Count total indexed symbols for a repo (pagination helper). */
export async function countSymbolsForRepo(
  repositoryId: string
): Promise<number> {
  try {
    const rows = await db
      .select({ id: codeSymbols.id })
      .from(codeSymbols)
      .where(eq(codeSymbols.repositoryId, repositoryId));
    return rows.length;
  } catch {
    return 0;
  }
}

// Test-only hook
export const __internal = { RULES, EXT_LANG };
