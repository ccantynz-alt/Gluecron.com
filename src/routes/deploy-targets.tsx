/**
 * Customer-facing deploy targets — /settings/deploy-targets
 *
 * Lets any authenticated user manage SSH deploy targets for their own repos.
 * Private keys are encrypted at rest with AES-256-GCM using SERVER_TARGETS_KEY
 * (same scheme as the admin surface in admin-server-targets.tsx).
 *
 *   GET    /settings/deploy-targets          — list user's own targets
 *   POST   /settings/deploy-targets          — create a new target
 *   POST   /settings/deploy-targets/:id/delete — delete (owner-only)
 *   POST   /settings/deploy-targets/:id/test   — test SSH connectivity
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { serverTargets } from "../db/schema";
import { Layout } from "../views/layout";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import {
  createTarget,
  deleteTarget,
  recordPin,
} from "../lib/server-target-store";
import { testConnection } from "../lib/server-targets";
import { getMasterKey } from "../lib/server-targets-crypto";

const deployTargets = new Hono<AuthEnv>();

deployTargets.use("/settings/deploy-targets*", requireAuth);

// ─── Scoped styles ────────────────────────────────────────────────────────────

const styles = `
  .dt-wrap {
    max-width: 960px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4);
  }

  /* ─── Hero ─── */
  .dt-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .dt-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .dt-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 360px; height: 360px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.65;
    pointer-events: none;
    z-index: 0;
  }
  .dt-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 640px;
  }
  .dt-hero-eyebrow {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }
  .dt-hero-title {
    font-size: clamp(26px, 3.5vw, 36px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .dt-hero-title .gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .dt-hero-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  /* ─── Subnav ─── */
  .dt-subnav {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
    padding: 4px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    width: fit-content;
    max-width: 100%;
    overflow-x: auto;
  }
  .dt-subnav a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    border-radius: 9999px;
    text-decoration: none;
    white-space: nowrap;
    transition: all 120ms ease;
  }
  .dt-subnav a:hover {
    color: var(--text-strong);
    background: var(--bg-hover);
  }
  .dt-subnav a.is-active {
    color: var(--text-strong);
    background: rgba(140,109,255,0.16);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }

  /* ─── Banners ─── */
  .dt-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 12px;
    font-size: 13.5px;
    margin-bottom: var(--space-4);
    line-height: 1.5;
  }
  .dt-banner-success {
    background: rgba(52,211,153,0.08);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .dt-banner-error {
    background: rgba(248,113,113,0.08);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30);
  }
  .dt-banner-icon {
    width: 18px; height: 18px;
    border-radius: 9999px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
  }
  .dt-banner-success .dt-banner-icon { background: rgba(52,211,153,0.18); color: #34d399; }
  .dt-banner-error .dt-banner-icon { background: rgba(248,113,113,0.18); color: #f87171; }

  /* ─── Section cards ─── */
  .dt-section {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    margin-bottom: var(--space-5);
    overflow: hidden;
  }
  .dt-section-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  .dt-section-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .dt-section-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .dt-section-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .dt-section-body { padding: var(--space-4) var(--space-5); }
  .dt-section-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }

  /* ─── Form fields ─── */
  .dt-field { margin-bottom: var(--space-4); }
  .dt-field:last-child { margin-bottom: 0; }
  .dt-field-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
    letter-spacing: -0.005em;
  }
  .dt-field-hint {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 6px;
    line-height: 1.45;
  }
  .dt-input,
  .dt-textarea {
    width: 100%;
    padding: 9px 12px;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
    font-family: var(--font-sans);
    box-sizing: border-box;
  }
  .dt-textarea {
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.5;
    resize: vertical;
  }
  .dt-input:focus,
  .dt-textarea:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .dt-row-2 {
    display: grid;
    grid-template-columns: 1fr 120px;
    gap: var(--space-3);
  }
  @media (max-width: 560px) {
    .dt-row-2 { grid-template-columns: 1fr; }
  }

  /* ─── Target cards ─── */
  .dt-target-card {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-3);
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-secondary);
    margin-bottom: 10px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .dt-target-card:last-child { margin-bottom: 0; }
  .dt-target-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.018);
  }
  .dt-target-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0 0 4px;
  }
  .dt-target-host {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    padding: 2px 8px;
    border-radius: 6px;
  }
  .dt-target-meta {
    margin-top: 6px;
    font-size: 12.5px;
    color: var(--text-muted);
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }
  .dt-status-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .dt-status-verified {
    background: rgba(52,211,153,0.12);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.28);
  }
  .dt-status-unverified {
    background: rgba(234,179,8,0.10);
    color: #fde047;
    box-shadow: inset 0 0 0 1px rgba(234,179,8,0.24);
  }
  .dt-target-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .dt-empty {
    padding: var(--space-5);
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: 12px;
    background: var(--bg-secondary);
    color: var(--text-muted);
    font-size: 13.5px;
  }

  /* ─── Warning banner (missing key) ─── */
  .dt-warn {
    padding: 12px 16px;
    border-radius: 10px;
    background: rgba(234,179,8,0.08);
    color: #fde047;
    box-shadow: inset 0 0 0 1px rgba(234,179,8,0.24);
    font-size: 13.5px;
    margin-bottom: var(--space-4);
    display: flex;
    gap: 10px;
    align-items: center;
  }

  @media (max-width: 640px) {
    .dt-target-card { flex-direction: column; }
    .dt-target-actions { flex-direction: row; }
  }
