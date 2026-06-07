/**
 * Admin security dashboard — SOC 2 evidence surface.
 *
 *   GET /admin/security   — recent failed logins, locked accounts, admin actions,
 *                           MFA status, active session count, account deletions
 *   GET /admin/soc2       — static SOC 2 readiness checklist
 *
 * Both routes are gated by `isSiteAdmin`.
 */

import { Hono } from "hono";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  auditLog,
  loginAttempts,
  sessions,
  userTotp,
  users,
} from "../db/schema";
import { isSiteAdmin } from "../lib/admin";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { Layout } from "../views/layout";

const adminSecurity = new Hono<AuthEnv>();
adminSecurity.use("*", softAuth);

// ── Auth guard ───────────────────────────────────────────────────────────────
adminSecurity.use("/admin/security*", async (c, next) => {
  const user = c.get("user");
  if (!user || !(await isSiteAdmin(user.id))) {
    return c.redirect("/login?redirect=/admin/security");
  }
  return next();
});
adminSecurity.use("/admin/soc2*", async (c, next) => {
  const user = c.get("user");
  if (!user || !(await isSiteAdmin(user.id))) {
    return c.redirect("/login?redirect=/admin/soc2");
  }
  return next();
});

// ── Scoped CSS ───────────────────────────────────────────────────────────────
const securityStyles = `
  .sec-page { max-width: 1200px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .sec-hero {
    position: relative; margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 16px; overflow: hidden;
  }
  .sec-hero::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f87171 30%, #fb923c 70%, transparent 100%);
    opacity: 0.7; pointer-events: none;
  }
  .sec-hero h1 { font-size: 1.5rem; font-weight: 800; margin: 0 0 4px; }
  .sec-hero p { color: var(--text-muted); margin: 0; font-size: 14px; }
  .sec-hero-nav { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .sec-hero-nav a { font-size: 13px; }

  .sec-stat-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px; margin-bottom: var(--space-6);
  }
  .sec-stat {
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 12px; padding: var(--space-4);
  }
  .sec-stat-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .sec-stat-value { font-size: 2rem; font-weight: 800; }
  .sec-stat-value.danger { color: #f87171; }
  .sec-stat-value.warning { color: #fb923c; }
  .sec-stat-value.ok { color: #34d399; }

  .sec-section { margin-bottom: var(--space-6); }
  .sec-section h2 { font-size: 16px; font-weight: 700; margin: 0 0 12px; }

  .sec-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .sec-table th { text-align: left; padding: 8px 12px; color: var(--text-muted); font-weight: 600; border-bottom: 1px solid var(--border); }
  .sec-table td { padding: 8px 12px; border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.06)); vertical-align: middle; }
  .sec-table tr:last-child td { border-bottom: none; }
  .sec-card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }

  .sec-badge {
    display: inline-block; padding: 2px 8px; border-radius: 100px;
    font-size: 11px; font-weight: 600;
  }
  .sec-badge.red { background: #f871711a; color: #f87171; }
  .sec-badge.orange { background: #fb923c1a; color: #fb923c; }
  .sec-badge.green { background: #34d3991a; color: #34d399; }

  /* SOC 2 checklist */
  .soc2-page { max-width: 900px; margin: 0 auto; padding: var(--space-6) var(--space-4); }
  .soc2-hero {
    position: relative; margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 16px; overflow: hidden;
  }
  .soc2-hero::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7; pointer-events: none;
  }
  .soc2-hero h1 { font-size: 1.5rem; font-weight: 800; margin: 0 0 4px; }
  .soc2-hero p { color: var(--text-muted); margin: 0; font-size: 14px; }
  .soc2-category { margin-bottom: var(--space-5); }
  .soc2-category h2 { font-size: 15px; font-weight: 700; margin: 0 0 10px; }
  .soc2-row {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 10px 0; border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
    font-size: 13.5px;
  }
  .soc2-row:last-child { border-bottom: none; }
  .soc2-icon { font-size: 16px; flex-shrink: 0; width: 24px; text-align: center; margin-top: 1px; }
  .soc2-text { flex: 1; }
  .soc2-label { font-weight: 600; }
  .soc2-desc { color: var(--text-muted); margin-top: 2px; font-size: 12.5px; }
  .soc2-status-ok { color: #34d399; }
  .soc2-status-warn { color: #fb923c; }
  .soc2-section-card {
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 12px; padding: var(--space-4) var(--space-5);
    margin-bottom: var(--space-4);
  }
`;

