/**
 * Block F3 — Site admin panel.
 *
 *   GET  /admin                           — dashboard (counts + recent users)
 *   GET  /admin/users                     — user list + search
 *   POST /admin/users/:id/admin           — toggle site-admin flag
 *   GET  /admin/repos                     — repo list (including private)
 *   POST /admin/repos/:id/delete          — nuclear delete (audit-logged)
 *   GET  /admin/flags                     — site flags CRUD
 *   POST /admin/flags                     — set flag
 *
 * All routes gated by `isSiteAdmin`. First registered user is the bootstrap
 * admin. Site banner + registration lock are surfaced to the rest of the app
 * via `getFlag`.
 */

import { Hono } from "hono";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  grantSiteAdmin,
  isSiteAdmin,
  KNOWN_FLAGS,
  listFlags,
  listSiteAdmins,
  revokeSiteAdmin,
  setFlag,
} from "../lib/admin";
import { audit } from "../lib/notify";
import { sendDigestsToAll, sendDigestForUser } from "../lib/email-digest";
import {
  getLastTick,
  getTickCount,
  runAutopilotTick,
} from "../lib/autopilot";
import { ensureDemoContent, DEMO_USERNAME } from "../lib/demo-seed";

const admin = new Hono<AuthEnv>();
admin.use("*", softAuth);

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="empty-state">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to view this page.</p>
        </div>
      </Layout>,
      403
    );
  }
  return { user };
}

