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
 * All writes audit()' the action. Read-only responses are HTML (SSR JSX).
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

  return c.html(
    <Layout title="OAuth applications" user={user}>
      <div class="settings-container">
        <div class="breadcrumb">
          <a href="/settings">settings</a>
          <span>/</span>
          <span>applications</span>
        </div>
        <h2>OAuth applications</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}
        <p style="color: var(--text-muted); font-size: 13px">
          Register third-party apps that can request access to gluecron on
          behalf of users via the OAuth 2.0 authorization code flow.
        </p>
        <div style="margin: 16px 0">
          <a href="/settings/applications/new" class="btn btn-primary">
            New OAuth app
          </a>
        </div>
        <div
          style="border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden"
        >
          {rows.length === 0 ? (
            <div
              style="padding: 16px; color: var(--text-muted); font-size: 13px; background: var(--bg-secondary)"
            >
              No OAuth apps registered yet.
            </div>
          ) : (
            rows.map((app) => (
              <div
                style="padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg-secondary)"
              >
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <div>
                    <strong>
                      <a href={`/settings/applications/${app.id}`}>{app.name}</a>
                    </strong>
                    {app.revokedAt && (
                      <span style="color: var(--red); font-size: 12px; margin-left: 8px">
                        revoked
                      </span>
                    )}
                    <div
                      style="color: var(--text-muted); font-size: 12px; margin-top: 2px"
                    >
                      <code>{app.clientId}</code>
                      {" · "}added {new Date(app.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <a
                    href={`/settings/applications/${app.id}`}
                    class="btn btn-sm"
                  >
                    manage
                  </a>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Layout>
  );
});

apps.get("/settings/applications/new", async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");
  return c.html(
    <Layout title="New OAuth app" user={user}>
      <div class="settings-container">
        <div class="breadcrumb">
          <a href="/settings/applications">applications</a>
          <span>/</span>
          <span>new</span>
        </div>
        <h2>Register a new OAuth app</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <form method="POST" action="/settings/applications/new">
          <div class="form-group">
            <label for="name">Application name</label>
            <input
              type="text"
              id="name"
              name="name"
              required
              maxLength={80}
              placeholder="My Awesome Integration"
            />
          </div>
          <div class="form-group">
            <label for="homepage_url">Homepage URL</label>
            <input
              type="url"
              id="homepage_url"
              name="homepage_url"
              placeholder="https://example.com"
            />
          </div>
          <div class="form-group">
            <label for="description">Description</label>
            <textarea
              id="description"
              name="description"
              rows={3}
              maxLength={500}
            />
          </div>
          <div class="form-group">
            <label for="redirect_uris">Authorization callback URLs</label>
            <textarea
              id="redirect_uris"
              name="redirect_uris"
              rows={4}
              required
              placeholder="https://example.com/oauth/callback"
            />
            <small style="color: var(--text-muted)">
              One URL per line. HTTPS required (HTTP allowed for localhost).
              Exact match; no wildcards.
            </small>
          </div>
          <div class="form-group">
            <label>
              <input
                type="checkbox"
                name="confidential"
                value="on"
                checked
              />
              {" "}Confidential client (server-side app)
            </label>
            <br />
            <small style="color: var(--text-muted)">
              Uncheck for public SPA / mobile apps — they must use PKCE
              instead of a client secret.
            </small>
          </div>
          <button type="submit" class="btn btn-primary">
            Register app
          </button>
          <a
            href="/settings/applications"
            class="btn"
            style="margin-left: 8px"
          >
            Cancel
          </a>
        </form>
      </div>
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
      <div class="settings-container">
        <div class="breadcrumb">
          <a href="/settings/applications">applications</a>
          <span>/</span>
          <span>{app.name}</span>
        </div>
        <h2>{app.name}</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}

        {secret && (
          <div
            style="padding: 12px; border: 1px solid var(--yellow); background: rgba(255,193,7,0.1); border-radius: var(--radius); margin-bottom: 16px"
          >
            <strong>Save this client secret — it will not be shown again:</strong>
            <pre
              style="margin-top: 8px; padding: 8px; background: var(--bg); border-radius: 4px; overflow-x: auto; user-select: all"
            >
              {secret}
            </pre>
          </div>
        )}

        <dl style="display: grid; grid-template-columns: 200px 1fr; gap: 8px 16px; margin-bottom: 16px">
          <dt style="color: var(--text-muted)">Client ID</dt>
          <dd>
            <code style="user-select: all">{app.clientId}</code>
          </dd>
          <dt style="color: var(--text-muted)">Client secret prefix</dt>
          <dd>
            <code>{app.clientSecretPrefix}…</code>
          </dd>
          <dt style="color: var(--text-muted)">Type</dt>
          <dd>{app.confidential ? "Confidential" : "Public (PKCE)"}</dd>
          <dt style="color: var(--text-muted)">Created</dt>
          <dd>{new Date(app.createdAt).toLocaleString()}</dd>
        </dl>

        <form method="POST" action={`/settings/applications/${app.id}`}>
          <div class="form-group">
            <label for="name">Application name</label>
            <input
              type="text"
              id="name"
              name="name"
              required
              maxLength={80}
              defaultValue={app.name}
            />
          </div>
          <div class="form-group">
            <label for="homepage_url">Homepage URL</label>
            <input
              type="url"
              id="homepage_url"
              name="homepage_url"
              defaultValue={app.homepageUrl || ""}
            />
          </div>
          <div class="form-group">
            <label for="description">Description</label>
            <textarea
              id="description"
              name="description"
              rows={3}
              maxLength={500}
            >
              {app.description || ""}
            </textarea>
          </div>
          <div class="form-group">
            <label for="redirect_uris">Authorization callback URLs</label>
            <textarea
              id="redirect_uris"
              name="redirect_uris"
              rows={4}
              required
            >
              {app.redirectUris}
            </textarea>
          </div>
          <button type="submit" class="btn btn-primary">
            Save changes
          </button>
        </form>

        <hr style="margin: 24px 0; border-color: var(--border)" />

        <h3>Rotate client secret</h3>
        <p style="color: var(--text-muted); font-size: 13px">
          Generate a new secret. The old one is invalidated immediately —
          existing access tokens keep working, but token exchange with the
          old secret will fail.
        </p>
        <form
          method="POST"
          action={`/settings/applications/${app.id}/rotate`}
          onsubmit="return confirm('Rotate the client secret? The old one will stop working immediately.')"
        >
          <button type="submit" class="btn">
            Rotate secret
          </button>
        </form>

        <hr style="margin: 24px 0; border-color: var(--border)" />

        <h3 style="color: var(--red)">Danger zone</h3>
        <form
          method="POST"
          action={`/settings/applications/${app.id}/delete`}
          onsubmit="return confirm('Delete this OAuth app? All issued access tokens will be revoked.')"
        >
          <button type="submit" class="btn btn-danger">
            Delete app
          </button>
        </form>
      </div>
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
