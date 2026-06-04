/**
 * OAuth 2.0 provider endpoints (Block B6).
 *
 *   GET  /oauth/authorize              consent screen (authed)
 *   POST /oauth/authorize/decision     approve/deny → redirect with code (authed)
 *   POST /oauth/token                  code or refresh → access+refresh tokens
 *   POST /oauth/revoke                 revoke access or refresh token
 *   GET  /settings/authorizations      list apps the user has granted (authed)
 *   POST /settings/authorizations/:appId/revoke   user-initiated revoke
 *
 * Developer-facing app management lives in `src/routes/developer-apps.tsx`.
 *
 * Visual polish (2026): gradient hairline + orb hero + app card + scope chips
 * + gradient Authorize CTA. Scoped under `.oauth-*` so it can't bleed into
 * other pages. Every OAuth flow, redirect URI, state/nonce, and token
 * issuance path is preserved EXACTLY — this is security-critical.
 */

import { Hono } from "hono";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  oauthApps,
  oauthAuthorizations,
  oauthAccessTokens,
  users,
} from "../db/schema";
import type { User } from "../db/schema";
import { Layout } from "../views/layout";
import { requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  generateAuthCode,
  generateAccessToken,
  generateRefreshToken,
  sha256Hex,
  verifyPkce,
  parseScopes,
  parseRedirectUris,
  redirectUriAllowed,
  timingSafeEqual,
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  SUPPORTED_SCOPES,
} from "../lib/oauth";
import { audit } from "../lib/notify";

const oauth = new Hono<AuthEnv>();

oauth.use("/oauth/authorize", requireAuth);
oauth.use("/oauth/authorize/decision", requireAuth);
oauth.use("/settings/authorizations", requireAuth);
oauth.use("/settings/authorizations/*", requireAuth);

// --- scope explainer copy (human-readable consent text) --------------------
//
// Plain-English description for each scope chip on the consent screen. The
// keys mirror SUPPORTED_SCOPES; unknown scopes fall back to a generic line.
const SCOPE_DESCRIPTIONS: Record<string, { label: string; explain: string }> = {
  "read:user": {
    label: "Read your profile",
    explain: "username, avatar, public email — never your password",
  },
  "read:repo": {
    label: "Read your repositories",
    explain: "code, branches, commits, file contents",
  },
  "write:repo": {
    label: "Write to your repositories",
    explain: "push commits, create branches, edit files",
  },
  "read:org": {
    label: "Read your organisations",
    explain: "membership, teams, org-owned repo list",
  },
  "write:org": {
    label: "Manage organisations",
    explain: "invite members, change settings, edit teams",
  },
  "read:issue": {
    label: "Read issues",
    explain: "issue threads, comments, labels, assignees",
  },
  "write:issue": {
    label: "Create + edit issues",
    explain: "open, comment, close, label, assign",
  },
  "read:pr": {
    label: "Read pull requests",
    explain: "PR diffs, comments, reviews, status",
  },
  "write:pr": {
    label: "Create + edit pull requests",
    explain: "open, review, comment, merge, close",
  },
};

function describeScope(s: string): { label: string; explain: string } {
  return (
    SCOPE_DESCRIPTIONS[s] ?? {
      label: s,
      explain: "custom scope — see the app's documentation",
    }
  );
}

