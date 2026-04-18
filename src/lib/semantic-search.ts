/**
 * Block D1 — Semantic code search.
 *
 * Two embedding backends:
 *  1. Voyage AI (`voyage-code-3`, 1024-dim) if VOYAGE_API_KEY is set.
 *  2. Lexical fallback: 512-dim hashing bag-of-words, L2-normalised.
 *     Deterministic, no network, good-enough baseline for tests + graceful
 *     degradation when no API key is configured.
 *
 * Embeddings are stored in `code_chunks.embedding` as a JSON-encoded number
 * array (schema = text) so we don't depend on pgvector. Cosine similarity
 * is computed in JS. If/when scale demands it, swap the column type to
 * `vector(1024)` and push cosine into Postgres.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { codeChunks } from "../db/schema";
import {
  getTree,
  getBlob,
  type GitTreeEntry,
} from "../git/repository";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Split code into identifier fragments. Splits on non-word boundaries, then
 * further splits `camelCase` and `snake_case` / kebab-case tokens into their
 * constituent pieces. All lowercase. Drops single-character tokens and pure
 * numeric tokens to keep the feature space meaningful.
 */
export function tokenize(code: string): string[] {
  if (!code) return [];
  const out: string[] = [];
  // First pass: split on non-alphanumeric (keep underscores for snake_case detection)
  const rough = code.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  for (const tok of rough) {
    // Split snake_case / kebab (kebab already gone; underscores split here)
    const underscoreParts = tok.split(/_+/).filter(Boolean);
    for (const part of underscoreParts) {
      // Split camelCase / PascalCase: insert boundary before each uppercase
      // letter that follows a lowercase or digit, and before the last upper
      // in a run of uppers followed by a lower (XMLParser -> XML, Parser).
      const camelParts = part
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/\s+/)
        .filter(Boolean);
      for (const cp of camelParts) {
        const lower = cp.toLowerCase();
        if (lower.length < 2) continue;
        if (/^\d+$/.test(lower)) continue;
        out.push(lower);
      }
    }
  }
  return out;
}

/**
 * FNV-1a 32-bit hash of a string. Deterministic + fast enough for the tiny
 * token volumes we throw at it.
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiplication via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Feature-hashing embedding with the sign trick. Maps each token into one of
 * `dim` slots; a second hash decides whether to add +1 or -1. Finally L2-
 * normalises so cosine ≈ dot product.
 */
export function hashEmbed(tokens: string[], dim = 512): number[] {
  const v = new Array<number>(dim).fill(0);
  if (!tokens.length) return v;
  for (const tok of tokens) {
    const h = fnv1a(tok);
    const slot = h % dim;
    // Sign from a perturbed second hash so it's not correlated with slot
    const signHash = fnv1a("\x00" + tok);
    const sign = signHash & 1 ? 1 : -1;
    v[slot] += sign;
  }
  let sumsq = 0;
  for (let i = 0; i < dim; i++) sumsq += v[i] * v[i];
  if (sumsq === 0) return v;
  const inv = 1 / Math.sqrt(sumsq);
  for (let i = 0; i < dim; i++) v[i] *= inv;
  return v;
}

/** Cosine similarity. Assumes a, b are same length. Handles zero vectors. */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "rb",
  "php",
  "c",
  "cpp",
  "cc",
  "h",
  "hpp",
  "md",
  "mdx",
  "yaml",
  "yml",
  "json",
  "css",
  "html",
  "htm",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "poetry.lock",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
]);

/**
 * Is the given path a code-like file we should index? Rejects lock files,
 * known binary extensions, images, and anything without an extension we
 * recognise.
 */
export function isCodeFile(path: string): boolean {
  if (!path) return false;
  const base = path.split("/").pop() || "";
  const lower = base.toLowerCase();
  if (SKIP_FILES.has(lower)) return false;
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = lower.slice(dot + 1);
  if (!CODE_EXTS.has(ext)) return false;
  return true;
}

/**
 * Split a file's content into overlapping chunks of ~maxLines lines with
 * a 5-line overlap. Skips non-code files. Returns [] for empty / binary-
 * looking content.
 */
