/**
 * Block H — Marketplace UI + developer-side app management.
 *
 *   GET  /marketplace                       — public app directory (search)
 *   GET  /marketplace/:slug                 — app detail + install CTA
 *   POST /marketplace/:slug/install         — install to user (v1 only)
 *   POST /marketplace/installations/:id/uninstall
 *                                           — revoke access
 *   GET  /settings/apps                     — list installed apps
 *   GET  /developer/apps-new                — register a new app
 *   POST /developer/apps-new                — create app + bot
 *   GET  /developer/apps/:slug/manage       — event log + install count
 *   POST /developer/apps/:slug/tokens/new   — issue install token (for testing)
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apps, appInstallations } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  KNOWN_PERMISSIONS,
  KNOWN_EVENTS,
  countInstalls,
  createApp,
  getAppBySlug,
  installApp,
  issueInstallToken,
  listEventsForApp,
  listInstallationsForApp,
  listInstallationsForTarget,
  listPublicApps,
  normalisePermissions,
  parsePermissions,
  uninstallApp,
} from "../lib/marketplace";
import { audit } from "../lib/notify";

const marketplace = new Hono<AuthEnv>();
marketplace.use("*", softAuth);

// ---------- Public directory ----------

marketplace.get("/marketplace", async (c) => {
  const user = c.get("user");
  const q = c.req.query("q") || "";
  const list = await listPublicApps(q);
  return c.html(
    <Layout title="Marketplace — Gluecron" user={user}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2>Marketplace</h2>
        {user && (
          <a href="/developer/apps-new" class="btn btn-sm">
            + Register app
          </a>
        )}
      </div>
      <form method="get" action="/marketplace" style="margin-bottom:16px">
        <input
          type="text"
          name="q"
          value={q}
          placeholder="Search apps"
          aria-label="Search apps"
          style="width:320px"
        />{" "}
        <button type="submit" class="btn">
          Search
        </button>
      </form>
      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px"
      >
        {list.length === 0 ? (
          <div class="panel-empty">No apps found.</div>
        ) : (
          list.map((a) => (
            <a
              href={`/marketplace/${a.slug}`}
              class="panel"
              style="padding:16px;color:inherit;text-decoration:none"
            >
              <div style="font-size:15px;font-weight:700">{a.name}</div>
              <div
                style="font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.4"
              >
                {a.description.slice(0, 140) || "No description."}
              </div>
              <div
                style="font-size:11px;color:var(--text-muted);margin-top:8px;text-transform:uppercase"
              >
                {parsePermissions(a.permissions).length} permissions
              </div>
            </a>
          ))
        )}
      </div>
    </Layout>
  );
});

marketplace.get("/marketplace/:slug", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const app = await getAppBySlug(slug);
  if (!app || !app.isPublic) return c.notFound();
  const [installs, perms] = await Promise.all([
    countInstalls(app.id),
    Promise.resolve(parsePermissions(app.permissions)),
  ]);
  return c.html(
    <Layout title={`${app.name} — Marketplace`} user={user}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2>{app.name}</h2>
        <a href="/marketplace" class="btn btn-sm">
          Back
        </a>
      </div>
      <div class="panel" style="padding:16px;margin-bottom:20px">
        <p>{app.description || "No description."}</p>
        {app.homepageUrl && (
          <p style="margin-top:8px">
            Homepage: <a href={app.homepageUrl}>{app.homepageUrl}</a>
          </p>
        )}
        <div style="font-size:12px;color:var(--text-muted);margin-top:8px">
          {installs} install{installs === 1 ? "" : "s"} · bot username{" "}
          <code>{app.slug}[bot]</code>
        </div>
      </div>

      <h3>Permissions</h3>
      <div class="panel" style="margin-bottom:20px">
        {perms.length === 0 ? (
          <div class="panel-empty">No permissions requested.</div>
        ) : (
          perms.map((p) => (
            <div class="panel-item">
              <code>{p}</code>
            </div>
          ))
        )}
      </div>

      {user ? (
        <form method="post" action={`/marketplace/${slug}/install`}>
          <div class="form-group">
            <p
              style="font-size:13px;color:var(--text-muted);margin-bottom:8px"
            >
              Installing grants {perms.length} permission
              {perms.length === 1 ? "" : "s"} to <strong>{app.name}</strong>{" "}
              on your personal account.
            </p>
          </div>
          {perms.map((p) => (
            <label
              style="display:inline-block;margin-right:10px;font-size:13px"
            >
              <input
                type="checkbox"
                name="permissions"
                value={p}
                checked
              />{" "}
              {p}
            </label>
          ))}
          <div style="margin-top:12px">
            <button type="submit" class="btn btn-primary">
              Install
            </button>
          </div>
        </form>
      ) : (
        <div class="panel" style="padding:16px;text-align:center">
          <a href={`/login?next=/marketplace/${slug}`}>Sign in to install</a>
        </div>
      )}
    </Layout>
  );
});

marketplace.post("/marketplace/:slug/install", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const app = await getAppBySlug(slug);
  if (!app) return c.notFound();
  const body = await c.req.parseBody({ all: true });
  const rawPerms = body.permissions;
  const perms = Array.isArray(rawPerms)
    ? rawPerms.map(String)
    : rawPerms
    ? [String(rawPerms)]
    : [];
  const inst = await installApp({
    appId: app.id,
    installedBy: user.id,
    targetType: "user",
    targetId: user.id,
    grantedPermissions: perms,
  });
  if (inst) {
    await audit({
      userId: user.id,
      action: "marketplace.install",
      targetType: "app",
      targetId: app.id,
      metadata: { grantedPermissions: normalisePermissions(perms) },
    });
  }
  return c.redirect("/settings/apps");
});

marketplace.post(
  "/marketplace/installations/:id/uninstall",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    // Only the installer can uninstall
    const [inst] = await db
      .select()
      .from(appInstallations)
      .where(eq(appInstallations.id, id))
      .limit(1);
    if (!inst || inst.installedBy !== user.id) {
      return c.text("forbidden", 403);
    }
    const ok = await uninstallApp(id);
    if (ok) {
      await audit({
        userId: user.id,
        action: "marketplace.uninstall",
        targetType: "app_installation",
        targetId: id,
      });
    }
    return c.redirect("/settings/apps");
  }
);

// ---------- Personal installs ----------

marketplace.get("/settings/apps", requireAuth, async (c) => {
  const user = c.get("user")!;
  const installs = await listInstallationsForTarget("user", user.id);
  return c.html(
    <Layout title="Installed apps — Gluecron" user={user}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2>Installed apps</h2>
        <a href="/marketplace" class="btn btn-sm">
          Browse marketplace
        </a>
      </div>
      <div class="panel">
        {installs.length === 0 ? (
          <div class="panel-empty">
            No apps installed.{" "}
            <a href="/marketplace">Browse the marketplace</a>.
          </div>
        ) : (
          installs.map((i) => (
            <div class="panel-item" style="justify-content:space-between">
              <div style="flex:1;min-width:0">
                <a
                  href={i.app ? `/marketplace/${i.app.slug}` : "#"}
                  style="font-weight:600"
                >
                  {i.app?.name || "(unknown app)"}
                </a>
                <div
                  style="font-size:12px;color:var(--text-muted);margin-top:2px"
                >
                  {parsePermissions(i.grantedPermissions).length} permissions ·
                  installed{" "}
                  {i.createdAt
                    ? new Date(i.createdAt).toLocaleDateString()
                    : ""}
                </div>
              </div>
              <form
                method="post"
                action={`/marketplace/installations/${i.id}/uninstall`}
                onsubmit="return confirm('Uninstall this app?')"
              >
                <button type="submit" class="btn btn-sm btn-danger">
                  Uninstall
                </button>
              </form>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
});

// ---------- Developer UX ----------

marketplace.get("/developer/apps-new", requireAuth, async (c) => {
  const user = c.get("user")!;
  return c.html(
    <Layout title="New app — Marketplace" user={user}>
      <h2>Register a new app</h2>
      <form method="post" action="/developer/apps-new" class="panel" style="padding:16px">
        <div class="form-group">
          <label>Name</label>
          <input type="text" name="name" required aria-label="App name" style="width:100%" />
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea name="description" rows={3} style="width:100%" />
        </div>
        <div class="form-group">
          <label>Homepage URL</label>
          <input type="url" name="homepageUrl" aria-label="Homepage URL" style="width:100%" />
        </div>
        <div class="form-group">
          <label>Webhook URL (optional)</label>
          <input type="url" name="webhookUrl" aria-label="Webhook URL" style="width:100%" />
        </div>
        <div class="form-group">
          <label>Permissions</label>
          <div
            style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px;font-size:13px"
          >
            {KNOWN_PERMISSIONS.map((p) => (
              <label>
                <input type="checkbox" name="permissions" value={p} /> {p}
              </label>
            ))}
          </div>
        </div>
        <div class="form-group">
          <label>Events</label>
          <div
            style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;font-size:13px"
          >
            {KNOWN_EVENTS.map((e) => (
              <label>
                <input type="checkbox" name="events" value={e} /> {e}
              </label>
            ))}
          </div>
        </div>
        <div class="form-group">
          <label>
            <input type="checkbox" name="isPublic" value="1" checked /> List in
            public marketplace
          </label>
        </div>
        <button type="submit" class="btn btn-primary">
          Create app
        </button>
      </form>
    </Layout>
  );
});

marketplace.post("/developer/apps-new", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody({ all: true });
  const name = String(body.name || "").trim();
  if (!name) return c.redirect("/developer/apps-new");
  const rawPerms = body.permissions;
  const perms = Array.isArray(rawPerms)
    ? rawPerms.map(String)
    : rawPerms
    ? [String(rawPerms)]
    : [];
  const rawEvents = body.events;
  const events = Array.isArray(rawEvents)
    ? rawEvents.map(String)
    : rawEvents
    ? [String(rawEvents)]
    : [];
  const app = await createApp({
    name,
    description: String(body.description || ""),
    homepageUrl: String(body.homepageUrl || "") || undefined,
    webhookUrl: String(body.webhookUrl || "") || undefined,
    creatorId: user.id,
    permissions: perms,
    defaultEvents: events,
    isPublic: !!body.isPublic,
  });
  if (!app) return c.text("failed to create", 500);
  await audit({
    userId: user.id,
    action: "marketplace.app.create",
    targetType: "app",
    targetId: app.id,
  });
  return c.redirect(`/developer/apps/${app.slug}/manage`);
});

marketplace.get("/developer/apps/:slug/manage", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const app = await getAppBySlug(slug);
  if (!app) return c.notFound();
  if (app.creatorId !== user.id) return c.text("forbidden", 403);
  const [installs, events] = await Promise.all([
    listInstallationsForApp(app.id),
    listEventsForApp(app.id, 20),
  ]);
  return c.html(
    <Layout title={`Manage ${app.name}`} user={user}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2>{app.name} · Developer</h2>
        <a href={`/marketplace/${app.slug}`} class="btn btn-sm">
          Public page
        </a>
      </div>
      <div class="panel" style="padding:12px;margin-bottom:20px">
        <div style="font-size:12px;color:var(--text-muted)">Bot identity</div>
        <div style="font-family:var(--font-mono)">{app.slug}[bot]</div>
        {app.webhookSecret && (
          <div style="margin-top:8px;font-size:12px">
            <span style="color:var(--text-muted)">Webhook secret:</span>{" "}
            <code>{app.webhookSecret}</code>
          </div>
        )}
      </div>

      <h3>Installations ({installs.length})</h3>
      <div class="panel" style="margin-bottom:20px">
        {installs.length === 0 ? (
          <div class="panel-empty">No installs yet.</div>
        ) : (
          installs.map((i) => (
            <div class="panel-item" style="justify-content:space-between">
              <div>
                {i.targetType}: <code>{i.targetId}</code>
              </div>
              <div style="font-size:12px;color:var(--text-muted)">
                {parsePermissions(i.grantedPermissions).length} perms ·{" "}
                {i.createdAt
                  ? new Date(i.createdAt).toLocaleDateString()
                  : ""}
              </div>
            </div>
          ))
        )}
      </div>

      <h3>Recent events</h3>
      <div class="panel" style="margin-bottom:20px">
        {events.length === 0 ? (
          <div class="panel-empty">No events yet.</div>
        ) : (
          events.map((e) => (
            <div class="panel-item" style="justify-content:space-between">
              <span>{e.kind}</span>
              <span style="font-size:12px;color:var(--text-muted)">
                {e.createdAt
                  ? new Date(e.createdAt).toLocaleString()
                  : ""}
              </span>
            </div>
          ))
        )}
      </div>

      <h3>Installation tokens</h3>
      <form
        method="post"
        action={`/developer/apps/${app.slug}/tokens/new`}
        class="panel"
        style="padding:16px"
      >
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
          Issue a bearer token for an existing installation. Use this to test
          bot API calls. Tokens are shown once and expire after 1 hour.
        </p>
        <select name="installationId">
          {installs.map((i) => (
            <option value={i.id}>
              {i.targetType}:{i.targetId.slice(0, 8)}
            </option>
          ))}
        </select>{" "}
        <button type="submit" class="btn btn-sm" disabled={installs.length === 0}>
          Issue token
        </button>
      </form>
    </Layout>
  );
});

marketplace.post(
  "/developer/apps/:slug/tokens/new",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const app = await getAppBySlug(slug);
    if (!app) return c.notFound();
    if (app.creatorId !== user.id) return c.text("forbidden", 403);
    const body = await c.req.parseBody();
    const installationId = String(body.installationId || "");
    if (!installationId) return c.redirect(`/developer/apps/${slug}/manage`);
    // Validate the installation belongs to this app
    const [inst] = await db
      .select()
      .from(appInstallations)
      .where(eq(appInstallations.id, installationId))
      .limit(1);
    if (!inst || inst.appId !== app.id) return c.text("forbidden", 403);
    const t = await issueInstallToken(installationId);
    if (!t) return c.text("failed", 500);
    await audit({
      userId: user.id,
      action: "marketplace.token.issue",
      targetType: "app_installation",
      targetId: installationId,
    });
    return c.html(
      <Layout title="Token issued" user={user}>
        <h2>Token issued</h2>
        <div class="panel" style="padding:16px">
          <p>Copy this token now — it won't be shown again.</p>
          <pre
            style="font-family:var(--font-mono);background:var(--bg-secondary);padding:12px;border-radius:6px;word-break:break-all"
          >
            {t.token}
          </pre>
          <p style="font-size:12px;color:var(--text-muted)">
            Expires at {t.expiresAt.toISOString()}
          </p>
          <a href={`/developer/apps/${slug}/manage`} class="btn" style="margin-top:12px">
            Back
          </a>
        </div>
      </Layout>
    );
  }
);

export default marketplace;
