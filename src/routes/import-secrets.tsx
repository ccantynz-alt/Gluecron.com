/**
 * Block T1 — GitHub Actions secret-migration checklist UI.
 *
 * After a user imports a GitHub repo (see `src/routes/import.tsx`), if their
 * GitHub repo had any Actions secrets we pre-create matching placeholder
 * rows in `workflow_secrets` (via `src/lib/github-secrets-import.ts`) and
 * redirect to `GET /:owner/:repo/import/secrets`. This route renders the
 * one-shot checklist — name + status pill + a password input per row + a
 * "Save" button per row. The Done button always works, even with empty
 * placeholders remaining, because users can come back later via the
 * regular `/settings/secrets` page.
 *
 * Why a separate route from `workflow-secrets.tsx`?
 *   - Different UX shape (vertical checklist vs add-form-on-top table)
 *   - Different copy ("we found N secrets from your GitHub repo")
 *   - Different one-shot lifecycle (cleanup empty placeholders on Done)
 *
 * Empty-vs-filled detection: we decrypt each row and check if plaintext
 * is the empty string. Cheap, accurate, and avoids leaking the "is this
 * a placeholder?" boolean as a database column (which would also force
 * a migration for a feature we shipped behaviourally).
 *
 * CSRF: every POST is guarded by the global `csrfProtect` middleware
 * (see `src/middleware/csrf.ts`); same-origin Origin/Referer check is the
 * primary defence. Each value submission still goes through the existing
 * `upsertRepoSecret` encryption layer — no plaintext storage.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { workflowSecrets } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { upsertRepoSecret, listRepoSecrets } from "../lib/workflow-secrets";
import { decryptSecret } from "../lib/workflow-secrets-crypto";
import { audit } from "../lib/notify";

const importSecretsRoutes = new Hono<AuthEnv>();

importSecretsRoutes.use("*", softAuth);

const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_VALUE_LEN = 32768;

// ─── Scoped CSS ─────────────────────────────────────────────────────────────
// Every class prefixed `.is-checklist-` so this surface cannot bleed into
// neighbouring repo pages. Mirrors the 2026 hero + numbered-step pattern
// from `src/routes/connect-claude.tsx` and `src/routes/admin-integrations.tsx`.
const checklistStyles = `
  .is-checklist-wrap {
    max-width: 820px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4);
  }

  /* ─── Hero ─── */
  .is-checklist-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .is-checklist-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .is-checklist-hero-orb {
    position: absolute;
    inset: -22% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .is-checklist-hero-inner { position: relative; z-index: 1; }
  .is-checklist-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 14px;
  }
  .is-checklist-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .is-checklist-title {
    font-size: clamp(26px, 3.6vw, 36px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .is-checklist-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .is-checklist-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }
  .is-checklist-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-tertiary);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--text);
  }
  .is-checklist-counts {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    margin-top: var(--space-3);
    padding: 6px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 9999px;
    font-size: 12.5px;
    color: var(--text);
    font-family: var(--font-mono);
  }
  .is-checklist-counts .num { color: var(--accent); font-weight: 700; }
  .is-checklist-counts .sep { color: var(--text-faint); }

  /* ─── Banners ─── */
  .is-checklist-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .is-checklist-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .is-checklist-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .is-checklist-banner code {
    font-family: var(--font-mono);
    background: rgba(0,0,0,0.18);
    padding: 1px 6px;
    border-radius: 4px;
  }

  /* ─── Numbered checklist cards ─── */
  .is-checklist-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }
  .is-checklist-card {
    position: relative;
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    transition: border-color 150ms ease, transform 150ms ease;
  }
  .is-checklist-card:hover { border-color: var(--border-strong); }
  .is-checklist-card.is-pasted { border-color: rgba(52,211,153,0.30); }

  .is-checklist-card-head {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }
  .is-checklist-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    color: #c5b3ff;
    border: 1px solid rgba(140,109,255,0.40);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
    flex-shrink: 0;
  }
  .is-checklist-card-name {
    font-family: var(--font-mono);
    font-size: 14px;
    color: var(--text-strong);
    font-weight: 600;
    word-break: break-all;
    flex: 1;
  }

  .is-checklist-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .is-checklist-pill .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .is-checklist-pill.is-saved {
    color: #6ee7b7;
    background: rgba(52,211,153,0.14);
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .is-checklist-pill.is-empty {
    color: #fde68a;
    background: rgba(251,191,36,0.10);
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
  }

  .is-checklist-form {
    display: flex;
    gap: 8px;
    align-items: stretch;
    flex-wrap: wrap;
  }
  .is-checklist-input {
    flex: 1;
    min-width: 220px;
    padding: 9px 12px;
    font-size: 13.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
  }
  .is-checklist-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .is-checklist-save {
    appearance: none;
    border: 1px solid var(--border-strong);
    background: var(--bg-secondary);
    color: var(--text);
    padding: 9px 16px;
    border-radius: 8px;
    font-family: inherit;
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 150ms ease, background 150ms ease;
  }
  .is-checklist-save:hover {
    border-color: var(--border-focus);
    background: rgba(255,255,255,0.03);
  }

  /* ─── Done bar ─── */
  .is-checklist-done {
    margin-top: var(--space-6);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .is-checklist-done-text {
    flex: 1;
    min-width: 220px;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .is-checklist-done-text strong {
    color: var(--text-strong);
    font-weight: 600;
  }
  .is-checklist-done-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .is-checklist-done-cleanup {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }
  .is-checklist-done-cleanup input[type="checkbox"] {
    width: 15px; height: 15px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .is-checklist-done-btn {
    appearance: none;
    padding: 11px 20px;
    border-radius: 10px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.005em;
    cursor: pointer;
    color: #fff;
    border: 1px solid rgba(140,109,255,0.55);
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    box-shadow: 0 4px 14px rgba(140,109,255,0.32);
    transition: transform 150ms ease, box-shadow 150ms ease, filter 150ms ease;
  }
  .is-checklist-done-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 18px rgba(140,109,255,0.42);
    filter: brightness(1.06);
  }
  .is-checklist-done-btn:active { transform: translateY(0); }
`;

type ChecklistRow = {
  id: string;
  name: string;
  status: "pasted" | "empty";
};

/**
 * Load each secret row for the repo and decrypt it to determine empty
 * (placeholder) vs filled. Returns an empty array on any DB or decrypt
 * failure — the route handler degrades to "no rows" rather than erroring,
 * because this UI is an optional post-import polish step.
 */
async function loadChecklist(repoId: string): Promise<ChecklistRow[]> {
  let rows: { id: string; name: string; encryptedValue: string }[];
  try {
    rows = await db
      .select({
        id: workflowSecrets.id,
        name: workflowSecrets.name,
        encryptedValue: workflowSecrets.encryptedValue,
      })
      .from(workflowSecrets)
      .where(eq(workflowSecrets.repositoryId, repoId));
  } catch {
    return [];
  }

  // Sort: empty placeholders first (so the user works through them), then
  // filled rows alphabetically. Stable within each group.
  const out: ChecklistRow[] = rows.map((r) => {
    const dec = decryptSecret(r.encryptedValue);
    const status: "pasted" | "empty" =
      dec.ok && dec.plaintext === "" ? "empty" : "pasted";
    return { id: r.id, name: r.name, status };
  });
  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === "empty" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

// ─── GET: Checklist ─────────────────────────────────────────────────────────

importSecretsRoutes.get(
  "/:owner/:repo/import/secrets",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;
    if (!repo) return c.notFound();

    const saved = c.req.query("saved");
    const error = c.req.query("error");

    const rows = await loadChecklist(repo.id);
    const emptyCount = rows.filter((r) => r.status === "empty").length;
    const pastedCount = rows.length - emptyCount;

    // If the repo has zero placeholders at all (e.g. the user came back to
    // this URL after finishing earlier, or the secrets migration didn't
    // actually find any rows — empty repo, no token, decrypt failure),
    // redirect back to /import with a success banner explaining what
    // happened. Previously this redirected silently to the repo home with
    // no feedback, so users didn't know whether secrets had migrated or
    // not.
    if (rows.length === 0) {
      return c.redirect(
        `/import?success=${encodeURIComponent(
          `Import of ${ownerName}/${repoName} succeeded. No secrets were migrated — either the GitHub repo has none, the token lacks the 'actions:read' scope, or you already pasted values in a previous session. Open the repo at /${ownerName}/${repoName} to start using it.`
        )}`
      );
    }

    return c.html(
      <Layout
        title={`Import secrets — ${ownerName}/${repoName}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} currentUser={user.username} />
        <RepoNav owner={ownerName} repo={repoName} active="settings" />
        <style dangerouslySetInnerHTML={{ __html: checklistStyles }} />
        <div class="is-checklist-wrap">
          {/* ─── Hero ─── */}
          <section class="is-checklist-hero">
            <div class="is-checklist-hero-orb" aria-hidden="true" />
            <div class="is-checklist-hero-inner">
              <div class="is-checklist-eyebrow">
                <span class="is-checklist-eyebrow-pill" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </span>
                Post-import · {ownerName}/{repoName}
              </div>
              <h1 class="is-checklist-title">
                Migrate{" "}
                <span class="is-checklist-title-grad">
                  {rows.length} secret{rows.length === 1 ? "" : "s"}
                </span>{" "}
                from GitHub.
              </h1>
              <p class="is-checklist-sub">
                We found {rows.length} Actions secret{rows.length === 1 ? "" : "s"} on your
                GitHub repo. Paste each value below to migrate. GitHub stores values
                opaquely — copy from wherever you originally created them
                (1Password, .env file, etc.).
              </p>
              <div class="is-checklist-counts" aria-label="Migration progress">
                <span><span class="num">{pastedCount}</span> pasted</span>
                <span class="sep">·</span>
                <span><span class="num">{emptyCount}</span> still empty</span>
              </div>
            </div>
          </section>

          {saved && (
            <div class="is-checklist-banner is-ok" role="status">
              Saved <code>{decodeURIComponent(saved)}</code>.
            </div>
          )}
          {error && (
            <div class="is-checklist-banner is-error" role="alert">
              {decodeURIComponent(error)}
            </div>
          )}

          {/* ─── Numbered checklist cards ─── */}
          <div class="is-checklist-list">
            {rows.map((row, idx) => {
              const action = `/${ownerName}/${repoName}/import/secrets/${encodeURIComponent(row.name)}`;
              const pasted = row.status === "pasted";
              return (
                <div
                  class={"is-checklist-card " + (pasted ? "is-pasted" : "is-empty")}
                  data-secret-row={row.name}
                >
                  <div class="is-checklist-card-head">
                    <span class="is-checklist-num" aria-hidden="true">
                      {idx + 1}
                    </span>
                    <span class="is-checklist-card-name">{row.name}</span>
                    <span
                      data-status-pill
                      class={"is-checklist-pill " + (pasted ? "is-saved" : "is-empty")}
                    >
                      <span class="dot" aria-hidden="true" />
                      {pasted ? "Saved" : "Empty"}
                    </span>
                  </div>
                  <form method="post" action={action} class="is-checklist-form">
                    <input
                      type="password"
                      name="value"
                      required
                      maxlength={MAX_VALUE_LEN}
                      placeholder={
                        pasted
                          ? "Already saved — paste new value to overwrite"
                          : "Paste value"
                      }
                      autocomplete="off"
                      spellcheck={false}
                      class="is-checklist-input"
                      aria-label={`Value for ${row.name}`}
                    />
                    <button type="submit" class="is-checklist-save">
                      Save
                    </button>
                  </form>
                </div>
              );
            })}
          </div>

          {/* ─── Done bar ─── */}
          <form
            method="post"
            action={`/${ownerName}/${repoName}/import/secrets/done`}
            class="is-checklist-done"
          >
            <div class="is-checklist-done-text">
              {emptyCount > 0 ? (
                <>
                  <strong>{emptyCount}</strong> placeholder{emptyCount === 1 ? "" : "s"} still empty —
                  finish later via{" "}
                  <code>/{ownerName}/{repoName}/settings/secrets</code>.
                </>
              ) : (
                <>All secrets migrated. <strong>Ship it.</strong></>
              )}
            </div>
            <div class="is-checklist-done-actions">
              {emptyCount > 0 && (
                <label class="is-checklist-done-cleanup">
                  <input type="checkbox" name="cleanup_empty" value="1" />
                  Delete the {emptyCount} empty placeholder{emptyCount === 1 ? "" : "s"}
                </label>
              )}
              <button type="submit" class="is-checklist-done-btn">
                Done — go to repo
              </button>
            </div>
          </form>
        </div>
      </Layout>
    );
  }
);

