/**
 * Continuous semantic index — per-push embeddings.
 *
 * Foundation for spec-to-PR, AI rubber-duck, and the v2 /search endpoint.
 *
 * Lifecycle:
 *   1. Push lands → `src/hooks/post-receive.ts` calls
 *      `indexChangedFiles(repoId, commitSha, paths)` fire-and-forget.
 *   2. For each path we resolve the blob sha at HEAD, pull a 1024-dim
 *      embedding from Voyage (preferred — `voyage-code-3` matches our
 *      column dim) or fall back to a deterministic TF-IDF-ish hash,
 *      then UPSERT into `code_embeddings`.
 *   3. `searchSemantic(repoId, q)` embeds the query in the same space
 *      and ORDER BY `embedding <=> $1` (cosine distance) on the server.
 *
 * Anthropic itself doesn't ship an embeddings API (their docs send you
 * to Voyage), so "Anthropic embeddings" here means "use Voyage when
 * ANTHROPIC_API_KEY is set, since the Voyage account is part of the
 * AI bundle" — VOYAGE_API_KEY is the actual auth header. We probe both.
 *
 * Hard rules:
 *   - Never throw. Every external call is wrapped; on any error we log
 *     and return safely (empty array for search, void for index).
 *   - Graceful when pgvector is missing: the table won't exist, so
 *     SELECTs/INSERTs fail and we catch + return empty / void.
 *   - On-disk cache keyed by blob-sha so reindexing identical content
 *     (rebases, force-pushes, branch merges) is free.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { codeEmbeddings } from "../db/schema";
import { getBlob } from "../git/repository";
import { hashEmbed, tokenize, isCodeFile } from "./semantic-search";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target embedding dimension — matches `vector(1024)` in the schema. */
export const EMBEDDING_DIM = 1024;

/** First N chars of file content surfaced as preview snippet. */
const SNIPPET_BYTES = 500;

/** Voyage's per-request batch limit. */
const VOYAGE_BATCH = 128;

/** Max bytes of file content we send to the embedder. */
const MAX_EMBED_BYTES = 32 * 1024;

const VOYAGE_MODEL = "voyage-code-3";
const FALLBACK_MODEL = "gluecron-tfidf-1024";

// ---------------------------------------------------------------------------
// Disk cache — keyed by sha256(model + ":" + blobSha).
// ---------------------------------------------------------------------------

let _cacheDirPromise: Promise<string> | null = null;

async function getCacheDir(): Promise<string> {
  if (_cacheDirPromise) return _cacheDirPromise;
  _cacheDirPromise = (async () => {
    const dir =
      process.env.GLUECRON_SEMANTIC_CACHE_DIR ||
      join(tmpdir(), "gluecron-semantic-cache");
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      /* tolerate — falls back to fetch every time */
    }
    return dir;
  })();
  return _cacheDirPromise;
}

