import type { FC, PropsWithChildren } from "hono/jsx";
import type { User } from "../db/schema";
import { hljsThemeCss } from "../lib/highlight";
import { clientJs } from "./client-js";
import { getBuildInfo } from "../lib/build-info";

export const Layout: FC<
  PropsWithChildren<{
    title?: string;
    user?: User | null;
    notificationCount?: number;
    theme?: "dark" | "light";
    // Block L10 — additive SEO + Open Graph fields. All optional;
    // omission preserves the prior render exactly (regression-safe).
    fullTitle?: string;
    description?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogType?: string;
    twitterCard?: "summary" | "summary_large_image";
    // Block O3 — site-wide footer banner stripe. When non-empty,
    // renders below the footer-bottom row; wired from
    // admin.system_flags.site_banner_text.
    siteBannerText?: string;
    siteBannerLevel?: "info" | "warn" | "error";
  }>
> = ({
  children,
  title,
  user,
  notificationCount,
  theme,
  fullTitle,
  description,
  ogTitle,
  ogDescription,
  ogType,
  twitterCard,
  siteBannerText,
  siteBannerLevel,
}) => {
  // Default to "light" — feedback from operators was the dark default
  // felt too gamer-ish and not what senior platform engineers expect from
  // a tool they'd evaluate alongside Vercel / Linear / Stripe. Users who
  // explicitly want dark can flip via the theme toggle (cookie persists).
  const initialTheme = theme === "dark" ? "dark" : "light";
  const build = getBuildInfo();
  // L10 — when `fullTitle` is provided, use it verbatim (no " — gluecron"
  // suffix); otherwise fall back to the existing `title` + suffix behaviour.
  const renderedTitle = fullTitle
    ? fullTitle
    : title
    ? `${title} — gluecron`
    : "gluecron";
  return (
    <html lang="en" data-theme={initialTheme}>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#0d1117" />
        {/* 2026 polish — load Inter + Inter Tight + JetBrains Mono for
            crisp modern typography. `preconnect` keeps the handshake
            cost off the critical path; `display=swap` means we never
            block first paint waiting on fonts. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
        />
        {/* PWA removed 2026-05-16 — repeated reload-loop bugs (admin
            dashboard, deploy pill, admin-screen flash). A git host has
            no use for service workers or install-as-app. Manifest link
            and SW registrations are gone permanently. */}
        <link rel="icon" type="image/svg+xml" href="/icon.svg" />
        <title>{renderedTitle}</title>
        {description && <meta name="description" content={description} />}
        {(ogTitle || fullTitle || title) && (
          <meta property="og:title" content={ogTitle ?? fullTitle ?? renderedTitle} />
        )}
        {(ogDescription || description) && (
          <meta
            property="og:description"
            content={ogDescription ?? description ?? ""}
          />
        )}
        {ogType && <meta property="og:type" content={ogType} />}
        {twitterCard && <meta name="twitter:card" content={twitterCard} />}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <style dangerouslySetInnerHTML={{ __html: hljsThemeCss }} />
      </head>
      <body>
        <div class="prelaunch-banner" role="status" aria-live="polite">
          Pre-launch &mdash; Gluecron is in final validation. Public signups
          and git hosting for non-owner users open after launch review.
        </div>
        {/* Block Q3 — Playground banner. Renders only when the active
            user is a playground account with a future expiry; the small
            inline script counts down once per minute. Strip is dismissible
            per-page-load (re-appears on next nav) — gentle, not noisy. */}
        {user && (user as any).isPlayground && (user as any).playgroundExpiresAt && (
          <div
            class="playground-banner"
            role="status"
            aria-live="polite"
            data-playground-expires={
              ((user as any).playgroundExpiresAt instanceof Date
                ? (user as any).playgroundExpiresAt.toISOString()
                : String((user as any).playgroundExpiresAt))
            }
          >
            <span class="playground-banner-icon" aria-hidden="true">{"\u{1F3AE}"}</span>
            <span class="playground-banner-text">
              Playground account &mdash;{" "}
              <span class="playground-banner-countdown">expires soon</span>.{" "}
              <a href="/play/claim" class="playground-banner-cta">
                Save your work &rarr;
              </a>
            </span>
            <button
              type="button"
              class="playground-banner-dismiss"
              aria-label="Dismiss"
              data-playground-dismiss="1"
            >
              {"×"}
            </button>
            <script
              dangerouslySetInnerHTML={{
                __html: /* js */ `
                  (function () {
                    var el = document.currentScript && document.currentScript.parentElement;
                    if (!el) return;
                    var iso = el.getAttribute('data-playground-expires');
                    if (!iso) return;
                    var target = Date.parse(iso);
                    if (isNaN(target)) return;
                    var out = el.querySelector('.playground-banner-countdown');
                    function render() {
                      var ms = target - Date.now();
                      if (!out) return;
                      if (ms <= 0) { out.textContent = 'expired'; return; }
                      var mins = Math.floor(ms / 60000);
                      var hrs = Math.floor(mins / 60);
                      if (hrs > 1) out.textContent = hrs + ' hours left';
                      else if (hrs === 1) out.textContent = '1 hour left';
                      else if (mins > 1) out.textContent = mins + ' minutes left';
                      else out.textContent = 'less than a minute left';
                    }
                    render();
                    setInterval(render, 60000);
                    var dismiss = el.querySelector('[data-playground-dismiss="1"]');
                    if (dismiss) {
                      dismiss.addEventListener('click', function () {
                        el.style.display = 'none';
                      });
                    }
                  })();
                `,
              }}
            />
          </div>
        )}
        <header>
          <nav>
            <a href="/" class="logo">
              gluecron
            </a>
            <div class="nav-search">
              <form method="get" action="/search">
                <input
                  type="search"
                  name="q"
                  placeholder="Search (press /)"
                  aria-label="Search"
                />
              </form>
            </div>
            <div class="nav-right">
              {/* Block N3 — site-admin platform-deploy status pill */}
              {user && (
                <a
                  id="deploy-pill"
                  href="/admin/deploys"
                  class="nav-deploy-pill"
                  style="display:none"
                  aria-label="Platform deploy status"
                  title="Platform deploy status"
                >
                  <span class="deploy-pill-dot" />
                  <span class="deploy-pill-text">Deploys</span>
                </a>
              )}
              <a href="/explore" class="nav-link">Explore</a>
              {user ? (
                <>
                  {/* AI dropdown */}
                  <div class="nav-ai-dropdown" data-nav-ai>
                    <button
                      type="button"
                      class="nav-link nav-ai-trigger"
                      aria-haspopup="true"
                      aria-expanded="false"
                      data-nav-ai-trigger
                    >
                      <span style="display:inline-flex;align-items:center;gap:5px">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M12 2l2.39 5.95L20 9l-4.5 3.9L17 19l-5-3.2L7 19l1.5-6.1L4 9l5.61-1.05L12 2z" />
                        </svg>
                        AI
                        <span aria-hidden="true" style="font-size:9px;opacity:0.7">{String.fromCharCode(9660)}</span>
                      </span>
                    </button>
                    <div class="nav-ai-menu" role="menu" data-nav-ai-menu>
                      <a href="/standups" role="menuitem" class="nav-ai-item">
                        <span class="nav-ai-item-label">Standups</span>
                        <span class="nav-ai-item-sub">Daily AI brief</span>
                      </a>
                      <a href="/voice" role="menuitem" class="nav-ai-item">
                        <span class="nav-ai-item-label">Voice</span>
                        <span class="nav-ai-item-sub">Talk to ship a PR</span>
                      </a>
                      <a href="/refactors" role="menuitem" class="nav-ai-item">
                        <span class="nav-ai-item-label">Refactors</span>
                        <span class="nav-ai-item-sub">Multi-repo agent</span>
                      </a>
                      <a href="/specs" role="menuitem" class="nav-ai-item">
                        <span class="nav-ai-item-label">Specs</span>
                        <span class="nav-ai-item-sub">Spec-to-PR loop</span>
                      </a>
                      <a href="/ask" role="menuitem" class="nav-ai-item">
                        <span class="nav-ai-item-label">Ask AI</span>
                        <span class="nav-ai-item-sub">Cross-repo chat</span>
                      </a>
                    </div>
                  </div>
                  {/* Inbox bell with unread badge */}
                  <a
                    href="/inbox"
                    class="nav-inbox-btn"
                    aria-label={notificationCount && notificationCount > 0 ? `Inbox — ${notificationCount} unread` : "Inbox"}
                    title="Inbox"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                    </svg>
                    {notificationCount && notificationCount > 0 ? (
                      <span class="nav-inbox-badge" aria-hidden="true">
                        {notificationCount > 99 ? "99+" : notificationCount}
                      </span>
                    ) : null}
                  </a>
                  <a href="/new" class="btn btn-sm btn-primary">+ New</a>
                  {/* User dropdown — consolidates profile + secondary nav */}
                  <div class="nav-user-dropdown" data-nav-user>
                    <button
                      type="button"
                      class="nav-user-trigger"
                      aria-haspopup="true"
                      aria-expanded="false"
                      data-nav-user-trigger
                    >
                      <span class="nav-user-avatar" aria-hidden="true">
                        {(user.displayName || user.username).charAt(0).toUpperCase()}
                      </span>
                      <span class="nav-user-name">{user.displayName || user.username}</span>
                      <span class="nav-user-caret" aria-hidden="true">{"▾"}</span>
                    </button>
                    <div class="nav-user-menu" role="menu" data-nav-user-menu>
                      <div class="nav-user-menu-header">
                        <span class="nav-user-menu-name">{user.displayName || user.username}</span>
                        <span class="nav-user-menu-handle">@{user.username}</span>
                      </div>
                      <div class="nav-user-menu-sep" />
                      <a href="/dashboard" role="menuitem" class="nav-user-item">Dashboard</a>
                      <a href="/pulls" role="menuitem" class="nav-user-item">Pull requests</a>
                      <a href="/issues" role="menuitem" class="nav-user-item">Issues</a>
                      <a href="/activity" role="menuitem" class="nav-user-item">Activity</a>
                      <a href="/insights" role="menuitem" class="nav-user-item">Insights</a>
                      <a href="/import" role="menuitem" class="nav-user-item">Import from GitHub</a>
                      <a href="/import/actions" role="menuitem" class="nav-user-item">Actions importer</a>
                      <div class="nav-user-menu-sep" />
                      <a href={`/${user.username}`} role="menuitem" class="nav-user-item">Your profile</a>
                      <a href="/settings" role="menuitem" class="nav-user-item">Settings</a>
                      <a href="/settings/tokens" role="menuitem" class="nav-user-item">Access tokens</a>
                      <div class="nav-user-menu-sep" />
                      <a href="/theme/toggle" class="nav-user-item" role="menuitem">
                        <span class="theme-icon-dark">{"☾"} Light mode</span>
                        <span class="theme-icon-light">{"☀"} Dark mode</span>
                      </a>
                      <a href="/logout" role="menuitem" class="nav-user-item nav-user-item--danger">Sign out</a>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <a href="/theme/toggle" class="nav-link nav-theme" title="Toggle theme" aria-label="Toggle theme">
                    <span class="theme-icon-dark">{"☾"}</span>
                    <span class="theme-icon-light">{"☀"}</span>
                  </a>
                  <a href="/import" class="nav-link nav-migrate" title="Migrate your GitHub repos to Gluecron">
                    Migrate from GitHub
                  </a>
                  <a href="/login" class="nav-link">Sign in</a>
                  <a href="/register" class="btn btn-sm btn-primary">Register</a>
                </>
              )}
            </div>
          </nav>
        </header>
        <main id="main-content">{children}</main>
        {/* Global toast host — populated by the toastScript below from
            ?success= / ?error= / ?toast= query params. Replaces the
            per-page banner pattern with one polished slide-in. */}
        <div
          id="toast-host"
          aria-live="polite"
          aria-atomic="true"
          style="position:fixed;top:calc(var(--header-h) + 12px);right:16px;z-index:var(--z-toast,10000);display:flex;flex-direction:column;gap:8px;pointer-events:none"
        />
        <footer>
          <div class="footer-inner">
            <div class="footer-brand">
              <a href="/" class="logo">gluecron</a>
              <p class="footer-tag">
                AI-native code intelligence. Self-hosted git, automated CI,
                push-time gates. Software that ships itself.
              </p>
            </div>
            <div class="footer-links">
              <div class="footer-col">
                <div class="footer-col-title">Product</div>
                <a href="/features">Features</a>
                <a href="/pricing">Pricing</a>
                <a href="/enterprise">Enterprise</a>
                <a href="/changelog">Changelog</a>
                <a href="/explore">Explore</a>
                <a href="/marketplace">Marketplace</a>
                <a href="/developer-program">Developer Program</a>
              </div>
              <div class="footer-col">
                <div class="footer-col-title">Platform</div>
                <a href="/docs">Docs</a>
                <a href="/help">Quickstart</a>
                <a href="/status">Status</a>
                <a href="/api/graphql">GraphQL</a>
                <a href="/mcp">MCP server</a>
              </div>
              <div class="footer-col">
                <div class="footer-col-title">Company</div>
                <a href="/about">About</a>
                <a href="/blog">Blog</a>
                <a href="/terms">Terms</a>
                <a href="/privacy">Privacy</a>
                <a href="/acceptable-use">Acceptable use</a>
              </div>
            </div>
          </div>
          <div class="footer-bottom">
            <span>&copy; {new Date().getFullYear()} gluecron</span>
            <span class="footer-build" title={`commit ${build.shaFull}\nbuilt ${build.builtAt}`}>
              <span class="footer-build-dot" aria-hidden="true" />
              {build.sha} · {build.branch}
            </span>
          </div>
          {siteBannerText ? (
            <div
              class={`footer-banner footer-banner-${siteBannerLevel || "info"}`}
              role="status"
              aria-live="polite"
            >
              {siteBannerText}
            </div>
          ) : null}
        </footer>
        {/* Live update poller — checks /api/version every 15s, prompts
            reload when the running sha changes. Pure progressive-
            enhancement; degrades to nothing if JS is off. */}
        <div
          id="version-banner"
          style="display:none;position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:9999;background:var(--bg-elevated);border:1px solid rgba(140,109,255,0.45);border-radius:9999px;padding:8px 14px 8px 14px;font-size:13px;color:var(--text-strong);box-shadow:0 12px 28px -8px rgba(0,0,0,0.55),0 0 24px -6px rgba(140,109,255,0.40);font-family:var(--font-sans);align-items:center;gap:10px"
        >
          <span style="display:inline-flex;align-items:center;gap:8px">
            <span style="width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 10px rgba(52,211,153,0.6)" />
            <span>New version available</span>
          </span>
          <button
            type="button"
            id="version-banner-reload"
            style="background:linear-gradient(135deg,#8c6dff 0%,#36c5d6 100%);color:#fff;border:0;border-radius:9999px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit"
          >
            Reload
          </button>
        </div>
        <script dangerouslySetInnerHTML={{ __html: versionPollerScript }} />
        {/* Block N3 — site-admin deploy status pill (script-only). The pill
            container is rendered above for authed users; this script bootstraps
            it by fetching /admin/deploys/latest.json. Non-admins get 401/403
            and the pill stays display:none — zero leak. */}
        {user && (
          <script dangerouslySetInnerHTML={{ __html: deployPillScript }} />
        )}
        {/* Block I4 — Command palette shell (hidden by default) */}
        <div
          id="cmdk-backdrop"
          style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9998"
        />
        <div
          id="cmdk-panel"
          style="display:none;position:fixed;top:10%;left:50%;transform:translateX(-50%);width:min(560px,92vw);background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 12px 32px rgba(0,0,0,0.4);z-index:9999;overflow:hidden"
        >
          <input
            id="cmdk-input"
            type="text"
            placeholder="Type a command..."
            aria-label="Command palette"
            style="width:100%;padding:var(--space-3) var(--space-4);background:transparent;color:var(--text);border:0;border-bottom:1px solid var(--border);outline:none;font-size:14px"
          />
          <div id="cmdk-list" style="max-height:60vh;overflow-y:auto" />
        </div>
        <script dangerouslySetInnerHTML={{ __html: clientJs }} />
        {/* PWA-kill script: actively unregisters any service worker
            previously installed under gluecron.com. Recovers any browser
            still trapped in the SW reload loop from the legacy registrations. */}
        <script dangerouslySetInnerHTML={{ __html: pwaKillSwitchScript }} />
        <script dangerouslySetInnerHTML={{ __html: toastScript }} />
        <script dangerouslySetInnerHTML={{ __html: navScript }} />
        <script dangerouslySetInnerHTML={{ __html: navAiDropdownScript }} />
        {/* Bell badge poller — only rendered for authenticated users.
            Polls /api/notifications/count every 60 s and updates the badge
            on the inbox bell icon. Falls back gracefully if the endpoint is
            unavailable or the user signs out mid-session. */}
        {user && (
          <script dangerouslySetInnerHTML={{ __html: bellPollerScript }} />
        )}
      </body>
    </html>
  );
};

