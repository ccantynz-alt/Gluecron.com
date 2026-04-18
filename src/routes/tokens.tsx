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
                <Form
                  action={`/settings/tokens/${token.id}/delete`}
                  method="POST"
                >
                  <Button type="submit" variant="danger" size="sm">
                    Revoke
                  </Button>
                </Form>
              </ListItem>
            ))
          )}
        </div>

        <Section title="Generate new token" style="margin-top: 24px">
          <Form action="/settings/tokens" method="POST">
            <FormGroup label="Token name" htmlFor="name">
              <Input
                name="name"
                id="name"
                required
                placeholder="e.g. CI/CD pipeline"
              />
            </FormGroup>
            <FormGroup label="Scopes">
              <Flex gap={16} wrap>
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
              </Flex>
            </FormGroup>
            <Button type="submit" variant="primary">
              Generate token
            </Button>
          </Form>
        </Section>
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
