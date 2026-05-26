/**
 * Personal cross-repo semantic search — the user-scoped sibling of
 * `src/lib/semantic-index.ts`.
 *
 * Today the per-repo `searchSemantic` ranks `code_embeddings` rows by a
 * single `repository_id`. This module unions the user's accessible repos
 * (owned + accepted collaborator rows) and runs the cosine-rank across
 * the entire union, annotating each hit with the source `repo_name` so
 * the chat surface can show "/owner/repo · path" alongside the citation.
 *
 * Privacy rules (hard, no exceptions):
 *
 *   - The function refuses to return any rows unless the user has flipped
 *     `users.personal_semantic_index_enabled = true`. The toggle is the
 *     contract between the user and the platform: while it's off we
 *     don't touch their data at all from this surface.
 *   - The set of repo IDs is recomputed on every call. We never cache
 *     it — a collaborator could be removed between requests and we want
 *     that decision to take immediate effect.
 *   - The Postgres `WHERE repository_id = ANY($repoIds)` clause is the
 *     boundary. If the union is empty (no owned repos, no accepted
 *     collaborator rows), we short-circuit to [] without hitting the
 *     embeddings table — cheap, and means a fresh user with no repos
 *     can't accidentally surface another user's data through any kind
 *     of overflow / fall-through.
 *
 * Failure modes:
 *
 *   - DB missing → [] (every catch swallows + logs at DEBUG level only).
 *   - pgvector missing → searchSemantic-style empty list (the cosine
 *     ORDER BY raises, the catch returns []).
 *   - Embedder unavailable → fallback hash embed (same as semantic-index).
 *
 * Test seam:
 *
 *   - Embedder override comes from `__setEmbedderForTests` on
 *     semantic-index — we deliberately don't add a second seam here so
 *     the two paths share the same deterministic vector source.
 */

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  codeEmbeddings,
  repoCollaborators,
  repositories,
  users,
} from "../db/schema";
import { embedOne, EMBEDDING_DIM } from "./semantic-index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonalSemanticHit {
  /** Path within the repo (e.g. `src/lib/foo.ts`). */
  filePath: string;
  /** The cached snippet from `code_embeddings.content_snippet`. */
  snippet: string;
  /** Cosine similarity, higher = closer (range 0..1 inclusive). */
  score: number;
  /** Blob SHA captured at indexing time. */
  blobSha: string;
  /** Source repository UUID — useful for downstream getBlob lookups. */
  repositoryId: string;
  /** "owner/name" — what citations render in the UI. */
  repoName: string;
  /** Owner username (left half of the slug). */
  ownerName: string;
}