export function chunkFile(
  path: string,
  content: string,
  maxLines = 40
): Array<{ path: string; startLine: number; endLine: number; content: string }> {
  if (!isCodeFile(path)) return [];
  if (!content) return [];
  if (content.includes("\0")) return []; // binary blob, skip
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const overlap = 5;
  const step = Math.max(1, maxLines - overlap);
  const out: Array<{
    path: string;
    startLine: number;
    endLine: number;
    content: string;
  }> = [];

  // For short files, emit a single chunk.
  if (lines.length <= maxLines) {
    out.push({
      path,
      startLine: 1,
      endLine: lines.length,
      content: lines.join("\n"),
    });
    return out;
  }

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + maxLines);
    out.push({
      path,
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join("\n"),
    });
    if (end >= lines.length) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

export function isEmbeddingsProviderAvailable(): {
  voyage: boolean;
  fallback: true;
} {
  return {
    voyage: !!process.env.VOYAGE_API_KEY,
    fallback: true,
  };
}

const VOYAGE_MODEL = "voyage-code-3";
const FALLBACK_MODEL = "gluecron-hash-512";
const VOYAGE_BATCH = 128;

/**
 * Embed a batch of texts. Uses Voyage AI when VOYAGE_API_KEY is set, and
 * falls back to `hashEmbed(tokenize(...))` per text otherwise — or if the
 * Voyage request fails for any reason.
 *
 * Never throws. Always returns the same number of vectors as inputs.
 */
export async function embedBatch(
  texts: string[],
  inputType: "document" | "query"
): Promise<{ vectors: number[][]; model: string }> {
  if (!texts.length) return { vectors: [], model: FALLBACK_MODEL };

  const apiKey = process.env.VOYAGE_API_KEY;
  if (apiKey) {
    const all: number[][] = [];
    let ok = true;
    for (let i = 0; i < texts.length && ok; i += VOYAGE_BATCH) {
      const slice = texts.slice(i, i + VOYAGE_BATCH);
      try {
        const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            input: slice,
            model: VOYAGE_MODEL,
            input_type: inputType,
          }),
        });
        if (!resp.ok) {
          ok = false;
          break;
        }
        const json: any = await resp.json();
        const data = Array.isArray(json?.data) ? json.data : null;
        if (!data || data.length !== slice.length) {
          ok = false;
          break;
        }
        for (const row of data) {
          const emb = row?.embedding;
          if (!Array.isArray(emb)) {
            ok = false;
            break;
          }
          all.push(emb as number[]);
        }
      } catch {
        ok = false;
        break;
      }
    }
    if (ok && all.length === texts.length) {
      return { vectors: all, model: VOYAGE_MODEL };
    }
    // fall through to fallback for the entire batch
  }

  const vectors = texts.map((t) => hashEmbed(tokenize(t), 512));
  return { vectors, model: FALLBACK_MODEL };
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

const MAX_CHUNKS_PER_REPO = 2000;
const MAX_BLOB_BYTES = 256 * 1024; // 256KB — skip anything larger