// ─── POST: Save one value ───────────────────────────────────────────────────

importSecretsRoutes.post(
  "/:owner/:repo/import/secrets/done",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;
    if (!repo) return c.notFound();

    const body = await c.req.parseBody();
    const cleanup = String(body.cleanup_empty || "") === "1";

    if (cleanup) {
      try {
        const meta = await listRepoSecrets(repo.id);
        if (meta.ok) {
          // Decrypt each row to find empty placeholders, then delete them
          // by id+repo (defensive scope, same shape as deleteRepoSecret).
          const rows = await db
            .select({
              id: workflowSecrets.id,
              name: workflowSecrets.name,
              encryptedValue: workflowSecrets.encryptedValue,
            })
            .from(workflowSecrets)
            .where(eq(workflowSecrets.repositoryId, repo.id));
          let deleted = 0;
          for (const r of rows) {
            const dec = decryptSecret(r.encryptedValue);
            if (dec.ok && dec.plaintext === "") {
              await db
                .delete(workflowSecrets)
                .where(
                  and(
                    eq(workflowSecrets.id, r.id),
                    eq(workflowSecrets.repositoryId, repo.id)
                  )
                );
              deleted++;
            }
          }
          if (deleted > 0) {
            try {
              await audit({
                userId: user.id,
                repositoryId: repo.id,
                action: "workflow.secret.import_cleanup",
                targetType: "repository",
                targetId: repo.id,
                metadata: { deleted },
              });
            } catch {
              // best-effort
            }
          }
        }
      } catch {
        // Cleanup errors never block the redirect — user can re-run via
        // the regular /settings/secrets UI.
      }
    }

    return c.redirect(`/${ownerName}/${repoName}`);
  }
);

importSecretsRoutes.post(
  "/:owner/:repo/import/secrets/:name",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const rawName = c.req.param("name");
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;
    if (!repo) return c.notFound();

    const base = `/${ownerName}/${repoName}/import/secrets`;
    const fail = (msg: string) =>
      c.redirect(`${base}?error=${encodeURIComponent(msg)}`);

    const name = (rawName || "").trim();
    if (!name || !SECRET_NAME_RE.test(name)) {
      return fail("Invalid secret name");
    }

    const body = await c.req.parseBody();
    const value = typeof body.value === "string" ? body.value : "";

    if (!value) return fail("Value is required");
    if (value.length > MAX_VALUE_LEN)
      return fail(`Value must be <= ${MAX_VALUE_LEN} characters`);

    const result = await upsertRepoSecret({
      repoId: repo.id,
      name,
      value,
      createdBy: user.id,
    });

    if (!result.ok) return fail(result.error);

    try {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "workflow.secret.import_pasted",
        targetType: "workflow_secret",
        targetId: result.id,
        metadata: { name },
      });
    } catch {
      // best-effort
    }

    return c.redirect(`${base}?saved=${encodeURIComponent(name)}`);
  }
);

export default importSecretsRoutes;
