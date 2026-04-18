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

function errorPage(title: string, message: string) {
  return (
    <Layout title={title}>
      <div class="empty-state">
        <h2>{title}</h2>
        <p>{message}</p>
        <a href="/" style="margin-top: 12px; display: inline-block">
          Go home
        </a>
      </div>
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
    return c.html(errorPage("OAuth error", "Missing client_id."), 400);
  }
  const app = await loadAppByClientId(clientId);
  if (!app) {
    return c.html(errorPage("OAuth error", "Unknown client."), 400);
  }
  if (app.revokedAt) {
    return c.html(errorPage("OAuth error", "This application has been revoked."), 400);
  }

  const registered = parseRedirectUris(app.redirectUris);
  if (!redirectUriAllowed(redirectUri, registered)) {
    return c.html(
      errorPage(
        "OAuth error",
        "redirect_uri does not match any registered callback for this app."
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

  return c.html(
    <Layout title="Authorize application" user={user}>
      <div class="auth-container">
        <h2>Authorize {app.name}</h2>
        <p style="color: var(--text-muted); font-size: 13px">
          <strong>{app.name}</strong> by <code>{ownerName}</code> wants
          access to your gluecron account as <strong>{user.username}</strong>.
        </p>
        {app.description && (
          <p style="color: var(--text-muted); font-size: 13px">
            {app.description}
          </p>
        )}
        <div
          style="border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; margin: 16px 0; background: var(--bg-secondary)"
        >
          <strong>Requested scopes</strong>
          {scopes.length === 0 ? (
            <p style="color: var(--text-muted); font-size: 12px; margin: 8px 0 0">
              No scopes — this app will only be able to identify you.
            </p>
          ) : (
            <ul style="margin: 8px 0 0 16px; font-size: 13px">
              {scopes.map((s) => (
                <li>
                  <code>{s}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p style="color: var(--text-muted); font-size: 12px">
          You can revoke access at any time from{" "}
          <a href="/settings/authorizations">Authorized applications</a>.
        </p>
        <form method="POST" action="/oauth/authorize/decision">
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
          <div style="display: flex; gap: 8px">
            <button type="submit" name="decision" value="approve" class="btn btn-primary">
              Authorize
            </button>
            <button type="submit" name="decision" value="deny" class="btn">
              Cancel
            </button>
          </div>
        </form>
      </div>
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
    return c.html(errorPage("OAuth error", "Unknown or revoked client."), 400);
  }
  const registered = parseRedirectUris(app.redirectUris);
  if (!redirectUriAllowed(redirectUri, registered)) {
    return c.html(errorPage("OAuth error", "Invalid redirect_uri."), 400);
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
      <div class="settings-container">
        <div class="breadcrumb">
          <a href="/settings">settings</a>
          <span>/</span>
          <span>authorized applications</span>
        </div>
        <h2>Authorized applications</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}
        <p style="color: var(--text-muted); font-size: 13px">
          Apps that have been granted access to your gluecron account.
          Revoking immediately invalidates every access + refresh token
          issued to that app for your user.
        </p>
        <div
          style="border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-top: 16px"
        >
          {grouped.length === 0 ? (
            <div
              style="padding: 16px; color: var(--text-muted); font-size: 13px; background: var(--bg-secondary)"
            >
              No authorized applications.
            </div>
          ) : (
            grouped.map(({ app, token }) => (
              <div
                style="padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg-secondary); display: flex; justify-content: space-between; align-items: center"
              >
                <div>
                  <strong>{app?.name || "Unknown app"}</strong>
                  <div
                    style="color: var(--text-muted); font-size: 12px; margin-top: 2px"
                  >
                    scopes: <code>{token.scopes || "(none)"}</code>
                    {" · "}authorised{" "}
                    {new Date(token.createdAt).toLocaleDateString()}
                    {token.lastUsedAt &&
                      ` · last used ${new Date(token.lastUsedAt).toLocaleDateString()}`}
                  </div>
                </div>
                <form
                  method="POST"
                  action={`/settings/authorizations/${token.appId}/revoke`}
                  onsubmit="return confirm('Revoke access for this application?')"
                >
                  <button type="submit" class="btn btn-sm btn-danger">
                    Revoke
                  </button>
                </form>
              </div>
            ))
          )}
        </div>
        <p style="margin-top: 16px; font-size: 12px; color: var(--text-muted)">
          Building an OAuth app?{" "}
          <a href="/settings/applications">Register one</a>.
        </p>
      </div>
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