// --- scoped styles ----------------------------------------------------------
//
// Every class prefixed `.oauth-` so the consent screen / authorizations list
// can't bleed into the wider app polish. Mirrors the gradient-hairline hero +
// orb pattern from admin-integrations.tsx and error-page.tsx.
const oauthStyles = `
  .oauth-wrap { max-width: 1120px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Hero ─── */
  .oauth-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .oauth-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .oauth-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .oauth-hero-inner { position: relative; z-index: 1; max-width: 680px; }
  .oauth-eyebrow {
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
  .oauth-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .oauth-title {
    font-size: clamp(26px, 3.5vw, 36px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.026em;
    line-height: 1.08;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .oauth-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .oauth-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }
  .oauth-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text);
  }

  /* ─── Banners ─── */
  .oauth-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .oauth-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .oauth-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }

  /* ─── App identity card (consent) ─── */
  .oauth-appcard {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    margin-bottom: var(--space-4);
  }
  .oauth-applogo {
    flex-shrink: 0;
    width: 56px;
    height: 56px;
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
  .oauth-appmeta { flex: 1; min-width: 0; }
  .oauth-appname {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    word-break: break-word;
  }
  .oauth-appname code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--accent);
    background: rgba(140,109,255,0.08);
    padding: 1px 6px;
    border-radius: 4px;
    margin-left: 6px;
    font-weight: 500;
  }
  .oauth-appdesc {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
  }

  /* ─── Section card ─── */
  .oauth-section {
    margin-bottom: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .oauth-section-head {
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .oauth-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-strong);
  }
  .oauth-section-count {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }
  .oauth-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Scope chips ─── */
  .oauth-scopes {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .oauth-scope {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(255,255,255,0.02);
  }
  .oauth-scope-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    color: #e9d5ff;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.10));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    flex-shrink: 0;
    margin-top: 2px;
    white-space: nowrap;
  }
  .oauth-scope-chip[data-write="1"] {
    color: #fde68a;
    background: linear-gradient(135deg, rgba(251,191,36,0.18), rgba(248,113,113,0.10));
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.36);
  }
  .oauth-scope-text { flex: 1; min-width: 0; }
  .oauth-scope-label {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text-strong);
    line-height: 1.3;
  }
  .oauth-scope-explain {
    margin-top: 2px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .oauth-scope-empty {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
    font-style: italic;
  }

  /* ─── Actions row ─── */
  .oauth-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
    margin-top: var(--space-4);
  }
  .oauth-actions form { margin: 0; }
  .oauth-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 13px 24px;
    border-radius: 12px;
    font-size: 14.5px;
    font-weight: 700;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .oauth-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 8px 22px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.18);
    min-width: 180px;
  }
  .oauth-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 12px 28px -8px rgba(140,109,255,0.65), inset 0 1px 0 rgba(255,255,255,0.22);
    color: #ffffff;
    text-decoration: none;
  }
  .oauth-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
    padding: 13px 20px;
  }
  .oauth-btn-ghost:hover {
    background: rgba(255,255,255,0.04);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .oauth-btn-danger-sm {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 12.5px;
    font-weight: 600;
    border: 1px solid rgba(248,113,113,0.35);
    background: transparent;
    color: #fca5a5;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
  }
  .oauth-btn-danger-sm:hover {
    border-color: rgba(248,113,113,0.70);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }

  /* ─── Explainer ─── */
  .oauth-explainer {
    margin-top: var(--space-4);
    padding: var(--space-3) var(--space-4);
    background: rgba(140,109,255,0.04);
    border: 1px dashed rgba(140,109,255,0.22);
    border-radius: 12px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.55;
  }
  .oauth-explainer strong { color: var(--text-strong); display: block; margin-bottom: 4px; font-size: 13px; }
  .oauth-explainer a { color: var(--accent); text-decoration: none; }
  .oauth-explainer a:hover { text-decoration: underline; }
  .oauth-explainer ul { margin: 6px 0 0; padding-left: 20px; }
  .oauth-explainer li { margin: 2px 0; }

  /* ─── Authorizations list ─── */
  .oauth-breadcrumb {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .oauth-breadcrumb a { color: var(--accent); text-decoration: none; }
  .oauth-breadcrumb a:hover { text-decoration: underline; }
  .oauth-breadcrumb span.sep { color: var(--text-muted); }

  .oauth-grant-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .oauth-grant {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    flex-wrap: wrap;
  }
  .oauth-grant-info { flex: 1; min-width: 240px; }
  .oauth-grant-name {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 4px;
    letter-spacing: -0.01em;
  }
  .oauth-grant-meta {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .oauth-grant-meta code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--text);
  }
  .oauth-empty {
    padding: 22px 18px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13.5px;
    background: var(--bg-elevated);
    border: 1px dashed var(--border);
    border-radius: 12px;
  }

  /* ─── Error sub-page ─── */
  .oauth-error-page {
    max-width: 540px;
    margin: var(--space-12) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .oauth-error-page h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .oauth-error-page p { color: var(--text-muted); margin: 0 0 16px; font-size: 14px; }
`;

