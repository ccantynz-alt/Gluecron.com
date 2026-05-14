/**
 * Block T1 — GitHub Actions secret-migration helper.
 *
 * When a user imports a repo from GitHub, the git history comes through fine
 * but GitHub's API never exposes secret VALUES (only names — even for the
 * authenticated owner). So we list the secret NAMES, pre-create matching
 * placeholder rows in Gluecron's `workflow_secrets` table (encrypted empty
 * strings), and hand the user a checklist UI where they paste each value
 * once. The checklist lives in `src/routes/import-secrets.tsx`.
 *
 * Pure-where-possible. Errors collapse to empty lists / counts — this helper
 * is fire-and-forget from the import route, so a network or auth blip must
 * NEVER block the parent import.
 *
 * Crucial security notes:
 *   - We never request the secret VALUE from GitHub (the API doesn't expose
 *     it for repo Actions secrets) — only names + timestamps.
 *   - We never log plaintext values anywhere.
 *   - Placeholder rows store an encrypted empty string, NOT a plaintext "".
 *     Going through the existing AES-256-GCM `encryptSecret` path means the
 *     storage layer treats them identically to real secrets and
 *     `loadSecretsContext` will decrypt them to an empty string (which then
 *     leaves the `${{ secrets.NAME }}` template intact — the right "this
 *     secret is unset" failure signal).
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { workflowSecrets } from "../db/schema";
import { encryptSecret } from "./workflow-secrets-crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export type GithubSecretName = {
  name: string;
  createdAt: string;
  updatedAt: string;
};

type GithubSecretListResponse = {
  total_count: number;
  secrets: Array<{
    name: string;
    created_at: string;
    updated_at: string;
  }>;
};

const GITHUB_API_BASE = "https://api.github.com";
const PER_PAGE = 30;
const MAX_PAGES = 10; // safety cap — 300 secrets is well past anyone's real repo

// ─── listGithubSecretNames ──────────────────────────────────────────────────

/**
 * List the secret NAMES (not values) for a GitHub repo via the
 * `GET /repos/{owner}/{repo}/actions/secrets` endpoint.
 *
 * Returns [] on:
 *   - 401 / 403 / 404 / any non-2xx
 *   - network error
 *   - malformed JSON response
 *   - missing PAT
 *
 * Pagination: GitHub returns 30 secrets per page by default with a
 * `total_count` field; we keep fetching additional pages until we've
 * collected `total_count` entries or hit `MAX_PAGES`.
 */