export interface PersonalSearchOpts {
  userId: string;
  query: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Repo enumeration — owned + accepted collaborator rows.
// ---------------------------------------------------------------------------

interface RepoMeta {
  id: string;
  /** `owner/name` slug. */
  fullName: string;
  ownerName: string;
}

/**
 * Resolve every repo this user has access to. Owned repos (any visibility)
 * plus accepted collaborator rows. Returns a {repoId → meta} map keyed by
 * repoId for cheap downstream annotation.
 *
 * Anyone touching this function: keep the access logic identical to
 * `src/middleware/repo-access.ts::resolveRepoAccess`. The whole point of
 * the personal search is to surface what the user already has read access
 * to — drifting the set here would either over-share (leak) or under-share
 * (confusing UX). Treat it like a security boundary.
 */
async function listAccessibleRepoIds(
  userId: string
): Promise<Map<string, RepoMeta>> {
  const out = new Map<string, RepoMeta>();
  if (!userId) return out;

  // Owned repos. We union via two SELECTs rather than a single OR-join so
  // each side can fail independently (e.g. repo_collaborators may not exist
  // on a fresh DB without the 0040 migration).
  try {
    const owned = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerUsername: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(eq(repositories.ownerId, userId));
    for (const row of owned) {
      out.set(row.id, {
        id: row.id,
        fullName: `${row.ownerUsername}/${row.name}`,
        ownerName: row.ownerUsername,
      });
    }
  } catch (err) {
    if (process.env.DEBUG_PERSONAL_SEMANTIC === "1") {
      console.warn("[personal-semantic] owned-repos lookup failed:", err);
    }
  }

  // Accepted collaborator rows. acceptedAt IS NOT NULL — pending invites
  // do NOT grant access, matching repo-access middleware exactly.
  try {
    const collab = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerUsername: users.username,
      })
      .from(repoCollaborators)
      .innerJoin(repositories, eq(repoCollaborators.repositoryId, repositories.id))
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(
        and(
          eq(repoCollaborators.userId, userId),
          isNotNull(repoCollaborators.acceptedAt)
        )
      );
    for (const row of collab) {
      // Don't overwrite an owner row with a collab row (cheaper to skip
      // than to compare). The two sets are usually disjoint anyway.
      if (!out.has(row.id)) {
        out.set(row.id, {
          id: row.id,
          fullName: `${row.ownerUsername}/${row.name}`,
          ownerName: row.ownerUsername,
        });
      }
    }
  } catch (err) {
    if (process.env.DEBUG_PERSONAL_SEMANTIC === "1") {
      console.warn("[personal-semantic] collaborator lookup failed:", err);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Opt-in gate
// ---------------------------------------------------------------------------

/**
 * Read the user's opt-in flag. Returns false on any error so the privacy
 * default ("off") is enforced even when the DB is unhappy.
 */
export async function isPersonalSemanticEnabled(
  userId: string
): Promise<boolean> {
  if (!userId) return false;
  try {
    const [row] = await db
      .select({ enabled: users.personalSemanticIndexEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return !!row?.enabled;
  } catch {
    return false;
  }
}

/**
 * Flip the opt-in flag. Returns the new value on success, null on failure.
 * Callers should write an audit log entry separately (`ai.personal.toggle`).
 */
export async function setPersonalSemanticEnabled(
  userId: string,
  enabled: boolean
): Promise<boolean | null> {
  if (!userId) return null;
  try {
    await db
      .update(users)
      .set({ personalSemanticIndexEnabled: enabled, updatedAt: new Date() })
      .where(eq(users.id, userId));
    return enabled;
  } catch (err) {
    if (process.env.DEBUG_PERSONAL_SEMANTIC === "1") {
      console.warn("[personal-semantic] toggle write failed:", err);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Cosine-rank the query across every repo the user has access to. Returns
 * the top `limit` hits annotated with their source repo name.
 *
 * Privacy contract:
 *
 *   - Refuses (returns []) unless `users.personal_semantic_index_enabled`
 *     is true for the user.
 *   - Never returns rows whose `repository_id` isn't in the user's
 *     accessible set — even if pgvector returns them, the `IN (...)`
 *     clause filters them out.
 *   - Returns [] for non-UUID / empty userIds without DB access.
 */
export async function searchPersonalSemantic(
  opts: PersonalSearchOpts
): Promise<PersonalSemanticHit[]> {
  const { userId, query } = opts;
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const q = (query || "").trim();
  if (!q || !userId) return [];

  // 1. Hard opt-in gate. The audit log is owned by the caller — we just
  //    refuse here without logging so this function stays cheap to call.
  const enabled = await isPersonalSemanticEnabled(userId);
  if (!enabled) return [];

  // 2. Recompute the accessible repo set on every call. A collaborator
  //    removed between requests must lose visibility immediately.
  const accessible = await listAccessibleRepoIds(userId);
  if (accessible.size === 0) return [];
  const repoIds = Array.from(accessible.keys());

  // 3. Embed the query in the same vector space as the indexed rows.
  let queryVec: number[];
  try {
    const out = await embedOne(q, "query");
    queryVec = out.vector;
  } catch {
    return [];
  }
  if (!queryVec || queryVec.length !== EMBEDDING_DIM) return [];
  const vecLit = "[" + queryVec.join(",") + "]";

  // 4. Cosine-rank across the union. The pgvector `<=>` operator is
  //    cosine distance (lower = closer); we surface the similarity
  //    (1 - distance) so the contract matches searchSemantic.
  try {
    const rows = await db
      .select({
        repositoryId: codeEmbeddings.repositoryId,
        filePath: codeEmbeddings.filePath,
        snippet: codeEmbeddings.contentSnippet,
        blobSha: codeEmbeddings.blobSha,
        score: sql<number>`1 - (${codeEmbeddings.embedding} <=> ${vecLit}::vector)`,
      })
      .from(codeEmbeddings)
      .where(inArray(codeEmbeddings.repositoryId, repoIds))
      .orderBy(sql`${codeEmbeddings.embedding} <=> ${vecLit}::vector`)
      .limit(limit);

    return rows.flatMap((r) => {
      const meta = accessible.get(r.repositoryId);
      if (!meta) {
        // Defensive: if the row's repo somehow isn't in our access set,
        // drop it. This should be impossible given the WHERE clause, but
        // never trust a DB result with a privacy-critical filter.
        return [] as PersonalSemanticHit[];
      }
      return [
        {
          repositoryId: r.repositoryId,
          filePath: r.filePath,
          snippet: r.snippet || "",
          score:
            typeof r.score === "number" ? r.score : Number(r.score) || 0,
          blobSha: r.blobSha,
          repoName: meta.fullName,
          ownerName: meta.ownerName,
        },
      ];
    });
  } catch (err) {
    if (process.env.DEBUG_PERSONAL_SEMANTIC === "1") {
      console.warn("[personal-semantic] search failed:", err);
    }
    return [];
  }
}

/**
 * Convenience alias — same as `searchPersonalSemantic`. Some call sites
 * read more naturally with the descriptive name.
 */
export async function searchAcrossAllReposForUser(
  opts: PersonalSearchOpts
): Promise<PersonalSemanticHit[]> {
  return searchPersonalSemantic(opts);
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test = {
  listAccessibleRepoIds,
};