// --- helpers ----------------------------------------------------------------

function appendQuery(url: string, params: Record<string, string | undefined>) {
  const sep = url.includes("?") ? "&" : "?";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  if (parts.length === 0) return url;
  return url + sep + parts.join("&");
}

function errorPage(title: string, message: string, user: User | null) {
  return (
    <Layout title={title} user={user}>
      <div class="oauth-wrap">
        <div class="oauth-error-page">
          <h2>{title}</h2>
          <p>{message}</p>
          <a href="/" class="oauth-btn oauth-btn-ghost" style="padding: 10px 18px">
            Go home
          </a>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: oauthStyles }} />
    </Layout>
  );
}

type OauthApp = typeof oauthApps.$inferSelect;

async function loadAppByClientId(clientId: string): Promise<OauthApp | null> {
  try {
    const [row] = await db
      .select()
      .from(oauthApps)
      .where(eq(oauthApps.clientId, clientId))
      .limit(1);
    return row || null;
  } catch (err) {
    console.error("[oauth] loadApp:", err);
    return null;
  }
}

/**
 * Extracts client_id + client_secret from either the request body or an
 * `Authorization: Basic` header. Returns `null` if neither is present.
 */
function extractClientCreds(
  authHeader: string | undefined,
  body: Record<string, unknown>
): { clientId?: string; clientSecret?: string } {
  if (authHeader && authHeader.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(authHeader.slice(6).trim());
      const idx = decoded.indexOf(":");
      if (idx > 0) {
        return {
          clientId: decoded.slice(0, idx),
          clientSecret: decoded.slice(idx + 1),
        };
      }
    } catch {
      /* fall through */
    }
  }
  const cid = body.client_id ? String(body.client_id) : undefined;
  const csec = body.client_secret ? String(body.client_secret) : undefined;
  return { clientId: cid, clientSecret: csec };
}

async function authenticateClient(
  app: OauthApp,
  providedSecret: string | undefined
): Promise<boolean> {
  if (!app.confidential) return true; // public clients auth via PKCE
  if (!providedSecret) return false;
  const hash = await sha256Hex(providedSecret);
  return timingSafeEqual(hash, app.clientSecretHash);
}

function isWriteScope(s: string): boolean {
  return s.startsWith("write:");
}

// --- GET /oauth/authorize ---------------------------------------------------