// Live version poller. Checks /api/version every 15s; if the sha differs
// from the one we booted with, reveal the floating 'New version' pill so
// the user can reload onto the new code without manually refreshing.
const versionPollerScript = `
  (function(){
    var loadedSha = null;
    var banner, btn;
    function poll(){
      fetch('/api/version', { cache: 'no-store' })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){
          if (!j || !j.sha) return;
          if (loadedSha === null) { loadedSha = j.sha; return; }
          if (j.sha !== loadedSha && banner) {
            banner.style.display = 'inline-flex';
          }
        })
        .catch(function(){});
    }
    function init(){
      banner = document.getElementById('version-banner');
      btn = document.getElementById('version-banner-reload');
      if (btn) btn.addEventListener('click', function(){ window.location.reload(); });
      poll();
      setInterval(poll, 15000);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  })();
`;

// Block N3 — site-admin deploy status pill. Fetches /admin/deploys/latest.json;
// if 200, reveals the pill in the nav and subscribes to the `platform:deploys`
// SSE topic for live status updates. Non-admins get 401/403 and the pill stays
// display:none — there's no leakage of admin-only data to other users.
//
// Pill states (CSS classes on the container drive colour):
//   .deploy-pill-success    🟢 "Deployed 12s ago"
//   .deploy-pill-progress   🟡 "Deploying… 14s"   (pulsing dot)
//   .deploy-pill-failed     🔴 "Deploy failed 1m ago"
//   .deploy-pill-empty      ⚪ "No deploys yet"
//
// Relative-time auto-refreshes every 15s without re-fetching.
export const deployPillScript = `
  (function(){
    var pill, dot, text;
    var state = { latest: null, asOf: null };

    function classifyAge(ms){
      if (ms < 0) return 'just now';
      var s = Math.floor(ms / 1000);
      if (s < 5) return 'just now';
      if (s < 60) return s + 's ago';
      var m = Math.floor(s / 60);
      if (m < 60) return m + 'm ago';
      var h = Math.floor(m / 60);
      if (h < 24) return h + 'h ago';
      var d = Math.floor(h / 24);
      return d + 'd ago';
    }
    function elapsed(ms){
      if (ms < 0) ms = 0;
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      var m = Math.floor(s / 60);
      var rem = s - m * 60;
      return m + 'm ' + rem + 's';
    }

    function render(){
      if (!pill || !text || !dot) return;
      var d = state.latest;
      // When there's no deploy event yet, keep the pill HIDDEN. Showing
      // "No deploys yet" was visible noise on every admin page load and
      // flashed during reconnect cycles — admins don't need a placeholder.
      // The pill reveals itself the first time a real deploy fires.
      if (!d) {
        pill.style.display = 'none';
        return;
      }
      pill.style.display = 'inline-flex';
      var now = Date.now();
      if (d.status === 'in_progress') {
        pill.className = 'nav-deploy-pill deploy-pill-progress';
        var started = Date.parse(d.started_at) || now;
        text.textContent = 'Deploying… ' + elapsed(now - started);
      } else if (d.status === 'succeeded') {
        pill.className = 'nav-deploy-pill deploy-pill-success';
        var ref = Date.parse(d.finished_at || d.started_at) || now;
        text.textContent = 'Deployed ' + classifyAge(now - ref);
      } else if (d.status === 'failed') {
        pill.className = 'nav-deploy-pill deploy-pill-failed';
        var refF = Date.parse(d.finished_at || d.started_at) || now;
        text.textContent = 'Deploy failed ' + classifyAge(now - refF);
      } else {
        pill.className = 'nav-deploy-pill';
        text.textContent = d.status;
      }
    }

    function fetchLatest(){
      fetch('/admin/deploys/latest.json', { cache: 'no-store', credentials: 'same-origin' })
        .then(function(r){ if (!r.ok) return null; return r.json(); })
        .then(function(j){
          if (!j || j.ok !== true) return;
          state.latest = j.latest;
          state.asOf = j.asOf;
          render();
          subscribe();
        })
        .catch(function(){});
    }

    var subscribed = false;
    function subscribe(){
      if (subscribed) return;
      if (typeof EventSource === 'undefined') return;
      subscribed = true;
      var es;
      // Exponential backoff with cap. Previously a tight 1500ms reconnect
      // produced visible looping in the nav whenever the proxy timed out
      // or the connection blipped — the bottom-of-page deploy pill
      // re-rendered the placeholder every 1.5s. Cap at 60s and reset on
      // successful message receipt.
      var delay = 2000;
      var DELAY_MAX = 60000;
      function bump(){
        delay = Math.min(delay * 2, DELAY_MAX);
      }
      function resetDelay(){
        delay = 2000;
      }
      function connect(){
        try { es = new EventSource('/live-events/platform:deploys'); }
        catch(e){ bump(); setTimeout(connect, delay); return; }
        es.onmessage = function(m){
          resetDelay();
          try {
            var d = JSON.parse(m.data);
            if (d && d.run_id) {
              if (!state.latest || state.latest.run_id === d.run_id ||
                  Date.parse(d.started_at) >= Date.parse(state.latest.started_at)) {
                state.latest = d;
                render();
              }
            }
          } catch(e){}
        };
        es.onerror = function(){
          try { es.close(); } catch(e){}
          bump();
          setTimeout(connect, delay);
        };
      }
      connect();
    }

    function init(){
      pill = document.getElementById('deploy-pill');
      if (!pill) return;
      dot = pill.querySelector('.deploy-pill-dot');
      text = pill.querySelector('.deploy-pill-text');
      fetchLatest();
      // Refresh relative-time labels every 15s so "12s ago" → "27s ago"
      // without a fresh fetch.
      setInterval(render, 15000);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  })();
`;

// Runs before paint — reads the theme cookie and flips data-theme so there's
// no light-to-dark flash on load. SSR default is "light"; cookie-set "dark"
// is honoured for users who explicitly opted in.
const themeInitScript = `
  (function(){
    try {
      var m = document.cookie.match(/(?:^|; )theme=([^;]+)/);
      var t = m ? decodeURIComponent(m[1]) : 'light';
      if (t !== 'light' && t !== 'dark') t = 'light';
      document.documentElement.setAttribute('data-theme', t);
    } catch(_){}
  })();
`;

// Block G1 — register service worker for offline / install support.
// Kept inline (and tiny) so we don't block first paint.
//
// Global toast notifications — reads ?success=, ?error=, ?toast= from the
// URL on page load and surfaces a polished slide-in toast instead of the
// per-page banner divs that crowded the layout. Toasts auto-dismiss after
// 4.5s; query params are scrubbed from the URL via history.replaceState
// so a subsequent Refresh doesn't re-fire the same toast.
//
// Variants: ?success=…, ?error=…, ?toast=info:…, ?toast=warn:…  All values
// must be URI-encoded (callers already do this via encodeURIComponent
// in c.redirect()).
const toastScript = `
  (function(){
    function showToast(kind, message){
      if (!message) return;
      var host = document.getElementById('toast-host');
      if (!host) return;
      var el = document.createElement('div');
      el.className = 'gx-toast gx-toast--' + kind;
      el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      var icon = document.createElement('span');
      icon.className = 'gx-toast__icon';
      icon.textContent = kind === 'success' ? '\\u2713'
                       : kind === 'error'   ? '\\u00D7'
                       : kind === 'warn'    ? '!'
                       :                       'i';
      el.appendChild(icon);
      var text = document.createElement('span');
      text.className = 'gx-toast__text';
      text.textContent = message;
      el.appendChild(text);
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'gx-toast__close';
      close.setAttribute('aria-label', 'Dismiss notification');
      close.textContent = '\\u00D7';
      close.addEventListener('click', function(){ dismiss(); });
      el.appendChild(close);
      host.appendChild(el);
      // Force a reflow then add the visible class so the slide-in transitions.
      void el.offsetWidth;
      el.classList.add('gx-toast--in');
      var timer = setTimeout(dismiss, 4500);
      function dismiss(){
        clearTimeout(timer);
        el.classList.remove('gx-toast--in');
        el.classList.add('gx-toast--out');
        setTimeout(function(){
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 220);
      }
    }
    try {
      var url = new URL(window.location.href);
      var hits = 0;
      var s = url.searchParams.get('success');
      if (s) { showToast('success', s); url.searchParams.delete('success'); hits++; }
      var e = url.searchParams.get('error');
      if (e) { showToast('error', e); url.searchParams.delete('error'); hits++; }
      var t = url.searchParams.get('toast');
      if (t) {
        var ix = t.indexOf(':');
        var kind = ix > 0 ? t.slice(0, ix) : 'info';
        var msg  = ix > 0 ? t.slice(ix + 1) : t;
        showToast(kind, msg);
        url.searchParams.delete('toast');
        hits++;
      }
      if (hits > 0 && window.history && window.history.replaceState) {
        window.history.replaceState({}, '', url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '') + url.hash);
      }
    } catch(_) {}
  })();
`;

// PWA kill-switch (2026-05-16) — replaces the previous pwaRegisterScript
// and pwaInstallBannerScript. Those two scripts registered /sw.js and
// /sw-push.js at the same scope, causing a reload loop that made the
// admin dashboard unusable (deploy pill flashing, typing wiped, buttons
// uncllickable). Per the SW spec, only one SW can control a scope; two
// different script URLs at the same scope keep replacing each other.
//
// PWA is gone for good. A git host has no use for service workers,
// install-as-app, or push notifications via SW. This script actively
// unregisters every previously installed SW on the gluecron.com origin
// so any browser still trapped in the loop recovers on the very next
// page load — without needing the user to clear site data or open
// DevTools. Idempotent and safe to keep running forever; once all
// browsers have been cleaned, it's a no-op.
const pwaKillSwitchScript = `
(function(){
  try {
    if (!('serviceWorker' in navigator)) return;
    if (!navigator.serviceWorker.getRegistrations) return;
    navigator.serviceWorker.getRegistrations().then(function(regs){
      if (!regs || regs.length === 0) return;
      regs.forEach(function(reg){
        try { reg.unregister(); } catch(_){}
      });
    }).catch(function(){});
    // Also drop any caches the old SWs left behind so the user gets
    // truly fresh HTML on every page load. Restricted to gluecron-*
    // namespaced caches so we don't trample anything a future opt-in
    // feature might create under a different name.
    if ('caches' in self) {
      caches.keys().then(function(keys){
        keys.forEach(function(k){
          if (typeof k === 'string' && k.indexOf('gluecron') === 0) {
            try { caches.delete(k); } catch(_){}
          }
        });
      }).catch(function(){});
    }
  } catch(_) {}
})();
`;

