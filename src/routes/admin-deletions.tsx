/**
 * GET  /admin/deletions      — list users pending purge + completed purges
 * POST /admin/deletions/:id/purge-now — force-run deletion cascade immediately
 *
 * Gated by isSiteAdmin (same pattern as all other admin sub-pages).
 */

import { Hono } from "hono";
import { eq, isNotNull, lt } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { purgeScheduledAccounts } from "../lib/account-deletion";
import { audit } from "../lib/notify";

const adminDeletions = new Hono<AuthEnv>();
adminDeletions.use("*", softAuth);

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/deletions");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div style="max-width:540px;margin:80px auto;padding:32px;text-align:center;background:var(--bg-elevated);border:1px solid var(--border);border-radius:16px;">
          <h2 style="font-family:var(--font-display);font-size:22px;margin:0 0 8px;color:var(--text-strong);">403 — Not a site admin</h2>
          <p style="color:var(--text-muted);margin:0;font-size:14px;">You don't have permission to view this page.</p>
        </div>
      </Layout>,
      403
    );
  }
  return { user };
}

const styles = `
  .adm-del-wrap { max-width: 1400px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .adm-del-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .adm-del-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f87171 30%, #fb923c 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .adm-del-hero-inner { position: relative; z-index: 1; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .adm-del-eyebrow { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #fb923c; margin-bottom: 6px; }
  .adm-del-title { font-family: var(--font-display); font-size: clamp(24px,3.5vw,36px); font-weight: 800; letter-spacing: -0.025em; margin: 0 0 4px; color: var(--text-strong); }
  .adm-del-sub { font-size: 14px; color: var(--text-muted); margin: 0; line-height: 1.5; }
  .adm-del-back { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; font-size: 12.5px; color: var(--text-muted); background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 8px; text-decoration: none; font-weight: 500; transition: border-color 120ms,color 120ms,background 120ms; }
  .adm-del-back:hover { border-color: var(--border-strong); color: var(--text-strong); background: rgba(255,255,255,0.04); }

  .adm-del-section { margin-bottom: var(--space-6); }
  .adm-del-section-title { font-family: var(--font-display); font-size: 16px; font-weight: 700; letter-spacing: -0.012em; color: var(--text-strong); margin: 0 0 var(--space-3); display: flex; align-items: center; gap: 10px; }
  .adm-del-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 700; }
  .adm-del-badge-warn { background: rgba(251,146,60,0.15); color: #fdba74; box-shadow: inset 0 0 0 1px rgba(251,146,60,0.35); }
  .adm-del-badge-ok { background: rgba(52,211,153,0.12); color: #6ee7b7; box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30); }

  .adm-del-table { width: 100%; border-collapse: collapse; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
  .adm-del-table thead th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); padding: 10px 14px; background: rgba(255,255,255,0.015); border-bottom: 1px solid var(--border); }
  .adm-del-table tbody td { padding: 10px 14px; border-bottom: 1px solid var(--border-subtle); font-size: 13px; color: var(--text); vertical-align: middle; }
  .adm-del-table tbody tr:last-child td { border-bottom: none; }
  .adm-del-table tbody tr:hover td { background: rgba(255,255,255,0.018); }
  .adm-del-table code { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-strong); }

  .adm-del-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 7px; font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: inherit; line-height: 1; transition: background 120ms, border-color 120ms, color 120ms; border: 1px solid rgba(248,113,113,0.45); background: rgba(248,113,113,0.08); color: #fca5a5; }
  .adm-del-btn:hover { background: rgba(248,113,113,0.18); border-color: rgba(248,113,113,0.70); color: #fecaca; }

  .adm-del-empty { padding: var(--space-6); text-align: center; color: var(--text-muted); font-size: 13.5px; background: var(--bg-elevated); border: 1px dashed var(--border); border-radius: 14px; }

  .adm-del-banner { margin-bottom: var(--space-4); padding: 10px 14px; border-radius: 10px; font-size: 13.5px; border: 1px solid var(--border); background: rgba(255,255,255,0.025); color: var(--text); }
  .adm-del-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .adm-del-banner.is-err { border-color: rgba(248,113,113,0.40); background: rgba(248,113,113,0.08); color: #fecaca; }

  @media (max-width: 720px) {
    .adm-del-wrap { padding: var(--space-4) var(--space-3); }
    .adm-del-hero { padding: var(--space-4); }
    .adm-del-table { display: block; overflow-x: auto; }
  }
`;

