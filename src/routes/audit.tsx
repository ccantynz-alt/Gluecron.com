/**
 * Audit log UI — personal audit (who has done what with *my* account) and
 * per-repo audit (who has done what in *my* repo). Reads the `audit_log`
 * table written by `src/lib/notify.ts#audit()`.
 */

import { Hono } from "hono";
import { desc, eq, and } from "drizzle-orm";
import { db } from "../db";
import { auditLog, repositories, users } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";

const audit = new Hono<AuthEnv>();

audit.use("/settings/audit", requireAuth);
audit.use("/:owner/:repo/settings/audit", requireAuth);

const LIMIT = 200;

type AuditRow = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: string | null;
  createdAt: Date;
  actor: string | null;
};

function renderMetadata(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

function timeAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
}

function AuditTable({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) {
    return (
      <div class="empty-state">
        <h2>No audit events yet</h2>
        <p>Sensitive actions will appear here as they happen.</p>
      </div>
    );
  }
  return (
    <div class="audit-log">
      <table class="audit-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
            <th>IP</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td class="audit-when" title={r.createdAt.toISOString()}>
                {timeAgo(new Date(r.createdAt))}
              </td>
              <td>{r.actor || <span class="audit-muted">system</span>}</td>
              <td>
                <code class="audit-action">{r.action}</code>
              </td>
              <td class="audit-target">
                {r.targetType ? (
                  <span>
                    {r.targetType}
                    {r.targetId ? <code> {r.targetId.slice(0, 8)}</code> : null}
                  </span>
                ) : (
                  <span class="audit-muted">—</span>
                )}
              </td>
              <td>
                <code class="audit-ip">{r.ip || "—"}</code>
              </td>
              <td class="audit-meta">
                {r.metadata ? (
                  <code title={r.metadata}>{renderMetadata(r.metadata).slice(0, 80)}</code>
                ) : (
                  <span class="audit-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Personal audit — events where userId = current user.
audit.get("/settings/audit", async (c) => {
  const user = c.get("user")!;
  let rows: AuditRow[] = [];
  try {
    const raw = await db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        ip: auditLog.ip,
        userAgent: auditLog.userAgent,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
        actor: users.username,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(eq(auditLog.userId, user.id))
      .orderBy(desc(auditLog.createdAt))
      .limit(LIMIT);
    rows = raw as AuditRow[];
  } catch (err) {
    console.error("[audit] personal:", err);
  }

  return c.html(
    <Layout title="Audit log" user={user}>
      <div class="settings-container" style="max-width: 1000px">
        <h2>Audit log</h2>
        <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 16px">
          The most recent {LIMIT} sensitive actions tied to your account — logins,
          token activity, merges, deploys, branch protection changes.
        </p>
        <AuditTable rows={rows} />
      </div>
    </Layout>
  );
});

// Per-repo audit — events with repositoryId = this repo. Owner-only.
audit.get("/:owner/:repo/settings/audit", async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();

  let repoRow: { id: string; ownerId: string; name: string } | null = null;
  try {
    const [r] = await db
      .select({ id: repositories.id, ownerId: repositories.ownerId, name: repositories.name })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    repoRow = (r as any) || null;
  } catch (err) {
    console.error("[audit] repo lookup:", err);
  }
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.html(
      <Layout title="Audit log" user={user}>
        <div class="empty-state">
          <h2>Forbidden</h2>
          <p>Only the repository owner can view the audit log.</p>
        </div>
      </Layout>,
      403
    );
  }

  let rows: AuditRow[] = [];
  try {
    const raw = await db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        ip: auditLog.ip,
        userAgent: auditLog.userAgent,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
        actor: users.username,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(eq(auditLog.repositoryId, repoRow.id))
      .orderBy(desc(auditLog.createdAt))
      .limit(LIMIT);
    rows = raw as AuditRow[];
  } catch (err) {
    console.error("[audit] repo:", err);
  }

  return c.html(
    <Layout title={`${owner}/${repo} — audit`} user={user}>
      <div class="settings-container" style="max-width: 1000px">
        <div class="breadcrumb">
          <a href={`/${owner}/${repo}`}>
            {owner}/{repo}
          </a>
          <span>/</span>
          <a href={`/${owner}/${repo}/settings`}>settings</a>
          <span>/</span>
          <span>audit</span>
        </div>
        <h2>Audit log</h2>
        <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 16px">
          Who did what in <code>{owner}/{repo}</code> — most recent {LIMIT} events.
        </p>
        <AuditTable rows={rows} />
      </div>
    </Layout>
  );
});

export default audit;
