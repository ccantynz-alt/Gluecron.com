/**
 * Workflow secrets — DB-backed CRUD + runtime context loader.
 *
 * Sibling to `workflow-secrets-crypto.ts`, which owns the pure AES-256-GCM
 * primitives. This file is the *only* place outside the runner that touches
 * `workflowSecrets` rows. All public fns follow the project-wide
 * `{ok:true,...}` / `{ok:false,error}` contract and never throw — DB errors
 * are caught and collapsed to a terse error string.
 *
 * Callers:
 *   - Agent 7 (settings UI) uses `listRepoSecrets`, `upsertRepoSecret`,
 *     `deleteRepoSecret` to render + mutate the per-repo secrets table.
 *   - Agent 5 (workflow runner) calls `loadSecretsContext` once at run start
 *     to build the `{ NAME: plaintext }` map that feeds
 *     `substituteSecrets(template, secrets)` for every step's `run:` / `env:`.
 *
 * Security notes:
 *   - `listRepoSecrets` never returns plaintext or ciphertext — UI only sees
 *     metadata (name, createdAt, createdBy).
 *   - `deleteRepoSecret` is scoped on both (repoId, secretId) to prevent a
 *     caller with one repo's context from deleting another repo's secret by
 *     guessing a UUID.
 *   - `loadSecretsContext` silently omits secrets whose decryption fails so
 *     the `${{ secrets.NAME }}` template left intact in logs — that's a louder
 *     failure signal than substituting empty string.
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { workflowSecrets } from "../db/schema";
import { decryptSecret, encryptSecret, getMasterKey } from "./workflow-secrets-crypto";

/** Matches GitHub Actions secret-name rules: uppercase + digits + underscore,
 * must not start with a digit, max 100 chars. Case is enforced strictly. */
const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_NAME_LEN = 100;

export type SecretMetadata = {
  id: string;
  name: string;
  createdAt: Date;
  createdBy: string | null;
};

/**
 * List a repository's secrets — metadata only.
 *
 * Returns rows ordered by `name` ascending. Plaintext and ciphertext are
 * deliberately excluded so this fn is safe to call from a web handler that
 * renders the settings page.
 */
export async function listRepoSecrets(
  repoId: string
): Promise<
  | { ok: true; secrets: SecretMetadata[] }
  | { ok: false; error: string }
> {
  if (typeof repoId !== "string" || repoId.length === 0) {
    return { ok: false, error: "repoId is required" };
  }
  try {
    const rows = await db
      .select({
        id: workflowSecrets.id,
        name: workflowSecrets.name,
        createdAt: workflowSecrets.createdAt,
        createdBy: workflowSecrets.createdBy,
      })
      .from(workflowSecrets)
      .where(eq(workflowSecrets.repositoryId, repoId))
      .orderBy(asc(workflowSecrets.name));
    return { ok: true, secrets: rows };
  } catch (err) {
    console.error("[workflow-secrets] listRepoSecrets:", err);
    return { ok: false, error: "db query failed" };
  }
}

/**
 * Create or update a repository secret. Name must match `[A-Z_][A-Z0-9_]*`
 * (max 100 chars) and value is encrypted under the master key before being
 * written. On conflict (repo+name already exists) the existing row is
 * replaced and its `updated_at` bumped; `created_at` and `created_by` stay
 * pinned to the original insert for audit history.
 */