oauth.get("/oauth/authorize", async (c) => {
  const user = c.get("user")!;
  const q = c.req.query();
  const clientId = q.client_id || "";
  const redirectUri = q.redirect_uri || "";
  const responseType = q.response_type || "";
  const scopeParam = q.scope || "";
  const state = q.state || "";
  const codeChallenge = q.code_challenge || "";
  const codeChallengeMethod = q.code_challenge_method || "";

  if (!clientId) {
    return c.html(errorPage("OAuth error", "Missing client_id.", user), 400);
  }
  const app = await loadAppByClientId(clientId);
  if (!app) {
    return c.html(errorPage("OAuth error", "Unknown client.", user), 400);
  }
  if (app.revokedAt) {
    return c.html(errorPage("OAuth error", "This application has been revoked.", user), 400);
  }

  const registered = parseRedirectUris(app.redirectUris);
  if (!redirectUriAllowed(redirectUri, registered)) {
    return c.html(
      errorPage(
        "OAuth error",
        "redirect_uri does not match any registered callback for this app.",
        user
      ),
      400
    );
  }

  // Beyond this point errors redirect back to redirect_uri with ?error=...
  if (responseType !== "code") {
    return c.redirect(
      appendQuery(redirectUri, {
        error: "unsupported_response_type",
        error_description: "response_type must be 'code'",
        state: state || undefined,
      })
    );
  }
  if (!app.confidential && !codeChallenge) {
    return c.redirect(
      appendQuery(redirectUri, {
        error: "invalid_request",
        error_description: "PKCE code_challenge is required for public clients",
        state: state || undefined,
      })
    );
  }

  const scopes = parseScopes(scopeParam);

  // Look up the app owner for the consent screen.
  let ownerName = "unknown";
  try {
    const [ownerRow] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, app.ownerId))
      .limit(1);
    if (ownerRow) ownerName = ownerRow.username;
  } catch {
    /* non-fatal */
  }

  const initial = (app.name || "?").trim().charAt(0).toUpperCase() || "?";

  return c.html(
    <Layout title="Authorize application" user={user}>
      <div class="oauth-wrap">
        <section class="oauth-hero">
          <div class="oauth-hero-orb" aria-hidden="true" />
          <div class="oauth-hero-inner">
            <div class="oauth-eyebrow">
              <span class="oauth-eyebrow-dot" aria-hidden="true" />
              OAuth · Authorize an application
            </div>
            <h1 class="oauth-title">
              <span class="oauth-title-grad">Authorize {app.name}?</span>
            </h1>
            <p class="oauth-sub">
              Signed in as <code>{user.username}</code>. Review what this app is
              asking for, then approve or cancel.
            </p>
          </div>
        </section>

        <section class="oauth-appcard" aria-label="Application identity">
          <div class="oauth-applogo" aria-hidden="true">{initial}</div>
          <div class="oauth-appmeta">
            <h2 class="oauth-appname">
              {app.name}
              <code>by {ownerName}</code>
            </h2>
            {app.description ? (
              <p class="oauth-appdesc">{app.description}</p>
            ) : (
              <p class="oauth-appdesc" style="font-style: italic">
                No description provided by the developer.
              </p>
            )}
          </div>
        </section>

        <section class="oauth-section" aria-label="Requested scopes">
          <header class="oauth-section-head">
            <h3 class="oauth-section-title">Requested permissions</h3>
            <span class="oauth-section-count">
              {scopes.length} {scopes.length === 1 ? "scope" : "scopes"}
            </span>
          </header>
          <div class="oauth-section-body">
            {scopes.length === 0 ? (
              <p class="oauth-scope-empty">
                No scopes — this app will only be able to identify you (your
                username + public profile).
              </p>
            ) : (
              <ul class="oauth-scopes">
                {scopes.map((s) => {
                  const meta = describeScope(s);
                  return (
                    <li class="oauth-scope">
                      <span
                        class="oauth-scope-chip"
                        data-write={isWriteScope(s) ? "1" : "0"}
                      >
                        <code>{s}</code>
                      </span>
                      <div class="oauth-scope-text">
                        <div class="oauth-scope-label">{meta.label}</div>
                        <div class="oauth-scope-explain">{meta.explain}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <form method="post" action="/oauth/authorize/decision">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="response_type" value={responseType} />
          <input type="hidden" name="scope" value={scopes.join(" ")} />
          <input type="hidden" name="state" value={state} />
          <input type="hidden" name="code_challenge" value={codeChallenge} />
          <input
            type="hidden"
            name="code_challenge_method"
            value={codeChallengeMethod}
          />
          <div class="oauth-actions">
            <button
              type="submit"
              name="decision"
              value="approve"
              class="oauth-btn oauth-btn-primary"
            >
              Authorize {app.name}
            </button>
            <button
              type="submit"
              name="decision"
              value="deny"
              class="oauth-btn oauth-btn-ghost"
            >
              Deny
            </button>
          </div>
        </form>

        <div class="oauth-explainer">
          <strong>What does {app.name} get?</strong>
          <ul>
            <li>
              A scoped access token that expires in{" "}
              {Math.round(ACCESS_TOKEN_TTL_MS / 60000)} minutes (auto-refreshed for{" "}
              up to {Math.round(REFRESH_TOKEN_TTL_MS / (24 * 60 * 60 * 1000))} days).
            </li>
            <li>
              The scopes listed above — nothing else. It never sees your password
              or your other personal access tokens.
            </li>
            <li>
              Revoke at any time from{" "}
              <a href="/settings/authorizations">Authorized applications</a> —
              every access + refresh token for this app is invalidated immediately.
            </li>
          </ul>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: oauthStyles }} />
    </Layout>
  );
});

// --- POST /oauth/authorize/decision -----------------------------------------

oauth.post("/oauth/authorize/decision", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const clientId = String(body.client_id || "");
  const redirectUri = String(body.redirect_uri || "");
  const scopeParam = String(body.scope || "");
  const state = String(body.state || "");
  const decision = String(body.decision || "");
  const codeChallenge = String(body.code_challenge || "");
  const codeChallengeMethod = String(body.code_challenge_method || "");

  const app = await loadAppByClientId(clientId);
  if (!app || app.revokedAt) {
    return c.html(errorPage("OAuth error", "Unknown or revoked client.", user), 400);
  }
  const registered = parseRedirectUris(app.redirectUris);
  if (!redirectUriAllowed(redirectUri, registered)) {
    return c.html(errorPage("OAuth error", "Invalid redirect_uri.", user), 400);
  }

  if (decision !== "approve") {
    return c.redirect(
      appendQuery(redirectUri, {
        error: "access_denied",
        error_description: "User denied the request",
        state: state || undefined,
      })
    );
  }

  const scopes = parseScopes(scopeParam);
  const code = generateAuthCode();
  const codeHash = await sha256Hex(code);

  try {
    await db.insert(oauthAuthorizations).values({
      appId: app.id,
      userId: user.id,
      codeHash,
      redirectUri,
      scopes: scopes.join(" "),
      codeChallenge: codeChallenge || null,
      codeChallengeMethod: codeChallengeMethod || null,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    });
    await audit({
      userId: user.id,
      action: "oauth.authorize",
      targetType: "oauth_app",
      targetId: app.id,
      metadata: { scopes: scopes.join(" ") },
    });
    return c.redirect(
      appendQuery(redirectUri, {
        code,
        state: state || undefined,
      })
    );
  } catch (err) {
    console.error("[oauth] authorize/decision:", err);
    return c.redirect(
      appendQuery(redirectUri, {
        error: "server_error",
        error_description: "Service unavailable",
        state: state || undefined,
      })
    );
  }
});

// --- POST /oauth/token ------------------------------------------------------

oauth.post("/oauth/token", async (c) => {
  // Accept either form-encoded or JSON bodies.
  let body: Record<string, unknown> = {};
  const contentType = (c.req.header("content-type") || "").toLowerCase();
  try {
    if (contentType.includes("application/json")) {
      body = (await c.req.json()) as Record<string, unknown>;
    } else {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    }
  } catch {
    return c.json(
      { error: "invalid_request", error_description: "Malformed body" },
      400
    );
  }

  const grantType = body.grant_type ? String(body.grant_type) : "";
  const authHeader = c.req.header("authorization");
  const creds = extractClientCreds(authHeader, body);

  if (!creds.clientId) {
    return c.json(
      { error: "invalid_client", error_description: "Missing client_id" },
      401
    );
  }
  const app = await loadAppByClientId(creds.clientId);
  if (!app || app.revokedAt) {
    return c.json(
      { error: "invalid_client", error_description: "Unknown client" },
      401
    );
  }
  const clientAuthOk = await authenticateClient(app, creds.clientSecret);
  if (!clientAuthOk) {
    return c.json(
      { error: "invalid_client", error_description: "Client authentication failed" },
      401
    );
  }

  try {
    if (grantType === "authorization_code") {
      const code = body.code ? String(body.code) : "";
      const redirectUri = body.redirect_uri ? String(body.redirect_uri) : "";
      const codeVerifier = body.code_verifier ? String(body.code_verifier) : "";
      if (!code || !redirectUri) {
        return c.json(
          { error: "invalid_request", error_description: "code and redirect_uri required" },
          400
        );
      }
      const codeHash = await sha256Hex(code);
      const [authRow] = await db
        .select()
        .from(oauthAuthorizations)
        .where(eq(oauthAuthorizations.codeHash, codeHash))
        .limit(1);
      if (!authRow) {
        return c.json({ error: "invalid_grant", error_description: "Unknown code" }, 400);
      }
      if (authRow.usedAt) {
        return c.json(
          { error: "invalid_grant", error_description: "Code already used" },
          400
        );
      }
      if (new Date(authRow.expiresAt) < new Date()) {
        return c.json({ error: "invalid_grant", error_description: "Code expired" }, 400);
      }
      if (authRow.appId !== app.id) {
        return c.json(
          { error: "invalid_grant", error_description: "Code does not belong to client" },
          400
        );
      }
      if (!timingSafeEqual(authRow.redirectUri, redirectUri)) {
        return c.json(
          { error: "invalid_grant", error_description: "redirect_uri mismatch" },
          400
        );
      }
      if (authRow.codeChallenge) {
        const ok = await verifyPkce({
          challenge: authRow.codeChallenge,
          method: authRow.codeChallengeMethod,
          verifier: codeVerifier,
        });
        if (!ok) {
          return c.json(
            { error: "invalid_grant", error_description: "PKCE verification failed" },
            400
          );
        }
      }

      // Single-use: mark used immediately.
      await db
        .update(oauthAuthorizations)
        .set({ usedAt: new Date() })
        .where(eq(oauthAuthorizations.id, authRow.id));

      const accessToken = generateAccessToken();
      const refreshToken = generateRefreshToken();
      const accessHash = await sha256Hex(accessToken);
      const refreshHash = await sha256Hex(refreshToken);

      await db.insert(oauthAccessTokens).values({
        appId: app.id,
        userId: authRow.userId,
        accessTokenHash: accessHash,
        refreshTokenHash: refreshHash,
        scopes: authRow.scopes,
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
        refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      });
      await audit({
        userId: authRow.userId,
        action: "oauth.token.issue",
        targetType: "oauth_app",
        targetId: app.id,
      });
      return c.json({
        access_token: accessToken,
        token_type: "bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: refreshToken,
        scope: authRow.scopes,
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = body.refresh_token ? String(body.refresh_token) : "";
      if (!refreshToken) {
        return c.json(
          { error: "invalid_request", error_description: "refresh_token required" },
          400
        );
      }
      const refreshHash = await sha256Hex(refreshToken);
      const [tokenRow] = await db
        .select()
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.refreshTokenHash, refreshHash))
        .limit(1);
      if (!tokenRow || tokenRow.revokedAt) {
        return c.json(
          { error: "invalid_grant", error_description: "Unknown refresh_token" },
          400
        );
      }
      if (tokenRow.appId !== app.id) {
        return c.json(
          { error: "invalid_grant", error_description: "Token does not belong to client" },
          400
        );
      }
      if (
        tokenRow.refreshExpiresAt &&
        new Date(tokenRow.refreshExpiresAt) < new Date()
      ) {
        return c.json(
          { error: "invalid_grant", error_description: "refresh_token expired" },
          400
        );
      }

      // Narrow scopes if the client explicitly requested a subset.
      let newScopes = tokenRow.scopes;
      if (body.scope) {
        const requested = parseScopes(String(body.scope));
        const originalSet = new Set(
          tokenRow.scopes.split(/\s+/).filter(Boolean)
        );
        const narrowed = requested.filter((s) => originalSet.has(s));
        newScopes = narrowed.join(" ");
      }

      // Rotate: revoke old, issue new.
      await db
        .update(oauthAccessTokens)
        .set({ revokedAt: new Date() })
        .where(eq(oauthAccessTokens.id, tokenRow.id));

      const accessToken = generateAccessToken();
      const newRefresh = generateRefreshToken();
      await db.insert(oauthAccessTokens).values({
        appId: app.id,
        userId: tokenRow.userId,
        accessTokenHash: await sha256Hex(accessToken),
        refreshTokenHash: await sha256Hex(newRefresh),
        scopes: newScopes,
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
        refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      });
      await audit({
        userId: tokenRow.userId,
        action: "oauth.token.refresh",
        targetType: "oauth_app",
        targetId: app.id,
      });
      return c.json({
        access_token: accessToken,
        token_type: "bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: newRefresh,
        scope: newScopes,
      });
    }

    return c.json(
      {
        error: "unsupported_grant_type",
        error_description: `grant_type '${grantType}' not supported`,
      },
      400
    );
  } catch (err) {
    console.error("[oauth] token:", err);
    return c.json(
      { error: "server_error", error_description: "Service unavailable" },
      503
    );
  }
});

// --- POST /oauth/revoke (RFC 7009) ------------------------------------------

oauth.post("/oauth/revoke", async (c) => {
  let body: Record<string, unknown> = {};
  const contentType = (c.req.header("content-type") || "").toLowerCase();
  try {
    if (contentType.includes("application/json")) {
      body = (await c.req.json()) as Record<string, unknown>;
    } else {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    }
  } catch {
    // Per RFC 7009 we still respond 200 to unknown tokens — but a malformed
    // body indicates a misbehaving client, so 400 is acceptable here.
    return c.json({ error: "invalid_request" }, 400);
  }

  const token = body.token ? String(body.token) : "";
  const authHeader = c.req.header("authorization");
  const creds = extractClientCreds(authHeader, body);

  if (!creds.clientId) {
    return c.json({ error: "invalid_client" }, 401);
  }
  const app = await loadAppByClientId(creds.clientId);
  if (!app) {
    return c.json({ error: "invalid_client" }, 401);
  }
  const clientAuthOk = await authenticateClient(app, creds.clientSecret);
  if (!clientAuthOk) {
    return c.json({ error: "invalid_client" }, 401);
  }

  if (!token) {
    // RFC 7009: server responds as if successful.
    return c.body(null, 200);
  }

  try {
    const hash = await sha256Hex(token);
    // Try access token first, then refresh token.
    const [asAccess] = await db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.accessTokenHash, hash))
      .limit(1);
    const [asRefresh] = asAccess
      ? []
      : await db
          .select()
          .from(oauthAccessTokens)
          .where(eq(oauthAccessTokens.refreshTokenHash, hash))
          .limit(1);
    const row = asAccess || asRefresh;
    if (row && row.appId === app.id && !row.revokedAt) {
      await db
        .update(oauthAccessTokens)
        .set({ revokedAt: new Date() })
        .where(eq(oauthAccessTokens.id, row.id));
      await audit({
        userId: row.userId,
        action: "oauth.token.revoke",
        targetType: "oauth_app",
        targetId: app.id,
      });
    }
  } catch (err) {
    console.error("[oauth] revoke:", err);
    // Still 200 per RFC 7009 — we don't want to leak whether the token existed.
  }
  return c.body(null, 200);
});