const navScript = `
  (function(){
    var chord = null;
    var chordTimer = null;
    function isTyping(t){
      t = t || {};
      var tag = (t.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || t.isContentEditable;
    }

    // ---------- Block I4 — Command palette ----------
    var COMMANDS = [
      { label: 'Go to Dashboard', href: '/dashboard', kw: 'home' },
      { label: 'Go to Explore', href: '/explore', kw: 'browse discover' },
      { label: 'Go to Notifications', href: '/notifications', kw: 'inbox' },
      { label: 'Go to Ask AI', href: '/ask', kw: 'chat assistant' },
      { label: 'Create new repository', href: '/new', kw: 'add create' },
      { label: 'Marketplace', href: '/marketplace', kw: 'apps store' },
      { label: 'Installed apps', href: '/settings/apps', kw: 'my apps' },
      { label: 'Register new app', href: '/developer/apps-new', kw: 'developer create' },
      { label: 'Keyboard shortcuts', href: '/shortcuts', kw: 'help keys' },
      { label: 'Settings (profile)', href: '/settings', kw: 'account' },
      { label: '2FA settings', href: '/settings/2fa', kw: 'two factor security' },
      { label: 'Passkeys settings', href: '/settings/passkeys', kw: 'webauthn' },
      { label: 'Personal access tokens', href: '/settings/tokens', kw: 'pat api' },
      { label: 'Billing + quotas', href: '/settings/billing', kw: 'plans money' },
      { label: 'AI usage + cost', href: '/billing/usage', kw: 'spend tokens anthropic budget' },
      { label: 'Audit log (personal)', href: '/settings/audit', kw: 'history' },
      { label: 'Gists', href: '/gists', kw: 'snippets' },
      { label: 'GraphQL explorer', href: '/api/graphql', kw: 'api query' },
      { label: 'Admin dashboard', href: '/admin', kw: 'superuser' },
      { label: 'Toggle theme', href: '/theme/toggle', kw: 'dark light mode' }
    ];

    function fuzzyMatch(item, q){
      if (!q) return true;
      var hay = (item.label + ' ' + (item.kw||'') + ' ' + item.href).toLowerCase();
      q = q.toLowerCase();
      var qi = 0;
      for (var i = 0; i < hay.length && qi < q.length; i++) {
        if (hay[i] === q[qi]) qi++;
      }
      return qi === q.length;
    }

    var backdrop, panel, input, list, selected = 0, filtered = COMMANDS.slice();

    function render(){
      if (!list) return;
      var html = '';
      for (var i = 0; i < filtered.length; i++) {
        var item = filtered[i];
        var cls = i === selected ? 'cmdk-item cmdk-active' : 'cmdk-item';
        var bg = i === selected ? 'background:var(--bg);' : '';
        html += '<div class="' + cls + '" data-idx="' + i + '" data-url="' + item.href + '"' +
                ' style="padding:var(--space-2) var(--space-4);cursor:pointer;border-bottom:1px solid var(--border);' + bg + '">' +
                '<div>' + item.label + '</div>' +
                '<div style="font-size:11px;color:var(--text-muted)">' + item.href + '</div>' +
                '</div>';
      }
      if (filtered.length === 0) {
        html = '<div style="padding:var(--space-4);color:var(--text-muted);text-align:center">No matches.</div>';
      }
      list.innerHTML = html;
    }

    function openPalette(){
      backdrop = document.getElementById('cmdk-backdrop');
      panel = document.getElementById('cmdk-panel');
      input = document.getElementById('cmdk-input');
      list = document.getElementById('cmdk-list');
      if (!backdrop || !panel) return;
      backdrop.style.display = 'block';
      panel.style.display = 'block';
      input.value = '';
      selected = 0;
      filtered = COMMANDS.slice();
      render();
      input.focus();
    }
    function closePalette(){
      if (backdrop) backdrop.style.display = 'none';
      if (panel) panel.style.display = 'none';
    }
    function go(href){ closePalette(); window.location.href = href; }

    document.addEventListener('click', function(e){
      var t = e.target;
      if (t && t.id === 'cmdk-backdrop') { closePalette(); return; }
      var item = t && t.closest && t.closest('.cmdk-item');
      if (item) { go(item.getAttribute('data-url')); }
    });

    document.addEventListener('input', function(e){
      if (e.target && e.target.id === 'cmdk-input') {
        var q = e.target.value;
        filtered = COMMANDS.filter(function(c){ return fuzzyMatch(c, q); });
        selected = 0;
        render();
      }
    });

    document.addEventListener('keydown', function(e){
      // Palette-scoped keys take priority when open
      if (panel && panel.style.display === 'block') {
        if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selected = Math.min(filtered.length - 1, selected + 1);
          render();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          selected = Math.max(0, selected - 1);
          render();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          var item = filtered[selected];
          if (item) go(item.href);
          return;
        }
        return;
      }

      if (isTyping(e.target)) return;
      // Single key shortcuts
      if (e.key === '/') {
        var el = document.querySelector('.nav-search input');
        if (el) { e.preventDefault(); el.focus(); return; }
      }
      if ((e.metaKey||e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
        return;
      }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); window.location.href = '/shortcuts'; return;
      }
      if (e.key === 'n' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); window.location.href = '/new'; return;
      }
      // "g" chord
      if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
        chord = 'g';
        clearTimeout(chordTimer);
        chordTimer = setTimeout(function(){ chord = null; }, 1200);
        return;
      }
      if (chord === 'g') {
        if (e.key === 'd') { e.preventDefault(); window.location.href = '/dashboard'; }
        else if (e.key === 'n') { e.preventDefault(); window.location.href = '/notifications'; }
        else if (e.key === 'e') { e.preventDefault(); window.location.href = '/explore'; }
        else if (e.key === 'a') { e.preventDefault(); window.location.href = '/ask'; }
        chord = null;
      }
      // j/k list navigation — move through .prs-row, .issue-row, .notif-item rows
      if (e.key === 'j' || e.key === 'k') {
        var selectors = '.prs-row, .issue-row, .issue-list-item, .notif-item, .repo-item, .exp-repo-card, .disc-row';
        var items = Array.from(document.querySelectorAll(selectors));
        if (items.length === 0) return;
        e.preventDefault();
        var cur = items.findIndex(function(el){ return el.classList.contains('is-kbd-focus'); });
        var next = e.key === 'j' ? (cur < 0 ? 0 : Math.min(items.length - 1, cur + 1)) : (cur < 0 ? items.length - 1 : Math.max(0, cur - 1));
        items.forEach(function(el){ el.classList.remove('is-kbd-focus'); });
        items[next].classList.add('is-kbd-focus');
        items[next].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter') {
        var focused = document.querySelector('.is-kbd-focus');
        if (focused) {
          e.preventDefault();
          var link = focused.tagName === 'A' ? focused : focused.querySelector('a');
          if (link && link.href) { window.location.href = link.href; }
          return;
        }
      }
      if (e.key === 'x') {
        // 'x' selects/deselects focused item (future: bulk actions)
        var sel = document.querySelector('.is-kbd-focus');
        if (sel) { e.preventDefault(); sel.classList.toggle('is-kbd-selected'); return; }
      }
    });
  })();
`;

// Bell poller — updates the inbox badge count every 60 s via /api/notifications/count.
// Only injected when a user is logged in (checked in the JSX above). Uses the
// `.nav-inbox-badge` element that the server renders inside `.nav-inbox-btn`.
// If the badge element is absent (user not logged in, DOM mismatch) it exits
// cleanly without error.
export const bellPollerScript = `
(function() {
  var badge = document.querySelector('.nav-inbox-btn .nav-inbox-badge');
  var btn   = document.querySelector('.nav-inbox-btn');
  function updateBadge(n) {
    if (!btn) return;
    if (n > 0) {
      var label = n > 99 ? '99+' : String(n);
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-inbox-badge';
        badge.setAttribute('aria-hidden', 'true');
        btn.appendChild(badge);
      }
      badge.textContent = label;
      badge.style.display = '';
      btn.setAttribute('aria-label', 'Inbox — ' + n + ' unread');
    } else {
      if (badge) badge.style.display = 'none';
      btn.setAttribute('aria-label', 'Inbox');
    }
  }
  function poll() {
    fetch('/api/notifications/count', { credentials: 'same-origin', cache: 'no-store' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d) return;
        var n = typeof d.unread === 'number' ? d.unread : (typeof d.count === 'number' ? d.count : 0);
        updateBadge(n);
      })
      .catch(function() {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { poll(); setInterval(poll, 60000); });
  } else {
    poll();
    setInterval(poll, 60000);
  }
})();
`;

// AI dropdown — keyboard- and click-accessible menu in the top nav.
// CSS handles the hover-open behaviour for pointer users; this script
// adds click-to-toggle for touch, Escape-to-close, and outside-click-
// to-close. Lives in its own IIFE so it never interferes with navScript.
const navAiDropdownScript = `
  (function(){
    function makeDropdown(rootSel, triggerSel, menuSel) {
      var open = false;
      var root = document.querySelector(rootSel);
      if (!root) return;
      var trigger = root.querySelector(triggerSel);
      var menu = root.querySelector(menuSel);
      if (!trigger || !menu) return;
      function setOpen(next){
        open = !!next;
        root.classList.toggle('is-open', open);
        menu.classList.toggle('is-open', open);
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      trigger.addEventListener('click', function(e){ e.preventDefault(); setOpen(!open); });
      document.addEventListener('click', function(e){
        if (!open) return;
        if (root.contains(e.target)) return;
        setOpen(false);
      });
      document.addEventListener('keydown', function(e){
        if (open && e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.focus(); }
      });
    }
    makeDropdown('[data-nav-ai]', '[data-nav-ai-trigger]', '[data-nav-ai-menu]');
    makeDropdown('[data-nav-user]', '[data-nav-user-trigger]', '[data-nav-user-menu]');
  })();
`;

