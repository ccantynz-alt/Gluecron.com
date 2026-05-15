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
import {
  Container,
  PageHeader,
  Section,
  Alert,
  EmptyState,
  ListItem,
  Flex,
  Form,
  FormGroup,
  Input,
  Button,
  InlineCode,
  Text,
} from "../views/ui";

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
      <Container class="settings-container">
        <PageHeader title="Personal access tokens" />
        {success && (
          <Alert variant="success">
            {decodeURIComponent(success)}
          </Alert>
        )}
        {newToken && (
          <Alert variant="success">
            <span style="font-family: var(--font-mono); word-break: break-all">
              New token (copy now — it won't be shown again):{" "}
              <strong>{decodeURIComponent(newToken)}</strong>
            </span>
          </Alert>
        )}
        <div style="margin-top: 16px">
          {userTokens.length === 0 ? (
            <EmptyState>
              <Text muted>No tokens yet.</Text>
            </EmptyState>
          ) : (
            userTokens.map((token) => (
              <ListItem>
                <div>
                  <strong>{token.name}</strong>
                  <div class="ssh-key-meta">
                    <InlineCode>{token.tokenPrefix}...</InlineCode>
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
                  method="post"
                  action={`/settings/tokens/${token.id}/delete`}
                >
                  <Button type="submit" variant="danger" size="sm">
                    Revoke
                  </Button>
                </form>
              </ListItem>
            ))
          )}
        </div>

        <h3 style="margin-top: 24px; margin-bottom: 12px">
          Generate new token
        </h3>
        <form method="post" action="/settings/tokens">
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
                    aria-label={scope}
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
      </Container>
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

/**
 * Emergency PAT issuance — break-glass for when the web UI is broken
 * (service-worker loop, css busted, whatever) and an operator needs
 * a token to push a fix.
 *
 * Auth: bearer of the `EMERGENCY_PAT_SECRET` env var (set on the host).
 * If the env var is unset, the endpoint returns 503 — we don't want it
 * silently usable with an empty secret. This is the ONLY token route
 * that isn't behind a normal session, by design.
 *
 * Issues a PAT for the user named in the JSON body's `username` field,
 * defaulting to the site admin / oldest user (same heuristic the
 * self-host bootstrap uses).
 *
 * Returns JSON: { user, token } — the token is shown ONCE.
 *
 * Use:
 *   curl -X POST https://gluecron.com/api/admin/emergency-pat \
 *     -H "Authorization: Bearer $EMERGENCY_PAT_SECRET" \
 *     -H "content-type: application/json" \
 *     -d '{"name":"break-glass","scopes":"admin"}'
 */
tokens.post("/api/admin/emergency-pat", async (c) => {
  const secret = process.env.EMERGENCY_PAT_SECRET;
  if (!secret) {
    return c.json(
      { error: "emergency PAT endpoint not configured (EMERGENCY_PAT_SECRET unset)" },
      503
    );
  }
  const provided = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (provided !== secret) {
    return c.json({ error: "invalid emergency secret" }, 401);
  }

  let body: { username?: string; name?: string; scopes?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const name = (body.name || "emergency-pat").trim();
  const scopes = (body.scopes || "admin").trim();

  // Resolve target user: explicit username → site admin → oldest user.
  const { users, siteAdmins } = await import("../db/schema");
  const { eq: eqOp, asc } = await import("drizzle-orm");
  let target:
    | { id: string; username: string }
    | undefined;

  if (body.username) {
    const [u] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eqOp(users.username, body.username))
      .limit(1);
    target = u;
  }
  if (!target) {
    try {
      const [u] = await db
        .select({ id: users.id, username: users.username })
        .from(siteAdmins)
        .innerJoin(users, eqOp(siteAdmins.userId, users.id))
        .limit(1);
      target = u;
    } catch {
      // siteAdmins table may not exist on stale schemas — fall through.
    }
  }
  if (!target) {
    const [u] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .orderBy(asc(users.createdAt))
      .limit(1);
    target = u;
  }
  if (!target) {
    return c.json({ error: "no user available to issue PAT for" }, 404);
  }

  // Token + hash — same algorithm the web flow uses.
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token =
    "glc_" +
    Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const hashBuf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  const tokenHash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  await db.insert(apiTokens).values({
    userId: target.id,
    name,
    tokenHash,
    tokenPrefix: token.slice(0, 12),
    scopes,
  });

  return c.json({
    user: { id: target.id, username: target.username },
    token,
    name,
    scopes,
    note: "Token is shown once. Store it now.",
  });
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
