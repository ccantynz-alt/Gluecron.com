/**
 * Block ST — Admin server targets UI + mutation endpoints.
 *
 *   GET  /admin/servers                       — list targets
 *   GET  /admin/servers/new                   — new-target form
 *   POST /admin/servers                       — create
 *   GET  /admin/servers/:id                   — detail (env vars + recent deploys)
 *   POST /admin/servers/:id/env               — upsert an env var
 *   POST /admin/servers/:id/env/:name/delete  — delete an env var
 *   POST /admin/servers/:id/test              — test connection (pin fingerprint)
 *   POST /admin/servers/:id/deploy            — manual deploy
 *   POST /admin/servers/:id/delete            — delete target
 *
 * v1 is site-admin only. Customer scoping arrives in a follow-up block.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import {
  createTarget,
  deleteEnv,
  deleteTarget,
  finishDeployRow,
  getTarget,
  listEnv,
  listTargets,
  recentDeploys,
  recordPin,
  resolveEnv,
  startDeployRow,
  upsertEnv,
} from "../lib/server-target-store";
import { deployToTarget, testConnection } from "../lib/server-targets";

const admin = new Hono<AuthEnv>();
admin.use("*", softAuth);

async function gate(c: any): Promise<{ userId: string } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/servers");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <main style="max-width:640px;margin:40px auto;padding:0 20px">
          <h1>403 — site admin required</h1>
          <p>The server-targets section is admin-only in v1.</p>
        </main>
      </Layout>,
      403
    );
  }
  return { userId: user.id };
}

function flash(msg: string | undefined, kind: "ok" | "err"): any {
  if (!msg) return null;
  const bg = kind === "ok" ? "#0f2a18" : "#2a1212";
  const border = kind === "ok" ? "#1f5a32" : "#5a1f1f";
  const fg = kind === "ok" ? "#7fe1a3" : "#ffb4b4";
  return (
    <div
      style={`background:${bg};border:1px solid ${border};color:${fg};padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:14px`}
    >
      {msg}
    </div>
  );
}

const wrap =
  "max-width:980px;margin:32px auto;padding:0 20px;color:#e5e7eb;font-family:system-ui,sans-serif";
const card =
  "background:#0e1117;border:1px solid #1f2937;border-radius:10px;padding:18px 20px;margin-bottom:18px";
const inputStyle =
  "width:100%;background:#0b0e13;border:1px solid #1f2937;color:#e5e7eb;padding:8px 10px;border-radius:6px;font-family:ui-monospace,monospace";
const btn =
  "background:#1f6feb;border:0;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:14px";
const btnDanger =
  "background:#a02020;border:0;color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px";
const btnSecondary =
  "background:#1f2937;border:0;color:#e5e7eb;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px";
const label = "display:block;font-size:13px;color:#9ca3af;margin:10px 0 4px";

// ─── GET /admin/servers ─────────────────────────────────────────────────────

admin.get("/admin/servers", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const user = c.get("user")!;
  const targets = await listTargets();
  const ok = c.req.query("ok") ?? undefined;
  const err = c.req.query("err") ?? undefined;

  return c.html(
    <Layout title="Server targets — admin" user={user}>
      <main style={wrap}>
        <h1 style="margin:0 0 6px;font-size:24px">Server targets</h1>
        <p style="margin:0 0 20px;color:#9ca3af;font-size:14px">
          Boxes Gluecron can SSH into. Admin-only. A push to a watched
          branch fires the target's deploy script with its env vars
          materialised on the box.
        </p>
        {flash(ok, "ok")}
        {flash(err, "err")}

        <div style="margin-bottom:16px">
          <a href="/admin/servers/new" style={btn + ";text-decoration:none"}>
            + New target
          </a>
        </div>

        <div style={card}>
          {targets.length === 0 ? (
            <p style="color:#9ca3af;margin:0">
              No targets yet. Add your first box.
            </p>
          ) : (
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <thead>
                <tr style="text-align:left;color:#9ca3af;border-bottom:1px solid #1f2937">
                  <th style="padding:8px 6px">Name</th>
                  <th style="padding:8px 6px">Host</th>
                  <th style="padding:8px 6px">Watch</th>
                  <th style="padding:8px 6px">Status</th>
                  <th style="padding:8px 6px;text-align:right">—</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => (
                  <tr style="border-bottom:1px solid #1f2937">
                    <td style="padding:10px 6px">
                      <a
                        href={`/admin/servers/${t.id}`}
                        style="color:#7aa2f7;text-decoration:none;font-weight:600"
                      >
                        {t.name}
                      </a>
                    </td>
                    <td style="padding:10px 6px;font-family:ui-monospace,monospace;color:#cbd5e1">
                      {t.sshUser}@{t.host}:{t.port}
                    </td>
                    <td style="padding:10px 6px;color:#9ca3af;font-size:13px">
                      {t.watchedRepositoryId && t.watchedBranch
                        ? `${t.watchedBranch}`
                        : "—"}
                    </td>
                    <td style="padding:10px 6px">
                      <span
                        style={
                          "padding:2px 8px;border-radius:99px;font-size:12px;" +
                          (t.status === "verified"
                            ? "background:#0f2a18;color:#7fe1a3"
                            : "background:#2a2410;color:#e1c47f")
                        }
                      >
                        {t.status}
                      </span>
                    </td>
                    <td style="padding:10px 6px;text-align:right">
                      <a href={`/admin/servers/${t.id}`} style="color:#9ca3af;font-size:13px;text-decoration:none">
                        open →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </Layout>
  );
});

// ─── GET /admin/servers/new ─────────────────────────────────────────────────

admin.get("/admin/servers/new", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const user = c.get("user")!;
  const repos = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      ownerName: users.username,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .limit(200);

  return c.html(
    <Layout title="New server target" user={user}>
      <main style={wrap}>
        <p style="margin:0 0 6px"><a href="/admin/servers" style="color:#9ca3af;text-decoration:none">← Server targets</a></p>
        <h1 style="margin:0 0 16px;font-size:22px">New server target</h1>
        <form method="post" action="/admin/servers" style={card}>
          <label style={label}>Name (unique identifier)</label>
          <input name="name" required pattern="[a-z0-9-]+" placeholder="crontech-prod-1" style={inputStyle} />

          <label style={label}>Host</label>
          <input name="host" required placeholder="1.2.3.4 or box.crontech.ai" style={inputStyle} />

          <div style="display:flex;gap:14px">
            <div style="flex:1">
              <label style={label}>SSH user</label>
              <input name="ssh_user" required placeholder="deploy" style={inputStyle} />
            </div>
            <div style="width:120px">
              <label style={label}>Port</label>
              <input name="port" type="number" value="22" style={inputStyle} />
            </div>
          </div>

          <label style={label}>Private SSH key (OpenSSH PEM)</label>
          <textarea
            name="private_key"
            required
            rows={8}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
            style={inputStyle + ";font-size:12px"}
          />
          <p style="color:#6b7280;font-size:12px;margin:6px 0 0">
            Encrypted at rest with <code>SERVER_TARGETS_KEY</code>. Never
            displayed again after save.
          </p>

          <label style={label}>Deploy path on the box</label>
          <input name="deploy_path" value="/var/www/app" style={inputStyle} />

          <label style={label}>Deploy script</label>
          <input name="deploy_script" value="bash deploy.sh" style={inputStyle} />
          <p style="color:#6b7280;font-size:12px;margin:6px 0 0">
            Runs inside the deploy path. <code>./.env.gluecron</code> is
            sourced first so all env vars are available.
          </p>

          <div style="display:flex;gap:14px;margin-top:6px">
            <div style="flex:1">
              <label style={label}>Watched repo (optional)</label>
              <select name="watched_repository_id" style={inputStyle}>
                <option value="">— none —</option>
                {repos.map((r) => (
                  <option value={r.id}>{r.ownerName}/{r.name}</option>
                ))}
              </select>
            </div>
            <div style="flex:1">
              <label style={label}>Watched branch</label>
              <input name="watched_branch" placeholder="main" style={inputStyle} />
            </div>
          </div>

          <div style="margin-top:18px">
            <button type="submit" style={btn}>Create target</button>
          </div>
        </form>
      </main>
    </Layout>
  );
});

// ─── POST /admin/servers ────────────────────────────────────────────────────

admin.post("/admin/servers", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const form = await c.req.parseBody();
  const name = String(form.name || "").trim();
  const host = String(form.host || "").trim();
  const sshUser = String(form.ssh_user || "").trim();
  const port = Number(form.port || 22);
  const privateKey = String(form.private_key || "");
  const deployPath = String(form.deploy_path || "/var/www/app").trim();
  const deployScript = String(form.deploy_script || "bash deploy.sh");
  const watchedRepositoryId = String(form.watched_repository_id || "") || null;
  const watchedBranch = String(form.watched_branch || "").trim() || null;

  if (!name || !host || !sshUser || !privateKey) {
    return c.redirect("/admin/servers?err=missing+required+fields");
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    return c.redirect("/admin/servers?err=name+must+be+lowercase+alphanumeric+with+dashes");
  }

  const out = await createTarget({
    name,
    host,
    port,
    sshUser,
    privateKey,
    deployPath,
    deployScript,
    watchedRepositoryId,
    watchedBranch,
    createdBy: g.userId,
  });
  if (!out.ok) {
    return c.redirect(`/admin/servers?err=${encodeURIComponent(out.error)}`);
  }
  return c.redirect(`/admin/servers/${out.target.id}?ok=created`);
});

// ─── GET /admin/servers/:id ─────────────────────────────────────────────────

admin.get("/admin/servers/:id", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const user = c.get("user")!;
  const id = c.req.param("id");
  const target = await getTarget(id);
  if (!target) return c.notFound();

  const envRows = await listEnv(id);
  const deploys = await recentDeploys(id, 10);
  const ok = c.req.query("ok") ?? undefined;
  const err = c.req.query("err") ?? undefined;

  return c.html(
    <Layout title={`${target.name} — server target`} user={user}>
      <main style={wrap}>
        <p style="margin:0 0 6px"><a href="/admin/servers" style="color:#9ca3af;text-decoration:none">← Server targets</a></p>
        <h1 style="margin:0 0 4px;font-size:22px">{target.name}</h1>
        <p style="margin:0 0 18px;color:#9ca3af;font-size:14px;font-family:ui-monospace,monospace">
          {target.sshUser}@{target.host}:{target.port} · {target.deployPath}
        </p>
        {flash(ok, "ok")}
        {flash(err, "err")}

        {/* Connection / status */}
        <div style={card}>
          <h2 style="margin:0 0 10px;font-size:16px">Connection</h2>
          <p style="margin:0 0 10px;font-size:14px">
            Status: <strong>{target.status}</strong>
            {target.hostFingerprint && (
              <span style="color:#9ca3af;font-family:ui-monospace,monospace;font-size:12px">
                {" "}· pinned {target.hostFingerprint}
              </span>
            )}
          </p>
          <form method="post" action={`/admin/servers/${target.id}/test`} style="display:inline-block;margin-right:8px">
            <button type="submit" style={btnSecondary}>Test connection</button>
          </form>
          <form method="post" action={`/admin/servers/${target.id}/deploy`} style="display:inline-block;margin-right:8px">
            <button type="submit" style={btn}>Deploy now</button>
          </form>
          <form method="post" action={`/admin/servers/${target.id}/delete`} style="display:inline-block;float:right" onsubmit="return confirm('Delete this target?')">
            <button type="submit" style={btnDanger}>Delete</button>
          </form>
        </div>

        {/* Env vars */}
        <div style={card}>
          <h2 style="margin:0 0 10px;font-size:16px">Environment variables</h2>
          <p style="margin:0 0 12px;color:#9ca3af;font-size:13px">
            Encrypted at rest. Materialised as <code>./.env.gluecron</code>
            on the box and sourced before the deploy script runs.
          </p>

          {envRows.length === 0 ? (
            <p style="color:#6b7280;font-size:14px;margin:0 0 12px">No env vars yet.</p>
          ) : (
            <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px">
              <tbody>
                {envRows.map((row) => (
                  <tr style="border-bottom:1px solid #1f2937">
                    <td style="padding:8px 6px;font-family:ui-monospace,monospace;color:#cbd5e1;width:35%">{row.name}</td>
                    <td style="padding:8px 6px;font-family:ui-monospace,monospace;color:#6b7280">
                      {row.isSecret ? "••••••••" : "(non-secret)"}
                    </td>
                    <td style="padding:8px 6px;color:#6b7280;font-size:12px">
                      {row.isSecret ? "secret" : "value"}
                    </td>
                    <td style="padding:8px 6px;text-align:right">
                      <form method="post" action={`/admin/servers/${target.id}/env/${encodeURIComponent(row.name)}/delete`} style="display:inline">
                        <button type="submit" style={btnDanger}>Delete</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <form method="post" action={`/admin/servers/${target.id}/env`} style="display:grid;grid-template-columns:1fr 2fr auto;gap:8px;align-items:center">
            <input name="name" placeholder="VAR_NAME" required pattern="[A-Z_][A-Z0-9_]*" style={inputStyle} />
            <input name="value" placeholder="value" required style={inputStyle} />
            <button type="submit" style={btn}>Save</button>
            <label style="grid-column:1/-1;font-size:12px;color:#9ca3af;display:flex;gap:6px;align-items:center;margin-top:2px">
              <input type="checkbox" name="is_secret" value="1" checked />
              Treat as secret (mask in UI)
            </label>
          </form>
        </div>

        {/* Recent deploys */}
        <div style={card}>
          <h2 style="margin:0 0 10px;font-size:16px">Recent deploys</h2>
          {deploys.length === 0 ? (
            <p style="color:#6b7280;font-size:14px;margin:0">No deploys yet.</p>
          ) : (
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="text-align:left;color:#9ca3af;border-bottom:1px solid #1f2937">
                  <th style="padding:6px">When</th>
                  <th style="padding:6px">Commit</th>
                  <th style="padding:6px">Source</th>
                  <th style="padding:6px">Status</th>
                </tr>
              </thead>
              <tbody>
                {deploys.map((d) => (
                  <tr style="border-bottom:1px solid #1f2937">
                    <td style="padding:6px;color:#9ca3af">{d.startedAt.toISOString()}</td>
                    <td style="padding:6px;font-family:ui-monospace,monospace">{d.commitSha?.slice(0, 7) ?? "—"}</td>
                    <td style="padding:6px;color:#9ca3af">{d.triggerSource}</td>
                    <td style={`padding:6px;color:${d.status === "success" ? "#7fe1a3" : d.status === "failed" ? "#ffb4b4" : "#e1c47f"}`}>
                      {d.status} {d.exitCode != null ? `(${d.exitCode})` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </Layout>
  );
});

// ─── POST /admin/servers/:id/env ────────────────────────────────────────────

admin.post("/admin/servers/:id/env", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const id = c.req.param("id");
  const target = await getTarget(id);
  if (!target) return c.notFound();
  const form = await c.req.parseBody();
  const name = String(form.name || "").trim();
  const value = String(form.value || "");
  const isSecret = !!form.is_secret;
  const out = await upsertEnv({
    targetId: id,
    name,
    value,
    isSecret,
    actorId: g.userId,
  });
  if (!out.ok) {
    return c.redirect(`/admin/servers/${id}?err=${encodeURIComponent(out.error)}`);
  }
  return c.redirect(`/admin/servers/${id}?ok=saved+${encodeURIComponent(name)}`);
});

admin.post("/admin/servers/:id/env/:name/delete", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const id = c.req.param("id");
  const name = c.req.param("name");
  await deleteEnv({ targetId: id, name, actorId: g.userId });
  return c.redirect(`/admin/servers/${id}?ok=deleted+${encodeURIComponent(name)}`);
});

// ─── POST /admin/servers/:id/test ───────────────────────────────────────────

admin.post("/admin/servers/:id/test", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const id = c.req.param("id");
  const target = await getTarget(id);
  if (!target) return c.notFound();
  const result = await testConnection(target);
  if (result.ok) {
    await recordPin(id, result.fingerprint, g.userId);
    return c.redirect(`/admin/servers/${id}?ok=connection+verified`);
  }
  return c.redirect(
    `/admin/servers/${id}?err=${encodeURIComponent(`${result.stage}: ${result.error}`)}`
  );
});

// ─── POST /admin/servers/:id/deploy ─────────────────────────────────────────

admin.post("/admin/servers/:id/deploy", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const id = c.req.param("id");
  const target = await getTarget(id);
  if (!target) return c.notFound();
  const env = await resolveEnv(id);
  const deployId = await startDeployRow({
    targetId: id,
    triggeredBy: g.userId,
    triggerSource: "manual",
  });
  const result = await deployToTarget(target, { env });
  if (deployId) {
    await finishDeployRow({
      id: deployId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  if (result.ok) {
    return c.redirect(`/admin/servers/${id}?ok=deploy+succeeded`);
  }
  return c.redirect(
    `/admin/servers/${id}?err=${encodeURIComponent(`deploy exit ${result.exitCode}: ${result.stderr.slice(0, 200)}`)}`
  );
});

// ─── POST /admin/servers/:id/delete ─────────────────────────────────────────

admin.post("/admin/servers/:id/delete", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const id = c.req.param("id");
  await deleteTarget(id, g.userId);
  return c.redirect("/admin/servers?ok=deleted");
});

export default admin;
