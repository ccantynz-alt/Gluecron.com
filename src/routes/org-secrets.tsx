/**
 * Org-level secrets UI — Block M1.
 *
 * Routes:
 *   GET  /orgs/:slug/settings/secrets          — list secrets (admin/owner only)
 *   POST /orgs/:slug/settings/secrets          — create or update a secret
 *   POST /orgs/:slug/settings/secrets/:id/delete — delete a secret
 *
 * Auth: requireAuth + org admin/owner check via loadOrgForUser.
 * CSS:  every selector prefixed `.osec-*` — no bleed into other surfaces.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { loadOrgForUser, orgRoleAtLeast } from "../lib/orgs";
import {
  listOrgSecrets,
  upsertOrgSecret,
  deleteOrgSecret,
} from "../lib/org-secrets";
import { getUnreadCount } from "../lib/unread";

const orgSecretsRoutes = new Hono<AuthEnv>();

// ── Auth guard ────────────────────────────────────────────────────────────────

orgSecretsRoutes.use("/orgs/:slug/settings/secrets*", softAuth, requireAuth);

// ── Scoped CSS (.osec-*) ──────────────────────────────────────────────────────

const osecStyles = `
  .osec-wrap {
    max-width: 900px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4);
  }

  /* ─── Hero ─── */
  .osec-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .osec-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .osec-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 360px; height: 360px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .osec-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 640px;
  }
  .osec-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .osec-title {
    font-size: clamp(26px, 4vw, 38px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .osec-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .osec-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  /* ─── Info banner ─── */
  .osec-banner {
    display: flex;
    gap: 12px;
    padding: 14px 18px;
    background: rgba(140,109,255,0.08);
    border: 1px solid rgba(140,109,255,0.22);
    border-radius: 12px;
    margin-bottom: var(--space-5);
    font-size: 13.5px;
    color: var(--text);
    line-height: 1.55;
  }
  .osec-banner-icon {
    flex-shrink: 0;
    width: 18px; height: 18px;
    margin-top: 1px;
    color: #a78bfa;
  }

  /* ─── Flash messages ─── */
  .osec-flash {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 10px;
    margin-bottom: var(--space-4);
    font-size: 13.5px;
    line-height: 1.45;
  }
  .osec-flash-ok {
    background: rgba(34,197,94,0.10);
    border: 1px solid rgba(34,197,94,0.26);
    color: #86efac;
  }
  .osec-flash-err {
    background: rgba(239,68,68,0.10);
    border: 1px solid rgba(239,68,68,0.28);
    color: #fca5a5;
  }

  /* ─── Form card ─── */
  .osec-form-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-5) var(--space-5);
    margin-bottom: var(--space-6);
  }
  .osec-form-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 var(--space-4);
    letter-spacing: -0.01em;
  }
  .osec-form-row {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 10px;
    align-items: end;
  }
  @media (max-width: 640px) {
    .osec-form-row { grid-template-columns: 1fr; }
  }
  .osec-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
    font-family: var(--font-mono);
  }
  .osec-input {
    width: 100%;
    padding: 9px 13px;
    background: var(--bg-input, var(--bg));
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 8px;
    color: var(--text);
    font-size: 13.5px;
    font-family: var(--font-mono);
    box-sizing: border-box;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .osec-input:focus {
    outline: none;
    border-color: rgba(140,109,255,0.6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.14);
  }
  .osec-input.is-invalid {
    border-color: rgba(239,68,68,0.6);
  }
  .osec-hint {
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 5px;
  }
  .osec-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 18px;
    border-radius: 9px;
    font-size: 13.5px;
    font-weight: 600;
    border: 1px solid transparent;
    cursor: pointer;
    font-family: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
    white-space: nowrap;
  }
  .osec-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 5px 16px -4px rgba(140,109,255,0.45);
  }
  .osec-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 9px 22px -6px rgba(140,109,255,0.55);
  }
  .osec-btn-danger {
    background: transparent;
    color: #f87171;
    border-color: rgba(239,68,68,0.35);
    padding: 6px 12px;
    font-size: 12.5px;
  }
  .osec-btn-danger:hover {
    background: rgba(239,68,68,0.08);
    border-color: rgba(239,68,68,0.6);
  }

  /* ─── Secrets table ─── */
  .osec-section-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 var(--space-3);
    letter-spacing: -0.01em;
  }
  .osec-table-wrap {
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .osec-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
  }
  .osec-table thead th {
    padding: 10px 16px;
    background: var(--bg-secondary, var(--bg-elevated));
    border-bottom: 1px solid var(--border);
    text-align: left;
    font-size: 11.5px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-family: var(--font-mono);
  }
  .osec-table tbody tr {
    border-bottom: 1px solid var(--border);
    transition: background 80ms ease;
  }
  .osec-table tbody tr:last-child { border-bottom: none; }
  .osec-table tbody tr:hover { background: rgba(140,109,255,0.035); }
  .osec-table td {
    padding: 11px 16px;
    color: var(--text);
    vertical-align: middle;
  }
  .osec-name {
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-strong);
    font-size: 13px;
  }
  .osec-hint-val {
    font-family: var(--font-mono);
    color: var(--text-muted);
    font-size: 12.5px;
  }
  .osec-date {
    font-size: 12.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .osec-actions { text-align: right; }

  /* ─── Empty state ─── */
  .osec-empty {
    padding: 48px 24px;
    text-align: center;
    background: var(--bg-secondary, var(--bg-elevated));
  }
  .osec-empty-icon {
    width: 40px; height: 40px;
    margin: 0 auto 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    background: rgba(140,109,255,0.12);
    color: #a78bfa;
  }
  .osec-empty-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
  }
  .osec-empty-sub {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  /* ─── Breadcrumb ─── */
  .osec-crumb {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .osec-crumb a { color: var(--text-muted); text-decoration: none; }
  .osec-crumb a:hover { color: var(--text); }
  .osec-crumb-sep { opacity: 0.4; }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ── GET /orgs/:slug/settings/secrets ─────────────────────────────────────────

orgSecretsRoutes.get("/orgs/:slug/settings/secrets", async (c) => {
  const slug = c.req.param("slug");
  const user = c.get("user")!;

  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "admin")) {
    return c.redirect(`/orgs/${slug}`);
  }

  const secrets = await listOrgSecrets(org.id);
  const unread = await getUnreadCount(user.id);
  const success = c.req.query("success");
  const error = c.req.query("error");

  return c.html(
    <Layout
      title={`Secrets — ${org.slug}`}
      user={user}
      notificationCount={unread}
    >
      <style dangerouslySetInnerHTML={{ __html: osecStyles }} />

      <div class="osec-wrap">
        {/* Breadcrumb */}
        <nav class="osec-crumb" aria-label="breadcrumb">
          <a href={`/orgs/${org.slug}`}>{org.slug}</a>
          <span class="osec-crumb-sep">/</span>
          <a href={`/orgs/${org.slug}/settings`}>settings</a>
          <span class="osec-crumb-sep">/</span>
          <span>secrets</span>
        </nav>

        {/* Hero */}
        <div class="osec-hero" role="banner">
          <div class="osec-hero-orb" aria-hidden="true" />
          <div class="osec-hero-inner">
            <div class="osec-eyebrow">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Org secrets
            </div>
            <h1 class="osec-title">
              <span class="osec-title-grad">Secrets.</span>
            </h1>
            <p class="osec-sub">
              Encrypted values available to all workflow runs in{" "}
              <strong>{org.slug}</strong>.
            </p>
          </div>
        </div>

        {/* Flash */}
        {success && (
          <div class="osec-flash osec-flash-ok" role="status">
            <svg class="osec-banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            {decodeURIComponent(success)}
          </div>
        )}
        {error && (
          <div class="osec-flash osec-flash-err" role="alert">
            <svg class="osec-banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {decodeURIComponent(error)}
          </div>
        )}

        {/* Info banner */}
        <div class="osec-banner" role="note">
          <svg class="osec-banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="8" />
            <line x1="12" y1="12" x2="12" y2="16" />
          </svg>
          These secrets are available to all workflow runs in this org. They're
          overridden by repo-level secrets of the same name.
        </div>

        {/* Add / update form */}
        <div class="osec-form-card">
          <p class="osec-form-title">Add or update a secret</p>
          <form method="post" action={`/orgs/${org.slug}/settings/secrets`}>
            <div class="osec-form-row">
              <div>
                <label class="osec-label" for="osec-name">Name</label>
                <input
                  id="osec-name"
                  class="osec-input"
                  type="text"
                  name="name"
                  required
                  placeholder="MY_SECRET_NAME"
                  pattern="[A-Z_][A-Z0-9_]*"
                  maxLength={100}
                  autocomplete="off"
                  spellcheck={false}
                  oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9_]/g,'');this.classList.toggle('is-invalid',this.value.length>0&&!/^[A-Z_][A-Z0-9_]*$/.test(this.value))"
                />
                <p class="osec-hint">
                  Uppercase letters, digits, underscores — must start with a letter or
                  underscore.
                </p>
              </div>
              <div>
                <label class="osec-label" for="osec-value">Value</label>
                <input
                  id="osec-value"
                  class="osec-input"
                  type="password"
                  name="value"
                  required
                  placeholder="••••••••••••"
                  autocomplete="new-password"
                />
                <p class="osec-hint">Value is encrypted at rest with AES-256-GCM.</p>
              </div>
              <div>
                <button type="submit" class="osec-btn osec-btn-primary">
                  Save secret
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Secrets list */}
        <p class="osec-section-title">
          {secrets.length === 0
            ? "No secrets yet"
            : `${secrets.length} secret${secrets.length === 1 ? "" : "s"}`}
        </p>

        {secrets.length === 0 ? (
          <div class="osec-table-wrap">
            <div class="osec-empty">
              <div class="osec-empty-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <p class="osec-empty-title">No secrets configured</p>
              <p class="osec-empty-sub">
                Add your first secret above. It will be injected into every
                workflow run inside <strong>{org.slug}</strong> as{" "}
                <code>{"${{ secrets.NAME }}"}</code>.
              </p>
            </div>
          </div>
        ) : (
          <div class="osec-table-wrap">
            <table class="osec-table" aria-label="Org secrets">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Hint</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span class="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {secrets.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span class="osec-name">{s.name}</span>
                    </td>
                    <td>
                      <span class="osec-hint-val">
                        {s.keyHint ? `••••${s.keyHint}` : "—"}
                      </span>
                    </td>
                    <td>
                      <span class="osec-date">{formatDate(s.updatedAt)}</span>
                    </td>
                    <td class="osec-actions">
                      <form
                        method="post"
                        action={`/orgs/${org.slug}/settings/secrets/${s.id}/delete`}
                        onsubmit="return confirm('Delete this secret? This cannot be undone.')"
                      >
                        <button type="submit" class="osec-btn osec-btn-danger">
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
});