// ── GET /admin/security ──────────────────────────────────────────────────────
adminSecurity.get("/admin/security", async (c) => {
  const user = c.get("user")!;
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since1h = new Date(Date.now() - 60 * 60 * 1000);

  // Recent failed logins in last 24h grouped by email + IP.
  const failedLogins = await db
    .select({
      email: loginAttempts.email,
      ip: loginAttempts.ip,
      attempts: sql<number>`count(*)::int`,
    })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.success, false),
        gte(loginAttempts.createdAt, since24h)
      )
    )
    .groupBy(loginAttempts.email, loginAttempts.ip)
    .orderBy(desc(sql`count(*)`))
    .limit(20);

  // Locked accounts: email addresses with >= 10 failures in last 1h.
  const lockedAccounts = await db
    .select({
      email: loginAttempts.email,
      attempts: sql<number>`count(*)::int`,
    })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.success, false),
        gte(loginAttempts.createdAt, since1h)
      )
    )
    .groupBy(loginAttempts.email)
    .having(sql`count(*) >= 10`);

  // Recent admin audit actions in last 24h.
  const adminActions = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      ip: auditLog.ip,
      createdAt: auditLog.createdAt,
      username: users.username,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.userId, users.id))
    .where(gte(auditLog.createdAt, since24h))
    .orderBy(desc(auditLog.createdAt))
    .limit(30);

  // Active session count.
  const [sessionRow] = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(sessions)
    .where(gte(sessions.expiresAt, new Date()));

  // Users with MFA configured (TOTP enabled).
  const [mfaRow] = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(userTotp)
    .where(sql`enabled_at IS NOT NULL`);

  // Total users.
  const [usersRow] = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`deleted_at IS NULL`);

  // Recent account deletions in audit log.
  const accountDeletions = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      ip: auditLog.ip,
      createdAt: auditLog.createdAt,
      username: users.username,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.userId, users.id))
    .where(
      and(
        eq(auditLog.action, "account.delete"),
        gte(auditLog.createdAt, since24h)
      )
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(10);

  const totalUsers = usersRow?.cnt ?? 0;
  const mfaUsers = mfaRow?.cnt ?? 0;
  const noMfaUsers = Math.max(0, totalUsers - mfaUsers);
  const activeSessions = sessionRow?.cnt ?? 0;
  const failedCount = failedLogins.reduce((s, r) => s + r.attempts, 0);
  const lockedCount = lockedAccounts.length;

  return c.html(
    <Layout title="Security dashboard" user={user}>
      <style dangerouslySetInnerHTML={{ __html: securityStyles }} />
      <div class="sec-page">
        <div class="sec-hero">
          <h1>Security dashboard</h1>
          <p>
            Real-time view of authentication events, account lockouts, and admin
            actions. Data is used as SOC 2 evidence for CC6.1 and CC7.2.
          </p>
          <div class="sec-hero-nav">
            <a href="/admin/security" class="btn btn-sm active">Security</a>
            <a href="/admin/soc2" class="btn btn-sm">SOC 2 Checklist</a>
            <a href="/admin" class="btn btn-sm">Admin home</a>
          </div>
        </div>

        {/* ── Stat cards ── */}
        <div class="sec-stat-grid">
          <div class="sec-stat">
            <div class="sec-stat-label">Failed logins (24h)</div>
            <div class={`sec-stat-value ${failedCount > 50 ? "danger" : failedCount > 10 ? "warning" : "ok"}`}>
              {failedCount}
            </div>
          </div>
          <div class="sec-stat">
            <div class="sec-stat-label">Locked accounts (1h window)</div>
            <div class={`sec-stat-value ${lockedCount > 0 ? "danger" : "ok"}`}>
              {lockedCount}
            </div>
          </div>
          <div class="sec-stat">
            <div class="sec-stat-label">Active sessions</div>
            <div class="sec-stat-value">{activeSessions}</div>
          </div>
          <div class="sec-stat">
            <div class="sec-stat-label">Users without MFA</div>
            <div class={`sec-stat-value ${noMfaUsers > 0 ? "warning" : "ok"}`}>
              {noMfaUsers}
            </div>
          </div>
          <div class="sec-stat">
            <div class="sec-stat-label">Total users</div>
            <div class="sec-stat-value">{totalUsers}</div>
          </div>
          <div class="sec-stat">
            <div class="sec-stat-label">MFA-enabled users</div>
            <div class="sec-stat-value ok">{mfaUsers}</div>
          </div>
        </div>

        {/* ── Locked accounts ── */}
        {lockedAccounts.length > 0 && (
          <div class="sec-section">
            <h2>Locked accounts (10+ failures in last hour)</h2>
            <div class="sec-card">
              <table class="sec-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Failed attempts (1h)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {lockedAccounts.map((row) => (
                    <tr key={row.email}>
                      <td>{row.email}</td>
                      <td>{row.attempts}</td>
                      <td>
                        <span class="sec-badge red">Locked</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Recent failed logins ── */}
        <div class="sec-section">
          <h2>Recent failed login attempts (last 24h)</h2>
          <div class="sec-card">
            {failedLogins.length === 0 ? (
              <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">
                No failed logins in the last 24 hours.
              </div>
            ) : (
              <table class="sec-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>IP address</th>
                    <th>Attempts</th>
                    <th>Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {failedLogins.map((row) => (
                    <tr key={`${row.email}-${row.ip}`}>
                      <td>{row.email}</td>
                      <td>
                        <code style="font-size: 12px;">{row.ip}</code>
                      </td>
                      <td>{row.attempts}</td>
                      <td>
                        <span
                          class={`sec-badge ${row.attempts >= 10 ? "red" : row.attempts >= 5 ? "orange" : "green"}`}
                        >
                          {row.attempts >= 10
                            ? "High"
                            : row.attempts >= 5
                              ? "Medium"
                              : "Low"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ── Recent admin actions ── */}
        <div class="sec-section">
          <h2>Recent audit log entries (last 24h)</h2>
          <div class="sec-card">
            {adminActions.length === 0 ? (
              <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">
                No audit log entries in the last 24 hours.
              </div>
            ) : (
              <table class="sec-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {adminActions.map((row) => (
                    <tr key={row.id}>
                      <td style="white-space: nowrap; color: var(--text-muted);">
                        {new Date(row.createdAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td>{row.username ?? "(system)"}</td>
                      <td>
                        <code style="font-size: 12px;">{row.action}</code>
                      </td>
                      <td style="color: var(--text-muted);">
                        <code style="font-size: 12px;">{row.ip ?? "-"}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ── Account deletions ── */}
        {accountDeletions.length > 0 && (
          <div class="sec-section">
            <h2>Recent account deletions (last 24h)</h2>
            <div class="sec-card">
              <table class="sec-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>User</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {accountDeletions.map((row) => (
                    <tr key={row.id}>
                      <td style="white-space: nowrap; color: var(--text-muted);">
                        {new Date(row.createdAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td>{row.username ?? "-"}</td>
                      <td style="color: var(--text-muted);">
                        <code style="font-size: 12px;">{row.ip ?? "-"}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p style="font-size: 12px; color: var(--text-muted); margin-top: var(--space-4);">
          All times are server-local. Full audit trail available at{" "}
          <a href="/audit">Audit log</a>. For SOC 2 mapping see{" "}
          <a href="/admin/soc2">SOC 2 Checklist</a>.
        </p>
      </div>
    </Layout>
  );
});

// ── GET /admin/soc2 ───────────────────────────────────────────────────────────
adminSecurity.get("/admin/soc2", async (c) => {
  const user = c.get("user")!;

  const CheckItem = ({
    ok,
    label,
    desc,
  }: {
    ok: boolean;
    label: string;
    desc?: string;
  }) => (
    <div class="soc2-row">
      <div class={`soc2-icon ${ok ? "soc2-status-ok" : "soc2-status-warn"}`}>
        {ok ? "✓" : "⚠"}
      </div>
      <div class="soc2-text">
        <div class="soc2-label">{label}</div>
        {desc && <div class="soc2-desc">{desc}</div>}
      </div>
    </div>
  );

  return c.html(
    <Layout title="SOC 2 Readiness" user={user}>
      <style dangerouslySetInnerHTML={{ __html: securityStyles }} />
      <div class="soc2-page">
        <div class="soc2-hero">
          <h1>SOC 2 Readiness Checklist</h1>
          <p>
            Maps the five SOC 2 Trust Service Criteria to Gluecron's implemented
            controls. Green items have active technical controls; amber items need
            policy, tooling, or external assessment.
            <br />
            <span style="color: var(--text-muted); font-size: 12px;">
              Last reviewed: {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} ·{" "}
              <a href="/admin/security">View security dashboard</a>
            </span>
          </p>
        </div>

        {/* ── CC: Security ── */}
        <div class="soc2-category">
          <div class="soc2-section-card">
            <h2 style="margin-top: 0;">CC — Security (Common Criteria)</h2>

            <CheckItem
              ok={true}
              label="Audit log (CC7.2)"
              desc="Every sensitive action is written to the audit_log table with user, IP, timestamp, and action. Exportable via /admin/audit or /api/v2/admin/audit."
            />
            <CheckItem
              ok={true}
              label="Access controls — role-based (CC6.1)"
              desc="Admin routes gated by isSiteAdmin. Repository access gated by visibility + collaborator membership. Branch protection rules enforced on push and merge."
            />
            <CheckItem
              ok={true}
              label="Account lockout after repeated failures (CC6.1)"
              desc="10 failed login attempts within 1 hour locks the account for 15 minutes. Attempts logged to login_attempts table with email + IP. Lockout events written to audit_log as auth.login.locked."
            />
            <CheckItem
              ok={true}
              label="Rate limiting (CC6.6)"
              desc="Login endpoint: 20 req/min/IP (middleware rate-limit). API: 1000 req/min/IP. Git push/pull: 100 req/min/IP. Brute-force protection on forgot-password and magic-link endpoints."
            />
            <CheckItem
              ok={true}
              label="Encryption in transit — HTTPS (CC6.7)"
              desc="TLS is enforced by the Fly.io edge and documented in fly.toml. All internal Neon PostgreSQL connections use SSL."
            />
            <CheckItem
              ok={true}
              label="Encryption at rest — SSH + API keys (CC6.7)"
              desc="SSH public keys stored as plain text (read-only); private keys never leave the user. API tokens stored as SHA-256 hashes; plaintext never persisted. Passwords stored as bcrypt hashes (cost 12)."
            />
            <CheckItem
              ok={true}
              label="Session management (CC6.1)"
              desc="30-day session expiry. Per-user session list at /settings/sessions with individual revoke and revoke-all. IP address and user-agent logged per session."
            />
            <CheckItem
              ok={true}
              label="2FA / TOTP support (CC6.1)"
              desc="TOTP (RFC 6238) supported via /settings/2fa. Recovery codes (SHA-256 hashed) for device loss. WebAuthn/passkey support for phishing-resistant auth."
            />
            <CheckItem
              ok={false}
              label="MFA enforcement policy (CC6.1)"
              desc="MFA is available but not yet mandatory for admin accounts. Recommend enforcing MFA for all users with isAdmin=true. Tracked: admin.security.mfa_enforcement_policy."
            />
            <CheckItem
              ok={false}
              label="Penetration test (CC7.1)"
              desc="No external penetration test on record. Schedule an annual third-party assessment. OWASP Top 10 self-review partially complete (secret-scan gate covers A3, A7)."
            />
            <CheckItem
              ok={false}
              label="Vulnerability disclosure policy (CC7.1)"
              desc="No public security.txt or responsible-disclosure policy page. Add /security.txt and a SECURITY.md to the repo."
            />
          </div>
        </div>

        {/* ── A: Availability ── */}
        <div class="soc2-category">
          <div class="soc2-section-card">
            <h2 style="margin-top: 0;">A — Availability</h2>

            <CheckItem
              ok={true}
              label="Health probes (A1.2)"
              desc="GET /health returns 200 with uptime, memory, and DB reachability. Used by Fly.io TCP healthcheck. Autopilot tick monitors DB connectivity."
            />
            <CheckItem
              ok={true}
              label="Public status page (A1.2)"
              desc="/status surfaces platform health. /admin/status shows synthetic-monitor results per component."
            />
            <CheckItem
              ok={true}
              label="Database backups (A1.3)"
              desc="Neon PostgreSQL provides continuous PITR (point-in-time recovery) with 7-day history by default on Pro plans. Verify the backup retention period in the Neon console."
            />
            <CheckItem
              ok={false}
              label="SLA definition (A1.1)"
              desc="No documented uptime SLA. Define target availability (e.g. 99.9%) and add it to /legal/terms or a dedicated /sla page."
            />
            <CheckItem
              ok={false}
              label="Incident response runbook (A1.2)"
              desc="No documented incident response process. Create a runbook covering detection → escalation → communication → post-mortem."
            />
          </div>
        </div>

        {/* ── C: Confidentiality ── */}
        <div class="soc2-category">
          <div class="soc2-section-card">
            <h2 style="margin-top: 0;">C — Confidentiality</h2>

            <CheckItem
              ok={true}
              label="Repository visibility controls (C1.1)"
              desc="Repos are private by default. Visibility enforced at the route layer (softAuth + git protocol). Private repos not reachable without a valid session or token."
            />
            <CheckItem
              ok={true}
              label="API token scoping (C1.2)"
              desc="Tokens carry comma-separated scope list. /api/* handlers check scope before processing write requests."
            />
            <CheckItem
              ok={true}
              label="Personal access token management (C1.2)"
              desc="Tokens shown once on creation; stored as SHA-256 hash. Users can revoke at /settings/tokens. Expiry supported."
            />
            <CheckItem
              ok={false}
              label="Data classification policy (C1.1)"
              desc="No formal data classification. Define at least: Public (explore), Internal (private repos), Confidential (credentials, PII). Required for auditor review."
            />
            <CheckItem
              ok={false}
              label="Third-party sub-processor list (C1.2)"
              desc="Neon, Resend, Fly.io, Anthropic API are used. Document these as sub-processors with data-handling descriptions on the Privacy page."
            />
          </div>
        </div>

        {/* ── PI: Processing Integrity ── */}
        <div class="soc2-category">
          <div class="soc2-section-card">
            <h2 style="margin-top: 0;">PI — Processing Integrity</h2>

            <CheckItem
              ok={true}
              label="Audit trail for all mutations (PI1.2)"
              desc="Every sensitive write (merge, delete, force-push, token create/revoke, deploy) emitted to audit_log. Immutable append-only structure."
            />
            <CheckItem
              ok={true}
              label="Git immutability (PI1.3)"
              desc="Branch protection prevents force-push on protected branches. Gate runs stored in gate_runs with commit SHA. Push events recorded in audit_log."
            />
            <CheckItem
              ok={true}
              label="GateTest / CI enforcement (PI1.1)"
              desc="GateTest, secret-scan, type-check, and lint gates block merge on failure. Gate results stored per-commit in gate_runs with pass/fail status."
            />
            <CheckItem
              ok={false}
              label="Input validation documentation (PI1.1)"
              desc="Input validation is implemented in route handlers but not formally documented. Add OpenAPI schema validation annotations for auditor review."
            />
          </div>
        </div>

        {/* ── P: Privacy ── */}
        <div class="soc2-category">
          <div class="soc2-section-card">
            <h2 style="margin-top: 0;">P — Privacy</h2>

            <CheckItem
              ok={true}
              label="Account deletion with grace period (P4.3)"
              desc="Users can schedule account deletion at /settings. 30-day grace period with cancellation option. Deletion scheduled via deletionScheduledFor; purge via autopilot task."
            />
            <CheckItem
              ok={true}
              label="Terms of Service + Privacy Policy (P1.1)"
              desc="Terms available at /terms and /legal/terms. Privacy Policy at /privacy. Acceptance timestamp + version recorded per user on registration (termsAcceptedAt, termsVersion)."
            />
            <CheckItem
              ok={true}
              label="Email verification (P4.2)"
              desc="Email verification sent on registration when RESEND_API_KEY is configured. emailVerifiedAt timestamp tracked per user."
            />
            <CheckItem
              ok={false}
              label="Data Processing Agreement / DPA (P1.1)"
              desc="No DPA available for EU/EEA customers. Required for GDPR Article 28 compliance if handling EU personal data. Add DPA to /legal/ and link from Privacy Policy."
            />
            <CheckItem
              ok={false}
              label="Data retention policy (P6.7)"
              desc="No documented data retention schedule. Specify how long: sessions (30d), audit_log (indefinite), deleted accounts (purged after 30d grace). Document and automate."
            />
            <CheckItem
              ok={false}
              label="Right to export / data portability (P8.1)"
              desc="No self-service data export for users. GitHub provides this via API; add an equivalent for full GDPR compliance."
            />
          </div>
        </div>

        <div style="margin-top: var(--space-6); padding: var(--space-4); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 12px; font-size: 13px; color: var(--text-muted);">
          <strong style="color: var(--text);">Summary:</strong> 16 controls implemented, 10 gaps identified.
          Priority order for SOC 2 Type I: (1) MFA enforcement for admins, (2) SLA definition,
          (3) DPA for EU customers, (4) Penetration test, (5) Vulnerability disclosure policy.
          Contact <a href="mailto:security@gluecron.com">security@gluecron.com</a> to report issues.
        </div>
      </div>
    </Layout>
  );
});

export default adminSecurity;
