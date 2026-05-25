/**
 * Per-repo workflow secrets — settings UI for listing, creating, and deleting
 * encrypted secrets that are substituted into workflow steps at runtime.
 *
 * Shape mirrors `src/routes/tokens.tsx` + `src/routes/webhooks.tsx`:
 *   - JSX page rendered through Layout + RepoHeader + RepoNav (active=settings).
 *   - Flash state via `?added=NAME | ?deleted=1 | ?error=...` query params.
 *   - Every mutating route is gated on `requireAuth` + `requireRepoAccess("admin")`.
 *
 * The UI never sees plaintext values after upsert — the `listRepoSecrets`
 * helper in `../lib/workflow-secrets` returns metadata only (id, name,
 * createdAt, createdBy). This file's sole job is to render and mutate.
 *
 * 2026 polish: scoped `.wsec-` CSS, hero with eyebrow + gradient title,
 * masked-value list with mono names + last-used timestamps + revoke
 * actions, and a separate add-new card. No shared file touches.
 */

import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { formatRelative } from "../views/ui";
import {
  listRepoSecrets,
  upsertRepoSecret,
  deleteRepoSecret,
} from "../lib/workflow-secrets";
import { audit } from "../lib/notify";

const workflowSecretsRoutes = new Hono<AuthEnv>();

workflowSecretsRoutes.use("*", softAuth);

const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_NAME_LEN = 100;
const MAX_VALUE_LEN = 32768;

/** Sub-nav shown under the main RepoNav for repo settings pages. */
function SettingsSubNav({
  owner,
  repo,
  active,
}: {
  owner: string;
  repo: string;
  active: "general" | "collaborators" | "webhooks" | "secrets";
}) {
  const link = (
    href: string,
    label: string,
    key: "general" | "collaborators" | "webhooks" | "secrets"
  ) => (
    <a
      href={href}
      class={
        "wsec-subnav-link" + (active === key ? " is-active" : "")
      }
    >
      {label}
    </a>
  );
  return (
    <nav class="wsec-subnav" aria-label="Repository settings">
      {link(`/${owner}/${repo}/settings`, "General", "general")}
      {link(
        `/${owner}/${repo}/settings/collaborators`,
        "Collaborators",
        "collaborators"
      )}
      {link(
        `/${owner}/${repo}/settings/webhooks`,
        "Webhooks",
        "webhooks"
      )}
      {link(
        `/${owner}/${repo}/settings/secrets`,
        "Secrets",
        "secrets"
      )}
    </nav>
  );
}

/**
 * Best-effort masked preview of a secret. We never have the plaintext on
 * disk, so this is a stable visual placeholder (always 12 bullets). The
 * dot count is deliberately constant so the list doesn't leak length.
 */
const MASKED_PLACEHOLDER = "••••••••••••";

// ─── GET: List + add form ───────────────────────────────────────────────────

