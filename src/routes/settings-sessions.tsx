/**
 * Session management — SOC 2 CC6.1 session visibility.
 *
 *   GET  /settings/sessions               — list all active sessions for the current user
 *   POST /settings/sessions/:id/revoke    — delete a specific session
 *   POST /settings/sessions/revoke-all   — delete all sessions except the current one
 */

import { Hono } from "hono";
import { and, desc, eq, ne } from "drizzle-orm";
import { getCookie, deleteCookie } from "hono/cookie";
import { db } from "../db";
import { sessions } from "../db/schema";
import { requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { Layout } from "../views/layout";

const settingsSessions = new Hono<AuthEnv>();
settingsSessions.use("/settings/sessions*", requireAuth);

// ── Helper: parse a friendly device/browser hint from a user-agent string ──
function parseBrowserHint(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const s = ua.toLowerCase();

  // OS
  let os = "";
  if (s.includes("android")) os = "Android";
  else if (s.includes("iphone") || s.includes("ipad")) os = "iOS";
  else if (s.includes("mac os") || s.includes("macintosh")) os = "macOS";
  else if (s.includes("windows")) os = "Windows";
  else if (s.includes("linux")) os = "Linux";

  // Browser
  let browser = "";
  if (s.includes("edg/") || s.includes("edge/")) browser = "Edge";
  else if (s.includes("chrome/") && !s.includes("chromium")) browser = "Chrome";
  else if (s.includes("firefox/")) browser = "Firefox";
  else if (s.includes("safari/") && !s.includes("chrome")) browser = "Safari";
  else if (s.includes("curl/")) browser = "curl";
  else if (s.includes("postman")) browser = "Postman";

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  // Fallback: first 60 chars of raw UA
  return ua.slice(0, 60);
}

// ── Scoped styles ────────────────────────────────────────────────────────────
const sessionsStyles = `
  .sessions-page { max-width: 800px; margin: 0 auto; padding: var(--space-6) var(--space-4); }
  .sessions-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .sessions-hero::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7; pointer-events: none;
  }
  .sessions-hero h1 { font-size: 1.5rem; font-weight: 700; margin: 0 0 4px; }
  .sessions-hero p { color: var(--text-muted); margin: 0; font-size: 14px; }
  .sessions-list { display: flex; flex-direction: column; gap: 12px; }
  .session-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: var(--space-4) var(--space-5);
    display: flex; align-items: center; gap: 16px;
  }
  .session-card.current { border-color: #8c6dff44; background: #8c6dff0a; }
  .session-icon {
    width: 40px; height: 40px; border-radius: 8px;
    background: var(--bg-canvas); display: flex; align-items: center;
    justify-content: center; flex-shrink: 0; font-size: 18px;
  }
  .session-info { flex: 1; min-width: 0; }
  .session-device { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .session-current-badge {
    font-size: 11px; font-weight: 600; padding: 2px 8px;
    background: #8c6dff22; color: #a388ff; border-radius: 100px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .session-meta { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .sessions-actions { margin-top: var(--space-6); padding-top: var(--space-4); border-top: 1px solid var(--border); }
  .sessions-actions h3 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
  .sessions-actions p { font-size: 13px; color: var(--text-muted); margin: 0 0 12px; }
`;

// ── GET /settings/sessions ───────────────────────────────────────────────────
settingsSessions.get("/settings/sessions", async (c) => {
  const user = c.get("user")!;
  const currentToken = getCookie(c, "session") ?? "";

  const allSessions = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, user.id),
        // Only show non-expired sessions
      )
    )
    .orderBy(desc(sessions.createdAt));

  // Filter to non-expired
  const now = new Date();
  const activeSessions = allSessions.filter((s) => new Date(s.expiresAt) > now);

  return c.html(
    <Layout title="Active sessions" user={user}>
      <style dangerouslySetInnerHTML={{ __html: sessionsStyles }} />
      <div class="sessions-page">
        <div class="sessions-hero">
          <h1>Active sessions</h1>
          <p>
            These are the devices currently signed in to your account. Revoke
            any session you don't recognise.
          </p>
        </div>

        <div class="sessions-list">
          {activeSessions.map((s) => {
            const isCurrent = s.token === currentToken;
            const deviceHint = parseBrowserHint(s.userAgent);
            const lastSeen = s.lastSeenAt
              ? new Date(s.lastSeenAt).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "Unknown";
            const created = new Date(s.createdAt).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            });
            const icon =
              deviceHint.toLowerCase().includes("mobile") ||
              deviceHint.toLowerCase().includes("android") ||
              deviceHint.toLowerCase().includes("ios")
                ? "📱"
                : "💻";

            return (
              <div class={`session-card${isCurrent ? " current" : ""}`} key={s.id}>
                <div class="session-icon">{icon}</div>
                <div class="session-info">
                  <div class="session-device">
                    {deviceHint}
                    {isCurrent && (
                      <span class="session-current-badge">Current</span>
                    )}
                  </div>
                  <div class="session-meta">
                    {s.ip ? `IP: ${s.ip} · ` : ""}
                    Last active: {lastSeen} · Signed in: {created}
                  </div>
                </div>
                {!isCurrent && (
                  <form method="post" action={`/settings/sessions/${s.id}/revoke`}>
                    <input
                      type="hidden"
                      name="_csrf"
                      value={(c.get("csrfToken") as string | undefined) ?? ""}
                    />
                    <button
                      type="submit"
                      class="btn btn-sm"
                      style="color: var(--danger); border-color: var(--danger);"
                    >
                      Revoke
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>

        {activeSessions.length > 1 && (
          <div class="sessions-actions">
            <h3>Sign out everywhere else</h3>
            <p>
              This will revoke all sessions except your current one. Any device
              signed in to your account will need to log in again.
            </p>
            <form method="post" action="/settings/sessions/revoke-all">
              <input
                type="hidden"
                name="_csrf"
                value={(c.get("csrfToken") as string | undefined) ?? ""}
              />
              <button
                type="submit"
                class="btn"
                style="color: var(--danger); border-color: var(--danger);"
              >
                Revoke all other sessions
              </button>
            </form>
          </div>
        )}
      </div>
    </Layout>
  );
});

// ── POST /settings/sessions/:id/revoke ───────────────────────────────────────
settingsSessions.post("/settings/sessions/:id/revoke", async (c) => {
  const user = c.get("user")!;
  const { id } = c.req.param();
  const currentToken = getCookie(c, "session") ?? "";

  // Fetch the session to verify ownership and ensure it's not current.
  const [target] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, user.id)))
    .limit(1);

  if (!target) {
    return c.redirect("/settings/sessions?error=Session+not+found");
  }
  if (target.token === currentToken) {
    return c.redirect("/settings/sessions?error=Cannot+revoke+your+current+session");
  }

  await db.delete(sessions).where(eq(sessions.id, id));
  return c.redirect("/settings/sessions?success=Session+revoked");
});

// ── POST /settings/sessions/revoke-all ──────────────────────────────────────
settingsSessions.post("/settings/sessions/revoke-all", async (c) => {
  const user = c.get("user")!;
  const currentToken = getCookie(c, "session") ?? "";

  // Find and delete all sessions belonging to this user EXCEPT the current one.
  const [currentSession] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, user.id), eq(sessions.token, currentToken)))
    .limit(1);

  if (currentSession) {
    await db
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, user.id),
          ne(sessions.id, currentSession.id)
        )
      );
  } else {
    // Fallback: delete all (this shouldn't happen in normal flow).
    await db.delete(sessions).where(eq(sessions.userId, user.id));
  }

  return c.redirect("/settings/sessions?success=All+other+sessions+revoked");
});

export default settingsSessions;
