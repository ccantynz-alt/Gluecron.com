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
 *
 * 2026 polish:
 *   - Scoped `.mig-*` CSS — no bleed into the global layout.
 *   - Eyebrow + display headline + 1-line subtitle.
 *   - Each migration row is a card: run name, applied/pending/failed pill,
 *     timestamp, duration (best-effort).
 *   - Dashed empty-state with orb + CTA when no migrations exist.
 *   - All query params + form actions preserved verbatim.
 */

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { formatRelative } from "../views/ui";
import { requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const migrations = new Hono<AuthEnv>();

migrations.use("/migrations", requireAuth);
migrations.use("/migrations/*", requireAuth);

// ─── Scoped CSS (.mig-*) ────────────────────────────────────────────────
const migStyles = `
  .mig-wrap { max-width: 1120px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .mig-head {
    margin-bottom: var(--space-5);
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .mig-head-text { flex: 1; min-width: 280px; }
  .mig-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .mig-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .mig-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .mig-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .mig-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 720px;
  }

  .mig-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .mig-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
    line-height: 1;
    white-space: nowrap;
  }
  .mig-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .mig-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }
  .mig-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .mig-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }

  /* ─── Migration row cards ─── */
  .mig-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .mig-row {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--space-3);
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease;
    overflow: hidden;
  }
  .mig-row::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1.5px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 50%, #36c5d6 100%);
    opacity: 0.35;
    pointer-events: none;
  }
  .mig-row:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.025);
  }
  .mig-row-main { min-width: 0; }
  .mig-row-name-line {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .mig-row-name {
    font-family: var(--font-display);
    font-size: 15.5px;
    font-weight: 700;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.012em;
  }
  .mig-row-name:hover { text-decoration: underline; }
  .mig-row-desc {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mig-row-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .mig-row-meta .sep { opacity: 0.4; }
  .mig-row-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* ─── Status pills ─── */
  .mig-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: capitalize;
  }
  .mig-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .mig-pill.is-applied {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .mig-pill.is-pending {
    background: rgba(251,191,36,0.12);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .mig-pill.is-failed {
    background: rgba(248,113,113,0.12);
    color: #fecaca;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }

  /* ─── Banners (used on verify page) ─── */
  .mig-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mig-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .mig-banner.is-error { border-color: rgba(248,113,113,0.40); background: rgba(248,113,113,0.08); color: #fecaca; }
  .mig-banner.is-warn { border-color: rgba(251,191,36,0.32); background: rgba(251,191,36,0.06); color: #fde68a; }
  .mig-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }

  .mig-checks { display: flex; flex-direction: column; gap: 10px; }
  .mig-check {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .mig-check-label {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-display);
    font-weight: 700;
    color: var(--text-strong);
    font-size: 13.5px;
  }
  .mig-check-dot {
    width: 10px; height: 10px;
    border-radius: 9999px;
    flex-shrink: 0;
  }
  .mig-check-dot.is-ok { background: #34d399; box-shadow: 0 0 0 3px rgba(52,211,153,0.18); }
  .mig-check-dot.is-fail { background: #f87171; box-shadow: 0 0 0 3px rgba(248,113,113,0.18); }
  .mig-check-detail {
    font-size: 12px;
    color: var(--text-muted);
  }
  .mig-issues-list {
    margin: 0;
    padding-left: 20px;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.6;
  }

  /* ─── Empty state ─── */
  .mig-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 52px) clamp(20px, 4vw, 40px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .mig-empty-orb {
    position: absolute;
    inset: -40% 25% auto 25%;
    height: 300px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(72px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .mig-empty-inner { position: relative; z-index: 1; }
  .mig-empty-icon {
    width: 56px; height: 56px;
    margin: 0 auto 14px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.25), rgba(54,197,214,0.20));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
  }
  .mig-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .mig-empty-sub {
    margin: 0 auto 16px;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 440px;
    line-height: 1.5;
  }
  .mig-crumbs {
    margin-bottom: var(--space-4);
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .mig-crumbs a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 11px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
    text-decoration: none;
    font-weight: 500;
  }
  .mig-crumbs a:hover { border-color: var(--border-strong); color: var(--text-strong); text-decoration: none; }
`;

function IconImport() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
function IconShield() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

// ─── Verifier loader ─────────────────────────────────────────
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
      <div class="mig-wrap">
        <header class="mig-head">
          <div class="mig-head-text">
            <div class="mig-eyebrow">
              <span class="mig-eyebrow-dot" aria-hidden="true" />
              Account · Migration history
            </div>
            <h1 class="mig-title">
              <span class="mig-title-grad">Every repo you brought over.</span>
            </h1>
            <p class="mig-sub">
              Re-run the post-migration verifier any time — it confirms the
              repo is clonable, the default branch resolves, and commits are
              present.
            </p>
          </div>
          <div class="mig-actions">
            <a class="mig-btn mig-btn-ghost" href="/import">
              <IconImport />
              Import
            </a>
            <a class="mig-btn mig-btn-primary" href="/import/bulk">
              <IconImport />
              Bulk import
            </a>
          </div>
        </header>

        {rows.length === 0 ? (
          <div class="mig-empty">
            <div class="mig-empty-orb" aria-hidden="true" />
            <div class="mig-empty-inner">
              <div class="mig-empty-icon" aria-hidden="true">
                <IconImport />
              </div>
              <h3 class="mig-empty-title">No migrations yet</h3>
              <p class="mig-empty-sub">
                Pull a single repo from GitHub or kick off a bulk org import to
                see migration runs land here.
              </p>
              <div class="mig-actions" style="justify-content:center">
                <a class="mig-btn mig-btn-ghost" href="/import">
                  <IconImport />
                  Single repo
                </a>
                <a class="mig-btn mig-btn-primary" href="/import/bulk">
                  <IconImport />
                  Bulk import
                </a>
              </div>
            </div>
          </div>
        ) : (
          <div class="mig-list">
            {rows.map((r) => {
              // The schema has no migration-status column yet — every repo
              // that exists has, by definition, been "applied". We expose the
              // pill shape so when status lands later we can swap the value.
              const status: "applied" | "pending" | "failed" = "applied";
              const pillClass =
                status === "applied"
                  ? "mig-pill is-applied"
                  : status === "pending"
                    ? "mig-pill is-pending"
                    : "mig-pill is-failed";
              const tsText = r.createdAt
                ? formatRelative(r.createdAt as unknown as string)
                : "—";
              // Duration not tracked in the schema; render an em-dash so the
              // visual treatment is in place for when it lands.
              return (
                <div class="mig-row">
                  <div class="mig-row-main">
                    <div class="mig-row-name-line">
                      <a
                        href={`/${user.username}/${r.name}`}
                        class="mig-row-name"
                      >
                        {r.name}
                      </a>
                      <span class={pillClass}>
                        <span class="dot" aria-hidden="true" />
                        {status}
                      </span>
                    </div>
                    {r.description && (
                      <p class="mig-row-desc">{r.description}</p>
                    )}
                    <div class="mig-row-meta">
                      <span>Imported {tsText}</span>
                      <span class="sep">·</span>
                      <span>duration —</span>
                    </div>
                  </div>
                  <div class="mig-row-actions">
                    <a
                      class="mig-btn mig-btn-primary"
                      href={`/migrations/verify/${r.id}`}
                    >
                      <IconShield />
                      Verify
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: migStyles }} />
    </Layout>
  );
});

// ─── GET /migrations/verify/:repoId ──────────────────────────
migrations.get("/migrations/verify/:repoId", async (c) => {
  const user = c.get("user")!;
  const repoId = c.req.param("repoId");

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
        <div class="mig-wrap">
          <div class="mig-crumbs">
            <a href="/migrations">← Back to migration history</a>
          </div>
          <header class="mig-head">
            <div class="mig-head-text">
              <div class="mig-eyebrow">
                <span class="mig-eyebrow-dot" aria-hidden="true" />
                Verify migration
              </div>
              <h1 class="mig-title">
                <span class="mig-title-grad">Repository not found.</span>
              </h1>
              <p class="mig-sub">
                The repo ID didn't resolve — it may have been deleted or the
                URL is stale.
              </p>
            </div>
          </header>
        </div>
        <style dangerouslySetInnerHTML={{ __html: migStyles }} />
      </Layout>,
      404
    );
  }

  if (repo.ownerId !== user.id) {
    return c.html(
      <Layout title="Verify migration" user={user}>
        <div class="mig-wrap">
          <div class="mig-crumbs">
            <a href="/migrations">← Back to migration history</a>
          </div>
          <header class="mig-head">
            <div class="mig-head-text">
              <div class="mig-eyebrow">
                <span class="mig-eyebrow-dot" aria-hidden="true" />
                Forbidden
              </div>
              <h1 class="mig-title">
                <span class="mig-title-grad">Not your repo.</span>
              </h1>
              <p class="mig-sub">
                You can only verify repositories you own.
              </p>
            </div>
          </header>
        </div>
        <style dangerouslySetInnerHTML={{ __html: migStyles }} />
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
      result = await verify(repo.id as unknown as number);
    } catch (err: any) {
      verifierError =
        "Verifier failed: " + (err && err.message ? err.message : String(err));
    }
  }

  return c.html(
    <Layout title={`Verify ${repo.name}`} user={user}>
      <div class="mig-wrap">
        <div class="mig-crumbs">
          <a href="/migrations">← Back to migration history</a>
        </div>
        <header class="mig-head">
          <div class="mig-head-text">
            <div class="mig-eyebrow">
              <span class="mig-eyebrow-dot" aria-hidden="true" />
              Migration · Verify run
            </div>
            <h1 class="mig-title">
              <span class="mig-title-grad">
                {user.username}/{repo.name}
              </span>
            </h1>
            <p class="mig-sub">
              Re-runs the post-migration verifier. We confirm clonability, the
              default branch, and the commit count.
            </p>
          </div>
          <div class="mig-actions">
            <a
              class="mig-btn mig-btn-primary"
              href={`/migrations/verify/${repo.id}`}
            >
              <IconShield />
              Re-run
            </a>
            <a class="mig-btn mig-btn-ghost" href="/migrations">
              Back
            </a>
          </div>
        </header>

        {verifierError && (
          <div class="mig-banner is-warn" role="status">
            <span class="mig-banner-dot" aria-hidden="true" />
            {verifierError}
          </div>
        )}

        {result && (
          <div class="mig-checks">
            <div class="mig-check">
              <div class="mig-check-label">
                <span
                  class={
                    "mig-check-dot " +
                    (result.clonable ? "is-ok" : "is-fail")
                  }
                  aria-hidden="true"
                />
                Clonable
              </div>
              <div class="mig-check-detail">
                {result.clonable
                  ? "Repository responds to git clone"
                  : "Clone failed"}
              </div>
            </div>
            <div class="mig-check">
              <div class="mig-check-label">
                <span
                  class={
                    "mig-check-dot " +
                    (result.hasDefaultBranch ? "is-ok" : "is-fail")
                  }
                  aria-hidden="true"
                />
                Default branch
              </div>
              <div class="mig-check-detail">
                {result.hasDefaultBranch
                  ? `Found ${repo.defaultBranch}`
                  : `Missing ${repo.defaultBranch}`}
              </div>
            </div>
            <div class="mig-check">
              <div class="mig-check-label">
                <span
                  class={
                    "mig-check-dot " +
                    (result.commitCount > 0 ? "is-ok" : "is-fail")
                  }
                  aria-hidden="true"
                />
                Commits
              </div>
              <div class="mig-check-detail">
                {result.commitCount} commit
                {result.commitCount === 1 ? "" : "s"}
              </div>
            </div>
            {result.issues && result.issues.length > 0 && (
              <div class="mig-check" style="flex-direction:column;align-items:stretch;gap:8px">
                <div class="mig-check-label">
                  <span class="mig-check-dot is-fail" aria-hidden="true" />
                  Issues
                </div>
                <ul class="mig-issues-list">
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
                <div class="mig-banner is-ok" role="status">
                  <span class="mig-banner-dot" aria-hidden="true" />
                  All checks passed.
                </div>
              )}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: migStyles }} />
    </Layout>
  );
});

export default migrations;
