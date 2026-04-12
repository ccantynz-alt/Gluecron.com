/**
 * API tokens — personal access tokens for automation.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiTokens } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const tokens = new Hono<AuthEnv>();

tokens.use("/settings/tokens*", softAuth, requireAuth);
tokens.use("/api/user/tokens*", softAuth, requireAuth);

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    "glc_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Token settings page
tokens.get("/settings/tokens", async (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  const newToken = c.req.query("new_token");

  const userTokens = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.id));

  return c.html(
    <Layout title="API Tokens" user={user}>
      <div class="settings-container">
        <h2>Personal access tokens</h2>
        {success && (
          <div class="auth-success" style="margin-top: 12px">
            {decodeURIComponent(success)}
          </div>
        )}
        {newToken && (
          <div
            class="auth-success"
            style="margin-top: 12px; font-family: var(--font-mono); word-break: break-all"
          >
            New token (copy now — it won't be shown again):{" "}
            <strong>{decodeURIComponent(newToken)}</strong>
          </div>
        )}
        <div style="margin-top: 16px">
          {userTokens.length === 0 ? (
            <p style="color: var(--text-muted)">No tokens yet.</p>
          ) : (
            userTokens.map((token) => (
              <div class="ssh-key-item">
                <div>
                  <strong>{token.name}</strong>
                  <div class="ssh-key-meta">
                    <code>{token.tokenPrefix}...</code>
                    <span style="margin-left: 8px">
                      Scopes: {token.scopes}
                    </span>
                    {token.lastUsedAt && (
                      <span>
                        {" "}
                        | Last used{" "}
                        {new Date(token.lastUsedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <form
                  method="POST"
                  action={`/settings/tokens/${token.id}/delete`}
                >
                  <button type="submit" class="btn btn-danger btn-sm">
                    Revoke
                  </button>
                </form>
              </div>
            ))
          )}
        </div>

        <h3 style="margin-top: 24px; margin-bottom: 12px">
          Generate new token
        </h3>
        <form method="POST" action="/settings/tokens">
          <div class="form-group">
            <label for="name">Token name</label>
            <input
              type="text"
              id="name"
              name="name"
              required
              placeholder="e.g. CI/CD pipeline"
            />
          </div>
          <div class="form-group">
            <label>Scopes</label>
            <div style="display: flex; gap: 16px; flex-wrap: wrap">
              {["repo", "user", "admin"].map((scope) => (
                <label style="display: flex; align-items: center; gap: 4px; font-size: 14px; cursor: pointer">
                  <input
                    type="checkbox"
                    name="scopes"
                    value={scope}
                    checked={scope === "repo"}
                  />{" "}
                  {scope}
                </label>
              ))}
            </div>
          </div>
          <button type="submit" class="btn btn-primary">
            Generate token
          </button>
        </form>
      </div>
    </Layout>
  );
});

// Create token
tokens.post("/settings/tokens", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();

  let scopes: string;
  const rawScopes = body.scopes;
  if (Array.isArray(rawScopes)) {
    scopes = rawScopes.join(",");
  } else {
    scopes = String(rawScopes || "repo");
  }

  if (!name) {
    return c.redirect("/settings/tokens?error=Name+is+required");
  }

  const token = generateToken();
  const tokenH = await hashToken(token);

  await db.insert(apiTokens).values({
    userId: user.id,
    name,
    tokenHash: tokenH,
    tokenPrefix: token.slice(0, 12),
    scopes,
  });

  return c.redirect(
    `/settings/tokens?new_token=${encodeURIComponent(token)}`
  );
});

// Delete token
tokens.post("/settings/tokens/:id/delete", async (c) => {
  const user = c.get("user")!;
  const tokenId = c.req.param("id");

  const [token] = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, tokenId))
    .limit(1);

  if (!token || token.userId !== user.id) {
    return c.redirect("/settings/tokens");
  }

  await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
  return c.redirect("/settings/tokens?success=Token+revoked");
});

// API endpoint
tokens.get("/api/user/tokens", async (c) => {
  const user = c.get("user")!;
  const userTokens = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      tokenPrefix: apiTokens.tokenPrefix,
      scopes: apiTokens.scopes,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.id));
  return c.json(userTokens);
});

export default tokens;
