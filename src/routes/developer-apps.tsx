/**
 * Developer Apps UI (Block B6).
 *
 * Lets authenticated users register + manage their OAuth 2.0 apps:
 *   GET  /settings/applications                 list + new button
 *   GET  /settings/applications/new             form
 *   POST /settings/applications/new             create (returns client_secret once)
 *   GET  /settings/applications/:id             edit / rotate secret / delete
 *   POST /settings/applications/:id             update
 *   POST /settings/applications/:id/rotate      generate a new client secret
 *   POST /settings/applications/:id/delete      remove app + all tokens
 *
 * Visual polish (2026): gradient hairline + orb hero + app cards with logos
 * + rotate-secret action card + danger zone. Scoped under `.dev-*` so it
 * can't bleed into other settings pages. All writes audit() the action.
 * Read-only responses are HTML (SSR JSX). Every secret-generation, rotation,
 * and revoke flow is preserved EXACTLY — this is security-critical.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { oauthApps } from "../db/schema";
import { Layout } from "../views/layout";
import { requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  generateClientId,
  generateClientSecret,
  sha256Hex,
  isValidRedirectUri,
  parseRedirectUris,
} from "../lib/oauth";
import { audit } from "../lib/notify";

const apps = new Hono<AuthEnv>();

apps.use("/settings/applications", requireAuth);
apps.use("/settings/applications/*", requireAuth);

// ----------------------------------------------------------------------------
// Scoped styles — every class prefixed `.dev-` so this surface can't bleed
// into other settings pages.
// ----------------------------------------------------------------------------
const devStyles = `
  .dev-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Breadcrumb ─── */
  .dev-breadcrumb {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .dev-breadcrumb a { color: var(--accent); text-decoration: none; }
  .dev-breadcrumb a:hover { text-decoration: underline; }
  .dev-breadcrumb span.sep { color: var(--text-muted); }

  /* ─── Hero ─── */
  .dev-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .dev-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .dev-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .dev-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .dev-hero-text { flex: 1; min-width: 280px; max-width: 660px; }
  .dev-eyebrow {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .dev-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .dev-title {
    font-size: clamp(26px, 3.5vw, 38px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.06;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .dev-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .dev-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }
  .dev-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text);
  }

  /* ─── Banner ─── */
  .dev-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .dev-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .dev-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }

  /* ─── App cards (list) ─── */
  .dev-cards {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-3);
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .dev-card {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
  }
  .dev-card:hover {
    border-color: rgba(140,109,255,0.32);
    box-shadow: 0 8px 24px -10px rgba(0,0,0,0.32);
  }
  .dev-card.is-revoked {
    opacity: 0.7;
    border-style: dashed;
  }
  .dev-logo {
    flex-shrink: 0;
    width: 52px;
    height: 52px;
    border-radius: 12px;
    background: linear-gradient(135deg, rgba(140,109,255,0.22), rgba(54,197,214,0.16));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 800;
    color: #e9d5ff;
    letter-spacing: -0.02em;
    text-transform: uppercase;
  }
  .dev-card-body { flex: 1; min-width: 0; }
  .dev-card-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .dev-card-name {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
  }
  .dev-card-name a {
    color: inherit;
    text-decoration: none;
  }
  .dev-card-name a:hover { color: var(--accent); }
  .dev-card-meta {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.55;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .dev-card-meta code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 2px 7px;
    border-radius: 5px;
    color: var(--text);
  }
  .dev-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .dev-pill.is-active {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .dev-pill.is-revoked {
    background: rgba(248,113,113,0.12);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .dev-pill.is-public {
    background: rgba(54,197,214,0.12);
    color: #67e8f9;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.32);
  }
  .dev-pill .dot { width: 5px; height: 5px; border-radius: 9999px; background: currentColor; }

  .dev-empty {
    padding: 30px 22px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13.5px;
    background: var(--bg-elevated);
    border: 1px dashed var(--border);
    border-radius: 14px;
    line-height: 1.6;
  }
  .dev-empty strong {
    display: block;
    font-family: var(--font-display);
    font-size: 16px;
    color: var(--text-strong);
    margin-bottom: 6px;
    letter-spacing: -0.01em;
  }

  /* ─── Section card ─── */
  .dev-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .dev-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .dev-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
  }
  .dev-section-sub {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .dev-section-body { padding: var(--space-4) var(--space-5); }
  .dev-section-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .dev-section-foot-hint {
    font-size: 12px;
    color: var(--text-muted);
  }

  .dev-section.is-danger { border-color: rgba(248,113,113,0.30); }
  .dev-section.is-danger .dev-section-head { border-bottom-color: rgba(248,113,113,0.30); }
  .dev-section.is-danger .dev-section-title { color: #fca5a5; }

  /* ─── Field ─── */
  .dev-field { margin-bottom: var(--space-4); }
  .dev-field:last-child { margin-bottom: 0; }
  .dev-field label {
    display: block;
    margin-bottom: 6px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.005em;
  }
  .dev-input,
  .dev-textarea {
    width: 100%;
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
  .dev-textarea { font-family: var(--font-mono); resize: vertical; }
  .dev-input:focus,
  .dev-textarea:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .dev-hint {
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 6px;
    line-height: 1.45;
  }
  .dev-toggle-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .dev-toggle-row input[type="checkbox"] { margin-top: 2px; flex-shrink: 0; }
  .dev-toggle-row span {
    font-size: 13px;
    color: var(--text);
    line-height: 1.45;
  }

  /* ─── Detail dl ─── */
  .dev-dl {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: 10px 16px;
    margin: 0;
  }
  @media (max-width: 600px) {
    .dev-dl { grid-template-columns: 1fr; gap: 2px 0; }
    .dev-dl dt { margin-top: 8px; }
  }
  .dev-dl dt {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    color: var(--text-muted);
    font-weight: 700;
    font-family: var(--font-mono);
    align-self: center;
  }
  .dev-dl dd {
    margin: 0;
    font-size: 13.5px;
    color: var(--text);
  }
  .dev-dl dd code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 3px 8px;
    border-radius: 6px;
    color: var(--text);
    user-select: all;
  }

  /* ─── Fresh-secret callout ─── */
  .dev-secret-callout {
    margin-bottom: var(--space-4);
    padding: 14px 16px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(251,191,36,0.10), rgba(248,113,113,0.05));
    border: 1px solid rgba(251,191,36,0.40);
  }
  .dev-secret-callout strong {
    display: block;
    color: #fde68a;
    font-family: var(--font-display);
    font-size: 14px;
    letter-spacing: -0.01em;
    margin-bottom: 8px;
  }
  .dev-secret-callout pre {
    margin: 0;
    padding: 10px 12px;
    background: rgba(0,0,0,0.30);
    border: 1px solid rgba(251,191,36,0.32);
    border-radius: 10px;
    color: #e9d5ff;
    font-family: var(--font-mono);
    font-size: 13px;
    word-break: break-all;
    white-space: pre-wrap;
    user-select: all;
    overflow-x: auto;
  }
  .dev-secret-callout-hint {
    margin: 8px 0 0;
    font-size: 12px;
    color: #fde68a;
    opacity: 0.85;
    line-height: 1.5;
  }

  /* ─── Buttons ─── */
  .dev-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 11px 18px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .dev-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .dev-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #ffffff;
    text-decoration: none;
  }
  .dev-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .dev-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .dev-btn-warn {
    background: transparent;
    color: #fde68a;
    border-color: rgba(251,191,36,0.40);
  }
  .dev-btn-warn:hover {
    background: rgba(251,191,36,0.10);
    border-color: rgba(251,191,36,0.65);
  }
  .dev-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.40);
  }
  .dev-btn-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.70);
    color: #fecaca;
  }
  .dev-btn-sm {
    padding: 6px 12px;
    font-size: 12.5px;
    border-radius: 8px;
  }

  /* ─── Top action bar ─── */
  .dev-actions-bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .dev-actions-bar form { margin: 0; }
