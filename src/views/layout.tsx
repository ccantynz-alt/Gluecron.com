import type { FC, PropsWithChildren } from "hono/jsx";
import type { User } from "../db/schema";
import { hljsThemeCss } from "../lib/highlight";
import { clientJs } from "./client-js";

export const Layout: FC<
  PropsWithChildren<{
    title?: string;
    user?: User | null;
    notificationCount?: number;
    theme?: "dark" | "light";
  }>
> = ({ children, title, user, notificationCount, theme }) => {
  const initialTheme = theme === "light" ? "light" : "dark";
  return (
    <html lang="en" data-theme={initialTheme}>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#0d1117" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" type="image/svg+xml" href="/icon.svg" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />
        <title>{title ? `${title} — gluecron` : "gluecron"}</title>
        <script>{themeInitScript}</script>
        <style>{css}</style>
        <style>{hljsThemeCss}</style>
      </head>
      <body>
        <div class="prelaunch-banner" role="status" aria-live="polite">
          Pre-launch &mdash; Gluecron is in final validation. Public signups
          and git hosting for non-owner users open after launch review.
        </div>
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
              <a
                href="/theme/toggle"
                class="nav-link nav-theme"
                title="Toggle theme"
                aria-label="Toggle theme"
              >
                <span class="theme-icon-dark">{"\u263E"}</span>
                <span class="theme-icon-light">{"\u2600"}</span>
              </a>
              <a href="/explore" class="nav-link">
                Explore
              </a>
              {user ? (
                <>
                  <a href="/dashboard" class="nav-link" style="font-weight: 600">
                    Dashboard
                  </a>
                  <a href="/import" class="nav-link">
                    Import
                  </a>
                  <a href="/new" class="btn btn-sm btn-primary">
                    + New
                  </a>
                  <a href={`/${user.username}`} class="nav-user">
                    {user.displayName || user.username}
                  </a>
                  <a href="/settings" class="nav-link">
                    Settings
                  </a>
                  <a href="/logout" class="nav-link">
                    Sign out
                  </a>
                </>
              ) : (
                <>
                  <a href="/login" class="nav-link">
                    Sign in
                  </a>
                  <a href="/register" class="btn btn-sm btn-primary">
                    Register
                  </a>
                </>
              )}
            </div>
          </nav>
        </header>
        <main id="main-content">{children}</main>
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
                <a href="/explore">Explore</a>
                <a href="/marketplace">Marketplace</a>
                <a href="/help">Quickstart</a>
                <a href="/shortcuts">Shortcuts</a>
              </div>
              <div class="footer-col">
                <div class="footer-col-title">Platform</div>
                <a href="/status">Status</a>
                <a href="/api/graphql">GraphQL</a>
                <a href="/mcp">MCP server</a>
                <a href="/sitemap.xml">Sitemap</a>
              </div>
              <div class="footer-col">
                <div class="footer-col-title">Legal</div>
                <a href="/terms">Terms</a>
                <a href="/privacy">Privacy</a>
                <a href="/acceptable-use">Acceptable use</a>
              </div>
            </div>
          </div>
          <div class="footer-bottom">
            <span>&copy; {new Date().getFullYear()} gluecron</span>
            <span>shipped with intent · v1</span>
          </div>
        </footer>
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
            style="width:100%;padding:12px 16px;background:transparent;color:var(--text);border:0;border-bottom:1px solid var(--border);outline:none;font-size:14px"
          />
          <div id="cmdk-list" style="max-height:60vh;overflow-y:auto" />
        </div>
        <script>{clientJs}</script>
        <script>{pwaRegisterScript}</script>
        <script>{navScript}</script>
      </body>
    </html>
  );
};

// Runs before paint — reads the theme cookie and flips data-theme so there's
// no dark-to-light flash on load. SSR default is dark.
const themeInitScript = `
  (function(){
    try {
      var m = document.cookie.match(/(?:^|; )theme=([^;]+)/);
      var t = m ? decodeURIComponent(m[1]) : 'dark';
      if (t !== 'light' && t !== 'dark') t = 'dark';
      document.documentElement.setAttribute('data-theme', t);
    } catch(_){}
  })();
`;