async function cacheKey(model: string, blobSha: string): Promise<string> {
  const data = new TextEncoder().encode(`${model}:${blobSha}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readCached(
  model: string,
  blobSha: string
): Promise<number[] | null> {
  try {
    const dir = await getCacheDir();
    const key = await cacheKey(model, blobSha);
    const path = join(dir, `${key}.json`);
    const text = await readFile(path, "utf8");
    const v = JSON.parse(text);
    if (Array.isArray(v) && v.length === EMBEDDING_DIM) return v as number[];
    return null;
  } catch {
    return null;
  }
}

async function writeCached(
  model: string,
  blobSha: string,
  vec: number[]
): Promise<void> {
  try {
    const dir = await getCacheDir();
    const key = await cacheKey(model, blobSha);
    const path = join(dir, `${key}.json`);
    await writeFile(path, JSON.stringify(vec), "utf8");
  } catch {
    /* cache miss next time, harmless */
  }
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

function voyageKey(): string | null {
  return process.env.VOYAGE_API_KEY || null;
}

/** What backend will `embed()` use right now? Used by the API endpoint. */
export function semanticIndexProvider(): "voyage" | "fallback" {
  return voyageKey() ? "voyage" : "fallback";
}

// ---------------------------------------------------------------------------
// Fallback embedder — deterministic, no network.
//
// Re-uses the FNV-1a sign-trick hasher from `semantic-search.ts` but at
// 1024 dimensions so the vectors are directly compatible with the
// `vector(1024)` column. This lets the index degrade smoothly when no
// API key is set: search still ranks, just less semantically.
// ---------------------------------------------------------------------------

function fallbackEmbed(text: string): number[] {
  return hashEmbed(tokenize(text), EMBEDDING_DIM);
}

// ---------------------------------------------------------------------------
// Voyage embedder
// ---------------------------------------------------------------------------

interface EmbedResult {
  vectors: number[][];
  model: string;
}

async function voyageEmbed(
  apiKey: string,
  texts: string[],
  inputType: "document" | "query"
): Promise<EmbedResult | null> {
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
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
      if (!resp.ok) return null;
      const json: any = await resp.json();
      const data = Array.isArray(json?.data) ? json.data : null;
      if (!data || data.length !== slice.length) return null;
      for (const row of data) {
        const emb = row?.embedding;
        if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIM) return null;
        all.push(emb as number[]);
      }
    } catch {
      return null;
    }
  }
  return { vectors: all, model: VOYAGE_MODEL };
}

/**
 * Embed a single text. Returns `{ vector, model }`. Never throws.
 *
 * @internal Exported so tests can stub the network round-trip via
 *           `__setEmbedderForTests`.
 */
export async function embedOne(
  text: string,
  inputType: "document" | "query"
): Promise<{ vector: number[]; model: string }> {
  if (_embedderOverride) {
    return _embedderOverride(text, inputType);
  }
  const key = voyageKey();
  if (key) {
    const out = await voyageEmbed(key, [text], inputType);
    if (out && out.vectors[0]) {
      return { vector: out.vectors[0], model: out.model };
    }
    // fall through
  }
  return { vector: fallbackEmbed(text), model: FALLBACK_MODEL };
}

// Test-only seam — bypass the real network/fallback path so unit tests
// can assert behaviour deterministically without a Voyage key or DB.
type Embedder = (
  text: string,
  inputType: "document" | "query"
) => Promise<{ vector: number[]; model: string }>;

let _embedderOverride: Embedder | null = null;

/** Test-only: replace `embedOne`'s implementation. Pass `null` to reset. */
export function __setEmbedderForTests(fn: Embedder | null): void {
  _embedderOverride = fn;
}

// ---------------------------------------------------------------------------
// Index — called from the post-receive hook.
// ---------------------------------------------------------------------------

/** Cap on the number of files indexed per push. */
const MAX_FILES_PER_PUSH = 50;

/**
 * Embed every changed file at the given commit and upsert one row per
 * file into `code_embeddings`. Best-effort: returns the count of rows
 * written. Never throws.
 *
 * @param repositoryId - DB id of the repo (NOT owner/name)
 * @param ownerName    - For `getBlob` git lookups
 * @param repoName     - For `getBlob` git lookups
 * @param commitSha    - The new commit sha after the push
 * @param changedPaths - Paths touched by the push (cap applies)
 */
export async function indexChangedFiles(args: {
  repositoryId: string;
  ownerName: string;
  repoName: string;
  commitSha: string;
  changedPaths: string[];
}): Promise<{ indexed: number; skipped: number; model: string }> {
  const { repositoryId, ownerName, repoName, commitSha, changedPaths } = args;

  if (!repositoryId || !commitSha || !changedPaths.length) {
    return { indexed: 0, skipped: 0, model: FALLBACK_MODEL };
  }

  // Dedupe, filter to code files, cap.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const p of changedPaths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (!isCodeFile(p)) continue;
    candidates.push(p);
    if (candidates.length >= MAX_FILES_PER_PUSH) break;
  }

  if (!candidates.length) {
    return { indexed: 0, skipped: changedPaths.length, model: FALLBACK_MODEL };
  }

  let indexed = 0;
  let model = FALLBACK_MODEL;

  for (const filePath of candidates) {
    let blob: Awaited<ReturnType<typeof getBlob>> = null;
    try {
      blob = await getBlob(ownerName, repoName, commitSha, filePath);
    } catch (err) {
      // File was deleted by this push, or git error — skip cleanly.
      blob = null;
    }
    if (!blob || blob.isBinary || !blob.content) continue;

    // Lock blob sha for cache keying. If we can't resolve one, derive
    // a content hash so the disk cache still works.
    const blobSha = await deriveBlobSha(blob.content);
    const snippet = blob.content.slice(0, SNIPPET_BYTES);
    const textToEmbed = `${filePath}\n${blob.content.slice(0, MAX_EMBED_BYTES)}`;

    // Disk cache by (model-namespace, blob sha). We don't know the
    // resolved model until embedOne runs, so we probe both candidates.
    let vec: number[] | null = null;
    let resolvedModel = FALLBACK_MODEL;

    // Try Voyage cache first if a key is configured — saves a real call.
    if (voyageKey()) {
      const hit = await readCached(VOYAGE_MODEL, blobSha);
      if (hit) {
        vec = hit;
        resolvedModel = VOYAGE_MODEL;
      }
    }
    if (!vec) {
      const hit = await readCached(FALLBACK_MODEL, blobSha);
      if (hit) {
        vec = hit;
        resolvedModel = FALLBACK_MODEL;
      }
    }

    if (!vec) {
      try {
        const out = await embedOne(textToEmbed, "document");
        vec = out.vector;
        resolvedModel = out.model;
        if (vec && vec.length === EMBEDDING_DIM) {
          void writeCached(resolvedModel, blobSha, vec);
        }
      } catch {
        vec = null;
      }
    }

    if (!vec || vec.length !== EMBEDDING_DIM) continue;
    model = resolvedModel;

    // UPSERT (repository_id, file_path) → new embedding + blob/commit.
    try {
      await db
        .insert(codeEmbeddings)
        .values({
          repositoryId,
          filePath,
          blobSha,
          commitSha,
          contentSnippet: snippet,
          embedding: vec,
          embeddingModel: resolvedModel,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [codeEmbeddings.repositoryId, codeEmbeddings.filePath],
          set: {
            blobSha,
            commitSha,
            contentSnippet: snippet,
            embedding: vec,
            embeddingModel: resolvedModel,
            updatedAt: new Date(),
          },
        });
      indexed++;
    } catch (err) {
      // pgvector missing → table missing → swallow. Single noisy log
      // per push is enough; rely on the migration NOTICE for diagnosis.
      if (process.env.DEBUG_SEMANTIC_INDEX === "1") {
        console.warn(
          `[semantic-index] upsert failed for ${ownerName}/${repoName}:${filePath}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  return {
    indexed,
    skipped: candidates.length - indexed,
    model,
  };
}

async function deriveBlobSha(content: string): Promise<string> {
  // SHA-256 of the raw bytes — only used as a cache key, doesn't need
  // to match git's SHA-1 blob hash. (We could call `git hash-object`
  // but that's another subprocess per file and this is plenty stable.)
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SemanticHit {
  filePath: string;
  snippet: string;
  score: number;
  blobSha: string;
}

/**
 * Cosine-rank the query against the repo's `code_embeddings` rows and
 * return the top `limit`. Empty array on any failure (pgvector missing,
 * no rows, embed failure, etc.). Never throws.
 *
 * Score is `1 - cosine_distance`, so higher = closer (0..1 inclusive).
 */
export async function searchSemantic(args: {
  repositoryId: string;
  query: string;
  limit?: number;
}): Promise<SemanticHit[]> {
  const { repositoryId, query } = args;
  const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
  const q = (query || "").trim();
  if (!q || !repositoryId) return [];

  let queryVec: number[];
  try {
    const out = await embedOne(q, "query");
    queryVec = out.vector;
  } catch {
    return [];
  }
  if (!queryVec || queryVec.length !== EMBEDDING_DIM) return [];

  // Postgres `<=>` is cosine distance (lower = closer). Score is the
  // similarity (1 - distance) so callers get a familiar "higher is
  // better" semantic. We coerce the vector literal manually because
  // drizzle's parameter binding for our customType happens in the
  // SELECT clause via `sql`, not in WHERE/ORDER BY.
  const vecLit = "[" + queryVec.join(",") + "]";

  try {
    const rows = await db
      .select({
        filePath: codeEmbeddings.filePath,
        snippet: codeEmbeddings.contentSnippet,
        blobSha: codeEmbeddings.blobSha,
        score: sql<number>`1 - (${codeEmbeddings.embedding} <=> ${vecLit}::vector)`,
      })
      .from(codeEmbeddings)
      .where(eq(codeEmbeddings.repositoryId, repositoryId))
      .orderBy(sql`${codeEmbeddings.embedding} <=> ${vecLit}::vector`)
      .limit(limit);

    return rows.map((r) => ({
      filePath: r.filePath,
      snippet: r.snippet || "",
      score: typeof r.score === "number" ? r.score : Number(r.score) || 0,
      blobSha: r.blobSha,
    }));
  } catch {
    // pgvector missing or DB unavailable — degrade to empty result.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test = {
  fallbackEmbed,
  deriveBlobSha,
  cacheKey,
  MAX_FILES_PER_PUSH,
  FALLBACK_MODEL,
  VOYAGE_MODEL,
};
