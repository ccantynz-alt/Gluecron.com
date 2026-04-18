/**
 * Block I9 — Repository mirroring.
 *
 *   GET  /:owner/:repo/settings/mirror             — config form + recent runs
 *   POST /:owner/:repo/settings/mirror             — save upstream URL + interval
 *   POST /:owner/:repo/settings/mirror/delete      — remove mirror config
 *   POST /:owner/:repo/settings/mirror/sync        — run one sync now (owner-only)
 *   POST /admin/mirrors/sync-all                   — site admin, run all due mirrors
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { audit } from "../lib/notify";
import {
  deleteMirror,
  getMirrorForRepo,
  listRecentRuns,
  runMirrorSync,
  safeUrlForLog,
  syncAllDue,
  upsertMirror,
  validateUpstreamUrl,
} from "../lib/mirrors";

const mirrors = new Hono<AuthEnv>();
mirrors.use("*", softAuth);

async function ownerGate(c: any): Promise<
  | Response
  | {
      user: any;
      ownerName: string;
      repoName: string;
      repo: typeof repositories.$inferSelect;
    }
> {
  const user = c.get("user");
  if (!user) return c.redirect("/login");
  const { owner: ownerName, repo: repoName } = c.req.param();
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner || owner.id !== user.id) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="empty-state">
          <h2>403</h2>
          <p>Only the repository owner can configure mirroring.</p>
        </div>
      </Layout>,
      403
    );
  }
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) return c.notFound();
  return { user, ownerName, repoName, repo };
}

// ---------- Config page ----------

mirrors.get("/:owner/:repo/settings/mirror", requireAuth, async (c) => {
  const g = await ownerGate(c);
  if (g instanceof Response) return g;
  const { user, ownerName, repoName, repo } = g;

  const mirror = await getMirrorForRepo(repo.id);
  const runs = mirror ? await listRecentRuns(mirror.id, 20) : [];

  const success = c.req.query("success");
  const error = c.req.query("error");

  return c.html(
    <Layout title={`Mirror — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div class="settings-container" style="max-width:720px">
        <h2>Mirror settings</h2>
        <p style="color:var(--text-muted)">
          Keep this repository in sync with an upstream URL by periodically
          running <code>git fetch --prune</code>. Only <code>https://</code>,{" "}
          <code>http://</code>, and <code>git://</code> URLs are accepted —
          SSH and local paths are not supported.
        </p>

        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}
        {error && (
          <div class="auth-error">{decodeURIComponent(error)}</div>
        )}

        <form
          method="post"
          action={`/${ownerName}/${repoName}/settings/mirror`}
          class="panel"
          style="padding:16px;margin:16px 0"
        >
          <div class="form-group">
            <label for="upstream_url">Upstream URL</label>
            <input
              type="text"
              id="upstream_url"
              name="upstream_url"
              value={mirror?.upstreamUrl || ""}
              placeholder="https://github.com/torvalds/linux.git"
              required
              style="font-family:var(--font-mono)"
            />
          </div>
          <div class="form-group">
            <label for="interval_minutes">Sync interval (minutes)</label>
            <input
              type="number"
              id="interval_minutes"
              name="interval_minutes"
              value={mirror?.intervalMinutes ?? 1440}
              min="5"
              max="43200"
              style="width:160px"
            />
          </div>
          <label
            style="display:flex;gap:8px;align-items:center;margin-bottom:12px"
          >
            <input
              type="checkbox"
              name="is_enabled"
              value="1"
              checked={mirror ? mirror.isEnabled : true}
            />
            <span>Enabled</span>
          </label>
          <button type="submit" class="btn btn-primary">
            {mirror ? "Update mirror" : "Enable mirror"}
          </button>
        </form>

        {mirror && (
          <>
            <div style="display:flex;gap:8px;margin:12px 0">
              <form
                method="post"
                action={`/${ownerName}/${repoName}/settings/mirror/sync`}
              >
                <button type="submit" class="btn">
                  Sync now
                </button>
              </form>
              <form
                method="post"
                action={`/${ownerName}/${repoName}/settings/mirror/delete`}
                onsubmit="return confirm('Remove mirror configuration?')"
              >
                <button type="submit" class="btn btn-danger">
                  Remove mirror
                </button>
              </form>
            </div>

            <h3 style="margin-top:20px">Last run</h3>
            <div class="panel" style="padding:12px">
              {mirror.lastSyncedAt ? (
                <div>
                  <div
                    style="font-size:12px;color:var(--text-muted);text-transform:uppercase"
                  >
                    {mirror.lastStatus === "ok" ? "Success" : "Error"} —{" "}
                    {new Date(
                      mirror.lastSyncedAt as unknown as string
                    ).toLocaleString()}
                  </div>
                  {mirror.lastError && (
                    <pre
                      style="margin-top:8px;padding:8px;background:var(--bg-subtle);border-radius:4px;font-size:12px;overflow-x:auto;color:var(--red)"
                    >
                      {mirror.lastError}
                    </pre>
                  )}
                </div>
              ) : (
                <div style="color:var(--text-muted)">Never synced.</div>
              )}
            </div>

            <h3 style="margin-top:20px">Recent runs</h3>
            <div class="panel">
              {runs.length === 0 ? (
                <div class="panel-empty">No runs yet.</div>
              ) : (
                runs.map((r) => (
                  <div
                    class="panel-item"
                    style="justify-content:space-between;flex-wrap:wrap;gap:6px"
                  >
                    <div>
                      <span
                        style={`font-size:11px;text-transform:uppercase;margin-right:8px;color:${
                          r.status === "ok"
                            ? "var(--green)"
                            : r.status === "error"
                            ? "var(--red)"
                            : "var(--text-muted)"
                        }`}
                      >
                        {r.status}
                      </span>
                      <span
                        style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono)"
                      >
                        {new Date(
                          r.startedAt as unknown as string
                        ).toLocaleString()}
                      </span>
                    </div>
                    {r.message && (
                      <span
                        style="font-size:12px;color:var(--text-muted);max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                        title={r.message}
                      >
                        {r.message.split("\n")[0]}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
            <p
              style="font-size:12px;color:var(--text-muted);margin-top:12px"
            >
              Upstream (logged, credentials redacted):{" "}
              <code>{safeUrlForLog(mirror.upstreamUrl)}</code>
            </p>
          </>
        )}
      </div>
    </Layout>
  );
});

// ---------- Save config ----------

mirrors.post("/:owner/:repo/settings/mirror", requireAuth, async (c) => {
  const g = await ownerGate(c);
  if (g instanceof Response) return g;
  const { user, ownerName, repoName, repo } = g;
  const body = await c.req.parseBody();
  const upstreamUrl = String(body.upstream_url || "").trim();
  const intervalRaw = Number(body.interval_minutes || 1440);
  const interval = Math.max(5, Math.min(43200, Math.floor(intervalRaw || 1440)));
  const isEnabled = String(body.is_enabled || "") === "1";

  const v = validateUpstreamUrl(upstreamUrl);
  if (!v.ok) {
    return c.redirect(
      `/${ownerName}/${repoName}/settings/mirror?error=${encodeURIComponent(
        v.error || "Invalid URL"
      )}`
    );
  }

  const result = await upsertMirror({
    repositoryId: repo.id,
    upstreamUrl,
    intervalMinutes: interval,
    isEnabled,
  });
  if (!result.ok) {
    return c.redirect(
      `/${ownerName}/${repoName}/settings/mirror?error=${encodeURIComponent(
        result.error
      )}`
    );
  }

  await audit({
    userId: user.id,
    repositoryId: repo.id,
    action: "mirror.configure",
    metadata: {
      upstream: safeUrlForLog(upstreamUrl),
      intervalMinutes: interval,
      isEnabled,
    },
  });

  return c.redirect(
    `/${ownerName}/${repoName}/settings/mirror?success=${encodeURIComponent(
      "Mirror configuration saved."
    )}`
  );
});

// ---------- Delete ----------

mirrors.post("/:owner/:repo/settings/mirror/delete", requireAuth, async (c) => {
  const g = await ownerGate(c);
  if (g instanceof Response) return g;
  const { user, ownerName, repoName, repo } = g;

  await deleteMirror(repo.id);
  await audit({
    userId: user.id,
    repositoryId: repo.id,
    action: "mirror.delete",
  });

  return c.redirect(
    `/${ownerName}/${repoName}/settings/mirror?success=${encodeURIComponent(
      "Mirror removed."
    )}`
  );
});

// ---------- Sync now ----------

mirrors.post("/:owner/:repo/settings/mirror/sync", requireAuth, async (c) => {
  const g = await ownerGate(c);
  if (g instanceof Response) return g;
  const { user, ownerName, repoName, repo } = g;
  const mirror = await getMirrorForRepo(repo.id);
  if (!mirror) {
    return c.redirect(
      `/${ownerName}/${repoName}/settings/mirror?error=${encodeURIComponent(
        "No mirror configured"
      )}`
    );
  }

  const result = await runMirrorSync(mirror.id);
  await audit({
    userId: user.id,
    repositoryId: repo.id,
    action: "mirror.sync",
    metadata: { ok: result.ok, exitCode: result.exitCode },
  });
  const msg = result.ok
    ? "Mirror sync completed."
    : `Sync failed: ${result.message.split("\n")[0]}`;
  return c.redirect(
    `/${ownerName}/${repoName}/settings/mirror?${
      result.ok ? "success" : "error"
    }=${encodeURIComponent(msg)}`
  );
});

// ---------- Admin: sync all due ----------

mirrors.post("/admin/mirrors/sync-all", requireAuth, async (c) => {
  const user = c.get("user")!;
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="empty-state">
          <h2>403</h2>
          <p>Site admin only.</p>
        </div>
      </Layout>,
      403
    );
  }
  const summary = await syncAllDue();
  await audit({
    userId: user.id,
    action: "admin.mirrors.sync-all",
    metadata: summary,
  });
  return c.redirect(
    `/admin?message=${encodeURIComponent(
      `Mirror sync: ${summary.total} due, ${summary.ok} ok, ${summary.failed} failed.`
    )}`
  );
});

export default mirrors;