export async function upsertRepoSecret(args: {
  repoId: string;
  name: string;
  value: string;
  createdBy: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { repoId, name, value, createdBy } = args;
  if (typeof repoId !== "string" || repoId.length === 0) {
    return { ok: false, error: "repoId is required" };
  }
  if (typeof createdBy !== "string" || createdBy.length === 0) {
    return { ok: false, error: "createdBy is required" };
  }
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, error: "name is required" };
  }
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `name must be <= ${MAX_NAME_LEN} chars` };
  }
  if (!SECRET_NAME_RE.test(name)) {
    return {
      ok: false,
      error: "name must match /^[A-Z_][A-Z0-9_]*$/ (uppercase, digits, underscore; not leading digit)",
    };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "value must be a string" };
  }

  const enc = encryptSecret(value);
  if (!enc.ok) return { ok: false, error: enc.error };

  try {
    const rows = await db
      .insert(workflowSecrets)
      .values({
        repositoryId: repoId,
        name,
        encryptedValue: enc.ciphertext,
        createdBy,
      })
      .onConflictDoUpdate({
        target: [workflowSecrets.repositoryId, workflowSecrets.name],
        set: {
          encryptedValue: enc.ciphertext,
          updatedAt: new Date(),
        },
      })
      .returning({ id: workflowSecrets.id });
    const id = rows[0]?.id;
    if (!id) return { ok: false, error: "insert returned no row" };
    return { ok: true, id };
  } catch (err) {
    console.error("[workflow-secrets] upsertRepoSecret:", err);
    return {
      ok: false,
      error: `db write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Delete a single secret by id, scoped to its repository. Both filters must
 * match — this is defence-in-depth against a caller that has a secretId but
 * the wrong repo context (e.g. path-param manipulation).
 *
 * Returns `{ok:true}` even if no row matched; the caller can't distinguish
 * "deleted" from "never existed" and that's fine for an idempotent DELETE.
 */
export async function deleteRepoSecret(args: {
  repoId: string;
  secretId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { repoId, secretId } = args;
  if (typeof repoId !== "string" || repoId.length === 0) {
    return { ok: false, error: "repoId is required" };
  }
  if (typeof secretId !== "string" || secretId.length === 0) {
    return { ok: false, error: "secretId is required" };
  }
  try {
    await db
      .delete(workflowSecrets)
      .where(
        and(
          eq(workflowSecrets.id, secretId),
          eq(workflowSecrets.repositoryId, repoId)
        )
      );
    return { ok: true };
  } catch (err) {
    console.error("[workflow-secrets] deleteRepoSecret:", err);
    return {
      ok: false,
      error: `db delete failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Substitute `${{ secrets.NAME }}` references inside a template string with
 * the corresponding plaintext from `secrets`. Pure helper — no DB, no
 * side effects. Designed to feed the workflow runner's per-step `run:`
 * value before handing it to `bash -c`.
 *
 * Behaviour:
 *   - Whitespace inside the `{{ ... }}` is tolerated: `${{secrets.X}}`,
 *     `${{ secrets.X }}`, `${{  secrets . X  }}`.
 *   - Names that don't appear in `secrets` are left intact (so the
 *     unsubstituted token shows up in logs and surfaces the misconfig
 *     loudly — matches the loadSecretsContext docstring contract).
 *   - Names that don't match the GitHub-Actions secret-name grammar
 *     (`[A-Z_][A-Z0-9_]*`) are also left intact, defence-in-depth
 *     against malformed YAML producing weird tokens.
 *   - The function never throws on bad input; non-string templates
 *     return `""`.
 *
 * Pure regex; no exec-on-string allocations beyond the single replace.
 */
export function substituteSecrets(
  template: string,
  secrets: Record<string, string>
): string {
  if (typeof template !== "string") return "";
  if (!template || !secrets) return template || "";
  // ${{ <ws>* secrets <ws>* . <ws>* NAME <ws>* }}
  // We split the regex on the dot so we can tolerate whitespace either
  // side of it; the NAME group is captured with the strict grammar so a
  // malformed identifier won't accidentally substitute.
  return template.replace(
    /\$\{\{\s*secrets\s*\.\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g,
    (match, name: string) => {
      if (Object.prototype.hasOwnProperty.call(secrets, name)) {
        return secrets[name];
      }
      return match;
    }
  );
}
/**
 * Build the `{ NAME: plaintext }` map consumed by the runner's
 * `substituteSecrets(template, secrets)` calls.
 *
 * Graceful-degrade semantics (intentional — the runner MUST NOT crash here):
 *   - Master key missing → returns `{}`. A warning is logged. Every
 *     `${{ secrets.X }}` token will pass through untouched, making the
 *     misconfiguration visible in job logs.
 *   - Individual decryption failure (tampered row, key rotated, etc.) → that
 *     secret is skipped; others still load.
 *   - DB error → returns `{}`.
 *
 * Note: this returns the raw map, not a `{ok,...}` tuple, because the runner
 * wants a hot path with no branching at call sites.
 */
export async function loadSecretsContext(
  repoId: string
): Promise<Record<string, string>> {
  if (typeof repoId !== "string" || repoId.length === 0) {
    return {};
  }
  if (!getMasterKey()) {
    console.error(
      "[workflow-secrets] loadSecretsContext: WORKFLOW_SECRETS_KEY missing; secrets will not be substituted"
    );
    return {};
  }

  let rows: { name: string; encryptedValue: string }[];
  try {
    rows = await db
      .select({
        name: workflowSecrets.name,
        encryptedValue: workflowSecrets.encryptedValue,
      })
      .from(workflowSecrets)
      .where(eq(workflowSecrets.repositoryId, repoId));
  } catch (err) {
    console.error("[workflow-secrets] loadSecretsContext db error:", err);
    return {};
  }

  const out: Record<string, string> = {};
  for (const row of rows) {
    const dec = decryptSecret(row.encryptedValue);
    if (!dec.ok) {
      console.error(
        `[workflow-secrets] decrypt failed for secret "${row.name}": ${dec.error}`
      );
      continue;
    }
    out[row.name] = dec.plaintext;
  }
  return out;
}