const css = `
  /* ================================================================
   * Gluecron design system — 2026.05 "Editorial-Technical"
   * Slate-noir base · refined violet signature · hairline geometry ·
   * mono-as-feature · cinematic motion · Inter Tight + JetBrains Mono.
   * All class names preserved for back-compat across 50+ route views.
   * ============================================================== */
  :root, :root[data-theme='dark'] {
    /* Surfaces — slate, not black. More depth, less crush. */
    --bg:           #08090f;
    --bg-secondary: #0c0d14;
    --bg-tertiary:  #11131c;
    --bg-elevated:  #0f111a;
    --bg-surface:   #161826;
    --bg-hover:     rgba(255,255,255,0.04);
    --bg-active:    rgba(255,255,255,0.08);
    --bg-inset:     rgba(0,0,0,0.30);

    /* Borders — three weights, used deliberately */
    --border:        rgba(255,255,255,0.06);
    --border-subtle: rgba(255,255,255,0.035);
    --border-strong: rgba(255,255,255,0.13);
    --border-focus:  rgba(140,109,255,0.55);

    /* Text */
    --text:        #ededf2;
    --text-strong: #f7f7fb;
    --text-muted:  #8b8c9c;
    --text-faint:  #555665;
    --text-link:   #b69dff;

    /* Accent — refined violet (less candy), warm amber as secondary signal */
    --accent:        #8c6dff;
    --accent-2:      #36c5d6;
    --accent-warm:   #ffb45e;
    --accent-hover:  #a48bff;
    --accent-pressed:#7559e8;
    --accent-gradient:       linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    --accent-gradient-soft:  linear-gradient(135deg, rgba(140,109,255,0.18) 0%, rgba(54,197,214,0.18) 100%);
    --accent-gradient-faint: linear-gradient(135deg, rgba(140,109,255,0.07) 0%, rgba(54,197,214,0.07) 100%);
    --accent-glow:           0 0 24px rgba(140,109,255,0.28);

    /* Semantic */
    --green:  #34d399;
    --red:    #f87171;
    --yellow: #fbbf24;
    --amber:  #fbbf24;
    --blue:   #60a5fa;

    /* Type — 2026 polish pass. Inter is the primary sans, Inter Tight for
       display (headlines), JetBrains Mono for code. All three loaded from
       Google Fonts with display:swap so we never block first paint. System
       fallbacks remain in place — if the CDN is unreachable the site still
       renders cleanly with Segoe UI (Win) / SF (Mac) / Roboto (Android). */
    --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Code', 'Cascadia Mono', Menlo, Consolas, 'Courier New', monospace;
    --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', system-ui, Roboto, 'Helvetica Neue', Arial, sans-serif;
    --font-display: 'Inter Tight', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', system-ui, Roboto, 'Helvetica Neue', Arial, sans-serif;
    --mono-feat: 'calt', 'liga', 'ss01';

    /* Radius — sharper than before */
    --r-sm:    5px;
    --r:       7px;
    --r-md:    9px;
    --r-lg:    12px;
    --r-xl:    16px;
    --r-2xl:   22px;
    --r-full:  9999px;
    --radius:  7px;

    /* Type scale — bigger display sizes for editorial feel */
    --t-xs:        11px;
    --t-sm:        13px;
    --t-base:      14px;
    --t-md:        16px;
    --t-lg:        20px;
    --t-xl:        28px;
    --t-2xl:       40px;
    --t-3xl:       56px;
    --t-display:   72px;
    --t-display-lg:96px;

    /* Spacing — 4px base */
    --s-0: 0;
    --s-1: 4px;  --s-2: 8px;   --s-3: 12px;  --s-4: 16px;
    --s-5: 20px; --s-6: 24px;  --s-7: 28px;  --s-8: 32px;
    --s-10:40px; --s-12:48px;  --s-14:56px;  --s-16:64px;
    --s-20:80px; --s-24:96px;  --s-32:128px;

    /* Elevation — softer + more layered */
    --elev-0:    0 0 0 1px var(--border);
    --elev-1:    0 1px 2px rgba(0,0,0,0.50), 0 0 0 1px var(--border);
    --elev-2:    0 8px 24px -8px rgba(0,0,0,0.60), 0 0 0 1px var(--border);
    --elev-3:    0 20px 48px -12px rgba(0,0,0,0.70), 0 0 0 1px var(--border-strong);
    --elev-glow: 0 0 0 1px rgba(140,109,255,0.40), 0 0 32px -4px rgba(140,109,255,0.30);
    --ring:      0 0 0 3px rgba(140,109,255,0.28);
    --ring-warn: 0 0 0 3px rgba(251,191,36,0.28);
    --ring-err:  0 0 0 3px rgba(248,113,113,0.28);

    /* Motion */
    --ease:           cubic-bezier(0.16, 1, 0.3, 1);
    --ease-spring:    cubic-bezier(0.34, 1.56, 0.64, 1);
    --ease-out-expo:  cubic-bezier(0.19, 1, 0.22, 1);
    --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
    --t-fast:  120ms;
    --t-base:  200ms;
    --t-slow:  360ms;
    --t-slower:560ms;

    --header-h: 60px;

    /* Block O3 — visual coherence: named token aliases (additive). */
    --space-1: var(--s-1);
    --space-2: var(--s-2);
    --space-3: var(--s-3);
    --space-4: var(--s-4);
    --space-5: var(--s-5);
    --space-6: var(--s-6);
    --space-8: var(--s-8);
    --space-10: var(--s-10);
    --space-12: var(--s-12);
    --space-16: var(--s-16);
    --space-20: var(--s-20);
    --space-24: var(--s-24);
    --radius-sm: var(--r-sm);
    --radius-md: var(--r-md);
    --radius-lg: var(--r-lg);
    --radius-xl: var(--r-xl);
    --radius-full: var(--r-full);
    --font-size-xs: var(--t-xs);
    --font-size-sm: var(--t-sm);
    --font-size-base: var(--t-base);
    --font-size-md: var(--t-md);
    --font-size-lg: var(--t-lg);
    --font-size-xl: var(--t-xl);
    --font-size-2xl: var(--t-2xl);
    --font-size-3xl: var(--t-3xl);
    --font-size-hero: var(--t-display);
    --leading-tight: 1.2;
    --leading-snug: 1.35;
    --leading-normal: 1.5;
    --leading-relaxed: 1.6;
    --leading-loose: 1.7;
    --z-base: 1;
    --z-nav: 10;
    --z-sticky: 50;
    --z-overlay: 100;
    --z-modal: 1000;
    --z-toast: 10000;
  }

  :root[data-theme='light'] {
    --bg:           #fbfbfc;
    --bg-secondary: #ffffff;
    --bg-tertiary:  #f3f3f6;
    --bg-elevated:  #ffffff;
    --bg-surface:   #f6f6f9;
    --bg-hover:     rgba(0,0,0,0.035);
    --bg-active:    rgba(0,0,0,0.07);
    --bg-inset:     rgba(0,0,0,0.04);

    --border:        rgba(15,16,28,0.08);
    --border-subtle: rgba(15,16,28,0.04);
    --border-strong: rgba(15,16,28,0.16);

    --text:        #0e1020;
    --text-strong: #050617;
    --text-muted:  #5a5b70;
    --text-faint:  #8a8b9e;
    --text-link:   #6d4dff;

    --accent:        #6d4dff;
    --accent-2:      #0891b2;
    --accent-hover:  #5a3df0;
    --accent-pressed:#4a30d6;
    --accent-glow:   0 0 24px rgba(109,77,255,0.18);

    --green:  #059669;
    --red:    #dc2626;
    --yellow: #d97706;

    --elev-1: 0 1px 2px rgba(15,16,28,0.06), 0 0 0 1px var(--border);
    --elev-2: 0 8px 24px -10px rgba(15,16,28,0.10), 0 0 0 1px var(--border);
    --elev-3: 0 20px 48px -16px rgba(15,16,28,0.14), 0 0 0 1px var(--border-strong);
  }

  /* Theme toggle — show the icon for the *opposite* theme so users see what they'll switch to. */
  .nav-theme { display: inline-flex; align-items: center; font-size: 15px; line-height: 1; opacity: 0.85; }
  .nav-theme:hover { opacity: 1; }
  :root[data-theme='dark'] .theme-icon-dark { display: none; }
  :root[data-theme='light'] .theme-icon-light { display: none; }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  *::selection { background: rgba(140,109,255,0.32); color: var(--text-strong); }

  html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }

  body {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--text);
    font-size: 15px;
    line-height: 1.55;
    letter-spacing: -0.011em;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    font-feature-settings: 'cv11', 'ss01', 'ss03', 'calt';
    /* Subtle: prefers grayscale font smoothing on macOS for thin text,
       and disables automatic synthesis of bold/italic which can produce
       muddier rendering on certain weights. */
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    font-synthesis: none;
  }
  /* Tighten heading rhythm — the body is 15/1.55, headings step down
     line-height inversely with size so display text doesn't feel airy. */
  h1, h2, h3, h4, h5, h6 {
    font-family: var(--font-display);
    color: var(--text-strong);
    letter-spacing: -0.022em;
    line-height: 1.18;
    font-weight: 650;
    margin-top: 0;
  }
  h1 { font-size: 28px; letter-spacing: -0.028em; }
  h2 { font-size: 22px; }
  h3 { font-size: 18px; letter-spacing: -0.018em; }
  h4 { font-size: 15.5px; letter-spacing: -0.012em; font-weight: 600; }
  /* Link refinement — underline only on hover/focus, never by default
     on internal nav. Prevents the "blue underline soup" look. */
  a { color: var(--text-link); text-decoration: none; transition: color var(--t-fast) var(--ease); }
  a:hover { color: var(--accent-hover); text-decoration: underline; text-underline-offset: 3px; }
  a:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(109,77,255,0.32);
    border-radius: 3px;
  }

  /* Whole-page atmosphere: very subtle gradient + dot-grid layered behind everything.
     Keeps every page feeling like part of the same product without competing with hero art. */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: -2;
    background:
      radial-gradient(70% 55% at 85% -20%, rgba(140,109,255,0.07), transparent 65%),
      radial-gradient(55% 45% at -10% 115%, rgba(54,197,214,0.05), transparent 65%);
  }
  body::after {
    content: '';
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: -1;
    background-image: radial-gradient(rgba(255,255,255,0.025) 1px, transparent 1px);
    background-size: 28px 28px;
    background-position: 0 0;
    opacity: 0.55;
    mask-image: radial-gradient(ellipse at 50% 0%, #000 0%, transparent 70%);
    -webkit-mask-image: radial-gradient(ellipse at 50% 0%, #000 0%, transparent 70%);
  }
  :root[data-theme='light'] body::before { opacity: 0.55; }
  :root[data-theme='light'] body::after {
    background-image: radial-gradient(rgba(15,16,28,0.06) 1px, transparent 1px);
    opacity: 0.4;
  }

  a { color: var(--text-link); text-decoration: none; transition: color var(--t-fast) var(--ease); }
  a:hover { color: var(--accent-hover); text-decoration: none; }

  /* Heading scale — confident, editorial, tight tracking */
  h1, h2, h3, h4, h5, h6 {
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: -0.022em;
    line-height: 1.18;
    color: var(--text-strong);
  }
  h1 { font-size: var(--t-xl); letter-spacing: -0.028em; }
  h2 { font-size: var(--t-lg); letter-spacing: -0.022em; }
  h3 { font-size: var(--t-md); font-weight: 600; letter-spacing: -0.015em; }
  h4 { font-size: var(--t-base); font-weight: 600; letter-spacing: -0.01em; }
  h5, h6 { font-size: var(--t-sm); font-weight: 600; letter-spacing: -0.005em; }

  /* Editorial display heading utility — used by landing + marketing pages */
  .display {
    font-family: var(--font-display);
    font-size: clamp(40px, 7.5vw, 96px);
    line-height: 0.98;
    letter-spacing: -0.04em;
    font-weight: 600;
    color: var(--text-strong);
  }

  /* Eyebrow — uppercase mono label that sits above section headings */
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: var(--s-3);
  }
  .eyebrow::before {
    content: '';
    width: 18px;
    height: 1px;
    background: currentColor;
    opacity: 0.6;
  }

  /* Section header — paired eyebrow + title + lede */
  .section-header { max-width: 720px; margin: 0 auto var(--s-10); text-align: center; }
  .section-header.left { text-align: left; margin-left: 0; margin-right: auto; }
  .section-header h2 {
    font-size: clamp(28px, 4vw, 44px);
    line-height: 1.05;
    letter-spacing: -0.028em;
    margin-bottom: var(--s-3);
  }
  .section-header p {
    color: var(--text-muted);
    font-size: var(--t-md);
    line-height: 1.6;
    max-width: 580px;
    margin: 0 auto;
  }
  .section-header.left p { margin-left: 0; }

  code, kbd, samp {
    font-family: var(--font-mono);
    font-feature-settings: var(--mono-feat);
  }
  code {
    font-size: 0.9em;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    padding: 1px 6px;
    border-radius: var(--r-sm);
    color: var(--text);
  }
  kbd, .kbd {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 4px;
    color: var(--text);
    line-height: 1.5;
    vertical-align: middle;
  }

  /* Mono utility for technical chrome (paths, IDs, dates) */
  .mono { font-family: var(--font-mono); font-feature-settings: var(--mono-feat); font-size: 0.96em; }
  .meta-mono { font-family: var(--font-mono); font-size: var(--t-xs); color: var(--text-muted); letter-spacing: 0; }

  /* Pre-launch banner — slim, refined, mono caption */
  .prelaunch-banner {
    position: relative;
    background:
      linear-gradient(180deg, rgba(251,191,36,0.10), rgba(251,191,36,0.03)),
      var(--bg);
    border-bottom: 1px solid rgba(251,191,36,0.28);
    color: var(--yellow);
    padding: 7px 24px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    text-align: center;
    line-height: 1.5;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .prelaunch-banner::before {
    content: '◆';
    margin-right: 8px;
    font-size: 9px;
    opacity: 0.7;
    vertical-align: 1px;
  }

  /* Block Q3 — Playground banner. Brighter than the prelaunch strip so
     visitors don't miss the "save your work" CTA, but slim enough to
     not feel like a modal. */
  .playground-banner {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background:
      linear-gradient(180deg, rgba(251,191,36,0.20), rgba(251,191,36,0.06)),
      var(--bg);
    border-bottom: 1px solid rgba(251,191,36,0.45);
    color: var(--yellow, #fbbf24);
    padding: 8px 40px 8px 24px;
    font-size: 13px;
    font-weight: 500;
    text-align: center;
    line-height: 1.4;
  }
  .playground-banner-icon { font-size: 14px; }
  .playground-banner-text { color: var(--text-strong, #e6edf3); }
  .playground-banner-countdown { font-weight: 600; }
  .playground-banner-cta {
    margin-left: 4px;
    color: var(--yellow, #fbbf24);
    text-decoration: underline;
    font-weight: 600;
  }
  .playground-banner-cta:hover { opacity: 0.85; }
  .playground-banner-dismiss {
    position: absolute;
    top: 50%;
    right: 12px;
    transform: translateY(-50%);
    background: transparent;
    border: none;
    color: var(--text-muted, #8b949e);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .playground-banner-dismiss:hover { color: var(--text-strong, #e6edf3); }

  /* Header — sticky, blurred, hairline border, taller for breathing room */
  header {
    position: sticky;
    top: 0;
    z-index: 100;
    border-bottom: 1px solid var(--border);
    padding: 0 24px;
    height: var(--header-h);
    background: rgba(8,9,15,0.72);
    backdrop-filter: saturate(180%) blur(18px);
    -webkit-backdrop-filter: saturate(180%) blur(18px);
  }
  :root[data-theme='light'] header { background: rgba(251,251,252,0.78); }

  header nav {
    display: flex;
    align-items: center;
    gap: 18px;
    max-width: 1920px;
    margin: 0 auto;
    height: 100%;
  }
  .logo {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: var(--text-strong);
    display: inline-flex;
    align-items: center;
    gap: 9px;
    transition: opacity var(--t-fast) var(--ease);
  }
  .logo::before {
    content: '';
    width: 20px; height: 20px;
    border-radius: 6px;
    background: var(--accent-gradient);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.25),
      0 0 0 1px rgba(140,109,255,0.45),
      0 0 20px rgba(140,109,255,0.30);
    flex-shrink: 0;
    transition: transform var(--t-base) var(--ease-spring), box-shadow var(--t-base) var(--ease);
  }
  .logo:hover { text-decoration: none; color: var(--text-strong); }
  .logo:hover::before {
    transform: rotate(8deg) scale(1.05);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.30),
      0 0 0 1px rgba(140,109,255,0.55),
      0 0 28px rgba(140,109,255,0.45);
  }

  .nav-search {
    flex: 1;
    max-width: 360px;
    margin: 0 4px 0 8px;
    position: relative;
  }
  .nav-search input {
    width: 100%;
    padding: 7px 12px 7px 32px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: var(--t-sm);
    transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
  }
  .nav-search::before {
    content: '';
    position: absolute;
    left: 11px; top: 50%;
    transform: translateY(-50%);
    width: 12px; height: 12px;
    border: 1.5px solid var(--text-faint);
    border-radius: 50%;
    pointer-events: none;
  }
  .nav-search::after {
    content: '';
    position: absolute;
    left: 19px; top: calc(50% + 4px);
    width: 5px; height: 1.5px;
    background: var(--text-faint);
    transform: rotate(45deg);
    pointer-events: none;
  }
  .nav-search input::placeholder { color: var(--text-faint); }
  .nav-search input:focus {
    outline: none;
    background: var(--bg-secondary);
    border-color: var(--border-focus);
    box-shadow: var(--ring);
  }

  .nav-right { display: flex; align-items: center; gap: 2px; margin-left: auto; }

  /* Block N3 — site-admin deploy status pill */
  .nav-deploy-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    margin: 0 6px 0 0;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    color: var(--text-strong);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    text-decoration: none;
    transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  .nav-deploy-pill:hover { background: var(--bg-hover); text-decoration: none; }
  .nav-deploy-pill .deploy-pill-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #6b7280;
  }
  .deploy-pill-success .deploy-pill-dot { background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.45); }
  .deploy-pill-failed  .deploy-pill-dot { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.45); }
  .deploy-pill-failed  { border-color: rgba(248,113,113,0.4); }
  .deploy-pill-progress .deploy-pill-dot {
    background: #fbbf24;
    box-shadow: 0 0 6px rgba(251,191,36,0.55);
    animation: deployPillPulse 1.2s ease-in-out infinite;
  }
  @keyframes deployPillPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.45; transform: scale(0.8); }
  }
  .deploy-pill-empty .deploy-pill-dot { background: #9ca3af; }

  /* ── AI dropdown (nav consolidation) ── */
  .nav-ai-dropdown {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .nav-ai-trigger {
    background: transparent;
    border: 0;
    font: inherit;
    cursor: pointer;
    color: var(--text-muted);
    font-size: var(--t-sm);
    font-weight: 500;
    padding: 7px 11px;
    border-radius: var(--r-sm);
    line-height: 1.2;
  }
  .nav-ai-trigger:hover {
    color: var(--text-strong);
    background: var(--bg-hover);
  }
  .nav-ai-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 220px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.40), 0 0 0 1px rgba(140,109,255,0.10);
    padding: 6px;
    display: none;
    z-index: var(--z-overlay, 100);
  }
  .nav-ai-dropdown:hover .nav-ai-menu,
  .nav-ai-dropdown.is-open .nav-ai-menu,
  .nav-ai-dropdown:focus-within .nav-ai-menu {
    display: block;
  }
  .nav-ai-item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 10px;
    border-radius: 6px;
    color: var(--text);
    text-decoration: none;
    transition: background var(--t-fast) var(--ease);
  }
  .nav-ai-item:hover {
    background: var(--bg-hover);
    text-decoration: none;
    color: var(--text-strong);
  }
  .nav-ai-item-label {
    font-size: var(--t-sm);
    font-weight: 600;
    color: var(--text-strong);
  }
  .nav-ai-item-sub {
    font-size: 11.5px;
    color: var(--text-muted);
  }

  .nav-link {
    position: relative;
    color: var(--text-muted);
    font-size: var(--t-sm);
    font-weight: 500;
    padding: 7px 11px;
    border-radius: var(--r-sm);
    transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
  }
  .nav-link:hover {
    color: var(--text-strong);
    background: var(--bg-hover);
    text-decoration: none;
  }
  .nav-link.active { color: var(--text-strong); }
  .nav-link.active::after {
    content: '';
    position: absolute;
    left: 11px; right: 11px;
    bottom: -1px;
    height: 2px;
    background: var(--accent-gradient);
    border-radius: 2px;
  }
  /* "Migrate from GitHub" nav link — logged-out only, slightly accented
     so it reads as an action affordance rather than a passive link. */
  .nav-migrate {
    color: var(--accent);
    font-weight: 600;
    border: 1px solid rgba(140,109,255,0.22);
    background: rgba(140,109,255,0.07);
  }
  .nav-migrate:hover {
    color: var(--accent-hover);
    background: rgba(140,109,255,0.13);
    border-color: rgba(140,109,255,0.40);
  }
  @media (max-width: 780px) { .nav-migrate { display: none; } }

  .nav-user {
    color: var(--text-strong);
    font-weight: 600;
    font-size: var(--t-sm);
    padding: 6px 10px;
    border-radius: var(--r-sm);
    margin-left: 6px;
    transition: background var(--t-fast) var(--ease);
  }
  .nav-user::before {
    content: '';
    display: inline-block;
    width: 8px; height: 8px;
    background: var(--green);
    border-radius: 50%;
    margin-right: 7px;
    box-shadow: 0 0 8px rgba(52,211,153,0.5);
    vertical-align: 1px;
  }
  .nav-user:hover { background: var(--bg-hover); text-decoration: none; }

  /* ── Inbox bell button ── */
  .nav-inbox-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: var(--r-sm);
    color: var(--text-muted);
    transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
    flex-shrink: 0;
  }
  .nav-inbox-btn:hover { color: var(--text); background: var(--bg-hover); text-decoration: none; }
  .nav-inbox-badge {
    position: absolute;
    top: 3px; right: 3px;
    min-width: 15px; height: 15px;
    padding: 0 4px;
    font-size: 9.5px;
    font-weight: 700;
    line-height: 15px;
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    border-radius: 9999px;
    text-align: center;
    box-shadow: 0 0 6px rgba(140,109,255,0.45);
    font-variant-numeric: tabular-nums;
  }

  /* ── User dropdown ── */
  .nav-user-dropdown { position: relative; }
  .nav-user-trigger {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 9px 5px 5px;
    border-radius: var(--r-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: var(--t-sm);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  .nav-user-trigger:hover { background: var(--bg-hover); border-color: var(--border); }
  .nav-user-avatar {
    width: 24px; height: 24px;
    border-radius: 50%;
    background: var(--accent-gradient);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: 0 0 0 2px var(--border);
  }
  .nav-user-name { font-weight: 500; font-size: var(--t-sm); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nav-user-caret { font-size: 8px; opacity: 0.5; }
  .nav-user-menu {
    display: none;
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 220px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    box-shadow: 0 16px 48px -8px rgba(0,0,0,0.55), 0 0 0 1px var(--border);
    padding: 6px;
    z-index: 200;
    animation: navMenuIn 140ms var(--ease) both;
  }
  .nav-user-menu.is-open { display: block; }
  .nav-user-menu-header {
    padding: 8px 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nav-user-menu-name { font-weight: 600; font-size: var(--t-sm); color: var(--text-strong); }
  .nav-user-menu-handle { font-size: var(--t-xs); color: var(--text-muted); }
  .nav-user-menu-sep { height: 1px; background: var(--border); margin: 4px -6px; }
  .nav-user-item {
    display: block;
    padding: 7px 10px;
    border-radius: 6px;
    font-size: var(--t-sm);
    color: var(--text);
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
    white-space: nowrap;
  }
  .nav-user-item:hover { background: var(--bg-hover); color: var(--text-strong); text-decoration: none; }
  .nav-user-item--danger { color: var(--red); }
  .nav-user-item--danger:hover { background: rgba(248,113,113,0.08); color: var(--red); }

  @keyframes navMenuIn {
    from { opacity: 0; transform: translateY(-4px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  main {
    max-width: 1920px;
    margin: 0 auto;
    padding: 36px 24px 80px;
    flex: 1;
    width: 100%;
    /* 2026 polish — subtle entrance animation on every page load.
       Content fades up 4px over 360ms, giving the site that "alive"
       quality that 2026 SaaS expects. Honors prefers-reduced-motion. */
    animation: gxMainEnter 360ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes gxMainEnter {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    main { animation: none; }
  }
  /* 2026 polish — accent focus ring across all focusable elements.
     The default browser ring is utilitarian; this is the same width
     but tinted to the brand accent so keyboard navigation feels
     intentional, not jarring. :focus-visible only — mouse users
     never see it. */
  :focus-visible {
    outline: none;
  }
  a:focus-visible,
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  [tabindex]:focus-visible {
    outline: 2px solid rgba(140, 109, 255, 0.55);
    outline-offset: 2px;
    border-radius: 4px;
  }

  /* Editorial footer: link grid + tagline row */
  footer {
    border-top: 1px solid var(--border);
    padding: 56px 24px 40px;
    color: var(--text-muted);
    font-size: var(--t-sm);
    background:
      linear-gradient(180deg, transparent 0%, rgba(140,109,255,0.025) 100%),
      var(--bg);
  }
  footer .footer-inner {
    max-width: 1920px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 48px;
    align-items: start;
  }
  footer .footer-brand .logo { margin-bottom: var(--s-3); }
  footer .footer-tag {
    color: var(--text-muted);
    font-size: var(--t-sm);
    max-width: 320px;
    line-height: 1.55;
  }
  footer .footer-links {
    display: grid;
    grid-template-columns: repeat(3, minmax(120px, auto));
    gap: 0 56px;
  }
  footer .footer-col-title {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-faint);
    margin-bottom: var(--s-3);
  }
  footer .footer-col a {
    display: block;
    color: var(--text-muted);
    font-size: var(--t-sm);
    padding: 5px 0;
    transition: color var(--t-fast) var(--ease);
  }
  footer .footer-col a:hover { color: var(--text-strong); text-decoration: none; }
  footer .footer-bottom {
    max-width: 1920px;
    margin: 40px auto 0;
    padding-top: 24px;
    border-top: 1px solid var(--border-subtle);
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--text-faint);
    font-size: var(--t-xs);
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
  }
  footer .footer-bottom a { color: var(--text-faint); }
  footer .footer-bottom a:hover { color: var(--text-muted); text-decoration: none; }
  footer .footer-build {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 11px;
    cursor: help;
  }
  footer .footer-build-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 6px rgba(52,211,153,0.55);
    animation: footer-build-pulse 2.4s ease-in-out infinite;
  }
  @keyframes footer-build-pulse {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }
  @media (max-width: 768px) {
    footer .footer-inner { grid-template-columns: 1fr; gap: 32px; }
    footer .footer-links { grid-template-columns: repeat(2, 1fr); gap: 24px 32px; }
    footer .footer-bottom { flex-direction: column; gap: 8px; text-align: center; }
  }

  /* ============================================================ */
  /* Buttons                                                      */
  /* ============================================================ */
  /* ============================================================ */
  /* Buttons — Block U2 senior polish pass.                       */
  /* Rules:                                                       */
  /*  · hover lifts every .btn by 1px + soft drop shadow (180ms)  */
  /*  · active presses back down to 0 (80ms — faster on press)    */
  /*  · focus-visible uses a soft box-shadow ring (no outline)    */
  /*  · primary gradient shifts position on hover for a slow      */
  /*    600ms shimmer                                             */
  /*  · disabled never lifts and never animates                   */
  /* ============================================================ */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 7px 14px;
    border-radius: var(--r-sm);
    font-family: var(--font-sans);
    font-size: var(--t-sm);
    font-weight: 500;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    cursor: pointer;
    text-decoration: none;
    line-height: 1.25;
    letter-spacing: -0.008em;
    /* U2 — hover/transform settles in 180ms; press snaps in 80ms.
       Listed once on the base rule so :active can override only the
       transform/duration without re-typing the colour/bg transitions. */
    transition:
      background 180ms ease,
      border-color 180ms ease,
      transform 180ms ease,
      box-shadow 180ms ease,
      color 180ms ease;
    user-select: none;
    white-space: nowrap;
    position: relative;
  }
  .btn:hover {
    background: var(--bg-surface);
    border-color: var(--border-strong);
    color: var(--text-strong);
    text-decoration: none;
    /* U2 — universal hover lift + soft accent drop shadow. */
    transform: translateY(-1px);
    box-shadow: 0 4px 12px -4px rgba(15, 17, 26, 0.45);
  }
  .btn:active {
    transform: translateY(0);
    transition-duration: 80ms;
  }
  /* U2 — soft modern focus ring via box-shadow, not outline. */
  .btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(140, 109, 255, 0.35);
  }

  .btn-primary {
    background: var(--accent-gradient);
    background-size: 200% 100%;
    background-position: 0% 50%;
    border-color: transparent;
    color: #fff;
    font-weight: 600;
    text-shadow: 0 1px 0 rgba(0,0,0,0.15);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.22),
      inset 0 -1px 0 rgba(0,0,0,0.10),
      0 1px 2px rgba(0,0,0,0.40),
      0 0 0 1px rgba(140,109,255,0.30);
    /* U2 — slower 600ms transition on background-position so the
       primary CTA shimmers when the cursor lands. */
    transition:
      background-position 600ms ease,
      transform 180ms ease,
      box-shadow 180ms ease,
      color 180ms ease;
  }
  .btn-primary::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(180deg, rgba(255,255,255,0.18), transparent 60%);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
    pointer-events: none;
  }
  .btn-primary:hover {
    color: #fff;
    background: var(--accent-gradient);
    background-size: 200% 100%;
    background-position: 100% 50%;
    border-color: transparent;
    transform: translateY(-1px);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.30),
      inset 0 -1px 0 rgba(0,0,0,0.10),
      0 6px 18px -4px rgba(140,109,255,0.45),
      0 0 0 1px rgba(140,109,255,0.45);
  }
  .btn-primary:hover::before { opacity: 1; }
  .btn-primary:active { transform: translateY(0); transition-duration: 80ms; }
  /* U2 — primary focus ring uses the same accent box-shadow recipe. */
  .btn-primary:focus-visible {
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.22),
      0 0 0 3px rgba(140,109,255,0.35);
  }

  .btn-danger {
    background: transparent;
    border-color: rgba(248,113,113,0.40);
    color: var(--red);
  }
  .btn-danger:hover {
    background: rgba(248,113,113,0.08);
    border-color: var(--red);
    color: var(--red);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px -4px rgba(248,113,113,0.30);
  }
  .btn-danger:focus-visible { box-shadow: 0 0 0 3px rgba(248,113,113,0.35); }

  .btn-ghost {
    background: transparent;
    border-color: transparent;
    color: var(--text-muted);
  }
  .btn-ghost:hover {
    background: var(--bg-hover);
    color: var(--text-strong);
    border-color: var(--border);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px -4px rgba(15, 17, 26, 0.30);
  }

  .btn-secondary {
    background: var(--bg-elevated);
    border-color: var(--border-strong);
    color: var(--text-strong);
  }
  .btn-secondary:hover {
    background: var(--bg-surface);
    border-color: var(--border-strong);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px -4px rgba(15, 17, 26, 0.35);
  }

  .btn-sm  { padding: 4px 10px; font-size: var(--t-xs); border-radius: var(--r-sm); gap: 5px; }
  .btn-lg  { padding: 11px 22px; font-size: var(--t-base); border-radius: var(--r); }
  .btn-xl  { padding: 14px 28px; font-size: var(--t-md); border-radius: var(--r); font-weight: 600; }
  .btn-block { width: 100%; }

  /* U2 — disabled never lifts, never shimmers, never glows. */
  .btn:disabled,
  .btn[aria-disabled='true'],
  .btn:disabled:hover,
  .btn[aria-disabled='true']:hover {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
    transform: none;
    box-shadow: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .btn,
    .btn:hover,
    .btn:active,
    .btn-primary,
    .btn-primary:hover {
      transform: none;
      transition: background-color 80ms linear, color 80ms linear;
    }
  }

  /* ============================================================ */
  /* Forms                                                        */
  /* ============================================================ */
  .form-group { margin-bottom: 20px; }
  .form-group label {
    display: block;
    font-size: var(--t-sm);
    font-weight: 500;
    margin-bottom: 6px;
    color: var(--text);
    letter-spacing: -0.005em;
  }
  .form-group input,
  .form-group textarea,
  .form-group select,
  input[type='text'], input[type='email'], input[type='password'],
  input[type='url'], input[type='search'], input[type='number'],
  textarea, select {
    width: 100%;
    padding: 9px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font-size: var(--t-sm);
    font-family: var(--font-sans);
    transition:
      border-color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease);
  }
  .form-group input::placeholder, textarea::placeholder, input::placeholder {
    color: var(--text-faint);
  }
  .form-group input:hover, textarea:hover, select:hover,
  input[type='text']:hover, input[type='email']:hover, input[type='password']:hover {
    border-color: var(--border-strong);
  }
  .form-group input:focus, .form-group textarea:focus, .form-group select:focus,
  input:focus, textarea:focus, select:focus {
    outline: none;
    background: var(--bg);
    border-color: var(--border-focus);
    box-shadow: var(--ring);
  }
  textarea { font-family: var(--font-mono); font-size: var(--t-sm); line-height: 1.55; }
  .input-disabled { opacity: 0.5; cursor: not-allowed; }

  /* ============================================================ */
  /* Auth (register / login / verify)                             */
  /* ============================================================ */
  .auth-container {
    /* 2026 polish — wider, more generous, with a subtle accent-glow
       border and gradient top-edge so it reads as a premium product
       gateway, not a stock form. The 480px width feels intentional
       (not cramped, not endless). */
    max-width: 480px;
    margin: 72px auto;
    padding: 40px 40px 36px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow:
      var(--elev-2),
      0 24px 64px -16px rgba(140, 109, 255, 0.12);
    position: relative;
    overflow: hidden;
  }
  .auth-container::before {
    /* Hairline gradient accent on the top edge — signals 'AI-native'
       without shouting. Pointer-events disabled so it never interferes
       with form interactions. */
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .auth-container h2 {
    margin: 0 0 8px;
    font-size: 28px;
    font-weight: 700;
    font-family: var(--font-display);
    letter-spacing: -0.025em;
    color: var(--text-strong);
    line-height: 1.15;
  }
  .auth-container .auth-subtitle {
    color: var(--text-muted);
    font-size: 14.5px;
    line-height: 1.5;
    margin: 0 0 24px;
  }
  .auth-container > p {
    color: var(--text-muted);
    font-size: var(--t-sm);
    margin-bottom: 24px;
  }
  .auth-container .btn-primary {
    width: 100%;
    padding: 12px 16px;
    font-size: 15px;
    font-weight: 600;
    margin-top: 4px;
  }

  /* OAuth provider buttons (Google / GitHub / SSO). Single-line layout
     with a brand-coloured logo on the left and a label centred-trailing.
     Hover lifts 1px with a subtle shadow — matches the rest of the
     button system but reads as a brand-affiliated action, not a brand-
     coloured primary CTA. */
  .auth-container .oauth-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    padding: 11px 16px;
    background: var(--bg-surface, var(--bg-elevated));
    border: 1px solid var(--border);
    border-radius: var(--r-md, 8px);
    color: var(--text-strong);
    font-family: var(--font-sans);
    font-size: 14.5px;
    font-weight: 500;
    text-decoration: none;
    transition:
      transform var(--t-base, 180ms) var(--ease, ease),
      box-shadow var(--t-base, 180ms) var(--ease, ease),
      background var(--t-fast, 120ms) var(--ease, ease),
      border-color var(--t-fast, 120ms) var(--ease, ease);
  }
  .auth-container .oauth-btn:hover {
    transform: translateY(-1px);
    background: var(--bg-hover);
    border-color: var(--text-muted);
    color: var(--text-strong);
    box-shadow: 0 4px 14px -4px rgba(0,0,0,0.25);
    text-decoration: none;
  }
  .auth-container .oauth-btn:focus-visible {
    outline: 2px solid rgba(140, 109, 255, 0.55);
    outline-offset: 2px;
  }
  .auth-container .oauth-btn .oauth-icon {
    flex-shrink: 0;
  }
  /* GitHub icon adopts the text colour so it reads in both themes. */
  .auth-container .oauth-github .oauth-icon {
    color: var(--text-strong);
  }
  /* Google logo uses the official 4-colour treatment via inline SVG fill
     attributes — nothing to override here. */
  /* "or" divider between the password form and provider buttons */
  .auth-container .auth-divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 20px 0 12px;
    color: var(--text-faint);
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .auth-container .auth-divider::before,
  .auth-container .auth-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .auth-error {
    background: rgba(248,113,113,0.08);
    border: 1px solid rgba(248,113,113,0.35);
    color: var(--red);
    padding: 10px 14px;
    border-radius: var(--r-sm);
    margin-bottom: 16px;
    font-size: var(--t-sm);
  }
  .auth-success {
    background: rgba(52,211,153,0.08);
    border: 1px solid rgba(52,211,153,0.35);
    color: var(--green);
    padding: 10px 14px;
    border-radius: var(--r-sm);
    margin-bottom: 16px;
    font-size: var(--t-sm);
  }
  .auth-switch {
    margin-top: 20px;
    font-size: var(--t-sm);
    color: var(--text-muted);
    text-align: center;
  }
  .banner {
    background: var(--accent-gradient-faint);
    border: 1px solid rgba(140,109,255,0.35);
    color: var(--text);
    padding: 10px 14px;
    border-radius: var(--r-sm);
    font-size: var(--t-sm);
  }

  /* ============================================================ */
  /* Settings                                                     */
  /* ============================================================ */
  .settings-container { max-width: 720px; }
  .settings-container h2 { margin-bottom: 8px; font-size: var(--t-xl); letter-spacing: -0.02em; }
  .settings-container > h2 + p { color: var(--text-muted); font-size: var(--t-sm); margin-bottom: 24px; }
  .settings-container h3 { font-size: var(--t-md); margin-bottom: 12px; margin-top: 28px; }
  .settings-container h3:first-of-type { margin-top: 0; }
  .ssh-keys-list { margin-bottom: 24px; }
  .ssh-key-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    margin-bottom: 8px;
    background: var(--bg-elevated);
    transition: border-color var(--t-fast) var(--ease);
  }
  .ssh-key-item:hover { border-color: var(--border-strong); }
  .ssh-key-meta { font-size: var(--t-xs); color: var(--text-muted); margin-top: 4px; }
  .ssh-key-meta code { font-size: var(--t-xs); background: var(--bg-tertiary); padding: 1px 6px; border-radius: 3px; margin-right: 8px; }

  /* ============================================================ */
  /* Repo header + nav                                            */
  /* ============================================================ */
  .repo-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 22px;
  }
  .repo-header-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-display);
    font-size: 24px;
    letter-spacing: -0.025em;
    flex-wrap: wrap;
  }
  .repo-header .owner {
    color: var(--text-muted);
    font-weight: 500;
    transition: color var(--t-fast) var(--ease);
  }
  .repo-header .owner:hover { color: var(--text-link); text-decoration: none; }
  .repo-header .separator { color: var(--text-faint); font-weight: 300; }
  .repo-header .name {
    color: var(--text-strong);
    font-weight: 700;
    letter-spacing: -0.028em;
  }
  .repo-header .name:hover { color: var(--text-link); text-decoration: none; }
  .repo-header-fork {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
    letter-spacing: 0.01em;
  }
  .repo-header-fork a { color: var(--text-muted); }
  .repo-header-fork a:hover { color: var(--accent); }
  .repo-header-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: var(--r-full);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    line-height: 1.6;
    vertical-align: 4px;
  }
  .repo-header-pill-archived {
    background: rgba(251,191,36,0.10);
    color: var(--yellow);
    border: 1px solid rgba(251,191,36,0.30);
  }
  .repo-header-pill-template {
    background: var(--accent-gradient-faint);
    color: var(--accent);
    border: 1px solid rgba(140,109,255,0.30);
  }
  .repo-header-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }

  /* Push Watch discoverability — live/recent indicator in the repo header */
  @keyframes pushWatchPulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.3; }
  }
  .repo-header-live-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-decoration: none !important;
    vertical-align: 3px;
    transition: filter 140ms ease, opacity 140ms ease;
  }
  .repo-header-live-badge:hover { filter: brightness(1.15); text-decoration: none !important; }
  .repo-header-live-badge--live {
    background: rgba(218, 54, 51, 0.12);
    color: #f97171;
    border: 1px solid rgba(218, 54, 51, 0.35);
  }
  .repo-header-live-badge--live .repo-header-live-dot {
    animation: pushWatchPulse 1.2s ease-in-out infinite;
    display: inline-block;
  }
  .repo-header-live-badge--recent {
    background: rgba(140, 109, 255, 0.08);
    color: var(--text-muted);
    border: 1px solid rgba(140, 109, 255, 0.22);
  }
  .repo-header-live-badge--recent:hover { color: var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .repo-header-live-badge--live .repo-header-live-dot { animation: none; }
  }

  .repo-nav {
    display: flex;
    gap: 1px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 28px;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .repo-nav::-webkit-scrollbar { height: 0; }
  .repo-nav a {
    position: relative;
    padding: 11px 14px;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    font-size: var(--t-sm);
    font-weight: 500;
    margin-bottom: -1px;
    transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
    white-space: nowrap;
  }
  .repo-nav a:hover { text-decoration: none; color: var(--text-strong); background: var(--bg-hover); }
  .repo-nav a.active {
    color: var(--text-strong);
    font-weight: 600;
  }
  .repo-nav a.active::after {
    content: '';
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: -1px;
    height: 2px;
    background: var(--accent-gradient);
    border-radius: 2px;
  }
  /* AI links in the right-side cluster — sparkle accent */
  .repo-nav-ai {
    color: var(--accent) !important;
    font-weight: 500;
  }
  .repo-nav-ai:hover {
    color: var(--accent-hover) !important;
    background: var(--accent-gradient-faint) !important;
  }
  .repo-nav-ai.active {
    color: var(--accent-hover) !important;
    font-weight: 600;
  }

  .breadcrumb {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 18px;
    color: var(--text-muted);
    font-size: var(--t-sm);
    font-family: var(--font-mono);
    font-feature-settings: var(--mono-feat);
  }
  .breadcrumb a { color: var(--text-link); font-weight: 500; }
  .breadcrumb a:hover { color: var(--accent-hover); }
  .breadcrumb strong {
    color: var(--text-strong);
    font-weight: 600;
  }

  /* Page header — eyebrow + title + optional actions row.
     Use on dashboard, settings, admin, any "section landing" page. */
  .page-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border-subtle);
    flex-wrap: wrap;
  }
  .page-header-text { flex: 1; min-width: 280px; }
  .page-header .eyebrow { margin-bottom: var(--s-2); }
  .page-header h1 {
    font-family: var(--font-display);
    font-size: clamp(24px, 3vw, 36px);
    line-height: 1.1;
    letter-spacing: -0.028em;
    margin-bottom: 6px;
  }
  .page-header p {
    color: var(--text-muted);
    font-size: var(--t-sm);
    line-height: 1.55;
    max-width: 640px;
  }
  .page-header-actions { display: flex; gap: 8px; align-items: center; }

  /* ============================================================ */
  /* File browser table                                           */
  /* ============================================================ */
  .file-table {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--bg-elevated);
    border-collapse: collapse;
  }
  .file-table tr { border-bottom: 1px solid var(--border-subtle); transition: background var(--t-fast) var(--ease); }
  .file-table tr:last-child { border-bottom: none; }
  .file-table td {
    padding: 9px 16px;
    font-size: var(--t-sm);
    font-family: var(--font-mono);
    font-feature-settings: var(--mono-feat);
  }
  .file-table tr:hover { background: var(--bg-hover); }
  .file-icon {
    width: 22px;
    color: var(--text-faint);
    font-size: 13px;
    text-align: center;
  }
  .file-name a {
    color: var(--text);
    font-weight: 500;
    transition: color var(--t-fast) var(--ease);
  }
  .file-name a:hover { color: var(--accent); text-decoration: none; }

  /* ============================================================ */
  /* Blob view                                                    */
  /* ============================================================ */
  .blob-view {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .blob-header {
    background: var(--bg-secondary);
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    font-size: var(--t-sm);
    color: var(--text-muted);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .blob-code {
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--t-sm);
    line-height: 1.65;
  }
  .blob-code table { width: 100%; border-collapse: collapse; }
  .blob-code .line-num {
    width: 1%;
    min-width: 56px;
    padding: 0 14px;
    text-align: right;
    color: var(--text-faint);
    user-select: none;
    white-space: nowrap;
    border-right: 1px solid var(--border);
  }
  .blob-code .line-content { padding: 0 16px; white-space: pre; }
  .blob-code tr:hover { background: var(--bg-hover); }

  /* ============================================================ */
  /* Commits + diffs                                              */
  /* ============================================================ */
  .commit-list {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .commit-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-subtle);
    transition: background var(--t-fast) var(--ease);
  }
  .commit-item:last-child { border-bottom: none; }
  .commit-item:hover { background: var(--bg-hover); }
  .commit-message {
    font-size: var(--t-sm);
    font-weight: 500;
    line-height: 1.45;
    color: var(--text-strong);
    letter-spacing: -0.005em;
  }
  .commit-meta {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 5px;
    letter-spacing: 0.01em;
  }
  .commit-sha {
    font-family: var(--font-mono);
    font-feature-settings: var(--mono-feat);
    font-size: 11px;
    padding: 4px 9px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--accent);
    font-weight: 600;
    letter-spacing: 0.02em;
    transition: all var(--t-fast) var(--ease);
  }
  .commit-sha:hover {
    border-color: rgba(140,109,255,0.40);
    background: var(--accent-gradient-faint);
    color: var(--accent-hover);
    text-decoration: none;
  }

  .diff-view { margin-top: 16px; }
  .diff-file {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    margin-bottom: 16px;
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .diff-file-header {
    background: var(--bg-secondary);
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: var(--t-sm);
    font-weight: 500;
  }
  .diff-content {
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: var(--t-sm);
    line-height: 1.65;
  }
  .diff-content .line-add { background: rgba(52,211,153,0.10); color: var(--green); }
  .diff-content .line-del { background: rgba(248,113,113,0.08); color: var(--red); }
  .diff-content .line-hunk { background: rgba(140,109,255,0.06); color: var(--text-link); }
  .diff-content .line { padding: 0 16px; white-space: pre; display: block; }

  .stat-add { color: var(--green); font-weight: 600; }
  .stat-del { color: var(--red); font-weight: 600; }

  /* ============================================================ */
  /* Empty state                                                  */
  /* ============================================================ */
  .empty-state {
    text-align: center;
    padding: 96px 24px;
    color: var(--text-muted);
    border: 1px dashed var(--border);
    border-radius: var(--r-lg);
    background:
      radial-gradient(60% 60% at 50% 0%, rgba(140,109,255,0.05), transparent 70%),
      var(--bg-elevated);
    position: relative;
    overflow: hidden;
  }
  .empty-state::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image: radial-gradient(rgba(255,255,255,0.025) 1px, transparent 1px);
    background-size: 24px 24px;
    opacity: 0.5;
    pointer-events: none;
    mask-image: radial-gradient(ellipse at center, #000 30%, transparent 70%);
    -webkit-mask-image: radial-gradient(ellipse at center, #000 30%, transparent 70%);
  }
  :root[data-theme='light'] .empty-state::before {
    background-image: radial-gradient(rgba(15,16,28,0.08) 1px, transparent 1px);
  }
  .empty-state > * { position: relative; z-index: 1; }
  .empty-state h2 {
    font-size: var(--t-xl);
    margin-bottom: 8px;
    color: var(--text-strong);
    letter-spacing: -0.022em;
  }
  .empty-state p { font-size: var(--t-md); max-width: 480px; margin: 0 auto; line-height: 1.55; }
  .empty-state pre {
    text-align: left;
    display: inline-block;
    background: var(--bg-secondary);
    padding: 18px 24px;
    border-radius: var(--r-md);
    border: 1px solid var(--border);
    font-family: var(--font-mono);
    font-feature-settings: var(--mono-feat);
    font-size: var(--t-sm);
    margin-top: 24px;
    line-height: 1.8;
    color: var(--text);
    box-shadow: var(--elev-1);
  }

  /* ============================================================ */
  /* Badges                                                       */
  /* ============================================================ */
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 9px;
    border-radius: var(--r-full);
    font-size: var(--t-xs);
    font-weight: 500;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-muted);
    line-height: 1.5;
  }

  /* ============================================================ */
  /* Branch dropdown                                              */
  /* ============================================================ */
  .branch-selector {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-size: var(--t-sm);
    color: var(--text);
    margin-bottom: 12px;
    transition: border-color var(--t-fast) var(--ease);
  }
  .branch-selector:hover { border-color: var(--border-strong); }

  .branch-dropdown {
    position: relative;
    display: inline-block;
    margin-bottom: 12px;
  }
  .branch-dropdown-content {
    display: none;
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 10;
    min-width: 220px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    overflow: hidden;
    box-shadow: var(--elev-3);
  }
  .branch-dropdown:hover .branch-dropdown-content,
  .branch-dropdown:focus-within .branch-dropdown-content { display: block; }
  .branch-dropdown-content a {
    display: block;
    padding: 9px 14px;
    font-size: var(--t-sm);
    color: var(--text);
    border-bottom: 1px solid var(--border);
    transition: background var(--t-fast) var(--ease);
  }
  .branch-dropdown-content a:last-child { border-bottom: none; }
  .branch-dropdown-content a:hover { background: var(--bg-hover); text-decoration: none; }
  .branch-dropdown-content a.active-branch { color: var(--text-link); font-weight: 600; background: var(--accent-gradient-faint); }

  /* ============================================================ */
  /* Card grid                                                    */
  /* ============================================================ */
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 16px;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 20px;
    background: var(--bg-elevated);
    transition:
      border-color var(--t-base) var(--ease),
      transform var(--t-base) var(--ease-out-quart),
      box-shadow var(--t-base) var(--ease);
    position: relative;
    overflow: hidden;
    isolation: isolate;
  }
  .card::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(140,109,255,0.06), transparent 50%);
    opacity: 0;
    transition: opacity var(--t-base) var(--ease);
    pointer-events: none;
    z-index: -1;
  }
  .card:hover {
    border-color: var(--border-strong);
    box-shadow: var(--elev-2);
    transform: translateY(-2px);
  }
  .card:hover::before { opacity: 1; }
  .card h3 { font-size: var(--t-md); margin-bottom: 6px; letter-spacing: -0.012em; }
  .card h3 a { color: var(--text); font-weight: 600; }
  .card h3 a:hover { color: var(--text-link); }
  .card p { font-size: var(--t-sm); color: var(--text-muted); line-height: 1.5; }
  .card-meta {
    display: flex;
    gap: 14px;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    font-size: var(--t-xs);
    color: var(--text-muted);
  }
  .card-meta span { display: flex; align-items: center; gap: 5px; }

  /* ============================================================ */
  /* Stat card / box                                              */
  /* ============================================================ */
  .stat-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 16px;
    transition: border-color var(--t-fast) var(--ease);
  }
  .stat-card:hover { border-color: var(--border-strong); }
  .stat-label {
    font-size: var(--t-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }
  .stat-value {
    font-size: var(--t-xl);
    font-weight: 700;
    margin-top: 4px;
    letter-spacing: -0.025em;
    color: var(--text);
    font-feature-settings: 'tnum';
  }

  /* ============================================================ */
  /* Star button                                                  */
  /* ============================================================ */
  .star-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font-size: var(--t-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--t-fast) var(--ease);
  }
  .star-btn:hover { background: var(--bg-surface); border-color: var(--border-strong); text-decoration: none; }
  .star-btn.starred {
    color: var(--yellow);
    border-color: rgba(251,191,36,0.4);
    background: rgba(251,191,36,0.08);
  }

  /* ============================================================ */
  /* User profile                                                 */
  /* ============================================================ */
  .user-profile {
    display: flex;
    gap: 32px;
    margin-bottom: 32px;
    padding: 24px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
  }
  .user-avatar {
    width: 96px;
    height: 96px;
    border-radius: var(--r-full);
    background: var(--accent-gradient-soft);
    border: 1px solid var(--border-strong);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 36px;
    font-weight: 600;
    color: var(--text);
    flex-shrink: 0;
    letter-spacing: -0.02em;
  }
  .user-info h2 { font-size: var(--t-xl); margin-bottom: 2px; letter-spacing: -0.025em; }
  .user-info .username { font-size: var(--t-md); color: var(--text-muted); }
  .user-info .bio { font-size: var(--t-sm); color: var(--text-muted); margin-top: 10px; line-height: 1.55; }

  /* ============================================================ */
  /* New repo form                                                */
  /* ============================================================ */
  .new-repo-form { max-width: 640px; }
  .new-repo-form h2 { margin-bottom: 24px; font-size: var(--t-xl); letter-spacing: -0.025em; }
  .visibility-options { display: flex; gap: 12px; margin-bottom: 20px; }
  .visibility-option {
    flex: 1;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg-elevated);
    cursor: pointer;
    text-align: left;
    transition: all var(--t-fast) var(--ease);
  }
  .visibility-option:hover { border-color: var(--border-strong); background: var(--bg-surface); }
  .visibility-option:has(input:checked) {
    border-color: var(--accent);
    background: var(--accent-gradient-faint);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .visibility-option input { display: none; }
  .visibility-option .vis-label { font-size: var(--t-sm); font-weight: 600; margin-bottom: 4px; }
  .visibility-option .vis-desc { font-size: var(--t-xs); color: var(--text-muted); }

  /* ============================================================ */
  /* Issues                                                       */
  /* ============================================================ */
  .issue-tabs { display: flex; gap: 4px; }
  .issue-tabs a {
    color: var(--text-muted);
    font-size: var(--t-sm);
    font-weight: 500;
    padding: 6px 12px;
    border-radius: var(--r-sm);
    transition: all var(--t-fast) var(--ease);
  }
  .issue-tabs a:hover { color: var(--text); background: var(--bg-hover); text-decoration: none; }
  .issue-tabs a.active { color: var(--text); background: var(--bg-elevated); }

  .issue-list {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .issue-item {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    transition: background var(--t-fast) var(--ease);
  }
  .issue-item:last-child { border-bottom: none; }
  .issue-item:hover { background: var(--bg-hover); }
  .issue-state-icon {
    font-size: 14px;
    padding-top: 2px;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--r-full);
    flex-shrink: 0;
  }
  .state-open { color: var(--green); }
  .state-closed { color: #b69dff; }
  .issue-title {
    font-family: var(--font-display);
    font-size: var(--t-md);
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: -0.012em;
  }
  .issue-title a { color: var(--text-strong); transition: color var(--t-fast) var(--ease); }
  .issue-title a:hover { color: var(--accent); text-decoration: none; }
  .issue-meta {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 5px;
    letter-spacing: 0.01em;
  }

  .issue-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: var(--r-full);
    font-size: var(--t-sm);
    font-weight: 500;
    line-height: 1.4;
  }
  .badge-open { background: rgba(52,211,153,0.10); color: var(--green); border: 1px solid rgba(52,211,153,0.35); }
  .badge-closed { background: rgba(182,157,255,0.10); color: #b69dff; border: 1px solid rgba(182,157,255,0.35); }
  .badge-merged { background: rgba(140,109,255,0.10); color: var(--accent); border: 1px solid rgba(140,109,255,0.35); }
  .state-merged { color: var(--accent); }
  .ai-review { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(140,109,255,0.3); }

  .issue-detail { max-width: 920px; }
  .issue-comment-box {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    margin-bottom: 16px;
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .comment-header {
    background: var(--bg-secondary);
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    font-size: var(--t-sm);
    color: var(--text-muted);
  }

  /* ============================================================ */
  /* Panel — flexible container used across many pages            */
  /* ============================================================ */
  .panel {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
  }
  .panel-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    transition: background var(--t-fast) var(--ease);
  }
  .panel-item:last-child { border-bottom: none; }
  .panel-item:hover { background: var(--bg-hover); }

  /* ─── j/k keyboard list navigation ─── */
  .is-kbd-focus {
    outline: 2px solid rgba(140,109,255,0.6) !important;
    outline-offset: -2px;
    background: rgba(140,109,255,0.06) !important;
    border-radius: 4px;
  }
  .is-kbd-selected {
    outline: 2px solid rgba(52,211,153,0.6) !important;
    background: rgba(52,211,153,0.06) !important;
  }
  .panel-empty {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--t-sm);
  }

  /* ============================================================ */
  /* Search                                                       */
  /* ============================================================ */
  .search-results .diff-file { margin-bottom: 12px; }

  /* ============================================================ */
  /* Timeline                                                     */
  /* ============================================================ */
  .timeline { position: relative; padding-left: 28px; }
  .timeline::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    background: linear-gradient(180deg, var(--border) 0%, transparent 100%);
  }
  .timeline-item { position: relative; padding-bottom: 16px; }
  .timeline-dot {
    position: absolute;
    left: -28px;
    top: 8px;
    width: 12px;
    height: 12px;
    border-radius: var(--r-full);
    background: var(--accent-gradient);
    border: 2px solid var(--bg);
    box-shadow: 0 0 0 1px var(--border-strong);
  }
  .timeline-content {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 14px 16px;
  }

  /* ============================================================ */
  /* Toggle switch                                                */
  /* ============================================================ */
  .toggle-switch {
    position: relative;
    display: inline-block;
    width: 40px;
    height: 22px;
    flex-shrink: 0;
    margin-left: 16px;
  }
  .toggle-switch input { opacity: 0; width: 0; height: 0; }
  .toggle-slider {
    position: absolute;
    cursor: pointer;
    top: 0; left: 0; right: 0; bottom: 0;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--r-full);
    transition: all var(--t-base) var(--ease);
  }
  .toggle-slider::before {
    content: '';
    position: absolute;
    height: 16px;
    width: 16px;
    left: 2px;
    bottom: 2px;
    background: var(--text-muted);
    border-radius: var(--r-full);
    transition: all var(--t-base) var(--ease);
  }
  .toggle-switch input:checked + .toggle-slider {
    background: var(--accent-gradient);
    border-color: transparent;
    box-shadow: 0 0 0 1px rgba(140,109,255,0.4);
  }
  .toggle-switch input:checked + .toggle-slider::before {
    transform: translateX(18px);
    background: #fff;
  }

  /* ============================================================
   * 2026 polish layer (purely additive — no layout changes).
   * Improves typography rendering, focus states, hover affordances,
   * and adds the gradient brand cue to primary buttons. Anything
   * that could alter dimensions stays in the rules above.
   * ============================================================ */
  html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  body { letter-spacing: -0.005em; font-feature-settings: 'cv11', 'ss01', 'ss03'; }
  *::selection { background: rgba(168,85,247,0.35); color: var(--text); }

  h1, h2, h3, h4 { letter-spacing: -0.018em; }
  h1 { letter-spacing: -0.025em; }

  /* Smoother colour transitions everywhere links live */
  a { transition: color 120ms cubic-bezier(0.16,1,0.3,1); }

  /* Buttons: focus rings + smoother transitions; primary gets the gradient */
  .btn {
    transition:
      background 120ms cubic-bezier(0.16,1,0.3,1),
      border-color 120ms cubic-bezier(0.16,1,0.3,1),
      transform 120ms cubic-bezier(0.16,1,0.3,1),
      box-shadow 120ms cubic-bezier(0.16,1,0.3,1);
  }
  .btn:active { transform: translateY(0.5px); }
  .btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(168,85,247,0.30);
  }
  .btn-primary {
    background: linear-gradient(135deg, #a855f7 0%, #06b6d4 100%);
    border-color: transparent;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.15),
      0 1px 2px rgba(168,85,247,0.25);
  }
  .btn-primary:hover {
    background: linear-gradient(135deg, #b766f8 0%, #22cce0 100%);
    filter: none;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.20),
      0 4px 12px rgba(168,85,247,0.30);
  }

  /* Inputs: cleaner focus ring + hover */
  .form-group input:hover,
  .form-group textarea:hover,
  .form-group select:hover {
    border-color: rgba(255,255,255,0.14);
  }
  .form-group input:focus,
  .form-group textarea:focus,
  .form-group select:focus {
    border-color: rgba(168,85,247,0.55);
    box-shadow: 0 0 0 3px rgba(168,85,247,0.22);
  }
  :root[data-theme='light'] .form-group input:hover,
  :root[data-theme='light'] .form-group textarea:hover,
  :root[data-theme='light'] .form-group select:hover {
    border-color: rgba(0,0,0,0.18);
  }

  /* Cards: subtle hover lift */
  .card {
    transition:
      border-color 160ms cubic-bezier(0.16,1,0.3,1),
      transform 160ms cubic-bezier(0.16,1,0.3,1),
      box-shadow 200ms cubic-bezier(0.16,1,0.3,1);
  }
  .card:hover {
    border-color: rgba(255,255,255,0.18);
    transform: translateY(-1px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.30);
  }
  :root[data-theme='light'] .card:hover {
    border-color: rgba(0,0,0,0.18);
    box-shadow: 0 8px 24px rgba(0,0,0,0.08);
  }

  /* Issue / commit / panel rows: smoother hover */
  .issue-item, .commit-item {
    transition: background 120ms cubic-bezier(0.16,1,0.3,1);
  }
  .repo-nav a {
    transition: color 120ms cubic-bezier(0.16,1,0.3,1),
                border-bottom-color 120ms cubic-bezier(0.16,1,0.3,1);
  }
  .nav-link {
    transition: color 120ms cubic-bezier(0.16,1,0.3,1);
  }

  /* Auth card: subtle elevation so register/login feel premium */
  .auth-container {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--r-lg, 12px);
    padding: 32px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.30), 0 0 0 1px var(--border);
  }
  :root[data-theme='light'] .auth-container {
    box-shadow: 0 4px 16px rgba(0,0,0,0.06), 0 0 0 1px var(--border);
  }
  .auth-container h2 { letter-spacing: -0.025em; }

  /* Empty state: dashed border, generous padding */
  .empty-state {
    border: 1px dashed var(--border);
    border-radius: var(--r-lg, 12px);
    background: var(--bg);
  }

  /* Badges + commit-sha: smoother transition */
  .commit-sha, .badge { transition: all 120ms cubic-bezier(0.16,1,0.3,1); }

  /* Gradient text utility — matches landing's accent treatment */
  .gradient-text {
    background: linear-gradient(135deg, #a855f7 0%, #06b6d4 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  /* Custom scrollbars (subtle, themed) */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.06);
    border: 2px solid var(--bg);
    border-radius: 9999px;
  }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.14); }
  :root[data-theme='light'] ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.10); }
  :root[data-theme='light'] ::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.18); }

  /* Honour reduced-motion preference */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* Block O3 — visual coherence additive rules. */
  .card.card-p-none { padding: 0; }
  .card.card-p-sm { padding: var(--space-3); }
  .card.card-p-md { padding: var(--space-4); }
  .card.card-p-lg { padding: var(--space-6); }
  .card.card-elevated { box-shadow: var(--elev-2); }
  .card.card-gradient {
    background:
      linear-gradient(135deg, rgba(140,109,255,0.05), transparent 60%),
      var(--bg-elevated);
  }
  .card.card-gradient::before { opacity: 1; }
  .notice {
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    font-size: var(--font-size-sm);
    margin-bottom: var(--space-6);
    line-height: var(--leading-normal);
  }
  .notice-info { border-color: rgba(96,165,250,0.40); background: rgba(96,165,250,0.08); color: var(--text); }
  .notice-success { border-color: var(--green); background: rgba(52,211,153,0.08); color: var(--text); }
  .notice-warn { border-color: var(--yellow); background: rgba(251,191,36,0.10); color: var(--yellow); }
  .notice-error { border-color: var(--red); background: rgba(248,113,113,0.10); color: var(--red); }
  .notice-accent { border-color: var(--accent); background: rgba(140,109,255,0.10); color: var(--text); }
  .email-preview {
    padding: var(--space-5);
    background: #fff;
    color: #111;
    border-radius: var(--radius-md);
  }
  .code-block {
    margin: var(--space-2) 0 0;
    padding: var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    line-height: var(--leading-normal);
    overflow-x: auto;
  }
  .status-pill-operational {
    display: inline-flex;
    align-items: center;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--font-size-xs);
    font-weight: 600;
    background: rgba(52,211,153,0.15);
    color: var(--green);
  }
  .api-tag {
    display: inline-flex;
    align-items: center;
    font-size: var(--font-size-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
  }
  .api-tag-auth { background: rgba(96,165,250,0.15); color: var(--accent); }
  .api-tag-scope { background: rgba(52,211,153,0.15); color: var(--green); }
  .stat-number {
    font-size: var(--font-size-xl);
    font-weight: 700;
    color: var(--text-strong);
    line-height: var(--leading-tight);
  }
  .stat-number-accent { color: var(--accent); }
  .stat-number-blue { color: var(--blue); }
  .stat-number-purple { color: var(--text-link); }
  footer .footer-tag-sub {
    margin-top: var(--space-2);
    font-size: var(--font-size-xs);
    color: var(--text-faint);
    line-height: var(--leading-normal);
  }
  footer .footer-version-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    cursor: help;
  }
  footer .footer-banner {
    max-width: 1240px;
    margin: var(--space-6) auto 0;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: center;
  }
  footer .footer-banner-info { border-color: rgba(96,165,250,0.40); color: var(--blue); }
  footer .footer-banner-warn { border-color: rgba(251,191,36,0.40); color: var(--yellow); }
  footer .footer-banner-error { border-color: rgba(248,113,113,0.45); color: var(--red); }

  /* ============================================================ */
  /* Global toast notifications.                                  */
  /* Slide-in from right, auto-dismiss, ARIA-live for SR users.   */
  /* ============================================================ */
  .gx-toast {
    pointer-events: auto;
    display: inline-flex;
    align-items: flex-start;
    gap: 10px;
    min-width: 280px;
    max-width: min(440px, calc(100vw - 32px));
    padding: 12px 14px 12px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow:
      0 12px 36px -10px rgba(15,16,28,0.18),
      0 2px 6px rgba(15,16,28,0.04),
      0 0 0 1px rgba(15,16,28,0.02);
    color: var(--text);
    font-size: 13.5px;
    line-height: 1.45;
    opacity: 0;
    transform: translateX(16px);
    transition:
      opacity 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
      transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .gx-toast--in { opacity: 1; transform: translateX(0); }
  .gx-toast--out { opacity: 0; transform: translateX(16px); }
  .gx-toast__icon {
    flex-shrink: 0;
    width: 20px; height: 20px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    margin-top: 1px;
  }
  .gx-toast__text { flex: 1 1 auto; min-width: 0; padding-top: 2px; word-wrap: break-word; }
  .gx-toast__close {
    flex-shrink: 0;
    width: 22px; height: 22px;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    border-radius: 4px;
    padding: 0;
    margin: -2px -2px 0 0;
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
  }
  .gx-toast__close:hover { background: var(--bg-hover); color: var(--text); }
  .gx-toast--success .gx-toast__icon { background: rgba(5,150,105,0.14); color: var(--green); }
  .gx-toast--error   .gx-toast__icon { background: rgba(220,38,38,0.14); color: var(--red); }
  .gx-toast--warn    .gx-toast__icon { background: rgba(217,119,6,0.16); color: var(--yellow); }
  .gx-toast--info    .gx-toast__icon { background: rgba(109,77,255,0.14); color: var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .gx-toast { transition: opacity 60ms linear; transform: none; }
    .gx-toast--in, .gx-toast--out { transform: none; }
  }

  /* ============================================================ */
  /* Block U4 — cross-document view transitions.                  */
  /* Chrome 126+, Edge, Safari 18.2+ get a soft 200ms fade on     */
  /* every same-origin navigation. Older browsers ignore these    */
  /* rules entirely — no JS shim, no breakage.                    */
  /* prefers-reduced-motion disables the animation honourably.    */
  /* ============================================================ */
  @view-transition {
    navigation: auto;
  }
  ::view-transition-old(root),
  ::view-transition-new(root) {
    animation-duration: 200ms;
    animation-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  ::view-transition-old(root) {
    animation-name: vt-fade-out;
  }
  ::view-transition-new(root) {
    animation-name: vt-fade-in;
  }
  @keyframes vt-fade-out {
    to { opacity: 0; }
  }
  @keyframes vt-fade-in {
    from { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    ::view-transition-old(root),
    ::view-transition-new(root) {
      animation-duration: 0s;
    }
  }
  /* The transition system picks up its root subject from this rule. */
  body {
    view-transition-name: root;
  }
`;
