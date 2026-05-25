/**
 * /settings/integrations — Slack, Discord, Teams workspace management.
 *
 * Surface:
 *   GET  /settings/integrations              — list installs + install CTAs
 *   POST /settings/integrations              — add a manual install (when
 *                                              the user has the webhook URL
 *                                              and signing secret in hand)
 *   POST /settings/integrations/:id/toggle   — flip enabled
 *   POST /settings/integrations/:id/delete   — remove
 *   POST /settings/integrations/:id/test     — fire a synthetic event so
 *                                              the user can confirm the
 *                                              channel routing is correct.
 *
 * Hard rule: all CSS is scoped under `.chati-*` so it can't bleed into
 * other settings surfaces. No changes to layout / components / shared UI.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chatIntegrations, repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { notifyChatChannels } from "../lib/chat-notifier";

const r = new Hono<AuthEnv>();
r.use("/settings/integrations*", softAuth, requireAuth);

// ---------------------------------------------------------------------------
// Scoped CSS (.chati-*). Mirrors the tokens / webhooks polish.
// ---------------------------------------------------------------------------
const chatiStyles = `
  .chati-wrap { max-width: 920px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Hero ─── */
  .chati-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .chati-hero::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .chati-hero-orb {
    position: absolute; inset: -30% -10% auto auto;
    width: 360px; height: 360px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.65;
    pointer-events: none;
  }
  .chati-hero-inner { position: relative; z-index: 1; max-width: 680px; }
  .chati-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
  }
  .chati-eyebrow-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }
  .chati-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 32px);
    font-weight: 800;
    letter-spacing: -0.024em;
    line-height: 1.08;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .chati-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .chati-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }

  /* ─── Install CTAs ─── */
  .chati-cta-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .chati-cta {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    text-decoration: none;
    color: var(--text-strong);
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .chati-cta:hover {
    border-color: rgba(140,109,255,0.5);
    transform: translateY(-1px);
  }
  .chati-cta-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px;
    border-radius: 10px;
    font-size: 18px;
    font-weight: 700;
  }
  .chati-cta-icon.is-slack { background: rgba(74,21,75,0.28); color: #ecb22e; }
  .chati-cta-icon.is-discord { background: rgba(88,101,242,0.18); color: #c4cdfa; }
  .chati-cta-icon.is-teams { background: rgba(70,76,194,0.20); color: #b4baf3; }
  .chati-cta-body { flex: 1; }
  .chati-cta-name {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
  }
  .chati-cta-sub {
    font-size: 12.5px;
    color: var(--text-muted);
    margin: 2px 0 0;
  }

  /* ─── Section cards ─── */
  .chati-section {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    margin-bottom: var(--space-5);
    overflow: hidden;
  }
  .chati-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .chati-section-title {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .chati-section-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .chati-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Install cards ─── */
  .chati-list {
    display: flex; flex-direction: column; gap: 10px;
  }
  .chati-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-3) var(--space-4);
    display: flex; flex-direction: column; gap: 10px;
    transition: border-color 120ms ease;
  }
  .chati-card:hover { border-color: var(--border-strong); }
  .chati-card-top {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
  }
  .chati-card-id {
    display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1;
  }
  .chati-card-kind {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .chati-card-kind.is-slack { background: rgba(74,21,75,0.28); color: #ecb22e; }
  .chati-card-kind.is-discord { background: rgba(88,101,242,0.18); color: #c4cdfa; }
  .chati-card-kind.is-teams { background: rgba(70,76,194,0.20); color: #b4baf3; }
  .chati-card-meta {
    min-width: 0;
    display: flex; flex-direction: column; gap: 2px;
  }
  .chati-card-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chati-card-team {
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .chati-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .chati-pill.is-on { background: rgba(52,211,153,0.14); color: #6ee7b7; box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32); }
  .chati-pill.is-off { background: rgba(107,114,128,0.16); color: #d1d5db; box-shadow: inset 0 0 0 1px rgba(107,114,128,0.32); }
  .chati-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }

  .chati-card-actions {
    display: flex; gap: 6px; flex-wrap: wrap;
  }
  .chati-card-channel {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .chati-channel-input {
    padding: 4px 10px;
    border-radius: 7px;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
    min-width: 140px;
    outline: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .chati-channel-input:focus {
    border-color: rgba(140,109,255,0.6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .chati-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 600;
    border-radius: 7px;
    cursor: pointer;
    font-family: inherit;
    text-decoration: none;
    border: 1px solid transparent;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .chati-btn-ghost {
    background: rgba(255,255,255,0.03);
    border-color: var(--border);
    color: var(--text);
  }
  .chati-btn-ghost:hover { background: rgba(255,255,255,0.06); border-color: var(--border-strong); color: var(--text-strong); }
  .chati-btn-danger {
    background: rgba(248,113,113,0.08);
    border-color: rgba(248,113,113,0.30);
    color: #fca5a5;
  }
  .chati-btn-danger:hover { background: rgba(248,113,113,0.14); border-color: rgba(248,113,113,0.50); color: #fecaca; }
  .chati-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #6d4ee0 100%);
    color: #fff;
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 4px 14px -6px rgba(140,109,255,0.45);
  }
  .chati-btn-primary:hover { filter: brightness(1.05); }

  /* ─── Empty state ─── */
  .chati-empty {
    position: relative;
    padding: var(--space-5) var(--space-4);
    border: 1px dashed var(--border-strong);
    border-radius: 12px;
    background: var(--bg-secondary);
    text-align: center;
  }
  .chati-empty-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0 0 4px;
  }
  .chati-empty-sub {
    font-size: 12.5px;
    color: var(--text-muted);
    margin: 0;
  }

  /* ─── Add-form ─── */
  .chati-field { margin-bottom: var(--space-3); }
  .chati-field:last-of-type { margin-bottom: 0; }
  .chati-label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
  }
  .chati-input,
  .chati-select {
    width: 100%;
    padding: 9px 12px;
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    box-sizing: border-box;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .chati-input:focus, .chati-select:focus {
    border-color: rgba(140,109,255,0.6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .chati-form-foot {
    display: flex; justify-content: flex-end; margin-top: var(--space-3);
  }

  /* ─── Banners ─── */
  .chati-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    display: flex; align-items: center; gap: 10px;
  }
  .chati-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .chati-banner.is-error { border-color: rgba(248,113,113,0.40); background: rgba(248,113,113,0.08); color: #fecaca; }
  .chati-banner-dot { width: 8px; height: 8px; border-radius: 9999px; background: currentColor; }
`;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

r.get("/settings/integrations", async (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  const error = c.req.query("error");

  const rows = await db
    .select()
    .from(chatIntegrations)
    .where(eq(chatIntegrations.ownerUserId, user.id));

  return c.html(
    <Layout title="Chat integrations" user={user}>
      <style dangerouslySetInnerHTML={{ __html: chatiStyles }} />
      <div class="chati-wrap">
        <div class="chati-hero">
          <div class="chati-hero-orb" aria-hidden="true" />
          <div class="chati-hero-inner">
            <div class="chati-eyebrow">
              <span class="chati-eyebrow-icon" aria-hidden="true">#</span>
              Integrations · {user.username}
            </div>
            <h1 class="chati-title">
              <span class="chati-grad">Ship from chat</span>.
            </h1>
            <p class="chati-sub">
              Wire Gluecron into Slack, Discord, or Microsoft Teams. Devs
              run <code>/gluecron pr list</code> or{" "}
              <code>/gluecron spec ship "add dark mode"</code> from inside
              the channel. PR + AI events post back automatically.
            </p>
          </div>
        </div>

        {success && (
          <div class="chati-banner is-ok" role="status">
            <span class="chati-banner-dot" aria-hidden="true" />
            {decodeURIComponent(success)}
          </div>
        )}
        {error && (
          <div class="chati-banner is-error" role="alert">
            <span class="chati-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}

        {/* Install CTAs (OAuth deep-links) */}
        <div class="chati-cta-row">
          <a class="chati-cta" href="/oauth/slack/start">
            <span class="chati-cta-icon is-slack">S</span>
            <span class="chati-cta-body">
              <p class="chati-cta-name">Install Slack app</p>
              <p class="chati-cta-sub">/gluecron commands · PR alerts</p>
            </span>
          </a>
          <a class="chati-cta" href="/oauth/discord/start">
            <span class="chati-cta-icon is-discord">D</span>
            <span class="chati-cta-body">
              <p class="chati-cta-name">Install Discord bot</p>
              <p class="chati-cta-sub">/gluecron commands · embeds</p>
            </span>
          </a>
          <a class="chati-cta" href="/oauth/teams/start">
            <span class="chati-cta-icon is-teams">T</span>
            <span class="chati-cta-body">
              <p class="chati-cta-name">Install Teams connector</p>
              <p class="chati-cta-sub">Outbound notifications</p>
            </span>
          </a>
        </div>

        {/* Installed workspaces */}
        <section class="chati-section">
          <header class="chati-section-head">
            <h2 class="chati-section-title">Installed workspaces</h2>
            <p class="chati-section-desc">
              Each row is one workspace + channel binding. Toggle to mute
              notifications without removing the install.
            </p>
          </header>
          <div class="chati-section-body">
            {rows.length === 0 ? (
              <div class="chati-empty">
                <p class="chati-empty-title">No integrations yet</p>
                <p class="chati-empty-sub">
                  Install Slack, Discord, or Teams above to get started.
                </p>
              </div>
            ) : (
              <div class="chati-list">
                {rows.map((row) => {
                  const kindClass = `is-${row.kind}`;
                  return (
                    <div class="chati-card">
                      <div class="chati-card-top">
                        <div class="chati-card-id">
                          <span class={"chati-card-kind " + kindClass}>
                            {row.kind.slice(0, 1).toUpperCase()}
                          </span>
                          <span class="chati-card-meta">
                            <span class="chati-card-name">
                              {row.webhookUrl
                                ? new URL(row.webhookUrl).host
                                : "no webhook"}
                            </span>
                            <span class="chati-card-team">
                              {row.teamId ?? "—"}
                              {row.channelId ? ` · ${row.channelId}` : ""}
                            </span>
                          </span>
                        </div>
                        <span
                          class={
                            "chati-pill " +
                            (row.enabled ? "is-on" : "is-off")
                          }
                        >
                          <span class="dot" aria-hidden="true" />
                          {row.enabled ? "enabled" : "disabled"}
                        </span>
                      </div>

                      <form
                        method="post"
                        action={`/settings/integrations/${row.id}/channel`}
                        class="chati-card-channel"
                      >
                        <label
                          for={`chan-${row.id}`}
                          style="margin:0;font-weight:600;color:var(--text-strong);"
                        >
                          Channel
                        </label>
                        <input
                          id={`chan-${row.id}`}
                          class="chati-channel-input"
                          name="channel_id"
                          value={row.channelId ?? ""}
                          placeholder="C012ABCDEF or default"
                          spellcheck={false}
                          autocomplete="off"
                        />
                        <button type="submit" class="chati-btn chati-btn-ghost">
                          Save
                        </button>
                      </form>

                      <div class="chati-card-actions">
                        <form
                          method="post"
                          action={`/settings/integrations/${row.id}/test`}
                          style="margin:0;"
                        >
                          <button type="submit" class="chati-btn chati-btn-primary">
                            Test
                          </button>
                        </form>
                        <form
                          method="post"
                          action={`/settings/integrations/${row.id}/toggle`}
                          style="margin:0;"
                        >
                          <button type="submit" class="chati-btn chati-btn-ghost">
                            {row.enabled ? "Disable" : "Enable"}
                          </button>
                        </form>
                        <form
                          method="post"
                          action={`/settings/integrations/${row.id}/delete`}
                          style="margin:0;"
                        >
                          <button type="submit" class="chati-btn chati-btn-danger">
                            Remove
                          </button>
                        </form>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* Manual install form — for users with the webhook URL + signing
            secret already in hand. The OAuth path above is the default. */}
        <section class="chati-section">
          <header class="chati-section-head">
            <h2 class="chati-section-title">Add manually</h2>
            <p class="chati-section-desc">
              Already have an Incoming Webhook URL? Paste it here.
            </p>
          </header>
          <form
            class="chati-section-body"
            method="post"
            action="/settings/integrations"
          >
            <div class="chati-field">
              <label class="chati-label" for="kind">
                Provider
              </label>
              <select id="kind" name="kind" class="chati-select" required>
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="teams">Microsoft Teams</option>
              </select>
            </div>
            <div class="chati-field">
              <label class="chati-label" for="webhook_url">
                Webhook URL
              </label>
              <input
                id="webhook_url"
                name="webhook_url"
                class="chati-input"
                type="url"
                required
                placeholder="https://hooks.slack.com/services/T0…"
                autocomplete="off"
                spellcheck={false}
              />
            </div>
            <div class="chati-field">
              <label class="chati-label" for="team_id">
                Team / guild / tenant ID (optional)
              </label>
              <input
                id="team_id"
                name="team_id"
                class="chati-input"
                placeholder="T012ABCDEF or 1234567890"
                autocomplete="off"
                spellcheck={false}
              />
            </div>
            <div class="chati-field">
              <label class="chati-label" for="channel_id">
                Channel ID (optional)
              </label>
              <input
                id="channel_id"
                name="channel_id"
                class="chati-input"
                placeholder="C012ABCDEF"
                autocomplete="off"
                spellcheck={false}
              />
            </div>
            <div class="chati-field">
              <label class="chati-label" for="signing_secret">
                Signing secret / public key (optional, required for inbound)
              </label>
              <input
                id="signing_secret"
                name="signing_secret"
                class="chati-input"
                placeholder="Slack signing secret or Discord public key (hex)"
                autocomplete="off"
                spellcheck={false}
              />
            </div>
            <div class="chati-form-foot">
              <button type="submit" class="chati-btn chati-btn-primary">
                Add integration
              </button>
            </div>
          </form>
        </section>
      </div>
    </Layout>
  );
});

// Add manual install
r.post("/settings/integrations", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const kind = String(body.kind ?? "").toLowerCase();
  const webhookUrl = String(body.webhook_url ?? "").trim();
  if (!["slack", "discord", "teams"].includes(kind) || !webhookUrl) {
    return c.redirect("/settings/integrations?error=" + encodeURIComponent("Provider and webhook URL are required"));
  }
  try {
    new URL(webhookUrl);
  } catch {
    return c.redirect("/settings/integrations?error=" + encodeURIComponent("Webhook URL is not valid"));
  }
  await db
    .insert(chatIntegrations)
    .values({
      ownerUserId: user.id,
      kind,
      teamId: String(body.team_id ?? "").trim() || null,
      channelId: String(body.channel_id ?? "").trim() || null,
      webhookUrl,
      signingSecret: String(body.signing_secret ?? "").trim() || null,
      enabled: true,
    })
    .onConflictDoNothing();
  return c.redirect(
    "/settings/integrations?success=" + encodeURIComponent("Integration added")
  );
});

// Toggle enabled
r.post("/settings/integrations/:id/toggle", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const [row] = await db
    .select()
    .from(chatIntegrations)
    .where(
      and(
        eq(chatIntegrations.id, id),
        eq(chatIntegrations.ownerUserId, user.id)
      )
    )
    .limit(1);
  if (!row) return c.redirect("/settings/integrations?error=Not+found");
  await db
    .update(chatIntegrations)
    .set({ enabled: !row.enabled })
    .where(eq(chatIntegrations.id, id));
  return c.redirect("/settings/integrations?success=Updated");
});

// Update channel
r.post("/settings/integrations/:id/channel", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const channelId = String(body.channel_id ?? "").trim() || null;
  await db
    .update(chatIntegrations)
    .set({ channelId })
    .where(
      and(
        eq(chatIntegrations.id, id),
        eq(chatIntegrations.ownerUserId, user.id)
      )
    );
  return c.redirect("/settings/integrations?success=Channel+updated");
});

// Delete
r.post("/settings/integrations/:id/delete", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  await db
    .delete(chatIntegrations)
    .where(
      and(
        eq(chatIntegrations.id, id),
        eq(chatIntegrations.ownerUserId, user.id)
      )
    );
  return c.redirect("/settings/integrations?success=Removed");
});

// Test — fires a synthetic event against the user's most-recent repo so
// the user can verify the channel routing is correct.
r.post("/settings/integrations/:id/test", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const [integ] = await db
    .select()
    .from(chatIntegrations)
    .where(
      and(
        eq(chatIntegrations.id, id),
        eq(chatIntegrations.ownerUserId, user.id)
      )
    )
    .limit(1);
  if (!integ) return c.redirect("/settings/integrations?error=Not+found");

  // Pick the most recent repo owned by the user.
  const [repo] = await db
    .select({ id: repositories.id, name: repositories.name })
    .from(repositories)
    .where(eq(repositories.ownerId, user.id))
    .limit(1);

  if (!repo) {
    return c.redirect(
      "/settings/integrations?error=" +
        encodeURIComponent("Create a repo first so we have something to notify about")
    );
  }

  await notifyChatChannels({
    ownerUserId: user.id,
    repositoryId: repo.id,
    event: {
      event: "test.notification",
      repo: `${user.username}/${repo.name}`,
      title: "Test notification from Gluecron",
      url: `/${user.username}/${repo.name}`,
      body: "If you see this in your channel, your integration is wired up correctly.",
      actor: user.username,
    },
  });

  return c.redirect("/settings/integrations?success=Test+fired");
});

export default r;