workflowSecretsRoutes.get(
  "/:owner/:repo/settings/secrets",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;

    const added = c.req.query("added");
    const deleted = c.req.query("deleted");
    const error = c.req.query("error");

    if (!repo) {
      return c.notFound();
    }

    const result = await listRepoSecrets(repo.id);
    const secrets = result.ok ? result.secrets : [];
    const loadError = result.ok ? null : result.error;

    // Resolve createdBy user ids -> usernames for display/linking.
    const creatorIds = Array.from(
      new Set(secrets.map((s) => s.createdBy).filter(Boolean) as string[])
    );
    const creatorRows = creatorIds.length
      ? await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(inArray(users.id, creatorIds))
      : [];
    const creatorMap = new Map(creatorRows.map((r) => [r.id, r.username]));

    return c.html(
      <Layout title={`Secrets — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} currentUser={user.username} />
        <RepoNav owner={ownerName} repo={repoName} active="settings" />
        <style dangerouslySetInnerHTML={{ __html: wsecStyles }} />
        <div class="wsec-wrap">
          <SettingsSubNav
            owner={ownerName}
            repo={repoName}
            active="secrets"
          />

          {/* ─── Hero ─── */}
          <section class="wsec-hero">
            <div class="wsec-hero-orb" aria-hidden="true" />
            <div class="wsec-hero-inner">
              <div class="wsec-eyebrow">
                <span class="wsec-eyebrow-pill" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </span>
                Workflow secrets · <strong>{ownerName}/{repoName}</strong>
              </div>
              <h1 class="wsec-title">
                Secrets, <span class="wsec-title-grad">encrypted at rest.</span>
              </h1>
              <p class="wsec-sub">
                Reference them in YAML as{" "}
                <code>{"${{ secrets.NAME }}"}</code>. Values are write-only —
                after saving, only the name is visible. They're never printed
                to workflow logs.
              </p>
            </div>
          </section>

          {/* ─── Flash banners ─── */}
          {added && (
            <div class="wsec-banner is-ok">
              <span class="wsec-banner-dot" aria-hidden="true" />
              Secret <code>{decodeURIComponent(added)}</code> saved.
            </div>
          )}
          {deleted && (
            <div class="wsec-banner is-ok">
              <span class="wsec-banner-dot" aria-hidden="true" />
              Secret deleted.
            </div>
          )}
          {error && (
            <div class="wsec-banner is-error">
              <span class="wsec-banner-dot" aria-hidden="true" />
              {decodeURIComponent(error)}
            </div>
          )}
          {loadError && (
            <div class="wsec-banner is-error">
              <span class="wsec-banner-dot" aria-hidden="true" />
              Could not load secrets: {loadError}
            </div>
          )}

          {/* ─── Secrets list ─── */}
          <section class="wsec-section" aria-labelledby="wsec-list-h">
            <header class="wsec-section-head">
              <div>
                <h2 class="wsec-section-title" id="wsec-list-h">
                  Stored secrets
                </h2>
                <p class="wsec-section-sub">
                  {secrets.length === 0
                    ? "Add your first secret below."
                    : `${secrets.length} secret${secrets.length === 1 ? "" : "s"} available to workflows in this repo.`}
                </p>
              </div>
              <span class="wsec-count-pill">
                {secrets.length} / unlimited
              </span>
            </header>
            <div class="wsec-section-body">
              {secrets.length === 0 ? (
                <div class="wsec-empty">
                  <div class="wsec-empty-orb" aria-hidden="true" />
                  <div class="wsec-empty-inner">
                    <p class="wsec-empty-title">No secrets yet.</p>
                    <p class="wsec-empty-sub">
                      Add an encrypted secret below — names like{" "}
                      <code>DEPLOY_TOKEN</code> or <code>STRIPE_KEY</code>{" "}
                      become available to every workflow step in this repo.
                    </p>
                  </div>
                </div>
              ) : (
                <ul class="wsec-list">
                  {secrets.map((s) => {
                    const creator = s.createdBy
                      ? creatorMap.get(s.createdBy)
                      : null;
                    const created = s.createdAt
                      ? formatRelative(s.createdAt)
                      : "—";
                    return (
                      <li class="wsec-row">
                        <div class="wsec-row-main">
                          <div class="wsec-row-name-row">
                            <code class="wsec-row-name">{s.name}</code>
                            <span class="wsec-row-masked" aria-label="value hidden">
                              {MASKED_PLACEHOLDER}
                            </span>
                          </div>
                          <div class="wsec-row-meta">
                            <span class="wsec-meta-item">
                              Added {created}
                            </span>
                            <span class="wsec-meta-sep" aria-hidden="true">·</span>
                            <span class="wsec-meta-item">
                              by{" "}
                              {creator ? (
                                <a
                                  href={`/${creator}`}
                                  class="wsec-meta-link"
                                >
                                  {creator}
                                </a>
                              ) : (
                                <span class="wsec-meta-faint">unknown</span>
                              )}
                            </span>
                          </div>
                        </div>
                        <div class="wsec-row-actions">
                          <form
                            method="post"
                            action={`/${ownerName}/${repoName}/settings/secrets/${s.id}/delete`}
                            onsubmit={`return confirm('Revoke secret ${s.name}? Workflow steps that reference it will fail until you add it again.')`}
                          >
                            <button
                              type="submit"
                              class="wsec-btn wsec-btn-danger"
                            >
                              Revoke
                            </button>
                          </form>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* ─── Add new ─── */}
          <section class="wsec-section" aria-labelledby="wsec-add-h">
            <header class="wsec-section-head">
              <div>
                <h2 class="wsec-section-title" id="wsec-add-h">
                  Add a new secret
                </h2>
                <p class="wsec-section-sub">
                  Names must be uppercase letters, digits, and underscores,
                  and cannot start with a digit. Adding a secret with an
                  existing name replaces the stored value.
                </p>
              </div>
            </header>
            <div class="wsec-section-body">
              <form
                method="post"
                action={`/${ownerName}/${repoName}/settings/secrets`}
                class="wsec-form"
              >
                <div class="wsec-field">
                  <label class="wsec-field-label" for="secret-name">
                    Name
                  </label>
                  <input
                    type="text"
                    id="secret-name"
                    name="name"
                    required
                    pattern="[A-Z_][A-Z0-9_]*"
                    maxlength={MAX_NAME_LEN}
                    placeholder="DEPLOY_TOKEN"
                    autocomplete="off"
                    class="wsec-input wsec-input-mono"
                    title="Uppercase letters, digits, and underscores; cannot start with a digit"
                  />
                  <p class="wsec-field-help">
                    Referenced in YAML as{" "}
                    <code>{"${{ secrets.YOUR_NAME }}"}</code>.
                  </p>
                </div>
                <div class="wsec-field">
                  <label class="wsec-field-label" for="secret-value">
                    Value
                  </label>
                  <textarea
                    id="secret-value"
                    name="value"
                    required
                    rows={5}
                    maxlength={MAX_VALUE_LEN}
                    placeholder="Paste secret value"
                    autocomplete="off"
                    spellcheck={false}
                    class="wsec-input wsec-input-mono wsec-textarea"
                  />
                  <p class="wsec-field-help">
                    Encrypted with AES-256-GCM before the row hits the
                    database. We never write it to logs.
                  </p>
                </div>
                <div class="wsec-form-actions">
                  <button
                    type="submit"
                    class="wsec-btn wsec-btn-primary"
                  >
                    Add secret
                  </button>
                </div>
              </form>
            </div>
          </section>
        </div>
      </Layout>
    );
  }
);

// ─── POST: Create / update ──────────────────────────────────────────────────

workflowSecretsRoutes.post(
  "/:owner/:repo/settings/secrets",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;
    if (!repo) return c.notFound();

    const body = await c.req.parseBody();
    const name = String(body.name || "").trim();
    const value = typeof body.value === "string" ? body.value : "";

    const base = `/${ownerName}/${repoName}/settings/secrets`;
    const fail = (msg: string) =>
      c.redirect(`${base}?error=${encodeURIComponent(msg)}`);

    if (!name) return fail("Name is required");
    if (name.length > MAX_NAME_LEN)
      return fail(`Name must be ≤ ${MAX_NAME_LEN} characters`);
    if (!SECRET_NAME_RE.test(name))
      return fail(
        "Name must be uppercase letters, digits, and underscores, and cannot start with a digit"
      );
    if (!value) return fail("Value is required");
    if (value.length > MAX_VALUE_LEN)
      return fail(`Value must be ≤ ${MAX_VALUE_LEN} characters`);

    const result = await upsertRepoSecret({
      repoId: repo.id,
      name,
      value,
      createdBy: user.id,
    });

    if (!result.ok) return fail(result.error);

    // Best-effort audit — swallow any error so it never breaks the redirect.
    try {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "workflow.secret.create",
        targetType: "workflow_secret",
        targetId: result.id,
        metadata: { name },
      });
    } catch {
      // audit() already swallows errors, but guard anyway.
    }

    return c.redirect(`${base}?added=${encodeURIComponent(name)}`);
  }
);

// ─── POST: Delete ───────────────────────────────────────────────────────────

workflowSecretsRoutes.post(
  "/:owner/:repo/settings/secrets/:secretId/delete",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = c.get("repository") as { id: string } | undefined;
    if (!repo) return c.notFound();

    const secretId = c.req.param("secretId");
    const base = `/${ownerName}/${repoName}/settings/secrets`;

    if (!secretId) {
      return c.redirect(`${base}?error=${encodeURIComponent("Missing secret id")}`);
    }

    const result = await deleteRepoSecret({
      repoId: repo.id,
      secretId,
    });

    if (!result.ok) {
      return c.redirect(
        `${base}?error=${encodeURIComponent(result.error)}`
      );
    }

    try {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "workflow.secret.delete",
        targetType: "workflow_secret",
        targetId: secretId,
      });
    } catch {
      // best-effort
    }

    return c.redirect(`${base}?deleted=1`);
  }
);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.wsec-` so this surface can't bleed
 * into other settings pages.
 * ───────────────────────────────────────────────────────────────────── */
const wsecStyles = `
  .wsec-wrap { max-width: 880px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  /* ─── Sub-nav ─── */
  .wsec-subnav {
    display: flex;
    gap: 4px;
    margin: 0 0 var(--space-4);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .wsec-subnav-link {
    padding: 6px 12px;
    border-radius: 8px;
    text-decoration: none;
    font-size: 13.5px;
    color: var(--text-muted);
    transition: color 120ms ease, background 120ms ease;
  }
  .wsec-subnav-link:hover {
    color: var(--text);
    text-decoration: none;
    background: rgba(255,255,255,0.03);
  }
  .wsec-subnav-link.is-active {
    background: var(--bg-secondary);
    color: var(--text-strong);
    font-weight: 600;
  }

  /* ─── Hero ─── */
  .wsec-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .wsec-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .wsec-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.65;
    pointer-events: none;
    z-index: 0;
  }
  .wsec-hero-inner { position: relative; z-index: 1; max-width: 640px; }
  .wsec-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .wsec-eyebrow strong {
    color: var(--accent);
    font-weight: 600;
  }
  .wsec-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .wsec-title {
    font-size: clamp(26px, 4vw, 36px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.026em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .wsec-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .wsec-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }
  .wsec-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text-strong);
  }

  /* ─── Banner ─── */
  .wsec-banner {
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
  .wsec-banner code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(0,0,0,0.18);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .wsec-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .wsec-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .wsec-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Section cards ─── */
  .wsec-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .wsec-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .wsec-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .wsec-section-sub {
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .wsec-section-sub code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .wsec-section-body { padding: 0; }

  .wsec-count-pill {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    background: rgba(140,109,255,0.10);
    color: #c5b3ff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    letter-spacing: 0.02em;
  }

  /* ─── Secret list rows ─── */
  .wsec-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .wsec-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--border);
    transition: background 120ms ease;
  }
  .wsec-row:last-child { border-bottom: 0; }
  .wsec-row:hover { background: rgba(255,255,255,0.018); }
  .wsec-row-main { flex: 1; min-width: 0; }
  .wsec-row-name-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .wsec-row-name {
    font-family: var(--font-mono);
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text-strong);
    background: var(--bg-secondary);
    padding: 3px 8px;
    border-radius: 6px;
    border: 1px solid var(--border-subtle);
  }
  .wsec-row-masked {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-faint);
    letter-spacing: 1px;
    user-select: none;
  }
  .wsec-row-meta {
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .wsec-meta-sep { color: var(--text-faint); }
  .wsec-meta-link {
    color: var(--accent);
    text-decoration: none;
  }
  .wsec-meta-link:hover { text-decoration: underline; }
  .wsec-meta-faint { color: var(--text-faint); }
  .wsec-row-actions { flex-shrink: 0; }

  /* ─── Empty state ─── */
  .wsec-empty {
    position: relative;
    margin: var(--space-4) var(--space-5) var(--space-5);
    padding: var(--space-6) var(--space-5);
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    background: rgba(255,255,255,0.02);
    text-align: center;
    overflow: hidden;
  }
  .wsec-empty-orb {
    position: absolute;
    inset: -40% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.55;
    pointer-events: none;
    z-index: 0;
  }
  .wsec-empty-inner { position: relative; z-index: 1; }
  .wsec-empty-title {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.012em;
  }
  .wsec-empty-sub {
    margin: 0 auto;
    max-width: 460px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .wsec-empty-sub code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text-strong);
  }

  /* ─── Form ─── */
  .wsec-form { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }
  .wsec-field { display: flex; flex-direction: column; gap: 6px; }
  .wsec-field-label {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.005em;
  }
  .wsec-input {
    width: 100%;
    padding: 9px 12px;
    font-size: 13.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    box-sizing: border-box;
    transition: border-color 120ms ease, box-shadow 120ms ease;
    font-family: inherit;
  }
  .wsec-input-mono { font-family: var(--font-mono); }
  .wsec-textarea {
    resize: vertical;
    min-height: 110px;
    line-height: 1.5;
  }
  .wsec-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .wsec-field-help {
    margin: 0;
    font-size: 11.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .wsec-field-help code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .wsec-form-actions { display: flex; justify-content: flex-end; }

  /* ─── Buttons ─── */
  .wsec-btn {
    appearance: none;
    border: 1px solid var(--border-strong);
    background: var(--bg-secondary);
    color: var(--text);
    padding: 8px 14px;
    border-radius: 8px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 150ms ease, background 150ms ease, transform 150ms ease, color 150ms ease;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .wsec-btn:hover {
    border-color: var(--border-focus);
    background: rgba(255,255,255,0.04);
    transform: translateY(-1px);
  }
  .wsec-btn-primary {
    border-color: rgba(140,109,255,0.45);
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    color: var(--text-strong);
    padding: 10px 18px;
    font-size: 13.5px;
  }
  .wsec-btn-primary:hover {
    border-color: rgba(140,109,255,0.65);
    background: linear-gradient(135deg, rgba(140,109,255,0.28), rgba(54,197,214,0.20));
  }
  .wsec-btn-danger {
    border-color: rgba(248,113,113,0.32);
    color: #fecaca;
  }
  .wsec-btn-danger:hover {
    border-color: rgba(248,113,113,0.55);
    background: rgba(248,113,113,0.10);
    color: #fee2e2;
  }

  @media (max-width: 640px) {
    .wsec-row { flex-direction: column; align-items: flex-start; }
    .wsec-row-actions { width: 100%; }
    .wsec-row-actions form { width: 100%; }
    .wsec-row-actions .wsec-btn { width: 100%; justify-content: center; }
  }
`;

export default workflowSecretsRoutes;
