/**
 * API tokens — personal access tokens for automation.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiTokens } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const tokens = new Hono<AuthEnv>();

tokens.use("/settings/tokens*", softAuth, requireAuth);
tokens.use("/api/user/tokens*", softAuth, requireAuth);

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    "glc_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Inline, scoped CSS — every class prefixed with `.tokens-` so the block
// cannot bleed into other surfaces. Pattern mirrors the settings polish
// (commit 98eb360) and repo-settings danger-zone (commit 58307ae).
const tokensStyles = `
  .tokens-wrap {
    max-width: 920px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4);
  }

  /* ─── Hero ─── */
  .tokens-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .tokens-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .tokens-hero-bg {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 360px; height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .tokens-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.65;
    animation: tokensHeroOrb 14s ease-in-out infinite;
  }
  @keyframes tokensHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.55; }
    50%      { transform: scale(1.08) translate(-8px, 6px); opacity: 0.78; }
  }
  @media (prefers-reduced-motion: reduce) {
    .tokens-hero-orb { animation: none; }
  }
  .tokens-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 640px;
  }
  .tokens-hero-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: -0.005em;
  }
  .tokens-hero-eyebrow-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 7px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    flex-shrink: 0;
  }
  .tokens-hero-eyebrow-icon svg { width: 12px; height: 12px; display: block; }
  .tokens-hero-eyebrow-sep { opacity: 0.45; }
  .tokens-hero-username {
    color: var(--accent);
    font-weight: 600;
  }
  .tokens-hero-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .tokens-hero-title .tokens-gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .tokens-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    max-width: 620px;
    line-height: 1.5;
  }

  /* ─── Banner: success / revealed-once token ─── */
  .tokens-banner {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px;
    border-radius: 12px;
    font-size: 13.5px;
    margin-bottom: var(--space-4);
    line-height: 1.5;
  }
  .tokens-banner-success {
    background: rgba(52,211,153,0.08);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .tokens-banner-icon {
    width: 20px; height: 20px;
    border-radius: 9999px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    margin-top: 1px;
  }
  .tokens-banner-success .tokens-banner-icon {
    background: rgba(52,211,153,0.18);
    color: #34d399;
  }
  .tokens-banner-body { flex: 1; min-width: 0; }

  /* ─── Revealed-once token card ─── */
  .tokens-reveal {
    position: relative;
    padding: var(--space-4) var(--space-5);
    border-radius: 14px;
    margin-bottom: var(--space-5);
    background:
      linear-gradient(180deg, rgba(140,109,255,0.06) 0%, rgba(54,197,214,0.03) 100%),
      var(--bg-elevated);
    border: 1px solid rgba(140,109,255,0.30);
    overflow: hidden;
  }
  .tokens-reveal::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.85;
    pointer-events: none;
  }
  .tokens-reveal-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #b69dff;
    margin-bottom: 6px;
  }
  .tokens-reveal-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.018em;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .tokens-reveal-value {
    display: block;
    font-family: var(--font-mono);
    font-size: 13px;
    padding: 12px 14px;
    border-radius: 10px;
    background: var(--bg);
    color: var(--text-strong);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    word-break: break-all;
    user-select: all;
    -webkit-user-select: all;
  }
  .tokens-reveal-hint {
    margin: var(--space-3) 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* ─── Section cards ─── */
  .tokens-section {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    margin-bottom: var(--space-5);
    overflow: hidden;
  }
  .tokens-section-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  .tokens-section-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .tokens-section-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .tokens-section-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .tokens-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Token list / cards ─── */
  .tokens-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .tokens-card {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-3);
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-secondary);
    transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
  }
  .tokens-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.02);
  }
  .tokens-card-main { flex: 1; min-width: 0; }
  .tokens-card-name {
    font-size: 14.5px;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0 0 6px;
    word-break: break-word;
  }
  .tokens-card-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .tokens-prefix-pill {
    display: inline-flex;
    align-items: center;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-strong);
    background: var(--bg-tertiary);
    padding: 2px 8px;
    border-radius: 6px;
    box-shadow: inset 0 0 0 1px var(--border);
    word-break: break-all;
  }
  .tokens-scope-chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .tokens-scope-chip {
    display: inline-flex;
    align-items: center;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    padding: 2px 8px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
  }
  .tokens-scope-chip.is-admin {
    background: rgba(248,113,113,0.10);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30);
  }
  .tokens-scope-chip.is-user {
    background: rgba(54,197,214,0.12);
    color: #7adfe9;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.30);
  }
  .tokens-meta-sep {
    opacity: 0.4;
  }
  .tokens-meta-time {
    font-variant-numeric: tabular-nums;
  }
  .tokens-card-action { flex-shrink: 0; }
  .tokens-revoke-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 12.5px;
    font-weight: 600;
    color: #fca5a5;
    background: rgba(248,113,113,0.06);
    border: 1px solid rgba(248,113,113,0.30);
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .tokens-revoke-btn:hover {
    background: rgba(248,113,113,0.14);
    border-color: rgba(248,113,113,0.55);
    color: #fecaca;
  }
  .tokens-revoke-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(248,113,113,0.25);
  }

  /* ─── Empty state ─── */
  .tokens-empty {
    position: relative;
    padding: var(--space-6) var(--space-5);
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    background: var(--bg-secondary);
    text-align: center;
    overflow: hidden;
  }
  .tokens-empty-orb {
    position: absolute;
    inset: -30% 50% auto auto;
    width: 220px; height: 220px;
    background: radial-gradient(circle, rgba(140,109,255,0.16), rgba(54,197,214,0.06) 45%, transparent 70%);
    filter: blur(60px);
    opacity: 0.7;
    pointer-events: none;
  }
  .tokens-empty-inner { position: relative; z-index: 1; }
  .tokens-empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    margin-bottom: 12px;
    border-radius: 12px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
  }
  .tokens-empty-icon svg { width: 22px; height: 22px; display: block; }
  .tokens-empty-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
  }
  .tokens-empty-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0 auto;
    max-width: 420px;
    line-height: 1.5;
  }

  /* ─── Form fields ─── */
  .tokens-field { margin-bottom: var(--space-4); }
  .tokens-field:last-child { margin-bottom: 0; }
  .tokens-field-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
    letter-spacing: -0.005em;
  }
  .tokens-field-hint {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 6px;
    line-height: 1.45;
  }
  .tokens-input {
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
  .tokens-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }

  /* ─── Scope picker ─── */
  .tokens-scope-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .tokens-scope-option {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
    border-radius: 10px;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .tokens-scope-option:hover {
    border-color: var(--border);
    background: rgba(255,255,255,0.02);
  }
  .tokens-scope-option input[type="checkbox"] {
    margin: 0;
    width: 14px; height: 14px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .tokens-scope-option-label {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
  }
  .tokens-scope-option:has(input:checked) {
    border-color: rgba(140,109,255,0.45);
    background: rgba(140,109,255,0.08);
  }

  /* ─── Primary action button ─── */
  .tokens-submit {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 16px;
    font-size: 13.5px;
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #6e54e0 100%);
    border: 1px solid rgba(140,109,255,0.50);
    border-radius: 10px;
    cursor: pointer;
    font-family: inherit;
    box-shadow:
      0 1px 0 rgba(255,255,255,0.10) inset,
      0 4px 16px rgba(140,109,255,0.25);
    transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease;
  }
  .tokens-submit:hover {
    filter: brightness(1.06);
    box-shadow:
      0 1px 0 rgba(255,255,255,0.12) inset,
      0 6px 20px rgba(140,109,255,0.32);
  }
  .tokens-submit:active { transform: translateY(1px); }
  .tokens-submit:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 3px rgba(140,109,255,0.30),
      0 4px 16px rgba(140,109,255,0.25);
  }

  /* ─── Responsive ─── */
  @media (max-width: 720px) {
    .tokens-hero { padding: var(--space-4) var(--space-4); }
    .tokens-section-head,
    .tokens-section-body { padding-left: var(--space-4); padding-right: var(--space-4); }
    .tokens-card {
      flex-direction: column;
      align-items: stretch;
    }
    .tokens-card-action { align-self: flex-end; }
  }
`;

function ShieldIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="M10 13l9-9" />
      <path d="M15 8l3 3" />
      <path d="M18 5l3 3" />
    </svg>
  );
}

/** Format a date as a friendly relative time, with absolute fallback. */
function relativeTime(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  const ms = Date.now() - d.getTime();
  if (Number.isNaN(ms)) return "";
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const yr = Math.floor(mo / 12);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

// Token settings page
tokens.get("/settings/tokens", async (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  const newToken = c.req.query("new_token");
  const error = c.req.query("error");

  const userTokens = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.id));

  return c.html(
    <Layout title="API Tokens" user={user}>
      <style dangerouslySetInnerHTML={{ __html: tokensStyles }} />
      <div class="tokens-wrap">
        {/* ─── Hero ─── */}
        <div class="tokens-hero">
          <div class="tokens-hero-bg" aria-hidden="true">
            <div class="tokens-hero-orb" />
          </div>
          <div class="tokens-hero-inner">
            <div class="tokens-hero-eyebrow">
              <span class="tokens-hero-eyebrow-icon">
                <ShieldIcon />
              </span>
              <span>Personal access tokens</span>
              <span class="tokens-hero-eyebrow-sep">·</span>
              <span>Settings</span>
              <span class="tokens-hero-eyebrow-sep">·</span>
              <span class="tokens-hero-username">{user.username}</span>
            </div>
            <h1 class="tokens-hero-title">
              Tokens for{" "}
              <span class="tokens-gradient-text">automation</span>.
            </h1>
            <p class="tokens-hero-sub">
              Issue scoped credentials for CI, scripts, and the
              Gluecron MCP. Tokens are shown once, hashed at rest, and
              can be revoked anytime.
            </p>
          </div>
        </div>

        {/* ─── Banners ─── */}
        {success && (
          <div class="tokens-banner tokens-banner-success" role="status">
            <span class="tokens-banner-icon" aria-hidden="true">✓</span>
            <div class="tokens-banner-body">{decodeURIComponent(success)}</div>
          </div>
        )}
        {error && (
          <div
            class="tokens-banner tokens-banner-success"
            style="background: rgba(248,113,113,0.08); color: #fca5a5; box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30);"
            role="alert"
          >
            <span
              class="tokens-banner-icon"
              style="background: rgba(248,113,113,0.18); color: #f87171;"
              aria-hidden="true"
            >
              !
            </span>
            <div class="tokens-banner-body">{decodeURIComponent(error)}</div>
          </div>
        )}

        {/* ─── Revealed-once new token ─── */}
        {newToken && (
          <div class="tokens-reveal" role="status" aria-live="polite">
            <div class="tokens-reveal-eyebrow">New token · copy now</div>
            <h2 class="tokens-reveal-title">
              This token will only be shown once
            </h2>
            <code class="tokens-reveal-value">
              {decodeURIComponent(newToken)}
            </code>
            <p class="tokens-reveal-hint">
              Store it somewhere safe — your password manager, CI
              secret store, or the GLUECRON_PAT env var. We can't
              recover it for you.
            </p>
          </div>
        )}

        {/* ─── Existing tokens ─── */}
        <div class="tokens-section">
          <div class="tokens-section-head">
            <div class="tokens-section-eyebrow">Active tokens</div>
            <h2 class="tokens-section-title">Your tokens</h2>
            <p class="tokens-section-desc">
              Each token carries its own scopes and can be revoked
              independently. The 12-character prefix is safe to log;
              the full value is not.
            </p>
          </div>
          <div class="tokens-section-body">
            {userTokens.length === 0 ? (
              <div class="tokens-empty">
                <div class="tokens-empty-orb" aria-hidden="true" />
                <div class="tokens-empty-inner">
                  <div class="tokens-empty-icon" aria-hidden="true">
                    <KeyIcon />
                  </div>
                  <h3 class="tokens-empty-title">No tokens yet</h3>
                  <p class="tokens-empty-desc">
                    Generate one below to authenticate against the
                    Gluecron API, MCP server, or your CI pipeline.
                  </p>
                </div>
              </div>
            ) : (
              <div class="tokens-list">
                {userTokens.map((token) => {
                  const scopes = (token.scopes || "")
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  return (
                    <div class="tokens-card">
                      <div class="tokens-card-main">
                        <div class="tokens-card-name">{token.name}</div>
                        <div class="tokens-card-meta">
                          <span class="tokens-prefix-pill">
                            {token.tokenPrefix}…
                          </span>
                          {scopes.length > 0 && (
                            <span class="tokens-scope-chips">
                              {scopes.map((scope) => (
                                <span
                                  class={`tokens-scope-chip${
                                    scope === "admin"
                                      ? " is-admin"
                                      : scope === "user"
                                      ? " is-user"
                                      : ""
                                  }`}
                                >
                                  {scope}
                                </span>
                              ))}
                            </span>
                          )}
                          {token.lastUsedAt ? (
                            <>
                              <span class="tokens-meta-sep">·</span>
                              <span class="tokens-meta-time">
                                Last used {relativeTime(token.lastUsedAt)}
                              </span>
                            </>
                          ) : (
                            <>
                              <span class="tokens-meta-sep">·</span>
                              <span class="tokens-meta-time">Never used</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div class="tokens-card-action">
                        <form
                          method="post"
                          action={`/settings/tokens/${token.id}/delete`}
                        >
                          <button type="submit" class="tokens-revoke-btn">
                            Revoke
                          </button>
                        </form>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ─── New token form ─── */}
        <div class="tokens-section">
          <div class="tokens-section-head">
            <div class="tokens-section-eyebrow">Generate</div>
            <h2 class="tokens-section-title">New token</h2>
            <p class="tokens-section-desc">
              Pick a memorable name and the minimum scopes you need.
              The token is generated, hashed, and surfaced exactly
              once — paste it into your secret store immediately.
            </p>
          </div>
          <div class="tokens-section-body">
            <form method="post" action="/settings/tokens">
              <div class="tokens-field">
                <label class="tokens-field-label" for="name">
                  Token name
                </label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  required
                  placeholder="e.g. CI/CD pipeline"
                  class="tokens-input"
                />
                <div class="tokens-field-hint">
                  A label only you see — helps you remember which
                  machine or workflow this token is for.
                </div>
              </div>
              <div class="tokens-field">
                <label class="tokens-field-label">Scopes</label>
                <div class="tokens-scope-grid">
                  {["repo", "user", "admin"].map((scope) => (
                    <label class="tokens-scope-option">
                      <input
                        type="checkbox"
                        name="scopes"
                        value={scope}
                        checked={scope === "repo"}
                        aria-label={scope}
                      />
                      <span class="tokens-scope-option-label">{scope}</span>
                    </label>
                  ))}
                </div>
                <div class="tokens-field-hint">
                  <code style="font-family: var(--font-mono); font-size: 12px;">repo</code>{" "}
                  reads &amp; writes repository contents.{" "}
                  <code style="font-family: var(--font-mono); font-size: 12px;">user</code>{" "}
                  edits your profile.{" "}
                  <code style="font-family: var(--font-mono); font-size: 12px;">admin</code>{" "}
                  is required for site-wide actions like merging PRs
                  via the MCP server.
                </div>
              </div>
              <button type="submit" class="tokens-submit">
                Generate token
              </button>
            </form>
          </div>
        </div>
      </div>
    </Layout>
  );
});

// Create token
tokens.post("/settings/tokens", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();

  let scopes: string;
  const rawScopes = body.scopes;
  if (Array.isArray(rawScopes)) {
    scopes = rawScopes.join(",");
  } else {
    scopes = String(rawScopes || "repo");
  }

  if (!name) {
    return c.redirect("/settings/tokens?error=Name+is+required");
  }

  const token = generateToken();
  const tokenH = await hashToken(token);

  await db.insert(apiTokens).values({
    userId: user.id,
    name,
    tokenHash: tokenH,
    tokenPrefix: token.slice(0, 12),
    scopes,
  });

  return c.redirect(
    `/settings/tokens?new_token=${encodeURIComponent(token)}`
  );
});

// Delete token
tokens.post("/settings/tokens/:id/delete", async (c) => {
  const user = c.get("user")!;
  const tokenId = c.req.param("id");

  const [token] = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, tokenId))
    .limit(1);

  if (!token || token.userId !== user.id) {
    return c.redirect("/settings/tokens");
  }

  await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
  return c.redirect("/settings/tokens?success=Token+revoked");
});

/**
 * Emergency PAT issuance — break-glass for when the web UI is broken
 * (service-worker loop, css busted, whatever) and an operator needs
 * a token to push a fix.
 *
 * Auth: bearer of the `EMERGENCY_PAT_SECRET` env var (set on the host).
 * If the env var is unset, the endpoint returns 503 — we don't want it
 * silently usable with an empty secret. This is the ONLY token route
 * that isn't behind a normal session, by design.
 *
 * Issues a PAT for the user named in the JSON body's `username` field,
 * defaulting to the site admin / oldest user (same heuristic the
 * self-host bootstrap uses).
 *
 * Returns JSON: { user, token } — the token is shown ONCE.
 *
 * Use:
 *   curl -X POST https://gluecron.com/api/admin/emergency-pat \
 *     -H "Authorization: Bearer $EMERGENCY_PAT_SECRET" \
 *     -H "content-type: application/json" \
 *     -d '{"name":"break-glass","scopes":"admin"}'
 */
tokens.post("/api/admin/emergency-pat", async (c) => {
  const secret = process.env.EMERGENCY_PAT_SECRET;
  if (!secret) {
    return c.json(
      { error: "emergency PAT endpoint not configured (EMERGENCY_PAT_SECRET unset)" },
      503
    );
  }
  const provided = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (provided !== secret) {
    return c.json({ error: "invalid emergency secret" }, 401);
  }

  let body: { username?: string; name?: string; scopes?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const name = (body.name || "emergency-pat").trim();
  const scopes = (body.scopes || "admin").trim();

  // Resolve target user: explicit username → site admin → oldest user.
  const { users, siteAdmins } = await import("../db/schema");
  const { eq: eqOp, asc } = await import("drizzle-orm");
  let target:
    | { id: string; username: string }
    | undefined;

  if (body.username) {
    const [u] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eqOp(users.username, body.username))
      .limit(1);
    target = u;
  }
  if (!target) {
    try {
      const [u] = await db
        .select({ id: users.id, username: users.username })
        .from(siteAdmins)
        .innerJoin(users, eqOp(siteAdmins.userId, users.id))
        .limit(1);
      target = u;
    } catch {
      // siteAdmins table may not exist on stale schemas — fall through.
    }
  }
  if (!target) {
    const [u] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .orderBy(asc(users.createdAt))
      .limit(1);
    target = u;
  }
  if (!target) {
    return c.json({ error: "no user available to issue PAT for" }, 404);
  }

  // Token + hash — same algorithm the web flow uses.
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token =
    "glc_" +
    Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const hashBuf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  const tokenHash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  await db.insert(apiTokens).values({
    userId: target.id,
    name,
    tokenHash,
    tokenPrefix: token.slice(0, 12),
    scopes,
  });

  return c.json({
    user: { id: target.id, username: target.username },
    token,
    name,
    scopes,
    note: "Token is shown once. Store it now.",
  });
});

// API endpoint
tokens.get("/api/user/tokens", async (c) => {
  const user = c.get("user")!;
  const userTokens = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      tokenPrefix: apiTokens.tokenPrefix,
      scopes: apiTokens.scopes,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.id));
  return c.json(userTokens);
});

export default tokens;