adminDeletions.get("/admin/deletions", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const now = new Date();

  // Users pending purge: deletion_scheduled_for is set and in the past (overdue)
  const pendingRows = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      deletedAt: users.deletedAt,
      deletionScheduledFor: users.deletionScheduledFor,
    })
    .from(users)
    .where(lt(users.deletionScheduledFor, now))
    .orderBy(users.deletionScheduledFor)
    .limit(200);

  // Users in grace period (deletion_scheduled_for is set but not yet overdue).
  // We fetch all with a non-null scheduled_for and filter in JS.
  const scheduledRows = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      deletedAt: users.deletedAt,
      deletionScheduledFor: users.deletionScheduledFor,
    })
    .from(users)
    .where(isNotNull(users.deletionScheduledFor))
    .orderBy(users.deletionScheduledFor)
    .limit(400);

  // Filter: grace period = scheduled but not yet overdue
  const graceRows = scheduledRows.filter(
    (r) => r.deletionScheduledFor && r.deletionScheduledFor > now
  );

  const msg = c.req.query("msg") || "";
  const errMsg = c.req.query("err") || "";

  const fmt = (d: Date | null | undefined) =>
    d ? new Date(d).toLocaleString() : "—";

  return c.html(
    <Layout title="Admin — Account Deletions" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="adm-del-wrap">
        <div class="adm-del-hero">
          <div class="adm-del-hero-inner">
            <div>
              <div class="adm-del-eyebrow">Admin / GDPR</div>
              <h1 class="adm-del-title">Account Deletions</h1>
              <p class="adm-del-sub">
                Users scheduled for deletion, their grace-period status, and completed purges.
              </p>
            </div>
            <a href="/admin" class="adm-del-back">← Admin</a>
          </div>
        </div>

        {msg && <div class="adm-del-banner is-ok">{msg}</div>}
        {errMsg && <div class="adm-del-banner is-err">{errMsg}</div>}

        {/* Overdue — pending execution */}
        <div class="adm-del-section">
          <div class="adm-del-section-title">
            Overdue (pending execution)
            <span class="adm-del-badge adm-del-badge-warn">{pendingRows.length}</span>
          </div>
          {pendingRows.length === 0 ? (
            <div class="adm-del-empty">No overdue deletions. Autopilot is keeping up.</div>
          ) : (
            <table class="adm-del-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Deleted at</th>
                  <th>Scheduled for</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingRows.map((r) => (
                  <tr>
                    <td><code>{r.username}</code></td>
                    <td>{r.email}</td>
                    <td>{fmt(r.deletedAt)}</td>
                    <td style="color:#fb923c">{fmt(r.deletionScheduledFor)}</td>
                    <td>
                      <form method="post" action={`/admin/deletions/${r.id}/purge-now`}>
                        <button type="submit" class="adm-del-btn"
                          onclick="return confirm('Hard-delete this user immediately? This cannot be undone.')">
                          Purge now
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Grace period */}
        <div class="adm-del-section">
          <div class="adm-del-section-title">
            In grace period
            <span class="adm-del-badge adm-del-badge-ok">{graceRows.length}</span>
          </div>
          {graceRows.length === 0 ? (
            <div class="adm-del-empty">No accounts in the grace period.</div>
          ) : (
            <table class="adm-del-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Deletion initiated</th>
                  <th>Purge scheduled for</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {graceRows.map((r) => (
                  <tr>
                    <td><code>{r.username}</code></td>
                    <td>{r.email}</td>
                    <td>{fmt(r.deletedAt)}</td>
                    <td>{fmt(r.deletionScheduledFor)}</td>
                    <td>
                      <form method="post" action={`/admin/deletions/${r.id}/purge-now`}>
                        <button type="submit" class="adm-del-btn"
                          onclick="return confirm('Hard-delete this user now, skipping the grace period? This cannot be undone.')">
                          Purge now
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  );
});

// Force-run deletion cascade immediately for a specific user.
adminDeletions.post("/admin/deletions/:id/purge-now", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user: adminUser } = g;

  const targetId = c.req.param("id");

  // Fetch the target user to confirm they're scheduled for deletion.
  const targetRows = await db
    .select({ id: users.id, username: users.username, deletionScheduledFor: users.deletionScheduledFor, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);

  const target = targetRows[0] ?? null;
  if (target && !target.deletedAt) {
    return c.redirect("/admin/deletions?err=" + encodeURIComponent("User is not scheduled for deletion."));
  }
  if (!target) {
    return c.redirect("/admin/deletions?err=" + encodeURIComponent("User not found or not scheduled for deletion."));
  }

  // Force-run purge by setting deletion_scheduled_for to epoch so lt(now) picks it up.
  try {
    await db
      .update(users)
      .set({ deletionScheduledFor: new Date(0) })
      .where(eq(users.id, targetId));
  } catch (err) {
    console.error("[admin-deletions] force-schedule update failed:", err);
  }

  // Use the import from account-deletion which already handles all cascade steps.
  const result = await purgeScheduledAccounts({ cap: 1 });

  await audit({
    userId: adminUser.id,
    action: "account.admin_purge",
    targetType: "user",
    targetId,
    metadata: { username: target.username, triggeredBy: adminUser.id },
  });

  if (result.purged > 0) {
    return c.redirect("/admin/deletions?msg=" + encodeURIComponent(`User "${target.username}" has been permanently purged.`));
  } else {
    return c.redirect("/admin/deletions?err=" + encodeURIComponent(`Purge encountered errors. Check server logs.`));
  }
});

export default adminDeletions;