// ── POST /orgs/:slug/settings/secrets ─────────────────────────────────────────

orgSecretsRoutes.post("/orgs/:slug/settings/secrets", async (c) => {
  const slug = c.req.param("slug");
  const user = c.get("user")!;

  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "admin")) {
    return c.redirect(`/orgs/${slug}`);
  }

  const body = await c.req.parseBody();
  const name = String(body.name ?? "").trim();
  const value = String(body.value ?? "");

  if (!name || !value) {
    const msg = encodeURIComponent("Name and value are required.");
    return c.redirect(`/orgs/${slug}/settings/secrets?error=${msg}`);
  }

  try {
    await upsertOrgSecret(org.id, name, value, user.id);
  } catch (err) {
    const msg = encodeURIComponent(
      err instanceof Error ? err.message : "Failed to save secret."
    );
    return c.redirect(`/orgs/${slug}/settings/secrets?error=${msg}`);
  }

  const ok = encodeURIComponent(`Secret "${name}" saved.`);
  return c.redirect(`/orgs/${slug}/settings/secrets?success=${ok}`);
});

// ── POST /orgs/:slug/settings/secrets/:id/delete ──────────────────────────────

orgSecretsRoutes.post("/orgs/:slug/settings/secrets/:id/delete", async (c) => {
  const slug = c.req.param("slug");
  const secretId = c.req.param("id");
  const user = c.get("user")!;

  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "admin")) {
    return c.redirect(`/orgs/${slug}`);
  }

  try {
    await deleteOrgSecret(org.id, secretId);
  } catch (err) {
    const msg = encodeURIComponent(
      err instanceof Error ? err.message : "Failed to delete secret."
    );
    return c.redirect(`/orgs/${slug}/settings/secrets?error=${msg}`);
  }

  const ok = encodeURIComponent("Secret deleted.");
  return c.redirect(`/orgs/${slug}/settings/secrets?success=${ok}`);
});

export default orgSecretsRoutes;