async function walkCodePaths(
  owner: string,
  repo: string,
  ref: string,
  maxFiles = 5000
): Promise<string[]> {
  const out: string[] = [];
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
        // Skip common noise directories.
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
        if (!isCodeFile(p)) continue;
        if (e.size !== undefined && e.size > MAX_BLOB_BYTES) continue;
        out.push(p);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export interface IndexResult {
  chunksIndexed: number;
  model: string;
}

/**
 * Walk the repo tree at the given commit sha, chunk every code file, embed
 * the chunks in batches, and replace any previous index rows for this repo.
 *
 * Caps total chunks at `MAX_CHUNKS_PER_REPO` (logs + stops). Never throws —
 * returns `{ chunksIndexed: 0, model }` on any failure.
 */
export async function indexRepository(args: {
  owner: string;
  repo: string;
  repositoryId: string;
  commitSha: string;
}): Promise<IndexResult> {
  const { owner, repo, repositoryId, commitSha } = args;

  let chunks: Array<{
    path: string;
    startLine: number;
    endLine: number;
    content: string;
  }> = [];

  try {
    const paths = await walkCodePaths(owner, repo, commitSha);
    for (const p of paths) {
      if (chunks.length >= MAX_CHUNKS_PER_REPO) {
        console.warn(
          `[semantic-search] chunk cap hit (${MAX_CHUNKS_PER_REPO}) for ${owner}/${repo} @ ${commitSha}; truncating`
        );
        break;
      }
      let blob;
      try {
        blob = await getBlob(owner, repo, commitSha, p);
      } catch {
        continue;
      }
      if (!blob || blob.isBinary) continue;
      const fileChunks = chunkFile(p, blob.content, 40);
      for (const ch of fileChunks) {
        if (chunks.length >= MAX_CHUNKS_PER_REPO) break;
        chunks.push(ch);
      }
    }
  } catch (err) {
    console.error(
      `[semantic-search] tree walk failed for ${owner}/${repo}:`,
      err
    );
    return { chunksIndexed: 0, model: FALLBACK_MODEL };
  }

  if (!chunks.length) {
    // Still wipe old rows so stale indexes don't linger.
    try {
      await db.delete(codeChunks).where(eq(codeChunks.repositoryId, repositoryId));
    } catch {}
    return { chunksIndexed: 0, model: FALLBACK_MODEL };
  }

  // Embed in batches sized for Voyage's 128/request limit.
  let model = FALLBACK_MODEL;
  const vectors: number[][] = [];
  try {
    for (let i = 0; i < chunks.length; i += VOYAGE_BATCH) {
      const slice = chunks.slice(i, i + VOYAGE_BATCH);
      const { vectors: vs, model: m } = await embedBatch(
        slice.map((c) => `${c.path}\n${c.content}`),
        "document"
      );
      model = m;
      for (const v of vs) vectors.push(v);
    }
  } catch (err) {
    console.error(`[semantic-search] embed failed for ${owner}/${repo}:`, err);
    return { chunksIndexed: 0, model };
  }

  if (vectors.length !== chunks.length) {
    console.error(
      `[semantic-search] vector/chunk length mismatch (${vectors.length} vs ${chunks.length})`
    );
    return { chunksIndexed: 0, model };
  }

  try {
    await db.delete(codeChunks).where(eq(codeChunks.repositoryId, repositoryId));

    // Batch-insert to avoid one-row-per-roundtrip.
    const INSERT_BATCH = 100;
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const slice = chunks.slice(i, i + INSERT_BATCH);
      const rows = slice.map((c, j) => ({
        repositoryId,
        commitSha,
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
        embedding: JSON.stringify(vectors[i + j]),
        embeddingModel: model,
      }));
      await db.insert(codeChunks).values(rows);
    }
  } catch (err) {
    console.error(`[semantic-search] DB write failed for ${owner}/${repo}:`, err);
    return { chunksIndexed: 0, model };
  }

  return { chunksIndexed: chunks.length, model };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

/**
 * Embed `query`, load all chunk embeddings for this repo, rank by cosine,
 * return the top `limit`. Empty array if the repo has no indexed chunks or
 * anything fails.
 */
export async function searchRepository(args: {
  repositoryId: string;
  query: string;
  limit?: number;
}): Promise<SearchHit[]> {
  const { repositoryId, query } = args;
  const limit = args.limit ?? 20;
  const q = (query || "").trim();
  if (!q) return [];

  let rows: Array<{
    path: string;
    startLine: number;
    endLine: number;
    content: string;
    embedding: string | null;
    embeddingModel: string | null;
  }>;
  try {
    rows = await db
      .select({
        path: codeChunks.path,
        startLine: codeChunks.startLine,
        endLine: codeChunks.endLine,
        content: codeChunks.content,
        embedding: codeChunks.embedding,
        embeddingModel: codeChunks.embeddingModel,
      })
      .from(codeChunks)
      .where(eq(codeChunks.repositoryId, repositoryId));
  } catch {
    return [];
  }

  if (!rows.length) return [];

  // Assume all rows use the same model (indexRepository rewrites them in bulk).
  const model = rows[0].embeddingModel || FALLBACK_MODEL;

  let queryVec: number[];
  if (model === VOYAGE_MODEL && process.env.VOYAGE_API_KEY) {
    const { vectors } = await embedBatch([q], "query");
    queryVec = vectors[0];
  } else {
    queryVec = hashEmbed(tokenize(q), 512);
  }

  const scored: SearchHit[] = [];
  for (const r of rows) {
    if (!r.embedding) continue;
    let v: number[];
    try {
      v = JSON.parse(r.embedding);
    } catch {
      continue;
    }
    if (!Array.isArray(v) || v.length === 0) continue;
    const s = cosine(queryVec, v);
    scored.push({
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      content: r.content,
      score: s,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Test-only exports — pure helpers, no DB dependency.
// ---------------------------------------------------------------------------

export const __test = {
  tokenize,
  hashEmbed,
  cosine,
  isCodeFile,
  chunkFile,
  fnv1a,
};