export async function listGithubSecretNames(args: {
  owner: string;
  repo: string;
  githubToken: string;
  fetchImpl?: typeof fetch;
}): Promise<GithubSecretName[]> {
  const { owner, repo, githubToken } = args;
  const doFetch = args.fetchImpl ?? fetch;

  if (
    typeof owner !== "string" ||
    !owner ||
    typeof repo !== "string" ||
    !repo ||
    typeof githubToken !== "string" ||
    !githubToken
  ) {
    return [];
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    Authorization: `Bearer ${githubToken}`,
    "User-Agent": "gluecron/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const out: GithubSecretName[] = [];

  try {
    let page = 1;
    let total = Infinity;
    while (page <= MAX_PAGES && out.length < total) {
      const url =
        `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
        `/actions/secrets?per_page=${PER_PAGE}&page=${page}`;
      const res = await doFetch(url, { headers });
      if (!res.ok) {
        // Don't log status codes verbosely — auth errors are routine here.
        return out;
      }
      let body: GithubSecretListResponse;
      try {
        body = (await res.json()) as GithubSecretListResponse;
      } catch {
        return out;
      }
      if (
        !body ||
        typeof body.total_count !== "number" ||
        !Array.isArray(body.secrets)
      ) {
        return out;
      }
      total = body.total_count;
      for (const s of body.secrets) {
        if (s && typeof s.name === "string" && s.name) {
          out.push({
            name: s.name,
            createdAt: typeof s.created_at === "string" ? s.created_at : "",
            updatedAt: typeof s.updated_at === "string" ? s.updated_at : "",
          });
        }
      }
      if (body.secrets.length < PER_PAGE) break;
      page++;
    }
  } catch {
    // Network / DNS / abort. Swallow — caller can degrade gracefully.
    return out;
  }

  return out;
}

// ─── createPlaceholderSecrets ───────────────────────────────────────────────

/**
 * Insert placeholder rows in `workflow_secrets` with empty (encrypted)
 * values for each name. Idempotent: rows whose (repo, name) pair already
 * exists are left untouched and counted as `skippedExisting`.
 *
 * Returns 0/0 on any DB error rather than throwing.
 */
export async function createPlaceholderSecrets(args: {
  repositoryId: string;
  names: string[];
  createdByUserId: string;
}): Promise<{ created: number; skippedExisting: number }> {
  const { repositoryId, names, createdByUserId } = args;

  if (typeof repositoryId !== "string" || !repositoryId) {
    return { created: 0, skippedExisting: 0 };
  }
  if (typeof createdByUserId !== "string" || !createdByUserId) {
    return { created: 0, skippedExisting: 0 };
  }
  if (!Array.isArray(names) || names.length === 0) {
    return { created: 0, skippedExisting: 0 };
  }

  // Pre-encrypt the empty placeholder ONCE — every row's `encrypted_value`
  // column has the same plaintext (""), so we don't burn AES-GCM nonces
  // per row. NOTE: we still get a unique IV per call to `encryptSecret`,
  // but that's overkill here since the plaintext is fixed. Reusing the same
  // ciphertext is fine because the actual security boundary is the master
  // key, and a placeholder doesn't carry confidential bytes.
  const enc = encryptSecret("");
  if (!enc.ok) {
    // Master key missing or crypto layer rejected — degrade. The import
    // flow will skip the checklist step (no rows to show) but won't error.
    return { created: 0, skippedExisting: 0 };
  }

  let created = 0;
  let skippedExisting = 0;

  for (const rawName of names) {
    if (typeof rawName !== "string") continue;
    const name = rawName.trim();
    if (!name) continue;

    try {
      // Check for an existing row in this repo's namespace. Drizzle's
      // upsert (`onConflictDoNothing`) would be cleaner but we want to
      // count "created" vs "skippedExisting" precisely — and the upsert
      // returning() shape doesn't distinguish them.
      const [existing] = await db
        .select({ id: workflowSecrets.id })
        .from(workflowSecrets)
        .where(
          and(
            eq(workflowSecrets.repositoryId, repositoryId),
            eq(workflowSecrets.name, name)
          )
        )
        .limit(1);

      if (existing) {
        skippedExisting++;
        continue;
      }

      await db.insert(workflowSecrets).values({
        repositoryId,
        name,
        encryptedValue: enc.ciphertext,
        createdBy: createdByUserId,
      });
      created++;
    } catch (err) {
      // Per-row DB failure → skip silently. Don't log the row content —
      // even the name shouldn't escape because some names hint at content
      // ("DEPLOY_PROD_AWS_KEY"). Counter stays put so the caller's
      // accounting still works.
      console.error("[github-secrets-import] insert failed:", err instanceof Error ? err.message : String(err));
    }
  }

  return { created, skippedExisting };
}

// ─── importSecretsForRepo (end-to-end) ──────────────────────────────────────

export type ImportSecretsResult = {
  imported: { name: string; status: "placeholder_created" | "already_exists" }[];
  errors: string[];
};

/**
 * End-to-end: list the GitHub repo's secret names + create matching
 * placeholders for the Gluecron repo. Returns the per-name status array
 * the checklist UI iterates over. Never throws — failures are collapsed
 * to `errors[]`.
 *
 * Called from `src/routes/import.tsx` after a successful single-repo
 * import (fire-and-forget — caller awaits but treats throw as no-op
 * since this function doesn't throw).
 */
export async function importSecretsForRepo(args: {
  githubOwner: string;
  githubRepo: string;
  githubToken: string;
  gluecronRepositoryId: string;
  importedByUserId: string;
  fetchImpl?: typeof fetch;
}): Promise<ImportSecretsResult> {
  const errors: string[] = [];

  if (!args.githubToken) {
    errors.push("no_github_token");
    return { imported: [], errors };
  }

  let names: GithubSecretName[];
  try {
    names = await listGithubSecretNames({
      owner: args.githubOwner,
      repo: args.githubRepo,
      githubToken: args.githubToken,
      fetchImpl: args.fetchImpl,
    });
  } catch {
    errors.push("github_api_failed");
    return { imported: [], errors };
  }

  if (names.length === 0) {
    return { imported: [], errors };
  }

  // Snapshot existing names BEFORE we insert so we can label each name
  // accurately as "placeholder_created" vs "already_exists" in the
  // return shape.
  let existingNames = new Set<string>();
  try {
    const existing = await db
      .select({ name: workflowSecrets.name })
      .from(workflowSecrets)
      .where(eq(workflowSecrets.repositoryId, args.gluecronRepositoryId));
    existingNames = new Set(existing.map((r) => r.name));
  } catch {
    errors.push("db_lookup_failed");
    // Still try the insert path — `createPlaceholderSecrets` handles
    // conflicts via its own per-row existence check.
  }

  await createPlaceholderSecrets({
    repositoryId: args.gluecronRepositoryId,
    names: names.map((n) => n.name),
    createdByUserId: args.importedByUserId,
  });

  const imported = names.map((n) => ({
    name: n.name,
    status: existingNames.has(n.name)
      ? ("already_exists" as const)
      : ("placeholder_created" as const),
  }));

  return { imported, errors };
}
