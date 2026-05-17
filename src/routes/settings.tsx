/**
 * User settings routes — profile, SSH keys.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, sshKeys } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";
import { raw } from "hono/html";
import { composeDigest } from "../lib/email-digest";
import {
  composeSleepModeReport,
  renderSleepModeDigest,
} from "../lib/sleep-mode";
import {
  scheduleAccountDeletion,
  cancelAccountDeletion,
  daysUntilPurge,
} from "../lib/account-deletion";
import { deleteCookie } from "hono/cookie";

const settings = new Hono<AuthEnv>();

// Auth guard scoped to /settings paths only
settings.use("/settings/*", requireAuth);
settings.use("/settings", requireAuth);
settings.use("/api/user/*", requireAuth);

// Inline, scoped CSS — every class prefixed with `.settings-` so the block
// cannot bleed into other surfaces. Pattern mirrors the dashboard-hero polish
// (commit a004c46) and auth-container gradient hairline (commit 98f45b4).
const settingsStyles = `
  .settings-container { max-width: 880px; margin: 0 auto; }

  /* ─── Hero ─── */
  .settings-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .settings-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .settings-hero-bg {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 360px; height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .settings-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.65;
    animation: settingsHeroOrb 14s ease-in-out infinite;
  }
  @keyframes settingsHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.55; }
    50%      { transform: scale(1.08) translate(-8px, 6px); opacity: 0.78; }
  }
  @media (prefers-reduced-motion: reduce) {
    .settings-hero-orb { animation: none; }
  }
  .settings-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 640px;
  }
  .settings-hero-eyebrow {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: -0.005em;
    text-transform: none;
  }
  .settings-hero-eyebrow .settings-hero-username {
    color: var(--accent);
    font-weight: 600;
  }
  .settings-hero-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .settings-hero-title .gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .settings-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  /* ─── Sub-nav (pill row) ─── */
  .settings-subnav {
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
  .settings-subnav a {
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
  .settings-subnav a:hover {
    color: var(--text-strong);
    background: var(--bg-hover);
  }
  .settings-subnav a.is-active {
    color: var(--text-strong);
    background: rgba(140,109,255,0.16);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }

  /* ─── Section cards ─── */
  .settings-section {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    margin-bottom: var(--space-5);
    overflow: hidden;
  }
  .settings-section-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  .settings-section-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .settings-section-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .settings-section-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .settings-section-body { padding: var(--space-4) var(--space-5); }
  .settings-section-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  .settings-section-foot .settings-foot-hint {
    margin-right: auto;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* ─── Form rows ─── */
  .settings-field { margin-bottom: var(--space-4); }
  .settings-field:last-child { margin-bottom: 0; }
  .settings-field-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
    letter-spacing: -0.005em;
  }
  .settings-field-hint {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 6px;
    line-height: 1.45;
  }
  .settings-input,
  .settings-textarea {
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
  }
  .settings-textarea {
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.5;
    resize: vertical;
  }
  .settings-input:focus,
  .settings-textarea:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .settings-input:disabled {
    color: var(--text-muted);
    background: var(--bg-secondary);
    cursor: not-allowed;
  }

  /* ─── Checkbox / toggle rows ─── */
  .settings-toggle-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
    margin-bottom: 8px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .settings-toggle-row:hover {
    border-color: var(--border);
    background: rgba(255,255,255,0.02);
  }
  .settings-toggle-row input[type="checkbox"] {
    margin-top: 2px;
    flex-shrink: 0;
    width: 16px; height: 16px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .settings-toggle-text {
    flex: 1;
    font-size: 14px;
    color: var(--text);
    line-height: 1.45;
  }
  .settings-toggle-text code {
    font-size: 12px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .settings-toggle-text-hint {
    display: block;
    margin-top: 3px;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* ─── Sleep mode state pill ─── */
  .settings-sleep-state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.01em;
    margin-bottom: var(--space-3);
  }
  .settings-sleep-state.is-on {
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .settings-sleep-state.is-off {
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .settings-sleep-state .dot {
    width: 7px; height: 7px;
    border-radius: 9999px;
    background: currentColor;
    box-shadow: 0 0 8px currentColor;
  }
  .settings-sleep-state.is-off .dot { box-shadow: none; opacity: 0.6; }
  .settings-hour-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-top: var(--space-3);
    font-size: 13.5px;
    color: var(--text);
  }
  .settings-hour-input {
    width: 76px;
    padding: 7px 10px;
    font-family: var(--font-mono);
    font-size: 13.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
  }
  .settings-hour-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .settings-hour-row a {
    color: var(--text-link);
    font-size: 13px;
  }

  /* ─── SSH key cards ─── */
  .settings-key-card {
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
  .settings-key-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.018);
  }
  .settings-key-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0 0 4px;
  }
  .settings-key-fp {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    padding: 2px 8px;
    border-radius: 6px;
    margin-right: 8px;
    word-break: break-all;
  }
  .settings-key-meta {
    margin-top: 6px;
    font-size: 12.5px;
    color: var(--text-muted);
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .settings-empty {
    padding: var(--space-5);
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: 12px;
    background: var(--bg-secondary);
    color: var(--text-muted);
    font-size: 13.5px;
  }

  /* ─── Push device panel ─── */
  .settings-push-card {
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-secondary);
  }
  .settings-push-status {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }
  .settings-push-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .settings-push-msg {
    margin-top: 8px;
    font-size: 12px;
    color: var(--text-muted);
    min-height: 1em;
  }

  /* ─── Banners (success / error) ─── */
  .settings-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 12px;
    font-size: 13.5px;
    margin-bottom: var(--space-4);
    line-height: 1.5;
  }
  .settings-banner-success {
    background: rgba(52,211,153,0.08);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .settings-banner-error {
    background: rgba(248,113,113,0.08);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30);
  }
  .settings-banner-icon {
    width: 18px; height: 18px;
    border-radius: 9999px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
  }
  .settings-banner-success .settings-banner-icon {
    background: rgba(52,211,153,0.18);
    color: #34d399;
  }
  .settings-banner-error .settings-banner-icon {
    background: rgba(248,113,113,0.18);
    color: #f87171;
  }

  /* ─── Danger zone ─── */
  .settings-danger {
    position: relative;
    margin-top: var(--space-6);
    padding: 0;
    border: 1px solid rgba(248,113,113,0.30);
    border-radius: 14px;
    background:
      linear-gradient(180deg, rgba(248,113,113,0.05) 0%, rgba(248,113,113,0.02) 100%),
      var(--bg-elevated);
    overflow: hidden;
  }
  .settings-danger::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f87171 30%, #ffb45e 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .settings-danger-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid rgba(248,113,113,0.15);
  }
  .settings-danger-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #f87171;
    margin-bottom: 6px;
  }
  .settings-danger-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .settings-danger-body { padding: var(--space-4) var(--space-5); }
  .settings-danger-body p { margin: 0 0 var(--space-3); font-size: 14px; line-height: 1.55; }
  .settings-danger-body p:last-child { margin-bottom: 0; }
  .settings-danger-body p.muted { color: var(--text-muted); font-size: 13px; }
  .settings-danger-row {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
    margin-top: var(--space-3);
  }
  .settings-danger-input {
    font-family: var(--font-mono);
    font-size: 13px;
    padding: 8px 12px;
    min-width: 240px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid rgba(248,113,113,0.35);
    border-radius: 8px;
    outline: none;
  }
  .settings-danger-input:focus {
    border-color: #f87171;
    box-shadow: 0 0 0 3px rgba(248,113,113,0.20);
  }
  .settings-danger-scheduled {
    padding: 12px 14px;
    border-radius: 10px;
    background: rgba(248,113,113,0.10);
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30);
    margin-bottom: var(--space-3);
    font-size: 13.5px;
  }
  .settings-danger-scheduled strong { color: #fca5a5; }

  /* ─── Responsive ─── */
  @media (max-width: 720px) {
    .settings-hero { padding: var(--space-4) var(--space-4); }
    .settings-section-head,
    .settings-section-body,
    .settings-section-foot,
    .settings-danger-head,
    .settings-danger-body { padding-left: var(--space-4); padding-right: var(--space-4); }
    .settings-subnav { width: 100%; }
  }
`;

/** Shared hero header used at the top of /settings and /settings/keys. */
function SettingsHero(props: {
  username: string;
  title: string;
  accent?: string; // word(s) rendered with the gradient treatment
  sub: string;
}) {
  const { username, title, accent, sub } = props;
  return (
    <div class="settings-hero">
      <div class="settings-hero-bg" aria-hidden="true">
        <div class="settings-hero-orb" />
      </div>
      <div class="settings-hero-inner">
        <div class="settings-hero-eyebrow">
          Your account ·{" "}
          <span class="settings-hero-username">{username}</span>
        </div>
        <h1 class="settings-hero-title">
          {accent ? (
            <>
              {title}{" "}
              <span class="gradient-text">{accent}</span>.
            </>
          ) : (
            <>{title}.</>
          )}
        </h1>
        <p class="settings-hero-sub">{sub}</p>
      </div>
    </div>
  );
}

/** Pill-row sub-navigation, hand-built so we don't depend on shared components. */
function SettingsSubnav(props: { active: "profile" | "keys" }) {
  const items: Array<{ key: "profile" | "keys"; href: string; label: string }> = [
    { key: "profile", href: "/settings", label: "Profile" },
    { key: "keys", href: "/settings/keys", label: "SSH keys" },
  ];
  return (
    <nav class="settings-subnav" aria-label="Settings sections">
      {items.map((it) => (
        <a
          href={it.href}
          class={it.key === props.active ? "is-active" : ""}
          aria-current={it.key === props.active ? "page" : undefined}
        >
          {it.label}
        </a>
      ))}
    </nav>
  );
}

function Banner(props: { kind: "success" | "error"; text: string }) {
  return (
    <div class={`settings-banner settings-banner-${props.kind}`} role="status">
      <span class="settings-banner-icon" aria-hidden="true">
        {props.kind === "success" ? "✓" : "!"}
      </span>
      <span>{props.text}</span>
    </div>
  );
}

// Profile settings
settings.get("/settings", (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  return c.html(
    <Layout title="Settings" user={user}>
      <style dangerouslySetInnerHTML={{ __html: settingsStyles }} />
      <div class="settings-container">
        <SettingsHero
          username={user.username}
          title="Your"
          accent="settings"
          sub="Profile, notifications, sleep mode, and account controls — all in one place."
        />
        <SettingsSubnav active="profile" />

        {success && (
          <Banner kind="success" text={decodeURIComponent(success)} />
        )}

        {/* ─── Profile ─── */}
        <section class="settings-section">
          <div class="settings-section-head">
            <div class="settings-section-eyebrow">Profile</div>
            <h2 class="settings-section-title">Public identity</h2>
            <p class="settings-section-desc">
              How you appear across repositories, issues, and reviews.
            </p>
          </div>
          <form method="post" action="/settings/profile">
            <div class="settings-section-body">
              <div class="settings-field">
                <label class="settings-field-label" for="username">Username</label>
                <input
                  class="settings-input"
                  name="username"
                  id="username"
                  type="text"
                  value={user.username}
                  disabled
                />
                <div class="settings-field-hint">
                  Your username is permanent and used in URLs.
                </div>
              </div>
              <div class="settings-field">
                <label class="settings-field-label" for="display_name">Display name</label>
                <input
                  class="settings-input"
                  name="display_name"
                  id="display_name"
                  value={user.displayName || ""}
                  placeholder="Your display name"
                />
              </div>
              <div class="settings-field">
                <label class="settings-field-label" for="bio">Bio</label>
                <textarea
                  class="settings-textarea"
                  name="bio"
                  id="bio"
                  rows={3}
                  placeholder="Tell us about yourself"
                  style="font-family: var(--font-sans); font-size: 14px"
                >{user.bio || ""}</textarea>
              </div>
              <div class="settings-field">
                <label class="settings-field-label" for="email">Email</label>
                <input
                  class="settings-input"
                  name="email"
                  id="email"
                  type="email"
                  value={user.email}
                  required
                />
                <div class="settings-field-hint">
                  Used for sign-in, digests, and security notifications.
                </div>
              </div>
            </div>
            <div class="settings-section-foot">
              <button type="submit" class="btn btn-primary">
                Update profile
              </button>
            </div>
          </form>
        </section>

        {/* ─── Email notifications + Sleep Mode + Push (single form, single save) ─── */}
        <form method="post" action="/settings/notifications">
          <section class="settings-section">
            <div class="settings-section-head">
              <div class="settings-section-eyebrow">Email</div>
              <h2 class="settings-section-title">Email notifications</h2>
              <p class="settings-section-desc">
                Opt out of individual email categories. In-app notifications
                are unaffected and continue to appear in your inbox.
              </p>
            </div>
            <div class="settings-section-body">
              <label class="settings-toggle-row">
                <input
                  type="checkbox"
                  name="notify_email_on_mention"
                  value="1"
                  checked={user.notifyEmailOnMention}
                  aria-label="Someone @mentions me or requests a review"
                />
                <span class="settings-toggle-text">
                  Someone <code>@mentions</code> me or requests a review
                  <span class="settings-toggle-text-hint">
                    Direct pings on issues, PRs, and code comments.
                  </span>
                </span>
              </label>
              <label class="settings-toggle-row">
                <input
                  type="checkbox"
                  name="notify_email_on_assign"
                  value="1"
                  checked={user.notifyEmailOnAssign}
                  aria-label="I am assigned to an issue or PR"
                />
                <span class="settings-toggle-text">
                  I am assigned to an issue or PR
                  <span class="settings-toggle-text-hint">
                    Email when someone hands you something to work on.
                  </span>
                </span>
              </label>
              <label class="settings-toggle-row">
                <input
                  type="checkbox"
                  name="notify_email_on_gate_fail"
                  value="1"
                  checked={user.notifyEmailOnGateFail}
                  aria-label="A gate fails on one of my repositories"
                />
                <span class="settings-toggle-text">
                  A gate fails on one of my repositories
                  <span class="settings-toggle-text-hint">
                    Security, test, or build gate alerts on your repos.
                  </span>
                </span>
              </label>
              <label class="settings-toggle-row">
                <input
                  type="checkbox"
                  name="notify_email_digest_weekly"
                  value="1"
                  checked={user.notifyEmailDigestWeekly}
                  aria-label="Weekly digest email"
                />
                <span class="settings-toggle-text">
                  Weekly digest &mdash;{" "}
                  <a href="/settings/digest/preview">preview</a>
                  <span class="settings-toggle-text-hint">
                    A Monday summary of what shipped last week.
                  </span>
                </span>
              </label>
            </div>
          </section>

          {/* ─── Sleep Mode ─── */}
          <section class="settings-section">
            <div class="settings-section-head">
              <div class="settings-section-eyebrow">Autonomy</div>
              <h2 class="settings-section-title">Sleep Mode</h2>
              <p class="settings-section-desc">
                Toggle Sleep Mode. Walk away. Wake up to a daily digest of
                what Claude shipped overnight &mdash; PRs auto-merged, issues
                built from <code>ai:build</code> labels, AI reviews, security
                auto-fixes, gate auto-repairs.{" "}
                <a href="/sleep-mode">Learn more</a>.
              </p>
            </div>
            <div class="settings-section-body">
              <div
                class={
                  "settings-sleep-state " +
                  (user.sleepModeEnabled ? "is-on" : "is-off")
                }
                aria-live="polite"
              >
                <span class="dot" aria-hidden="true" />
                {user.sleepModeEnabled ? "Sleep Mode active" : "Sleep Mode off"}
              </div>
              <label class="settings-toggle-row">
                <input
                  type="checkbox"
                  name="sleep_mode_enabled"
                  value="1"
                  checked={user.sleepModeEnabled}
                  aria-label="Enable Sleep Mode"
                />
                <span class="settings-toggle-text">
                  Enable Sleep Mode (daily &ldquo;overnight&rdquo; digest)
                  <span class="settings-toggle-text-hint">
                    Claude operates autonomously between digests and reports
                    back on a schedule you control.
                  </span>
                </span>
              </label>
              <div class="settings-hour-row">
                <label for="sleep_mode_digest_hour_utc">
                  Send my morning digest at (UTC hour, 0&ndash;23):
                </label>
                <input
                  class="settings-hour-input"
                  type="number"
                  id="sleep_mode_digest_hour_utc"
                  name="sleep_mode_digest_hour_utc"
                  min={0}
                  max={23}
                  step={1}
                  value={String(user.sleepModeDigestHourUtc)}
                  aria-label="Sleep Mode digest UTC hour"
                />
                <a href="/settings/sleep-mode/preview">Preview digest now</a>
              </div>
            </div>
          </section>

          {/* ─── Mobile push ─── */}
          <section class="settings-section">
            <div class="settings-section-head">
              <div class="settings-section-eyebrow">Mobile</div>
              <h2 class="settings-section-title">Mobile push notifications</h2>
              <p class="settings-section-desc">
                Install Gluecron as a PWA (look for the install banner at the
                bottom of the page after a few visits) to get push notifications
                when something needs your attention. Per-event filters below
                control which notification kinds trigger a push.
              </p>
            </div>
            <div class="settings-section-body">
              <label class="settings-toggle-row">
                <input
                  type="checkbox"
                  name="notify_push_on_mention"
                  value="1"
                  checked={user.notifyPushOnMention}
                  aria-label="Someone @mentions me"
                />
                <span class="settings-toggle-text">
                  Someone <code>@mentions</code> me
                </span>
              </label>
              <label class="settings-toggle-row">
                <input
                  type="checkbox"
                  name="notify_push_on_assign"
                  value="1"
                  checked={user.notifyPushOnAssign}
                  aria-label="I am assigned to an issue or PR"
                />
                <span class="settings-toggle-text">
                  I am assigned to an issue or PR
                </span>
              </label>
              <label class="settings-toggle-row">
                <input
                  type="checkbox"
                  name="notify_push_on_review_request"
                  value="1"
                  checked={user.notifyPushOnReviewRequest}
                  aria-label="Someone requests a review from me"
                />
                <span class="settings-toggle-text">
                  Someone requests a review from me
                </span>
              </label>
              <label class="settings-toggle-row">
                <input
                  type="checkbox"
                  name="notify_push_on_deploy_failed"
                  value="1"
                  checked={user.notifyPushOnDeployFailed}
                  aria-label="A deploy fails"
                />
                <span class="settings-toggle-text">
                  A deploy fails on one of my repositories
                </span>
              </label>
            </div>
            <div class="settings-section-foot">
              <span class="settings-foot-hint">
                Saved across email, sleep mode, and push.
              </span>
              <button type="submit" class="btn btn-primary">
                Save preferences
              </button>
            </div>
          </section>
        </form>

        {/* ─── Push device controls (separate, JS-driven) ─── */}
        <section class="settings-section">
          <div class="settings-section-head">
            <div class="settings-section-eyebrow">This device</div>
            <h2 class="settings-section-title">Push subscription</h2>
            <p class="settings-section-desc">
              Subscribe this browser to receive push notifications. Each device
              you sign in from can be subscribed independently.
            </p>
          </div>
          <div class="settings-section-body">
            <div id="gc-push-device" class="settings-push-card">
              <div id="gc-push-status" class="settings-push-status">
                Push status: checking…
              </div>
              <div class="settings-push-actions">
                <button type="button" id="gc-push-subscribe" class="btn btn-sm btn-primary">
                  Subscribe on this device
                </button>
                <button type="button" id="gc-push-unsubscribe" class="btn btn-sm">
                  Unsubscribe
                </button>
                <button type="button" id="gc-push-test" class="btn btn-sm">
                  Send test notification
                </button>
              </div>
              <div id="gc-push-msg" role="status" class="settings-push-msg" />
            </div>
          </div>
        </section>

        <script dangerouslySetInnerHTML={{ __html: pushDeviceScript }} />
        {renderDeleteAccountSection({ user, csrfToken: c.get("csrfToken") })}
      </div>
    </Layout>
  );
});

/** Block P5 — Danger zone at bottom of /settings. */
function renderDeleteAccountSection(args: {
  user: { id: string; username: string; deletedAt: Date | null; deletionScheduledFor: Date | null };
  csrfToken: string | undefined;
}) {
  const { user, csrfToken } = args;
  const scheduled = user.deletedAt !== null;
  const daysLeft = daysUntilPurge({ deletionScheduledFor: user.deletionScheduledFor });

  if (scheduled) {
    return (
      <section class="settings-danger" aria-label="Account deletion scheduled">
        <div class="settings-danger-head">
          <div class="settings-danger-eyebrow">Danger zone</div>
          <h3 class="settings-danger-title">Account scheduled for deletion</h3>
        </div>
        <div class="settings-danger-body">
          <div class="settings-danger-scheduled">
            Your account is scheduled for permanent deletion in{" "}
            <strong>{daysLeft ?? 0}</strong>{" "}
            {daysLeft === 1 ? "day" : "days"}.
          </div>
          <p>
            Cancel below to keep your account; signing in again also cancels
            the deletion automatically.
          </p>
          <form method="post" action="/settings/delete-account/cancel">
            <input type="hidden" name="_csrf" value={csrfToken || ""} />
            <button type="submit" class="btn btn-primary">
              Cancel deletion
            </button>
          </form>
        </div>
      </section>
    );
  }

  return (
    <section class="settings-danger" aria-label="Delete account">
      <div class="settings-danger-head">
        <div class="settings-danger-eyebrow">Danger zone</div>
        <h3 class="settings-danger-title">Delete account</h3>
      </div>
      <div class="settings-danger-body">
        <p>
          Deleting your account starts a 30-day grace period. Your repos,
          issues, PRs, and settings are kept during that window — sign in any
          time before it ends to cancel. After 30 days everything is
          permanently purged.
        </p>
        <p class="muted">
          To confirm, type your username (<code>{user.username}</code>) below.
        </p>
        <form method="post" action="/settings/delete-account">
          <input type="hidden" name="_csrf" value={csrfToken || ""} />
          <div class="settings-danger-row">
            <input
              class="settings-danger-input"
              type="text"
              name="confirm_username"
              required
              autocomplete="off"
              placeholder={user.username}
              aria-label="Type your username to confirm account deletion"
            />
            <button type="submit" class="btn btn-danger">
              Delete my account
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

// Block P5 — schedule a deletion.
settings.post("/settings/delete-account", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const confirm = String(body.confirm_username || "").trim();
  if (confirm !== user.username) {
    return c.text(
      "Username confirmation did not match. Account NOT deleted.",
      400
    );
  }
  const result = await scheduleAccountDeletion(user.id);
  if (!result.ok) {
    return c.text("Failed to schedule deletion. Please try again later.", 500);
  }
  deleteCookie(c, "session", { path: "/" });
  return c.redirect("/login?info=Account+scheduled+for+deletion");
});

// Block P5 — cancel a pending deletion.
settings.post("/settings/delete-account/cancel", async (c) => {
  const user = c.get("user")!;
  await cancelAccountDeletion(user.id);
  return c.redirect("/settings?success=Account+deletion+cancelled");
});

// Preview the Sleep Mode digest in-browser (rendered HTML).
settings.get("/settings/sleep-mode/preview", async (c) => {
  const user = c.get("user")!;
  const report = await composeSleepModeReport(user.id);
  const rendered = renderSleepModeDigest(report, { username: user.username });
  const total =
    report.prsAutoMerged.length +
    report.issuesBuiltByAi.length +
    report.aiReviewsPosted +
    report.securityIssuesAutoFixed +
    report.gateFailuresAutoRepaired;
  return c.html(
    <Layout title="Sleep Mode preview" user={user}>
      <h2>Sleep Mode preview</h2>
      <p style="color:var(--text-muted);font-size:13px">
        Subject: <code>{rendered.subject}</code>
      </p>
      <p style="font-size:12px;color:var(--text-muted)">
        Window: {report.windowHours}h &middot; PRs auto-merged:{" "}
        {report.prsAutoMerged.length} &middot; Issues built:{" "}
        {report.issuesBuiltByAi.length} &middot; AI reviews:{" "}
        {report.aiReviewsPosted} &middot; Security auto-fixed:{" "}
        {report.securityIssuesAutoFixed} &middot; Gates repaired:{" "}
        {report.gateFailuresAutoRepaired} &middot; Hours saved:{" "}
        {report.hoursSaved} &middot; Total events: {total}
      </p>
      <div class="panel" style="padding:var(--space-5);background:#fff;color:#111">
        {raw(rendered.html)}
      </div>
      <p style="margin-top:20px">
        <a href="/settings">Back to settings</a>
      </p>
    </Layout>
  );
});

// Preview the weekly digest in-browser (rendered HTML)
settings.get("/settings/digest/preview", async (c) => {
  const user = c.get("user")!;
  const body = await composeDigest(user.id);
  if (!body) {
    return c.html(
      <Layout title="Digest preview" user={user}>
        <h2>Digest preview</h2>
        <p>Could not compose a digest right now.</p>
        <p>
          <a href="/settings">Back to settings</a>
        </p>
      </Layout>
    );
  }
  return c.html(
    <Layout title="Digest preview" user={user}>
      <h2>Digest preview</h2>
      <p style="color:var(--text-muted);font-size:13px">
        Subject: <code>{body.subject}</code>
      </p>
      <p style="font-size:12px;color:var(--text-muted)">
        Notifications: {body.counts.notifications} · Failed gates:{" "}
        {body.counts.failedGates} · Repaired: {body.counts.repairedGates} ·
        Merged PRs: {body.counts.mergedPrs}
      </p>
      <div
        class="panel"
        style="padding:var(--space-5);background:#fff;color:#111"
      >
        {raw(body.html)}
      </div>
      <p style="margin-top:20px">
        <a href="/settings">Back to settings</a>
      </p>
    </Layout>
  );
});

settings.post("/settings/notifications", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  // Coerce the Sleep Mode hour to a clamped integer 0-23.
  const rawHour = String(body.sleep_mode_digest_hour_utc ?? "");
  let hour = Number.parseInt(rawHour, 10);
  if (!Number.isFinite(hour)) hour = user.sleepModeDigestHourUtc;
  if (hour < 0) hour = 0;
  if (hour > 23) hour = 23;
  await db
    .update(users)
    .set({
      notifyEmailOnMention: String(body.notify_email_on_mention || "") === "1",
      notifyEmailOnAssign: String(body.notify_email_on_assign || "") === "1",
      notifyEmailOnGateFail:
        String(body.notify_email_on_gate_fail || "") === "1",
      notifyEmailDigestWeekly:
        String(body.notify_email_digest_weekly || "") === "1",
      sleepModeEnabled: String(body.sleep_mode_enabled || "") === "1",
      sleepModeDigestHourUtc: hour,
      // Block M2 — per-event push preferences.
      notifyPushOnMention:
        String(body.notify_push_on_mention || "") === "1",
      notifyPushOnAssign:
        String(body.notify_push_on_assign || "") === "1",
      notifyPushOnReviewRequest:
        String(body.notify_push_on_review_request || "") === "1",
      notifyPushOnDeployFailed:
        String(body.notify_push_on_deploy_failed || "") === "1",
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));
  return c.redirect("/settings?success=Notification+preferences+updated");
});

// Block M2 — client-side device subscribe/unsubscribe/test helpers. Plain
// JS, no framework; reads/writes via the /pwa/* endpoints.
const pushDeviceScript = `
(function(){
  var statusEl = document.getElementById('gc-push-status');
  var msgEl    = document.getElementById('gc-push-msg');
  var subBtn   = document.getElementById('gc-push-subscribe');
  var unsubBtn = document.getElementById('gc-push-unsubscribe');
  var testBtn  = document.getElementById('gc-push-test');
  function setStatus(s){ if (statusEl) statusEl.textContent = 'Push status: ' + s; }
  function setMsg(s){ if (msgEl) msgEl.textContent = s; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setStatus("Browser doesn't support push");
    if (subBtn) subBtn.disabled = true;
    if (unsubBtn) unsubBtn.disabled = true;
    if (testBtn) testBtn.disabled = true;
    return;
  }
  function b64uToU8(s){
    var pad = '='.repeat((4 - s.length % 4) % 4);
    var b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i=0; i<bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function getReg(){
    return navigator.serviceWorker.getRegistration('/').then(function(r){
      return r || navigator.serviceWorker.register('/sw-push.js', { scope: '/' });
    });
  }
  function refresh(){
    getReg().then(function(reg){
      return reg.pushManager.getSubscription();
    }).then(function(sub){
      if (sub) {
        setStatus('Enabled on this device');
        if (subBtn) subBtn.disabled = true;
        if (unsubBtn) unsubBtn.disabled = false;
        if (testBtn) testBtn.disabled = false;
      } else {
        setStatus('Not subscribed on this device');
        if (subBtn) subBtn.disabled = false;
        if (unsubBtn) unsubBtn.disabled = true;
        if (testBtn) testBtn.disabled = true;
      }
    }).catch(function(){ setStatus('unavailable'); });
  }
  if (subBtn) subBtn.addEventListener('click', function(){
    setMsg('Requesting permission…');
    Notification.requestPermission().then(function(perm){
      if (perm !== 'granted') { setMsg('Permission denied.'); return; }
      return fetch('/pwa/vapid-public-key').then(function(r){ return r.json(); }).then(function(j){
        if (!j || !j.key) throw new Error('no vapid key');
        return getReg().then(function(reg){
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: b64uToU8(j.key),
          });
        });
      }).then(function(sub){
        var json = sub.toJSON();
        return fetch('/pwa/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
        });
      }).then(function(){ setMsg('Subscribed.'); refresh(); });
    }).catch(function(err){ setMsg('Failed: ' + (err && err.message || err)); });
  });
  if (unsubBtn) unsubBtn.addEventListener('click', function(){
    getReg().then(function(reg){
      return reg.pushManager.getSubscription();
    }).then(function(sub){
      if (!sub) return;
      var endpoint = sub.endpoint;
      return sub.unsubscribe().then(function(){
        return fetch('/pwa/unsubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: endpoint }),
        });
      });
    }).then(function(){ setMsg('Unsubscribed.'); refresh(); })
      .catch(function(err){ setMsg('Failed: ' + (err && err.message || err)); });
  });
  if (testBtn) testBtn.addEventListener('click', function(){
    fetch('/pwa/test', { method: 'POST' }).then(function(r){ return r.json(); })
      .then(function(j){
        setMsg('Sent ' + (j.sent || 0) + ', failed ' + (j.failed || 0) + '.');
      }).catch(function(err){ setMsg('Failed: ' + (err && err.message || err)); });
  });
  refresh();
})();
`;

settings.post("/settings/profile", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();

  await db
    .update(users)
    .set({
      displayName: String(body.display_name || "").trim() || null,
      bio: String(body.bio || "").trim() || null,
      email: String(body.email || "").trim() || user.email,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return c.redirect("/settings?success=Profile+updated");
});

/** Relative-time helper for "Last used 3 days ago" style copy. */
function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) {
    const hours = Math.max(1, Math.floor(diff / (60 * 60 * 1000)));
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.floor(diff / day);
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

// SSH Keys page
settings.get("/settings/keys", async (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  const error = c.req.query("error");

  const keys = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.userId, user.id));

  return c.html(
    <Layout title="SSH Keys" user={user}>
      <style dangerouslySetInnerHTML={{ __html: settingsStyles }} />
      <div class="settings-container">
        <SettingsHero
          username={user.username}
          title="SSH"
          accent="keys"
          sub="Authenticate git pushes and clones over SSH. Each device or workstation gets its own key."
        />
        <SettingsSubnav active="keys" />

        {success && (
          <Banner kind="success" text={decodeURIComponent(success)} />
        )}
        {error && <Banner kind="error" text={decodeURIComponent(error)} />}

        <section class="settings-section">
          <div class="settings-section-head">
            <div class="settings-section-eyebrow">Authorized keys</div>
            <h2 class="settings-section-title">
              {keys.length === 0
                ? "No keys yet"
                : keys.length === 1
                ? "1 key"
                : `${keys.length} keys`}
            </h2>
            <p class="settings-section-desc">
              Any of these keys can push to repositories you own.
            </p>
          </div>
          <div class="settings-section-body">
            {keys.length === 0 ? (
              <div class="settings-empty">
                No SSH keys yet. Add one below to push and clone over SSH.
              </div>
            ) : (
              keys.map((key) => (
                <div class="settings-key-card">
                  <div style="min-width:0;flex:1">
                    <div class="settings-key-title">{key.title}</div>
                    <code class="settings-key-fp">{key.fingerprint}</code>
                    <div class="settings-key-meta">
                      <span>
                        Added{" "}
                        {new Date(key.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </span>
                      {key.lastUsedAt ? (
                        <span>
                          Last used {relativeTime(new Date(key.lastUsedAt))}
                        </span>
                      ) : (
                        <span>Never used</span>
                      )}
                    </div>
                  </div>
                  <form method="post" action={`/settings/keys/${key.id}/delete`}>
                    <button type="submit" class="btn btn-danger btn-sm">
                      Delete
                    </button>
                  </form>
                </div>
              ))
            )}
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-section-head">
            <div class="settings-section-eyebrow">Add a key</div>
            <h2 class="settings-section-title">New SSH key</h2>
            <p class="settings-section-desc">
              Paste a public key (the contents of <code>~/.ssh/id_ed25519.pub</code>
              {" "}or similar). Supported types: <code>ssh-ed25519</code>,{" "}
              <code>ssh-rsa</code>, <code>ecdsa-sha2-*</code>.
            </p>
          </div>
          <form method="post" action="/settings/keys">
            <div class="settings-section-body">
              <div class="settings-field">
                <label class="settings-field-label" for="title">Title</label>
                <input
                  class="settings-input"
                  type="text"
                  id="title"
                  name="title"
                  required
                  placeholder="e.g. My laptop"
                />
                <div class="settings-field-hint">
                  A label so you can recognise this key later.
                </div>
              </div>
              <div class="settings-field">
                <label class="settings-field-label" for="public_key">Public key</label>
                <textarea
                  class="settings-textarea"
                  id="public_key"
                  name="public_key"
                  rows={5}
                  required
                  placeholder="ssh-ed25519 AAAA... or ssh-rsa AAAA..."
                />
                <div class="settings-field-hint">
                  Generate one with <code>ssh-keygen -t ed25519</code> then paste
                  the contents of the resulting <code>.pub</code> file.
                </div>
              </div>
            </div>
            <div class="settings-section-foot">
              <button type="submit" class="btn btn-primary">
                Add SSH key
              </button>
            </div>
          </form>
        </section>
      </div>
    </Layout>
  );
});

settings.post("/settings/keys", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const title = String(body.title || "").trim();
  const publicKey = String(body.public_key || "").trim();

  if (!title || !publicKey) {
    return c.redirect("/settings/keys?error=Title+and+key+are+required");
  }

  // Basic validation
  if (
    !publicKey.startsWith("ssh-rsa ") &&
    !publicKey.startsWith("ssh-ed25519 ") &&
    !publicKey.startsWith("ecdsa-sha2-")
  ) {
    return c.redirect("/settings/keys?error=Invalid+SSH+public+key+format");
  }

  // Generate a simple fingerprint (hash of key data)
  const keyData = publicKey.split(" ")[1] || "";
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keyData)
  );
  const fingerprint =
    "SHA256:" +
    btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
      .replace(/=+$/, "");

  await db.insert(sshKeys).values({
    userId: user.id,
    title,
    fingerprint,
    publicKey,
  });

  return c.redirect("/settings/keys?success=SSH+key+added");
});

settings.post("/settings/keys/:id/delete", async (c) => {
  const user = c.get("user")!;
  const keyId = c.req.param("id");

  // Verify ownership
  const [key] = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.id, keyId))
    .limit(1);

  if (!key || key.userId !== user.id) {
    return c.redirect("/settings/keys?error=Key+not+found");
  }

  await db.delete(sshKeys).where(eq(sshKeys.id, keyId));
  return c.redirect("/settings/keys?success=SSH+key+deleted");
});

// SSH Keys API
settings.get("/api/user/keys", async (c) => {
  const user = c.get("user")!;
  const keys = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.userId, user.id));
  return c.json(keys);
});

settings.post("/api/user/keys", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ title: string; public_key: string }>();

  if (!body.title || !body.public_key) {
    return c.json({ error: "title and public_key are required" }, 400);
  }

  const keyData = body.public_key.split(" ")[1] || "";
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keyData)
  );
  const fingerprint =
    "SHA256:" +
    btoa(String.fromCharCode(...new Uint8Array(hashBuffer))).replace(/=+$/, "");

  const [key] = await db
    .insert(sshKeys)
    .values({
      userId: user.id,
      title: body.title,
      fingerprint,
      publicKey: body.public_key,
    })
    .returning();

  return c.json(key, 201);
});

settings.delete("/api/user/keys/:id", async (c) => {
  const user = c.get("user")!;
  const keyId = c.req.param("id");

  const [key] = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.id, keyId))
    .limit(1);

  if (!key || key.userId !== user.id) {
    return c.json({ error: "Key not found" }, 404);
  }

  await db.delete(sshKeys).where(eq(sshKeys.id, keyId));
  return c.json({ deleted: true });
});

export default settings;