`;

function appLogoInitial(name: string): string {
  return (name.trim().charAt(0) || "?").toUpperCase();
}

function normaliseRedirectUris(raw: string): {
  ok: boolean;
  value?: string;
  error?: string;
} {
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { ok: false, error: "At least one redirect URI is required" };
  }
  if (lines.length > 10) {
    return { ok: false, error: "At most 10 redirect URIs allowed" };
  }
  for (const u of lines) {
    if (!isValidRedirectUri(u)) {
      return { ok: false, error: `Invalid redirect URI: ${u}` };
    }
  }
  return { ok: true, value: lines.join("\n") };
}

apps.get("/settings/applications", async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");
  const success = c.req.query("success");

  let rows: (typeof oauthApps.$inferSelect)[] = [];
  try {
    rows = await db
      .select()
      .from(oauthApps)
      .where(eq(oauthApps.ownerId, user.id));
  } catch (err) {
    console.error("[oauth-apps] list:", err);
  }

  const activeCount = rows.filter((r) => !r.revokedAt).length;

  return c.html(
    <Layout title="OAuth applications" user={user}>
      <div class="dev-wrap">
        <div class="dev-breadcrumb">
          <a href="/settings">settings</a>
          <span class="sep">/</span>
          <span>developer applications</span>
        </div>

        <section class="dev-hero">
          <div class="dev-hero-orb" aria-hidden="true" />
          <div class="dev-hero-inner">
            <div class="dev-hero-text">
              <div class="dev-eyebrow">
                <span class="dev-eyebrow-dot" aria-hidden="true" />
                Developer · {user.username}
              </div>
              <h1 class="dev-title">
                <span class="dev-title-grad">Your OAuth apps.</span>
              </h1>
              <p class="dev-sub">
                Register third-party apps that can request access to Gluecron
                on behalf of users via the OAuth 2.0 authorization-code flow.
                You'll get a <code>client_id</code> + <code>client_secret</code> per
                app and can scope access via PKCE for SPAs and mobile apps.
              </p>
            </div>
            <a href="/settings/applications/new" class="dev-btn dev-btn-primary">
              + New OAuth app
            </a>
          </div>
        </section>

        {error && <div class="dev-banner is-error">{decodeURIComponent(error)}</div>}
        {success && <div class="dev-banner is-ok">{decodeURIComponent(success)}</div>}

        {rows.length === 0 ? (
          <div class="dev-empty">
            <strong>No OAuth apps registered yet.</strong>
            Click "+ New OAuth app" to register one. You'll get a client ID +
            secret you can use to drive the <code style="font-family:var(--font-mono);font-size:12px;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px">/oauth/authorize</code> + <code style="font-family:var(--font-mono);font-size:12px;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px">/oauth/token</code> flow.
          </div>
        ) : (
          <>
            <div class="dev-actions-bar">
              <span style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono)">
                {activeCount} active · {rows.length - activeCount} revoked
              </span>
            </div>
            <ul class="dev-cards">
              {rows.map((app) => (
                <li class={"dev-card" + (app.revokedAt ? " is-revoked" : "")}>
                  <div class="dev-logo" aria-hidden="true">
                    {appLogoInitial(app.name)}
                  </div>
                  <div class="dev-card-body">
                    <div class="dev-card-row">
                      <h3 class="dev-card-name">
                        <a href={`/settings/applications/${app.id}`}>{app.name}</a>
                      </h3>
                      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                        {app.revokedAt ? (
                          <span class="dev-pill is-revoked">
                            <span class="dot" aria-hidden="true" />
                            revoked
                          </span>
                        ) : (
                          <span class="dev-pill is-active">
                            <span class="dot" aria-hidden="true" />
                            active
                          </span>
                        )}
                        {!app.confidential && (
                          <span class="dev-pill is-public">
                            <span class="dot" aria-hidden="true" />
                            PKCE
                          </span>
                        )}
                      </div>
                    </div>
                    <div class="dev-card-meta">
                      <code>{app.clientId}</code>
                      <span>·</span>
                      <span>added {new Date(app.createdAt).toLocaleDateString()}</span>
                    </div>
                    {app.description && (
                      <p style="margin:8px 0 0;font-size:13px;color:var(--text-muted);line-height:1.5">
                        {app.description}
                      </p>
                    )}
                    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
                      <a
                        href={`/settings/applications/${app.id}`}
                        class="dev-btn dev-btn-ghost dev-btn-sm"
                      >
                        Manage
                      </a>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: devStyles }} />
    </Layout>
  );
});

apps.get("/settings/applications/new", async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");
  return c.html(
    <Layout title="New OAuth app" user={user}>
      <div class="dev-wrap">
        <div class="dev-breadcrumb">
          <a href="/settings">settings</a>
          <span class="sep">/</span>
          <a href="/settings/applications">applications</a>
          <span class="sep">/</span>
          <span>new</span>
        </div>

        <section class="dev-hero">
          <div class="dev-hero-orb" aria-hidden="true" />
          <div class="dev-hero-inner">
            <div class="dev-hero-text">
              <div class="dev-eyebrow">
                <span class="dev-eyebrow-dot" aria-hidden="true" />
                OAuth · Register a new app
              </div>
              <h1 class="dev-title">
                <span class="dev-title-grad">Register an OAuth app.</span>
              </h1>
              <p class="dev-sub">
                We'll generate a <code>client_id</code> + <code>client_secret</code>
                on submit. The secret is shown <strong>once</strong> — copy it
                immediately into your app's environment.
              </p>
            </div>
          </div>
        </section>

        {error && <div class="dev-banner is-error">{decodeURIComponent(error)}</div>}

        <form method="post" action="/settings/applications/new">
          <section class="dev-section">
            <header class="dev-section-head">
              <h3 class="dev-section-title">App identity</h3>
              <p class="dev-section-sub">
                Shown to users on the consent screen. Pick a name and (optionally)
                a description that explains what your app does.
              </p>
            </header>
            <div class="dev-section-body">
              <div class="dev-field">
                <label for="name">Application name</label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  required
                  maxLength={80}
                  placeholder="My Awesome Integration"
                  class="dev-input"
                />
              </div>
              <div class="dev-field">
                <label for="homepage_url">Homepage URL</label>
                <input
                  type="url"
                  id="homepage_url"
                  name="homepage_url"
                  placeholder="https://example.com"
                  class="dev-input"
                />
              </div>
              <div class="dev-field">
                <label for="description">Description</label>
                <textarea
                  id="description"
                  name="description"
                  rows={3}
                  maxLength={500}
                  class="dev-textarea"
                />
                <div class="dev-hint">Up to 500 characters.</div>
              </div>
            </div>
          </section>

          <section class="dev-section">
            <header class="dev-section-head">
              <h3 class="dev-section-title">OAuth flow</h3>
              <p class="dev-section-sub">
                Where we redirect users after they approve — and whether your
                app is server-side (confidential, holds a secret) or
                browser/mobile (public, must use PKCE).
              </p>
            </header>
            <div class="dev-section-body">
              <div class="dev-field">
                <label for="redirect_uris">Authorization callback URLs</label>
                <textarea
                  id="redirect_uris"
                  name="redirect_uris"
                  rows={4}
                  required
                  placeholder="https://example.com/oauth/callback"
                  class="dev-textarea"
                />
                <div class="dev-hint">
                  One URL per line. HTTPS required (HTTP allowed for localhost).
                  Exact match; no wildcards. Up to 10.
                </div>
              </div>

              <div class="dev-field">
                <div class="dev-toggle-row">
                  <input
                    type="checkbox"
                    name="confidential"
                    value="on"
                    checked
                    aria-label="Confidential client"
                    id="confidential"
                  />
                  <span>
                    <strong style="color:var(--text-strong)">Confidential client (server-side app).</strong>
                    {" "}Uncheck for public SPA / mobile apps — they must use PKCE
                    instead of a client secret.
                  </span>
                </div>
              </div>
            </div>
            <div class="dev-section-foot">
              <span class="dev-section-foot-hint">
                You'll be shown the client secret <strong>once</strong> after creation.
              </span>
              <div style="display:flex;gap:8px">
                <a href="/settings/applications" class="dev-btn dev-btn-ghost">
                  Cancel
                </a>
                <button type="submit" class="dev-btn dev-btn-primary">
                  Register app
                </button>
              </div>
            </div>
          </section>
        </form>
      </div>
      <style dangerouslySetInnerHTML={{ __html: devStyles }} />
    </Layout>
  );
});

apps.post("/settings/applications/new", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim().slice(0, 80);
  const homepageUrl = String(body.homepage_url || "").trim().slice(0, 200);
  const description = String(body.description || "").trim().slice(0, 500);
  const confidential = String(body.confidential || "") === "on";
  const redirectRaw = String(body.redirect_uris || "");

  if (!name) {
    return c.redirect("/settings/applications/new?error=Name+is+required");
  }
  const parsed = normaliseRedirectUris(redirectRaw);
  if (!parsed.ok) {
    return c.redirect(
      `/settings/applications/new?error=${encodeURIComponent(parsed.error || "Invalid redirect URIs")}`
    );
  }

  const clientId = generateClientId();
  const clientSecret = generateClientSecret();
  const clientSecretHash = await sha256Hex(clientSecret);

  try {
    const [row] = await db
      .insert(oauthApps)
      .values({
        ownerId: user.id,
        name,
        clientId,
        clientSecretHash,
        clientSecretPrefix: clientSecret.slice(0, 8),
        redirectUris: parsed.value!,
        homepageUrl: homepageUrl || null,
        description: description || null,
        confidential,
      })
      .returning();
    await audit({
      userId: user.id,
      action: "oauth_app.create",
      targetType: "oauth_app",
      targetId: row.id,
      metadata: { clientId },
    });
    // Redirect to the manage page with the plaintext secret appended once.
    return c.redirect(
      `/settings/applications/${row.id}?secret=${encodeURIComponent(clientSecret)}&success=App+created`
    );
  } catch (err) {
    console.error("[oauth-apps] create:", err);
    return c.redirect(
      "/settings/applications/new?error=Service+unavailable"
    );
  }
});

apps.get("/settings/applications/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const error = c.req.query("error");
  const success = c.req.query("success");
  const secret = c.req.query("secret");

  let app: typeof oauthApps.$inferSelect | undefined;
  try {
    const [row] = await db
      .select()
      .from(oauthApps)
      .where(and(eq(oauthApps.id, id), eq(oauthApps.ownerId, user.id)))
      .limit(1);
    app = row;
  } catch (err) {
    console.error("[oauth-apps] get:", err);
  }
  if (!app) {
    return c.redirect("/settings/applications?error=Not+found");
  }

  return c.html(
    <Layout title={app.name} user={user}>
      <div class="dev-wrap">
        <div class="dev-breadcrumb">
          <a href="/settings">settings</a>
          <span class="sep">/</span>
          <a href="/settings/applications">applications</a>
          <span class="sep">/</span>
          <span>{app.name}</span>
        </div>

        <section class="dev-hero">
          <div class="dev-hero-orb" aria-hidden="true" />
          <div class="dev-hero-inner">
            <div class="dev-hero-text" style="display:flex;gap:var(--space-3);align-items:center">
              <div class="dev-logo" aria-hidden="true">
                {appLogoInitial(app.name)}
              </div>
              <div>
                <div class="dev-eyebrow">
                  <span class="dev-eyebrow-dot" aria-hidden="true" />
                  OAuth app · {app.confidential ? "Confidential" : "Public (PKCE)"}
                </div>
                <h1 class="dev-title" style="margin:0">
                  <span class="dev-title-grad">{app.name}</span>
                </h1>
              </div>
            </div>
          </div>
        </section>

        {error && <div class="dev-banner is-error">{decodeURIComponent(error)}</div>}
        {success && <div class="dev-banner is-ok">{decodeURIComponent(success)}</div>}

        {secret && (
          <div class="dev-secret-callout">
            <strong>Save this client secret — it will not be shown again.</strong>
            <pre>{secret}</pre>
            <p class="dev-secret-callout-hint">
              Store it in your app's environment (e.g.{" "}
              <code style="font-family:var(--font-mono);font-size:11.5px;background:rgba(0,0,0,0.30);padding:1px 5px;border-radius:4px">OAUTH_CLIENT_SECRET</code>).
              Rotating below invalidates it immediately.
            </p>
          </div>
        )}

        {/* ─── Credentials ─── */}
        <section class="dev-section">
          <header class="dev-section-head">
            <h3 class="dev-section-title">Credentials</h3>
            <p class="dev-section-sub">
              The client ID is safe to embed in client code. The secret prefix
              is shown so you can verify which secret is current after a rotate.
            </p>
          </header>
          <div class="dev-section-body">
            <dl class="dev-dl">
              <dt>Client ID</dt>
              <dd><code>{app.clientId}</code></dd>
              <dt>Client secret</dt>
              <dd>
                <code>{app.clientSecretPrefix}…</code>{" "}
                <span style="font-size:12px;color:var(--text-muted);margin-left:6px">prefix only — full value shown once at creation/rotate</span>
              </dd>
              <dt>Type</dt>
              <dd>
                {app.confidential ? (
                  <span class="dev-pill is-active">
                    <span class="dot" aria-hidden="true" />
                    Confidential
                  </span>
                ) : (
                  <span class="dev-pill is-public">
                    <span class="dot" aria-hidden="true" />
                    Public · PKCE required
                  </span>
                )}
              </dd>
              <dt>Created</dt>
              <dd>{new Date(app.createdAt).toLocaleString()}</dd>
            </dl>
          </div>
        </section>

        {/* ─── Edit ─── */}
        <form method="post" action={`/settings/applications/${app.id}`}>
          <section class="dev-section">
            <header class="dev-section-head">
              <h3 class="dev-section-title">App details</h3>
              <p class="dev-section-sub">
                Name + description are shown to users on the consent screen.
                Callback URLs must match exactly at <code style="font-family:var(--font-mono);font-size:12px;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px">/oauth/authorize</code>.
              </p>
            </header>
            <div class="dev-section-body">
              <div class="dev-field">
                <label for="name">Application name</label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  required
                  maxLength={80}
                  value={app.name}
                  class="dev-input"
                />
              </div>
              <div class="dev-field">
                <label for="homepage_url">Homepage URL</label>
                <input
                  type="url"
                  id="homepage_url"
                  name="homepage_url"
                  value={app.homepageUrl || ""}
                  class="dev-input"
                />
              </div>
              <div class="dev-field">
                <label for="description">Description</label>
                <textarea
                  id="description"
                  name="description"
                  rows={3}
                  maxLength={500}
                  class="dev-textarea"
                >
                  {app.description || ""}
                </textarea>
              </div>
              <div class="dev-field">
                <label for="redirect_uris">Authorization callback URLs</label>
                <textarea
                  id="redirect_uris"
                  name="redirect_uris"
                  rows={4}
                  required
                  class="dev-textarea"
                >
                  {app.redirectUris}
                </textarea>
                <div class="dev-hint">
                  One URL per line. HTTPS required (HTTP allowed for localhost).
                </div>
              </div>
            </div>
            <div class="dev-section-foot">
              <span class="dev-section-foot-hint">
                Changes apply immediately — existing tokens keep working.
              </span>
              <button type="submit" class="dev-btn dev-btn-primary">
                Save changes
              </button>
            </div>
          </section>
        </form>

        {/* ─── Rotate ─── */}
        <section class="dev-section">
          <header class="dev-section-head">
            <h3 class="dev-section-title">Rotate client secret</h3>
            <p class="dev-section-sub">
              Generate a new secret. The old one is invalidated immediately —
              existing access tokens keep working, but token exchange with the
              old secret will fail.
            </p>
          </header>
          <div class="dev-section-body">
            <form
              method="post"
              action={`/settings/applications/${app.id}/rotate`}
              onsubmit="return confirm('Rotate the client secret? The old one will stop working immediately.')"
              style="margin:0"
            >
              <button type="submit" class="dev-btn dev-btn-warn">
                Rotate secret
              </button>
            </form>
          </div>
        </section>

        {/* ─── Danger zone ─── */}
        <section class="dev-section is-danger">
          <header class="dev-section-head">
            <h3 class="dev-section-title">Danger zone</h3>
            <p class="dev-section-sub">
              Deleting an app removes it from the database and revokes every
              access + refresh token ever issued under its <code style="font-family:var(--font-mono);font-size:12px;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px">client_id</code>.
              This cannot be undone.
            </p>
          </header>
          <div class="dev-section-body">
            <form
              method="post"
              action={`/settings/applications/${app.id}/delete`}
              onsubmit="return confirm('Delete this OAuth app? All issued access tokens will be revoked.')"
              style="margin:0"
            >
              <button type="submit" class="dev-btn dev-btn-danger">
                Delete app permanently
              </button>
            </form>
          </div>
        </section>
      </div>
      <style dangerouslySetInnerHTML={{ __html: devStyles }} />
    </Layout>
  );
});

apps.post("/settings/applications/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim().slice(0, 80);
  const homepageUrl = String(body.homepage_url || "").trim().slice(0, 200);
  const description = String(body.description || "").trim().slice(0, 500);
  const redirectRaw = String(body.redirect_uris || "");

  if (!name) {
    return c.redirect(
      `/settings/applications/${id}?error=Name+is+required`
    );
  }
  const parsed = normaliseRedirectUris(redirectRaw);
  if (!parsed.ok) {
    return c.redirect(
      `/settings/applications/${id}?error=${encodeURIComponent(parsed.error || "Invalid redirect URIs")}`
    );
  }
  try {
    const [existing] = await db
      .select({ id: oauthApps.id, ownerId: oauthApps.ownerId })
      .from(oauthApps)
      .where(eq(oauthApps.id, id))
      .limit(1);
    if (!existing || existing.ownerId !== user.id) {
      return c.redirect("/settings/applications?error=Not+found");
    }
    await db
      .update(oauthApps)
      .set({
        name,
        homepageUrl: homepageUrl || null,
        description: description || null,
        redirectUris: parsed.value!,
        updatedAt: new Date(),
      })
      .where(eq(oauthApps.id, id));
    await audit({
      userId: user.id,
      action: "oauth_app.update",
      targetType: "oauth_app",
      targetId: id,
    });
    return c.redirect(`/settings/applications/${id}?success=Saved`);
  } catch (err) {
    console.error("[oauth-apps] update:", err);
    return c.redirect(
      `/settings/applications/${id}?error=Service+unavailable`
    );
  }
});

apps.post("/settings/applications/:id/rotate", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  try {
    const [existing] = await db
      .select({ id: oauthApps.id, ownerId: oauthApps.ownerId })
      .from(oauthApps)
      .where(eq(oauthApps.id, id))
      .limit(1);
    if (!existing || existing.ownerId !== user.id) {
      return c.redirect("/settings/applications?error=Not+found");
    }
    const newSecret = generateClientSecret();
    const newHash = await sha256Hex(newSecret);
    await db
      .update(oauthApps)
      .set({
        clientSecretHash: newHash,
        clientSecretPrefix: newSecret.slice(0, 8),
        updatedAt: new Date(),
      })
      .where(eq(oauthApps.id, id));
    await audit({
      userId: user.id,
      action: "oauth_app.rotate_secret",
      targetType: "oauth_app",
      targetId: id,
    });
    return c.redirect(
      `/settings/applications/${id}?secret=${encodeURIComponent(newSecret)}&success=Secret+rotated`
    );
  } catch (err) {
    console.error("[oauth-apps] rotate:", err);
    return c.redirect(
      `/settings/applications/${id}?error=Service+unavailable`
    );
  }
});

apps.post("/settings/applications/:id/delete", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  try {
    const [existing] = await db
      .select({ id: oauthApps.id, ownerId: oauthApps.ownerId })
      .from(oauthApps)
      .where(eq(oauthApps.id, id))
      .limit(1);
    if (!existing || existing.ownerId !== user.id) {
      return c.redirect("/settings/applications?error=Not+found");
    }
    await db.delete(oauthApps).where(eq(oauthApps.id, id));
    await audit({
      userId: user.id,
      action: "oauth_app.delete",
      targetType: "oauth_app",
      targetId: id,
    });
    return c.redirect("/settings/applications?success=App+deleted");
  } catch (err) {
    console.error("[oauth-apps] delete:", err);
    return c.redirect(
      `/settings/applications/${id}?error=Service+unavailable`
    );
  }
});

export default apps;