admin.get("/admin", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const [uc] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  const [rc] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(repositories);

  const recent = await db
    .select({
      id: users.id,
      username: users.username,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(10);

  const admins = await listSiteAdmins();

  const msg = c.req.query("result") || c.req.query("error");
  const isErr = !!c.req.query("error");

  return c.html(
    <Layout title="Admin — Gluecron" user={user}>
      <h2>Site admin</h2>

      {msg && (
        <div
          class={isErr ? "auth-error" : "banner"}
          style="margin-bottom:16px"
        >
          {decodeURIComponent(msg)}
        </div>
      )}

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:22px;font-weight:700">{Number(uc?.n || 0)}</div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
            Users
          </div>
        </div>
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:22px;font-weight:700">{Number(rc?.n || 0)}</div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
            Repos
          </div>
        </div>
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:22px;font-weight:700">{admins.length}</div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
            Site admins
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:20px">
        <a href="/admin/users" class="btn">
          Manage users
        </a>
        <a href="/admin/repos" class="btn">
          Manage repos
        </a>
        <a href="/admin/flags" class="btn">
          Site flags
        </a>
        <a href="/admin/digests" class="btn">
          Email digests
        </a>
        <a href="/admin/sso" class="btn">
          Enterprise SSO
        </a>
        <a href="/admin/autopilot" class="btn">
          Autopilot
        </a>
        <form
          method="post"
          action="/admin/demo/reseed"
          style="display:contents"
        >
          <button class="btn" type="submit" title="Idempotently (re)create demo user + 3 sample repos">
            Reseed demo
          </button>
        </form>
      </div>

      <h3>Recent signups</h3>
      <div class="panel" style="margin-bottom:20px">
        {recent.map((u) => (
          <div class="panel-item" style="justify-content:space-between">
            <a href={`/${u.username}`}>{u.username}</a>
            <span style="font-size:12px;color:var(--text-muted)">
              {u.createdAt
                ? new Date(u.createdAt as unknown as string).toLocaleString()
                : ""}
            </span>
          </div>
        ))}
      </div>

      <h3>Site admins</h3>
      <div class="panel">
        {admins.length === 0 ? (
          <div class="panel-empty">
            No admins (bootstrap mode — oldest user is admin).
          </div>
        ) : (
          admins.map((a) => (
            <div class="panel-item" style="justify-content:space-between">
              <a href={`/${a.username}`}>{a.username}</a>
              <span style="font-size:12px;color:var(--text-muted)">
                Granted{" "}
                {a.grantedAt
                  ? new Date(a.grantedAt as unknown as string).toLocaleDateString()
                  : ""}
              </span>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
});

// ----- Users -----

admin.get("/admin/users", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const q = c.req.query("q") || "";
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(
      q
        ? or(ilike(users.username, `%${q}%`), ilike(users.email, `%${q}%`))!
        : sql`1=1`
    )
    .orderBy(desc(users.createdAt))
    .limit(200);

  const adminIds = new Set((await listSiteAdmins()).map((a) => a.userId));

  return c.html(
    <Layout title="Admin — Users" user={user}>
      <h2>Users</h2>
      <form method="get" action="/admin/users" style="margin-bottom:16px">
        <input
          type="text"
          name="q"
          value={q}
          placeholder="Search username or email"
          style="width:320px"
        />{" "}
        <button type="submit" class="btn">
          Search
        </button>
        <a href="/admin" class="btn" style="margin-left:6px">
          Back
        </a>
      </form>
      <div class="panel">
        {rows.length === 0 ? (
          <div class="panel-empty">No users found.</div>
        ) : (
          rows.map((u) => {
            const isAdmin = adminIds.has(u.id);
            return (
              <div class="panel-item" style="justify-content:space-between">
                <div>
                  <a href={`/${u.username}`} style="font-weight:600">
                    {u.username}
                  </a>{" "}
                  <span style="color:var(--text-muted)">{u.email}</span>
                  {isAdmin && (
                    <span
                      style="margin-left:6px;font-size:11px;background:#8957e5;color:white;padding:2px 6px;border-radius:3px"
                    >
                      ADMIN
                    </span>
                  )}
                </div>
                <form
                  method="post"
                  action={`/admin/users/${u.id}/admin`}
                  onsubmit={
                    isAdmin
                      ? "return confirm('Revoke site admin?')"
                      : "return confirm('Grant site admin?')"
                  }
                >
                  <button type="submit" class="btn btn-sm">
                    {isAdmin ? "Revoke admin" : "Grant admin"}
                  </button>
                </form>
              </div>
            );
          })
        )}
      </div>
    </Layout>
  );
});

admin.post("/admin/users/:id/admin", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const id = c.req.param("id");
  const admins = await listSiteAdmins();
  const isAlready = admins.some((a) => a.userId === id);
  if (isAlready) {
    await revokeSiteAdmin(id);
    await audit({
      userId: user.id,
      action: "site_admin.revoke",
      targetType: "user",
      targetId: id,
    });
  } else {
    await grantSiteAdmin(id, user.id);
    await audit({
      userId: user.id,
      action: "site_admin.grant",
      targetType: "user",
      targetId: id,
    });
  }
  return c.redirect("/admin/users");
});

// ----- Repos -----

admin.get("/admin/repos", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const rows = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      ownerUsername: users.username,
      isPrivate: repositories.isPrivate,
      createdAt: repositories.createdAt,
      starCount: repositories.starCount,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .orderBy(desc(repositories.createdAt))
    .limit(200);

  return c.html(
    <Layout title="Admin — Repos" user={user}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2>Repositories</h2>
        <a href="/admin" class="btn btn-sm">
          Back
        </a>
      </div>
      <div class="panel">
        {rows.length === 0 ? (
          <div class="panel-empty">No repositories.</div>
        ) : (
          rows.map((r) => (
            <div class="panel-item" style="justify-content:space-between">
              <div>
                <a
                  href={`/${r.ownerUsername}/${r.name}`}
                  style="font-weight:600"
                >
                  {r.ownerUsername}/{r.name}
                </a>
                <span
                  style="margin-left:6px;font-size:11px;color:var(--text-muted);text-transform:uppercase"
                >
                  {r.isPrivate ? "private" : "public"}
                </span>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
                  {r.starCount} stars ·{" "}
                  {r.createdAt
                    ? new Date(r.createdAt as unknown as string).toLocaleDateString()
                    : ""}
                </div>
              </div>
              <form
                method="post"
                action={`/admin/repos/${r.id}/delete`}
                onsubmit="return confirm('Delete repository permanently? This cannot be undone.')"
              >
                <button type="submit" class="btn btn-sm btn-danger">
                  Delete
                </button>
              </form>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
});

admin.post("/admin/repos/:id/delete", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const id = c.req.param("id");
  try {
    await db.delete(repositories).where(eq(repositories.id, id));
  } catch (err) {
    console.error("[admin] repo delete:", err);
  }
  await audit({
    userId: user.id,
    action: "admin.repo.delete",
    targetType: "repository",
    targetId: id,
  });
  return c.redirect("/admin/repos");
});

// ----- Flags -----

admin.get("/admin/flags", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const existing = await listFlags();
  const existingMap = new Map(existing.map((f) => [f.key, f.value]));
  const keys = Object.keys(KNOWN_FLAGS) as Array<keyof typeof KNOWN_FLAGS>;

  return c.html(
    <Layout title="Admin — Flags" user={user}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2>Site flags</h2>
        <a href="/admin" class="btn btn-sm">
          Back
        </a>
      </div>
      <form
        method="post"
        action="/admin/flags"
        class="panel"
        style="padding:16px"
      >
        {keys.map((k) => {
          const current = existingMap.get(k) ?? (KNOWN_FLAGS as any)[k];
          return (
            <div class="form-group">
              <label>{k}</label>
              <input
                type="text"
                name={k}
                value={current}
                style="font-family:var(--font-mono)"
              />
              <div
                style="font-size:11px;color:var(--text-muted);margin-top:2px"
              >
                default: <code>{(KNOWN_FLAGS as any)[k] || "(empty)"}</code>
              </div>
            </div>
          );
        })}
        <button type="submit" class="btn btn-primary">
          Save
        </button>
      </form>
    </Layout>
  );
});

admin.post("/admin/flags", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const body = await c.req.parseBody();
  const keys = Object.keys(KNOWN_FLAGS) as Array<keyof typeof KNOWN_FLAGS>;
  for (const k of keys) {
    const v = String(body[k] ?? "");
    await setFlag(k, v, user.id);
  }
  await audit({ userId: user.id, action: "admin.flags.save" });
  return c.redirect("/admin/flags");
});

// ----- Email digests (Block I7) -----

admin.get("/admin/digests", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const [optedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.notifyEmailDigestWeekly, true));
  const opted = Number(optedRow?.n || 0);

  const recentlySent = await db
    .select({
      id: users.id,
      username: users.username,
      lastDigestSentAt: users.lastDigestSentAt,
    })
    .from(users)
    .where(sql`${users.lastDigestSentAt} is not null`)
    .orderBy(desc(users.lastDigestSentAt))
    .limit(20);

  const result = c.req.query("result");
  const error = c.req.query("error");

  return c.html(
    <Layout title="Admin — Digests" user={user}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2>Email digests</h2>
        <a href="/admin" class="btn btn-sm">
          Back
        </a>
      </div>

      {result && (
        <div class="auth-success">{decodeURIComponent(result)}</div>
      )}
      {error && (
        <div class="auth-error">{decodeURIComponent(error)}</div>
      )}

      <div class="panel" style="padding:16px;margin-bottom:20px">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">
          {opted} user{opted === 1 ? "" : "s"} opted into the weekly digest.
        </div>
        <form method="post" action="/admin/digests/run" style="margin-bottom:8px">
          <button
            type="submit"
            class="btn btn-primary"
            onclick="return confirm('Send weekly digest to all opted-in users now?')"
          >
            Send digests now
          </button>
        </form>
        <form method="post" action="/admin/digests/preview" style="display:flex;gap:6px;align-items:center">
          <input
            type="text"
            name="username"
            placeholder="username"
            required
            style="width:240px"
          />
          <button type="submit" class="btn btn-sm">
            Send to one user
          </button>
        </form>
      </div>

      <h3>Recently sent</h3>
      <div class="panel">
        {recentlySent.length === 0 ? (
          <div class="panel-empty">No digests have been sent yet.</div>
        ) : (
          recentlySent.map((u) => (
            <div class="panel-item" style="justify-content:space-between">
              <a href={`/${u.username}`}>{u.username}</a>
              <span style="font-size:12px;color:var(--text-muted)">
                {u.lastDigestSentAt
                  ? new Date(
                      u.lastDigestSentAt as unknown as string
                    ).toLocaleString()
                  : ""}
              </span>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
});

admin.post("/admin/digests/run", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const results = await sendDigestsToAll();
  const sent = results.filter((r) => r.ok).length;
  const skipped = results.length - sent;
  await audit({
    userId: user.id,
    action: "admin.digests.run",
    metadata: { sent, skipped, total: results.length },
  });
  return c.redirect(
    `/admin/digests?result=${encodeURIComponent(
      `Processed ${results.length} opted-in users: ${sent} sent, ${skipped} skipped.`
    )}`
  );
});

admin.post("/admin/digests/preview", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const body = await c.req.parseBody();
  const username = String(body.username || "").trim();
  if (!username) {
    return c.redirect("/admin/digests?error=Username+required");
  }
  const [target] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!target) {
    return c.redirect("/admin/digests?error=User+not+found");
  }
  const result = await sendDigestForUser(target.id);
  await audit({
    userId: user.id,
    action: "admin.digests.preview",
    targetType: "user",
    targetId: target.id,
    metadata: {
      ok: result.ok,
      skipped: "skipped" in result ? result.skipped : null,
    },
  });
  if (result.ok) {
    return c.redirect(
      `/admin/digests?result=${encodeURIComponent(
        `Digest sent to ${target.username}.`
      )}`
    );
  }
  return c.redirect(
    `/admin/digests?error=${encodeURIComponent(
      `Not sent: ${"skipped" in result ? result.skipped : "unknown reason"}`
    )}`
  );
});

admin.get("/admin/autopilot", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  const tick = getLastTick();
  const total = getTickCount();
  const disabled = process.env.AUTOPILOT_DISABLED === "1";
  const intervalRaw = process.env.AUTOPILOT_INTERVAL_MS;
  const intervalMs =
    intervalRaw && Number.isFinite(Number(intervalRaw)) && Number(intervalRaw) > 0
      ? Number(intervalRaw)
      : 5 * 60 * 1000;
  const msg = c.req.query("result") || c.req.query("error");
  const isErr = !!c.req.query("error");
  return c.html(
    <Layout title="Autopilot — admin" user={user}>
      <div style="max-width: 960px; margin: 0 auto; padding: 24px 16px">
        <h1 style="margin-bottom: 8px">Autopilot</h1>
        <p style="color: var(--text-muted); margin-bottom: 24px">
          Periodic platform-maintenance loop — mirror sync, merge-queue
          progress, weekly digests, advisory rescans.
        </p>
        {msg && (
          <div
            class={isErr ? "auth-error" : "banner"}
            style="margin-bottom: 16px"
          >
            {decodeURIComponent(msg)}
          </div>
        )}
        <div
          style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px"
        >
          <div class="stat-card">
            <div class="stat-label">Status</div>
            <div class="stat-value">
              {disabled ? "disabled" : "running"}
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Interval</div>
            <div class="stat-value">{Math.round(intervalMs / 1000)}s</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Ticks this process</div>
            <div class="stat-value">{total}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Last tick</div>
            <div class="stat-value" style="font-size: 14px">
              {tick ? tick.finishedAt : "never"}
            </div>
          </div>
        </div>
        <form
          method="post"
          action="/admin/autopilot/run"
          style="margin-bottom: 24px"
        >
          <button class="btn btn-primary" type="submit">
            Run tick now
          </button>
          <span style="color: var(--text-muted); margin-left: 12px; font-size: 13px">
            Executes all sub-tasks synchronously and records the result.
          </span>
        </form>
        <h2 style="margin-bottom: 12px">Last tick tasks</h2>
        {tick ? (
          <table class="table" style="width: 100%">
            <thead>
              <tr>
                <th style="text-align: left">Task</th>
                <th style="text-align: left">Status</th>
                <th style="text-align: right">Duration</th>
                <th style="text-align: left">Error</th>
              </tr>
            </thead>
            <tbody>
              {tick.tasks.map((t) => (
                <tr>
                  <td>
                    <code>{t.name}</code>
                  </td>
                  <td
                    style={
                      t.ok
                        ? "color: var(--green)"
                        : "color: var(--red)"
                    }
                  >
                    {t.ok ? "ok" : "failed"}
                  </td>
                  <td style="text-align: right">{t.durationMs}ms</td>
                  <td style="color: var(--text-muted); font-size: 13px">
                    {t.error || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style="color: var(--text-muted)">
            No ticks have run yet. The first tick fires after the interval
            elapses. Click "Run tick now" to fire one immediately.
          </p>
        )}
        <p style="margin-top: 32px; color: var(--text-muted); font-size: 13px">
          Opt out with env <code>AUTOPILOT_DISABLED=1</code>. Adjust cadence
          with <code>AUTOPILOT_INTERVAL_MS</code> (milliseconds).
        </p>
      </div>
    </Layout>
  );
});

admin.post("/admin/demo/reseed", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  try {
    const result = await ensureDemoContent({ force: true });
    const summary = `Demo reseed: user=${result.created.user ? "created" : "existed"}, repos=${result.created.repos.length}, issues=${result.created.issues}, prs=${result.created.prs}${result.errors.length ? `, errors=${result.errors.length}` : ""}`;
    await audit({
      userId: user.id,
      action: "admin.demo.reseed",
      targetType: "user",
      targetId: result.demoUser?.id ?? "demo",
      metadata: {
        createdUser: result.created.user,
        createdRepos: result.created.repos,
        createdIssues: result.created.issues,
        createdPrs: result.created.prs,
        errors: result.errors.slice(0, 5),
      },
    });
    return c.redirect(`/admin?result=${encodeURIComponent(summary)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.redirect(
      `/admin?error=${encodeURIComponent("Demo reseed failed: " + message)}`
    );
  }
});

// Public jump-to-demo — redirects to the first demo repo if present,
// otherwise to /explore. Useful as a landing-page-linkable "try it" URL.
admin.get("/demo", (c) => {
  return c.redirect(`/${DEMO_USERNAME}/hello-python`);
});

admin.post("/admin/autopilot/run", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;
  let summary = "";
  try {
    const result = await runAutopilotTick();
    const ok = result.tasks.filter((t) => t.ok).length;
    summary = `Tick complete: ${ok}/${result.tasks.length} tasks ok.`;
    await audit({
      userId: user.id,
      action: "admin.autopilot.run",
      targetType: "system",
      targetId: "autopilot",
      metadata: { ok, total: result.tasks.length },
    });
    return c.redirect(
      `/admin/autopilot?result=${encodeURIComponent(summary)}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.redirect(
      `/admin/autopilot?error=${encodeURIComponent("Tick failed: " + message)}`
    );
  }
});

// Keep requireAuth import used even if some routes don't reference it here.
void requireAuth;

export default admin;
