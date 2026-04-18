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
          <span>
            &copy; {new Date().getFullYear()} gluecron — AI-native code intelligence
          </span>
          <div style="margin-top: 6px; display: flex; gap: 16px; justify-content: center; font-size: 12px">
            <a href="/terms" style="color: var(--text-muted)">Terms</a>
            <a href="/privacy" style="color: var(--text-muted)">Privacy</a>
            <a href="/acceptable-use" style="color: var(--text-muted)">Acceptable Use</a>
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
        html += '<div class="' + cls + '" data-idx="' + i + '" data-href="' + item.href + '"' +
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
      if (item) { go(item.getAttribute('data-href')); }
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
  :root, :root[data-theme='dark'] {
    --bg: #0d1117;
    --bg-secondary: #161b22;
    --bg-tertiary: #21262d;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --text-link: #58a6ff;
    --accent: #1f6feb;
    --accent-hover: #388bfd;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --font-mono: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    --radius: 6px;
  }

  :root[data-theme='light'] {
    --bg: #ffffff;
    --bg-secondary: #f6f8fa;
    --bg-tertiary: #eaeef2;
    --border: #d0d7de;
    --text: #1f2328;
    --text-muted: #656d76;
    --text-link: #0969da;
    --accent: #0969da;
    --accent-hover: #0550ae;
    --green: #1a7f37;
    --red: #cf222e;
    --yellow: #9a6700;
  }

  /* Theme toggle — show the icon for the *opposite* theme so users see what they'll switch to. */
  .nav-theme { display: inline-flex; align-items: center; font-size: 16px; line-height: 1; }
  :root[data-theme='dark'] .theme-icon-dark { display: none; }
  :root[data-theme='light'] .theme-icon-light { display: none; }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  a { color: var(--text-link); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Pre-launch banner - always visible, not dismissible. Amber tone, readable
     on both light and dark themes via the shared --yellow token. */
  .prelaunch-banner {
    background: rgba(210, 153, 34, 0.15);
    border-bottom: 1px solid var(--yellow);
    color: var(--yellow);
    padding: 8px 24px;
    font-size: 13px;
    font-weight: 500;
    text-align: center;
    line-height: 1.4;
  }

  header {
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    background: var(--bg-secondary);
  }

  header nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    max-width: 1200px;
    margin: 0 auto;
  }
  .logo { font-size: 20px; font-weight: 700; color: var(--text); }
  .logo:hover { text-decoration: none; color: var(--text-link); }

  .nav-right { display: flex; align-items: center; gap: 16px; }
  .nav-link { color: var(--text-muted); font-size: 14px; }
  .nav-link:hover { color: var(--text); text-decoration: none; }
  .nav-user { color: var(--text); font-weight: 600; font-size: 14px; }
  .nav-user:hover { color: var(--text-link); text-decoration: none; }

  main { max-width: 1200px; margin: 0 auto; padding: 24px; flex: 1; width: 100%; }

  footer {
    border-top: 1px solid var(--border);
    padding: 16px 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: var(--radius);
    font-size: 14px;
    font-weight: 500;
    border: 1px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text);
    cursor: pointer;
    text-decoration: none;
    line-height: 1.4;
  }
  .btn:hover { background: var(--border); text-decoration: none; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-danger { background: transparent; border-color: var(--red); color: var(--red); }
  .btn-danger:hover { background: rgba(248, 81, 73, 0.15); }
  .btn-sm { padding: 4px 12px; font-size: 13px; }

  /* Forms */
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; color: var(--text); }
  .form-group input, .form-group textarea, .form-group select {
    width: 100%;
    padding: 8px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 14px;
    font-family: var(--font-sans);
  }
  .form-group input:focus, .form-group textarea:focus, .form-group select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(31, 111, 235, 0.3);
  }
  .input-disabled { opacity: 0.5; cursor: not-allowed; }

  /* Auth */
  .auth-container { max-width: 400px; margin: 40px auto; }
  .auth-container h2 { margin-bottom: 20px; font-size: 24px; }
  .auth-error {
    background: rgba(248, 81, 73, 0.1);
    border: 1px solid var(--red);
    color: var(--red);
    padding: 8px 12px;
    border-radius: var(--radius);
    margin-bottom: 16px;
    font-size: 14px;
  }
  .auth-success {
    background: rgba(63, 185, 80, 0.1);
    border: 1px solid var(--green);
    color: var(--green);
    padding: 8px 12px;
    border-radius: var(--radius);
    margin-bottom: 16px;
    font-size: 14px;
  }
  .auth-switch { margin-top: 16px; font-size: 14px; color: var(--text-muted); }

  /* Settings */
  .settings-container { max-width: 600px; }
  .settings-container h2 { margin-bottom: 20px; font-size: 24px; }
  .settings-container h3 { font-size: 18px; margin-bottom: 12px; }
  .ssh-keys-list { margin-bottom: 24px; }
  .ssh-key-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 8px;
    background: var(--bg-secondary);
  }
  .ssh-key-meta { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .ssh-key-meta code { font-size: 11px; background: var(--bg-tertiary); padding: 1px 6px; border-radius: 3px; margin-right: 8px; }

  /* Repo header */
  .repo-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    font-size: 20px;
  }
  .repo-header .owner { color: var(--text-link); }
  .repo-header .separator { color: var(--text-muted); }
  .repo-header .name { color: var(--text-link); font-weight: 600; }
  .repo-header-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }

  .repo-nav {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
  }
  .repo-nav a {
    padding: 8px 16px;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    font-size: 14px;
  }
  .repo-nav a:hover { text-decoration: none; color: var(--text); }
  .repo-nav a.active { color: var(--text); border-bottom-color: var(--accent); }

  .breadcrumb { display: flex; gap: 4px; align-items: center; margin-bottom: 16px; color: var(--text-muted); font-size: 14px; }
  .breadcrumb a { color: var(--text-link); }

  .file-table { width: 100%; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .file-table tr { border-bottom: 1px solid var(--border); }
  .file-table tr:last-child { border-bottom: none; }
  .file-table td { padding: 8px 16px; font-size: 14px; }
  .file-table tr:hover { background: var(--bg-secondary); }
  .file-icon { width: 20px; color: var(--text-muted); }
  .file-name a { color: var(--text); }
  .file-name a:hover { color: var(--text-link); text-decoration: underline; }

  .blob-view {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .blob-header {
    background: var(--bg-secondary);
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-muted);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .blob-code {
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
  }
  .blob-code table { width: 100%; border-collapse: collapse; }
  .blob-code .line-num {
    width: 1%;
    min-width: 50px;
    padding: 0 12px;
    text-align: right;
    color: var(--text-muted);
    user-select: none;
    white-space: nowrap;
    border-right: 1px solid var(--border);
  }
  .blob-code .line-content { padding: 0 12px; white-space: pre; }

  .commit-list { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .commit-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .commit-item:last-child { border-bottom: none; }
  .commit-item:hover { background: var(--bg-secondary); }
  .commit-message { font-size: 14px; font-weight: 500; }
  .commit-meta { font-size: 12px; color: var(--text-muted); }
  .commit-sha {
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 2px 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-link);
  }

  .diff-view { margin-top: 16px; }
  .diff-file {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 16px;
    overflow: hidden;
  }
  .diff-file-header {
    background: var(--bg-secondary);
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .diff-content {
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
  }
  .diff-content .line-add { background: rgba(63, 185, 80, 0.15); color: var(--green); }
  .diff-content .line-del { background: rgba(248, 81, 73, 0.1); color: var(--red); }
  .diff-content .line-hunk { background: rgba(56, 139, 253, 0.1); color: var(--text-link); }
  .diff-content .line { padding: 0 12px; white-space: pre; display: block; }

  .stat-add { color: var(--green); font-weight: 600; }
  .stat-del { color: var(--red); font-weight: 600; }

  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-muted);
  }
  .empty-state h2 { font-size: 24px; margin-bottom: 8px; color: var(--text); }
  .empty-state pre {
    text-align: left;
    display: inline-block;
    background: var(--bg-secondary);
    padding: 16px 24px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 13px;
    margin-top: 16px;
    line-height: 1.8;
  }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-muted);
  }

  .branch-selector {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
    color: var(--text);
    margin-bottom: 12px;
    position: relative;
  }

  .branch-dropdown {
    position: relative;
    display: inline-block;
    margin-bottom: 12px;
  }
  .branch-dropdown-content {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 10;
    min-width: 200px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-top: 4px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .branch-dropdown:hover .branch-dropdown-content,
  .branch-dropdown:focus-within .branch-dropdown-content { display: block; }
  .branch-dropdown-content a {
    display: block;
    padding: 8px 12px;
    font-size: 13px;
    color: var(--text);
    border-bottom: 1px solid var(--border);
  }
  .branch-dropdown-content a:last-child { border-bottom: none; }
  .branch-dropdown-content a:hover { background: var(--bg-tertiary); text-decoration: none; }
  .branch-dropdown-content a.active-branch { color: var(--text-link); font-weight: 600; }

  .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    background: var(--bg-secondary);
    transition: border-color 0.15s;
  }
  .card:hover { border-color: var(--text-muted); }
  .card h3 { font-size: 16px; margin-bottom: 4px; }
  .card h3 a { color: var(--text-link); }
  .card p { font-size: 13px; color: var(--text-muted); }
  .card-meta { display: flex; gap: 16px; margin-top: 12px; font-size: 12px; color: var(--text-muted); }
  .card-meta span { display: flex; align-items: center; gap: 4px; }

  .star-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 13px;
    cursor: pointer;
  }
  .star-btn:hover { background: var(--border); text-decoration: none; }
  .star-btn.starred { color: var(--yellow); border-color: var(--yellow); }

  .user-profile {
    display: flex;
    gap: 32px;
    margin-bottom: 32px;
  }
  .user-avatar {
    width: 96px;
    height: 96px;
    border-radius: 50%;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 40px;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .user-info h2 { font-size: 24px; margin-bottom: 2px; }
  .user-info .username { font-size: 16px; color: var(--text-muted); }
  .user-info .bio { font-size: 14px; color: var(--text-muted); margin-top: 8px; }

  .new-repo-form { max-width: 600px; }
  .new-repo-form h2 { margin-bottom: 20px; }
  .visibility-options { display: flex; gap: 12px; margin-bottom: 16px; }
  .visibility-option {
    flex: 1;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-secondary);
    cursor: pointer;
    text-align: center;
  }
  .visibility-option:has(input:checked) { border-color: var(--accent); background: rgba(31, 111, 235, 0.1); }
  .visibility-option input { display: none; }
  .visibility-option .vis-label { font-size: 14px; font-weight: 500; }
  .visibility-option .vis-desc { font-size: 12px; color: var(--text-muted); }

  /* Issues */
  .issue-tabs { display: flex; gap: 16px; }
  .issue-tabs a { color: var(--text-muted); font-size: 14px; font-weight: 500; }
  .issue-tabs a:hover { color: var(--text); text-decoration: none; }
  .issue-tabs a.active { color: var(--text); }

  .issue-list { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .issue-item {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .issue-item:last-child { border-bottom: none; }
  .issue-item:hover { background: var(--bg-secondary); }
  .issue-state-icon { font-size: 16px; padding-top: 2px; }
  .state-open { color: var(--green); }
  .state-closed { color: #986ee2; }
  .issue-title { font-size: 15px; font-weight: 600; }
  .issue-title a { color: var(--text); }
  .issue-title a:hover { color: var(--text-link); }
  .issue-meta { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

  .issue-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 500;
  }
  .badge-open { background: rgba(63, 185, 80, 0.15); color: var(--green); border: 1px solid var(--green); }
  .badge-closed { background: rgba(152, 110, 226, 0.15); color: #986ee2; border: 1px solid #986ee2; }
  .badge-merged { background: rgba(152, 110, 226, 0.15); color: #986ee2; border: 1px solid #986ee2; }
  .state-merged { color: #986ee2; }
  .ai-review { border-color: var(--accent); }

  .issue-detail { max-width: 900px; }
  .issue-comment-box {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 16px;
    overflow: hidden;
  }
  .comment-header {
    background: var(--bg-secondary);
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-muted);
  }

  /* Search */
  .search-results .diff-file { margin-bottom: 12px; }

  /* Timeline */
  .timeline { position: relative; padding-left: 24px; }
  .timeline::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    background: var(--border);
  }
  .timeline-item {
    position: relative;
    padding-bottom: 16px;
  }
  .timeline-dot {
    position: absolute;
    left: -24px;
    top: 6px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-muted);
    border: 2px solid var(--bg);
  }
  .timeline-content {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 16px;
  }

  /* Toggle switch */
  .toggle-switch {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
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
    border-radius: 12px;
    transition: 0.2s;
  }
  .toggle-slider::before {
    content: '';
    position: absolute;
    height: 18px;
    width: 18px;
    left: 2px;
    bottom: 2px;
    background: var(--text-muted);
    border-radius: 50%;
    transition: 0.2s;
  }
  .toggle-switch input:checked + .toggle-slider {
    background: var(--accent);
    border-color: var(--accent);
  }
  .toggle-switch input:checked + .toggle-slider::before {
    transform: translateX(20px);
    background: #fff;
  }
`;
