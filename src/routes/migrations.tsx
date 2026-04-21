/**
 * Migration history — tracks repos imported from GitHub (bulk org import + single
 * repo import) and lets owners re-run the post-migration verifier on demand.
 *
 * The `repositories` table does NOT currently carry an `importedAt` /
 * `importSource` / `mirrorUpstreamUrl` column (see `src/db/schema.ts`), so
 * we fall back to a best-effort derivation: list every repo owned by the
 * current user and surface `createdAt` as the "imported at" timestamp. When
 * the schema eventually grows an `importedAt` column we can switch the
 * filter to `isNotNull(repositories.importedAt)` without changing the UI.
 *
 * The verifier itself lives in `src/lib/import-verify.ts` and is being
 * supplied by a parallel agent. We load it via dynamic import inside a
 * try/catch so a missing module produces a helpful "verifier not available"
 * note instead of a 500.
 */

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const migrations = new Hono<AuthEnv>();

migrations.use("/migrations", requireAuth);
migrations.use("/migrations/*", requireAuth);

// ─── Verifier loader ─────────────────────────────────────────
//
// The verifier is optional at app boot — a parallel agent owns the file.
// We load it dynamically so this route works whether or not the module
// is present on disk. The expected interface is:
//
//   export async function verifyMigration(repoId: number): Promise<{
//     repoId: number;
//     clonable: boolean;
//     hasDefaultBranch: boolean;
//     commitCount: number;
//     issues: string[];
//   }>
//
type VerifyResult = {
  repoId: number;
  clonable: boolean;
  hasDefaultBranch: boolean;
  commitCount: number;
  issues: string[];
};

async function loadVerifier(): Promise<
  ((repoId: number) => Promise<VerifyResult>) | null
> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod: any = await import("../lib/import-verify");
    if (mod && typeof mod.verifyMigration === "function") {
      return mod.verifyMigration as (id: number) => Promise<VerifyResult>;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── GET /migrations ─────────────────────────────────────────
migrations.get("/migrations", async (c) => {
  const user = c.get("user")!;

  // Best-effort listing: all repos owned by the user, newest first.
  // When an `importedAt` column is added later, narrow this WHERE to
  // `and(eq(ownerId, user.id), isNotNull(importedAt))`.
  let rows: Array<{
    id: string;
    name: string;
    createdAt: Date;
    description: string | null;
  }> = [];
  try {
    const result = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        createdAt: repositories.createdAt,
        description: repositories.description,
      })
      .from(repositories)
      .where(eq(repositories.ownerId, user.id))
      .orderBy(desc(repositories.createdAt));
    rows = result as any;
  } catch {
    rows = [];
  }

  return c.html(
    <Layout title="Migration history" user={user}>
      <div style="max-width: 900px; margin: 0 auto; padding: 24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h1 style="margin:0">Migration history</h1>
          <div style="display:flex;gap:8px">
            <a class="btn" href="/import">
              Import
            </a>
            <a class="btn" href="/import/bulk">
              Bulk import
            </a>
          </div>
        </div>

        <p style="color: var(--text-muted); margin-bottom: 16px">
          Repositories you've migrated to gluecron. Use <strong>Verify</strong>
          {" "}to re-run the post-migration check (clonability, default branch,
          commit count).
        </p>

        {rows.length === 0 ? (
          <div class="panel-empty" style="padding: 32px; text-align: center">
            You haven't migrated any repos yet. Try{" "}
            <a href="/import">/import</a> or{" "}
            <a href="/import/bulk">/import/bulk</a>.
          </div>
        ) : (
          <div class="panel">
            <div
              class="panel-item"
              style="font-weight:600;background:var(--bg-subtle)"
            >
              <div style="flex:2;min-width:0">Repo</div>
              <div style="flex:2;min-width:0">Source</div>
              <div style="flex:1;min-width:0">Imported at</div>
              <div style="width:120px;text-align:right">Action</div>
            </div>
            {rows.map((r) => (
              <div class="panel-item">
                <div style="flex:2;min-width:0;overflow:hidden;text-overflow:ellipsis">
                  <a href={`/${user.username}/${r.name}`}>
                    <strong>{r.name}</strong>
                  </a>
                  {r.description && (
                    <div
                      style="font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                    >
                      {r.description}
                    </div>
                  )}
                </div>
                <div
                  style="flex:2;min-width:0;font-size:12px;color:var(--text-muted);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis"
                >
                  {/* Source URL column — we don't persist the upstream URL
                      yet, so show a neutral placeholder. */}
                  —
                </div>
                <div style="flex:1;min-width:0;font-size:12px;color:var(--text-muted)">
                  {r.createdAt
                    ? new Date(r.createdAt).toLocaleString()
                    : "—"}
                </div>
                <div style="width:120px;text-align:right">
                  <a
                    class="btn btn-primary"
                    href={`/migrations/verify/${r.id}`}
                  >
                    Verify
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
});

// ─── GET /migrations/verify/:repoId ──────────────────────────
migrations.get("/migrations/verify/:repoId", async (c) => {
  const user = c.get("user")!;
  const repoId = c.req.param("repoId");

  // Ownership check: the verifier must only run for repos this user owns.
  let repo:
    | {
        id: string;
        name: string;
        ownerId: string;
        defaultBranch: string;
      }
    | null = null;
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        defaultBranch: repositories.defaultBranch,
      })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);
    repo = (row as any) || null;
  } catch {
    repo = null;
  }

  if (!repo) {
    return c.html(
      <Layout title="Verify migration" user={user}>
        <div style="max-width: 700px; margin: 0 auto; padding: 24px">
          <h1>Repository not found</h1>
          <p style="color:var(--text-muted)">
            <a href="/migrations">Back to migration history</a>
          </p>
        </div>
      </Layout>,
      404
    );
  }

  if (repo.ownerId !== user.id) {
    return c.html(
      <Layout title="Verify migration" user={user}>
        <div style="max-width: 700px; margin: 0 auto; padding: 24px">
          <h1>Forbidden</h1>
          <p style="color:var(--text-muted)">
            You can only verify repositories you own.
          </p>
          <p>
            <a href="/migrations">Back to migration history</a>
          </p>
        </div>
      </Layout>,
      403
    );
  }

  const verify = await loadVerifier();
  let result: VerifyResult | null = null;
  let verifierError: string | null = null;
  if (!verify) {
    verifierError =
      "Verifier not available. The import-verify module is not installed yet.";
  } else {
    try {
      // Schema stores repo id as uuid string; the verifier interface
      // types it as `number` but many callers pass through strings. Cast
      // defensively so we don't crash on either shape.
      result = await verify(repo.id as unknown as number);
    } catch (err: any) {
      verifierError =
        "Verifier failed: " + (err && err.message ? err.message : String(err));
    }
  }

  const indicator = (ok: boolean) => (
    <span
      style={`display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:${
        ok ? "var(--green, #2ea043)" : "var(--red, #f85149)"
      }`}
    />
  );

  return c.html(
    <Layout title={`Verify ${repo.name}`} user={user}>
      <div style="max-width: 700px; margin: 0 auto; padding: 24px">
        <div style="margin-bottom: 12px">
          <a href="/migrations" style="font-size:12px">
            ← Migration history
          </a>
        </div>
        <h1 style="margin:0 0 4px 0">Verify migration</h1>
        <div style="color:var(--text-muted);font-family:var(--font-mono);margin-bottom:16px">
          {user.username}/{repo.name}
        </div>

        {verifierError && (
          <div
            class="panel-empty"
            style="padding:16px;border-left:3px solid var(--red, #f85149)"
          >
            {verifierError}
          </div>
        )}

        {result && (
          <div class="panel">
            <div class="panel-item">
              <div style="flex:1">
                {indicator(result.clonable)}
                <strong>Clonable</strong>
              </div>
              <div style="color:var(--text-muted);font-size:12px">
                {result.clonable ? "Repository responds to git clone" : "Clone failed"}
              </div>
            </div>
            <div class="panel-item">
              <div style="flex:1">
                {indicator(result.hasDefaultBranch)}
                <strong>Default branch</strong>
              </div>
              <div style="color:var(--text-muted);font-size:12px">
                {result.hasDefaultBranch
                  ? `Found ${repo.defaultBranch}`
                  : `Missing ${repo.defaultBranch}`}
              </div>
            </div>
            <div class="panel-item">
              <div style="flex:1">
                {indicator(result.commitCount > 0)}
                <strong>Commits</strong>
              </div>
              <div style="color:var(--text-muted);font-size:12px">
                {result.commitCount} commit
                {result.commitCount === 1 ? "" : "s"}
              </div>
            </div>
            {result.issues && result.issues.length > 0 && (
              <div
                class="panel-item"
                style="flex-direction:column;align-items:stretch;gap:4px"
              >
                <div>
                  {indicator(false)}
                  <strong>Issues</strong>
                </div>
                <ul style="margin:0;padding-left:20px;color:var(--text-muted);font-size:13px">
                  {result.issues.map((i) => (
                    <li>{i}</li>
                  ))}
                </ul>
              </div>
            )}
            {(!result.issues || result.issues.length === 0) &&
              result.clonable &&
              result.hasDefaultBranch &&
              result.commitCount > 0 && (
                <div class="panel-item">
                  <div style="flex:1;color:var(--green, #2ea043)">
                    All checks passed.
                  </div>
                </div>
              )}
          </div>
        )}

        <div style="margin-top:16px;display:flex;gap:8px">
          <a
            class="btn btn-primary"
            href={`/migrations/verify/${repo.id}`}
          >
            Re-run verification
          </a>
          <a class="btn" href="/migrations">
            Back
          </a>
        </div>
      </div>
    </Layout>
  );
});

export default migrations;