// --- GET /settings/authorizations -------------------------------------------

oauth.get("/settings/authorizations", async (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  const error = c.req.query("error");

  type Row = {
    app: typeof oauthApps.$inferSelect | null;
    token: typeof oauthAccessTokens.$inferSelect;
  };
  let rows: Row[] = [];
  try {
    const raw = await db
      .select()
      .from(oauthAccessTokens)
      .leftJoin(oauthApps, eq(oauthAccessTokens.appId, oauthApps.id))
      .where(
        and(
          eq(oauthAccessTokens.userId, user.id),
          isNull(oauthAccessTokens.revokedAt),
          gt(oauthAccessTokens.expiresAt, new Date())
        )
      );
    rows = raw.map((r: any) => ({
      app: r.oauth_apps,
      token: r.oauth_access_tokens,
    }));
  } catch (err) {
    console.error("[oauth] authorizations list:", err);
  }

  // Group by appId — show each app once with the most recent token's data.
  const byApp = new Map<string, Row>();
  for (const r of rows) {
    const existing = byApp.get(r.token.appId);
    if (
      !existing ||
      new Date(r.token.createdAt) > new Date(existing.token.createdAt)
    ) {
      byApp.set(r.token.appId, r);
    }
  }
  const grouped = Array.from(byApp.values());

  return c.html(
    <Layout title="Authorized applications" user={user}>
      <div class="oauth-wrap">
        <div class="oauth-breadcrumb">
          <a href="/settings">settings</a>
          <span class="sep">/</span>
          <span>authorized applications</span>
        </div>

        <section class="oauth-hero">
          <div class="oauth-hero-orb" aria-hidden="true" />
          <div class="oauth-hero-inner">
            <div class="oauth-eyebrow">
              <span class="oauth-eyebrow-dot" aria-hidden="true" />
              OAuth · {user.username}
            </div>
            <h1 class="oauth-title">
              <span class="oauth-title-grad">Authorized applications.</span>
            </h1>
            <p class="oauth-sub">
              Apps you've granted access to your Gluecron account. Revoking
              immediately invalidates every access + refresh token issued to
              that app for you.
            </p>
          </div>
        </section>

        {error && <div class="oauth-banner is-error">{decodeURIComponent(error)}</div>}
        {success && <div class="oauth-banner is-ok">{decodeURIComponent(success)}</div>}

        {grouped.length === 0 ? (
          <div class="oauth-empty">
            No authorized applications. Apps you approve via the OAuth consent
            screen will appear here.
          </div>
        ) : (
          <ul class="oauth-grant-list">
            {grouped.map(({ app, token }) => {
              const initial = ((app?.name || "?").trim().charAt(0) || "?").toUpperCase();
              return (
                <li class="oauth-grant">
                  <div
                    class="oauth-applogo"
                    aria-hidden="true"
                    style="width:42px;height:42px;font-size:17px;border-radius:10px"
                  >
                    {initial}
                  </div>
                  <div class="oauth-grant-info">
                    <h3 class="oauth-grant-name">{app?.name || "Unknown app"}</h3>
                    <div class="oauth-grant-meta">
                      scopes: <code>{token.scopes || "(none)"}</code>
                      {" · "}authorised{" "}
                      {new Date(token.createdAt).toLocaleDateString()}
                      {token.lastUsedAt &&
                        ` · last used ${new Date(token.lastUsedAt).toLocaleDateString()}`}
                    </div>
                  </div>
                  <form
                    method="post"
                    action={`/settings/authorizations/${token.appId}/revoke`}
                    onsubmit="return confirm('Revoke access for this application?')"
                    style="margin:0"
                  >
                    <button type="submit" class="oauth-btn-danger-sm">
                      Revoke
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}

        <div class="oauth-explainer" style="margin-top:var(--space-5)">
          <strong>Building an OAuth app?</strong>
          Register one at <a href="/settings/applications">Developer applications</a>.
          You'll get a <code>client_id</code> + <code>client_secret</code> and
          can point users at <code>/oauth/authorize?client_id=…</code>.
          The full spec — supported scopes ({SUPPORTED_SCOPES.length}), PKCE
          rules, token TTLs — is at <a href="/api-docs">/api-docs</a>.
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: oauthStyles }} />
    </Layout>
  );
});

// --- POST /settings/authorizations/:appId/revoke ----------------------------

oauth.post("/settings/authorizations/:appId/revoke", async (c) => {
  const user = c.get("user")!;
  const appId = c.req.param("appId");
  try {
    await db
      .update(oauthAccessTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(oauthAccessTokens.userId, user.id),
          eq(oauthAccessTokens.appId, appId),
          isNull(oauthAccessTokens.revokedAt)
        )
      );
    await audit({
      userId: user.id,
      action: "oauth.user_revoke",
      targetType: "oauth_app",
      targetId: appId,
    });
    return c.redirect("/settings/authorizations?success=Revoked");
  } catch (err) {
    console.error("[oauth] user revoke:", err);
    return c.redirect(
      "/settings/authorizations?error=Service+unavailable"
    );
  }
});

export default oauth;

// re-export for test visibility
export { SUPPORTED_SCOPES };