`;

// ─── Shared subnav (mirrors settings.tsx pattern) ────────────────────────────

function DeployTargetsSubnav() {
  return (
    <nav class="dt-subnav" aria-label="Settings sections">
      <a href="/settings">Profile</a>
      <a href="/settings/keys">SSH keys</a>
      <a href="/settings/agents">Agents</a>
      <a href="/settings/deploy-targets" class="is-active" aria-current="page">
        Deploy targets
      </a>
    </nav>
  );
}

function Banner(props: { kind: "success" | "error"; text: string }) {
  return (
    <div class={`dt-banner dt-banner-${props.kind}`} role="status">
      <span class="dt-banner-icon" aria-hidden="true">
        {props.kind === "success" ? "✓" : "!"}
      </span>
      <span>{props.text}</span>
    </div>
  );
}

// ─── GET /settings/deploy-targets ────────────────────────────────────────────

deployTargets.get("/settings/deploy-targets", async (c) => {
  const user = c.get("user")!;
  const ok = c.req.query("ok") ?? undefined;
  const err = c.req.query("err") ?? undefined;

  // Fetch only targets belonging to this user
  const targets = await db
    .select()
    .from(serverTargets)
    .where(eq(serverTargets.createdBy, user.id))
    .orderBy(desc(serverTargets.createdAt));

  const keyConfigured = getMasterKey() !== null;

  return c.html(
    <Layout title="Deploy targets — settings" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="dt-wrap">
        {/* ─── Hero ─── */}
        <div class="dt-hero">
          <div class="dt-hero-orb" aria-hidden="true" />
          <div class="dt-hero-inner">
            <div class="dt-hero-eyebrow">
              Your account · <span style="color:var(--accent);font-weight:600">{user.username}</span>
            </div>
            <h1 class="dt-hero-title">
              Deploy <span class="gradient-text">targets</span>.
            </h1>
            <p class="dt-hero-sub">
              SSH boxes that Gluecron can deploy to. Private keys are encrypted
              at rest and never displayed again after saving.
            </p>
          </div>
        </div>

        <DeployTargetsSubnav />

        {!keyConfigured && (
          <div class="dt-warn" role="alert">
            <span aria-hidden="true">⚠</span>
            <span>
              <strong>SERVER_TARGETS_KEY not set.</strong> Deploy targets require
              this environment variable (a 64-character hex string / 32-byte AES key)
              to encrypt private keys. Contact your administrator.
            </span>
          </div>
        )}

        {ok && <Banner kind="success" text={decodeURIComponent(ok)} />}
        {err && <Banner kind="error" text={decodeURIComponent(err)} />}

        {/* ─── Existing targets ─── */}
        <section class="dt-section">
          <div class="dt-section-head">
            <div class="dt-section-eyebrow">SSH deploy targets</div>
            <h2 class="dt-section-title">Your targets</h2>
            <p class="dt-section-desc">
              Boxes registered to your account. Each target can be linked to a
              repo + branch so pushes trigger deploys automatically.
            </p>
          </div>
          <div class="dt-section-body">
            {targets.length === 0 ? (
              <div class="dt-empty">
                No deploy targets yet. Add your first box below.
              </div>
            ) : (
              targets.map((t) => (
                <div class="dt-target-card">
                  <div>
                    <div class="dt-target-name">{t.name}</div>
                    <code class="dt-target-host">
                      {t.sshUser}@{t.host}:{t.port}
                    </code>
                    <div class="dt-target-meta">
                      <span
                        class={
                          "dt-status-pill " +
                          (t.status === "verified"
                            ? "dt-status-verified"
                            : "dt-status-unverified")
                        }
                      >
                        {t.status}
                      </span>
                      {t.deployPath && (
                        <span style="font-family:var(--font-mono);font-size:12px">
                          {t.deployPath}
                        </span>
                      )}
                      {t.createdAt && (
                        <span>
                          Added {t.createdAt.toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div class="dt-target-actions">
                    <form
                      method="post"
                      action={`/settings/deploy-targets/${t.id}/test`}
                      style="display:inline"
                    >
                      <button
                        type="submit"
                        class="btn btn-sm"
                        title="Test SSH connection"
                      >
                        Test
                      </button>
                    </form>
                    <form
                      method="post"
                      action={`/settings/deploy-targets/${t.id}/delete`}
                      style="display:inline"
                      onsubmit="return confirm('Delete this deploy target?')"
                    >
                      <button type="submit" class="btn btn-sm btn-danger">
                        Delete
                      </button>
                    </form>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* ─── Add new target form ─── */}
        <section class="dt-section">
          <div class="dt-section-head">
            <div class="dt-section-eyebrow">Add target</div>
            <h2 class="dt-section-title">New deploy target</h2>
            <p class="dt-section-desc">
              Enter your server's SSH credentials. The private key is encrypted
              immediately and never stored in plaintext.
            </p>
          </div>
          <form method="post" action="/settings/deploy-targets">
            <div class="dt-section-body">
              <div class="dt-field">
                <label class="dt-field-label" for="dt-name">
                  Name
                </label>
                <input
                  class="dt-input"
                  id="dt-name"
                  name="name"
                  required
                  pattern="[a-z0-9-]+"
                  placeholder="my-prod-server"
                  autocomplete="off"
                />
                <div class="dt-field-hint">
                  Lowercase letters, numbers and hyphens only. Must be unique
                  across all targets on the platform.
                </div>
              </div>

              <div class="dt-row-2">
                <div class="dt-field">
                  <label class="dt-field-label" for="dt-host">Host</label>
                  <input
                    class="dt-input"
                    id="dt-host"
                    name="host"
                    required
                    placeholder="1.2.3.4 or example.com"
                    autocomplete="off"
                  />
                </div>
                <div class="dt-field">
                  <label class="dt-field-label" for="dt-port">Port</label>
                  <input
                    class="dt-input"
                    id="dt-port"
                    name="port"
                    type="number"
                    value="22"
                    min="1"
                    max="65535"
                  />
                </div>
              </div>

              <div class="dt-field">
                <label class="dt-field-label" for="dt-ssh-user">
                  SSH username
                </label>
                <input
                  class="dt-input"
                  id="dt-ssh-user"
                  name="ssh_user"
                  required
                  placeholder="deploy"
                  autocomplete="off"
                />
              </div>

              <div class="dt-field">
                <label class="dt-field-label" for="dt-private-key">
                  SSH private key
                </label>
                <textarea
                  class="dt-textarea"
                  id="dt-private-key"
                  name="private_key"
                  required
                  rows={8}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                />
                <div class="dt-field-hint">
                  Paste your OpenSSH PEM private key. It is encrypted with
                  AES-256-GCM before being stored and will never be displayed
                  again after saving.
                </div>
              </div>

              <div class="dt-field">
                <label class="dt-field-label" for="dt-deploy-path">
                  Deploy path
                </label>
                <input
                  class="dt-input"
                  id="dt-deploy-path"
                  name="deploy_path"
                  placeholder="/var/www/app"
                  value="/var/www/app"
                />
                <div class="dt-field-hint">
                  Absolute path on the remote server where your app lives.
                </div>
              </div>
            </div>
            <div class="dt-section-foot">
              <button
                type="submit"
                class="btn btn-primary"
                disabled={!keyConfigured}
              >
                Add deploy target
              </button>
            </div>
          </form>
        </section>
      </div>
    </Layout>
  );
});

// ─── POST /settings/deploy-targets ───────────────────────────────────────────

deployTargets.post("/settings/deploy-targets", async (c) => {
  const user = c.get("user")!;

  if (getMasterKey() === null) {
    return c.redirect(
      "/settings/deploy-targets?err=SERVER_TARGETS_KEY+not+configured"
    );
  }

  const form = await c.req.parseBody();
  const name = String(form.name || "").trim();
  const host = String(form.host || "").trim();
  const port = Number(form.port || 22);
  const sshUser = String(form.ssh_user || "").trim();
  const privateKey = String(form.private_key || "");
  const deployPath = String(form.deploy_path || "/var/www/app").trim();

  if (!name || !host || !sshUser || !privateKey) {
    return c.redirect(
      "/settings/deploy-targets?err=Name%2C+host%2C+SSH+user+and+private+key+are+required"
    );
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    return c.redirect(
      "/settings/deploy-targets?err=Name+must+be+lowercase+letters%2C+numbers+and+hyphens+only"
    );
  }
  if (!privateKey.includes("PRIVATE KEY")) {
    return c.redirect(
      "/settings/deploy-targets?err=Private+key+does+not+look+like+a+valid+OpenSSH+PEM+key"
    );
  }

  const out = await createTarget({
    name,
    host,
    port: isNaN(port) ? 22 : port,
    sshUser,
    privateKey,
    deployPath: deployPath || "/var/www/app",
    deployScript: "bash deploy.sh",
    watchedRepositoryId: null,
    watchedBranch: null,
    createdBy: user.id,
  });

  if (!out.ok) {
    return c.redirect(
      `/settings/deploy-targets?err=${encodeURIComponent(out.error)}`
    );
  }

  return c.redirect(
    `/settings/deploy-targets?ok=Deploy+target+%22${encodeURIComponent(name)}%22+created`
  );
});

// ─── POST /settings/deploy-targets/:id/delete ────────────────────────────────

deployTargets.post("/settings/deploy-targets/:id/delete", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  // Verify ownership before deleting
  const [target] = await db
    .select()
    .from(serverTargets)
    .where(and(eq(serverTargets.id, id), eq(serverTargets.createdBy, user.id)))
    .limit(1);

  if (!target) {
    return c.redirect(
      "/settings/deploy-targets?err=Target+not+found+or+not+owned+by+you"
    );
  }

  await deleteTarget(id, user.id);
  return c.redirect(
    `/settings/deploy-targets?ok=Target+%22${encodeURIComponent(target.name)}%22+deleted`
  );
});

// ─── POST /settings/deploy-targets/:id/test ──────────────────────────────────

deployTargets.post("/settings/deploy-targets/:id/test", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  // Verify ownership
  const [target] = await db
    .select()
    .from(serverTargets)
    .where(and(eq(serverTargets.id, id), eq(serverTargets.createdBy, user.id)))
    .limit(1);

  if (!target) {
    return c.redirect(
      "/settings/deploy-targets?err=Target+not+found+or+not+owned+by+you"
    );
  }

  const result = await testConnection(target);
  if (result.ok) {
    await recordPin(id, result.fingerprint, user.id);
    return c.redirect(
      `/settings/deploy-targets?ok=Connection+to+%22${encodeURIComponent(target.name)}%22+verified`
    );
  }

  return c.redirect(
    `/settings/deploy-targets?err=${encodeURIComponent(
      `${result.stage}: ${result.error}`
    )}`
  );
});

export default deployTargets;