// Block G1 — register service worker for offline / install support.
// Kept inline (and tiny) so we don't block first paint.
const pwaRegisterScript = `
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('/sw.js').catch(function(){});
    });
  }
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
                ' style="padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--border);' + bg + '">' +
                '<div>' + item.label + '</div>' +
                '<div style="font-size:11px;color:var(--text-muted)">' + item.href + '</div>' +
                '</div>';
      }
      if (filtered.length === 0) {
        html = '<div style="padding:16px;color:var(--text-muted);text-align:center">No matches.</div>';
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
    });
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

    /* Type — Inter Tight for sans (tighter metrics) */
    --font-mono: 'JetBrains Mono', 'SF Mono', 'Cascadia Code', 'Fira Code', ui-monospace, monospace;
    --font-sans: 'Inter Tight', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    --font-display: 'Inter Tight', 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
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
    line-height: 1.55;
    letter-spacing: -0.011em;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    font-feature-settings: 'cv11', 'ss01', 'ss03', 'calt';
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
    max-width: 1240px;
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

  main {
    max-width: 1240px;
    margin: 0 auto;
    padding: 36px 24px 80px;
    flex: 1;
    width: 100%;
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
    max-width: 1240px;
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
    max-width: 1240px;
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
  @media (max-width: 768px) {
    footer .footer-inner { grid-template-columns: 1fr; gap: 32px; }
    footer .footer-links { grid-template-columns: repeat(2, 1fr); gap: 24px 32px; }
    footer .footer-bottom { flex-direction: column; gap: 8px; text-align: center; }
  }

  /* ============================================================ */
  /* Buttons                                                      */
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
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      transform var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
    user-select: none;
    white-space: nowrap;
    position: relative;
  }
  .btn:hover {
    background: var(--bg-surface);
    border-color: var(--border-strong);
    color: var(--text-strong);
    text-decoration: none;
  }
  .btn:active { transform: translateY(1px); }
  .btn:focus-visible { outline: none; box-shadow: var(--ring); }

  .btn-primary {
    background: var(--accent-gradient);
    border-color: transparent;
    color: #fff;
    font-weight: 600;
    text-shadow: 0 1px 0 rgba(0,0,0,0.15);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.22),
      inset 0 -1px 0 rgba(0,0,0,0.10),
      0 1px 2px rgba(0,0,0,0.40),
      0 0 0 1px rgba(140,109,255,0.30);
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
    border-color: transparent;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.30),
      inset 0 -1px 0 rgba(0,0,0,0.10),
      0 6px 18px -4px rgba(140,109,255,0.45),
      0 0 0 1px rgba(140,109,255,0.45);
  }
  .btn-primary:hover::before { opacity: 1; }

  .btn-danger {
    background: transparent;
    border-color: rgba(248,113,113,0.40);
    color: var(--red);
  }
  .btn-danger:hover {
    background: rgba(248,113,113,0.08);
    border-color: var(--red);
    color: var(--red);
  }
  .btn-danger:focus-visible { box-shadow: var(--ring-err); }

  .btn-ghost {
    background: transparent;
    border-color: transparent;
    color: var(--text-muted);
  }
  .btn-ghost:hover {
    background: var(--bg-hover);
    color: var(--text-strong);
    border-color: var(--border);
  }

  .btn-secondary {
    background: var(--bg-elevated);
    border-color: var(--border-strong);
    color: var(--text-strong);
  }
  .btn-secondary:hover {
    background: var(--bg-surface);
    border-color: var(--border-strong);
  }

  .btn-sm  { padding: 4px 10px; font-size: var(--t-xs); border-radius: var(--r-sm); gap: 5px; }
  .btn-lg  { padding: 11px 22px; font-size: var(--t-base); border-radius: var(--r); }
  .btn-xl  { padding: 14px 28px; font-size: var(--t-md); border-radius: var(--r); font-weight: 600; }
  .btn-block { width: 100%; }

  .btn:disabled, .btn[aria-disabled='true'] {
    opacity: 0.45;
    cursor: not-allowed;
    pointer-events: none;
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
    max-width: 420px;
    margin: 64px auto;
    padding: 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--elev-2);
  }
  .auth-container h2 {
    margin-bottom: 6px;
    font-size: var(--t-lg);
    letter-spacing: -0.02em;
  }
  .auth-container > p {
    color: var(--text-muted);
    font-size: var(--t-sm);
    margin-bottom: 24px;
  }
  .auth-container .btn-primary { width: 100%; padding: 10px 16px; }
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
    gap: 8px;
    margin-bottom: 18px;
    font-size: var(--t-lg);
    letter-spacing: -0.015em;
  }
  .repo-header .owner { color: var(--text-link); font-weight: 500; }
  .repo-header .separator { color: var(--text-faint); }
  .repo-header .name { color: var(--text); font-weight: 700; }
  .repo-header .name:hover { color: var(--text-link); text-decoration: none; }
  .repo-header-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }

  .repo-nav {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 24px;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .repo-nav::-webkit-scrollbar { height: 0; }
  .repo-nav a {
    padding: 10px 14px;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    font-size: var(--t-sm);
    font-weight: 500;
    margin-bottom: -1px;
    transition: all var(--t-fast) var(--ease);
    white-space: nowrap;
  }
  .repo-nav a:hover { text-decoration: none; color: var(--text); background: var(--bg-hover); }
  .repo-nav a.active {
    color: var(--text);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }

  .breadcrumb {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-bottom: 16px;
    color: var(--text-muted);
    font-size: var(--t-sm);
    font-family: var(--font-mono);
  }
  .breadcrumb a { color: var(--text-link); font-weight: 500; }
  .breadcrumb a:hover { color: var(--accent-hover); }

  /* ============================================================ */
  /* File browser table                                           */
  /* ============================================================ */
  .file-table {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .file-table tr { border-bottom: 1px solid var(--border); }
  .file-table tr:last-child { border-bottom: none; }
  .file-table td { padding: 10px 16px; font-size: var(--t-sm); }
  .file-table tr:hover { background: var(--bg-hover); }
  .file-icon { width: 22px; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--t-sm); }
  .file-name a { color: var(--text); font-weight: 500; }
  .file-name a:hover { color: var(--text-link); text-decoration: none; }

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
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    transition: background var(--t-fast) var(--ease);
  }
  .commit-item:last-child { border-bottom: none; }
  .commit-item:hover { background: var(--bg-hover); }
  .commit-message { font-size: var(--t-sm); font-weight: 500; line-height: 1.45; }
  .commit-meta { font-size: var(--t-xs); color: var(--text-muted); margin-top: 4px; }
  .commit-sha {
    font-family: var(--font-mono);
    font-size: var(--t-xs);
    padding: 3px 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text-link);
    font-weight: 500;
    transition: all var(--t-fast) var(--ease);
  }
  .commit-sha:hover { border-color: var(--border-strong); color: var(--accent-hover); }

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
    font-size: var(--t-base);
    font-weight: 600;
    line-height: 1.4;
    letter-spacing: -0.005em;
  }
  .issue-title a { color: var(--text); }
  .issue-title a:hover { color: var(--text-link); text-decoration: none; }
  .issue-meta { font-size: var(--t-xs); color: var(--text-muted); margin-top: 4px; }

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

  /* ============================================================ */
  /* Utilities — gradient text, surfaces, dot-grid, skeleton      */
  /* ============================================================ */
  .gradient-text {
    background: var(--accent-gradient);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .surface { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--r-md); }
  .surface-elevated { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--r-md); box-shadow: var(--elev-1); }
  .surface-glow {
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--elev-2), var(--accent-glow);
  }

  /* Dot-grid background utility — for hero surfaces, empty states, terminal blocks */
  .dot-grid {
    background-image: radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px);
    background-size: 22px 22px;
  }
  :root[data-theme='light'] .dot-grid {
    background-image: radial-gradient(rgba(15,16,28,0.06) 1px, transparent 1px);
  }

  /* Hairline-grid background utility */
  .grid-lines {
    background-image:
      linear-gradient(to right, var(--border-subtle) 1px, transparent 1px),
      linear-gradient(to bottom, var(--border-subtle) 1px, transparent 1px);
    background-size: 56px 56px;
  }

  /* Skeleton loader */
  .skeleton {
    background: linear-gradient(90deg, var(--bg-tertiary) 0%, var(--bg-surface) 50%, var(--bg-tertiary) 100%);
    background-size: 200% 100%;
    animation: skel 1.4s ease-in-out infinite;
    border-radius: var(--r-sm);
  }
  @keyframes skel { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  /* Inline divider */
  .divider {
    border: 0;
    border-top: 1px solid var(--border);
    margin: var(--s-6) 0;
  }
  .divider-vert {
    width: 1px;
    align-self: stretch;
    background: var(--border);
    margin: 0 var(--s-3);
  }

  /* Stagger fade-in helper — apply to a parent, animate children */
  .stagger > * {
    opacity: 0;
    transform: translateY(10px);
    animation: stagger-in 600ms var(--ease-out-expo) forwards;
  }
  .stagger > *:nth-child(1) { animation-delay: 0ms; }
  .stagger > *:nth-child(2) { animation-delay: 60ms; }
  .stagger > *:nth-child(3) { animation-delay: 120ms; }
  .stagger > *:nth-child(4) { animation-delay: 180ms; }
  .stagger > *:nth-child(5) { animation-delay: 240ms; }
  .stagger > *:nth-child(6) { animation-delay: 300ms; }
  .stagger > *:nth-child(7) { animation-delay: 360ms; }
  .stagger > *:nth-child(8) { animation-delay: 420ms; }
  @keyframes stagger-in {
    to { opacity: 1; transform: translateY(0); }
  }

  /* Tag pill — used for labels, topics */
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: var(--r-full);
    font-size: 11px;
    font-weight: 500;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-muted);
    line-height: 1.5;
    font-family: var(--font-mono);
    letter-spacing: 0.01em;
  }
  .tag-accent {
    background: var(--accent-gradient-faint);
    border-color: rgba(140,109,255,0.30);
    color: var(--accent);
  }

  /* Command palette polish */
  .cmdk-item { transition: background var(--t-fast) var(--ease); }
  .cmdk-item:hover { background: var(--bg-hover) !important; }
  .cmdk-active { background: var(--accent-gradient-faint) !important; border-left: 2px solid var(--accent) !important; }

  /* Reduced motion preference */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* Tablet + below */
  @media (max-width: 768px) {
    main { padding: 20px 16px 40px; }
    header { padding: 0 16px; }
    .nav-search { display: none; }
    .repo-header { font-size: var(--t-md); }
    .card-grid { grid-template-columns: 1fr; }
    .auth-container { margin: 32px 16px; padding: 24px; }
    .visibility-options { flex-direction: column; }
  }

  /* Scrollbar styling — subtle, themed */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: var(--bg-surface);
    border: 2px solid var(--bg);
    border-radius: var(--r-full);
  }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }
`;
