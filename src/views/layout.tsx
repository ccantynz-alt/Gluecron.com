import type { FC, PropsWithChildren } from "hono/jsx";

export const Layout: FC<PropsWithChildren<{ title?: string }>> = ({
  children,
  title,
}) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title ? `${title} — gluecron` : "gluecron"}</title>
        <style>{css}</style>
      </head>
      <body>
        <header>
          <nav>
            <a href="/" class="logo">
              gluecron
            </a>
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          <span>gluecron — AI-native code intelligence</span>
        </footer>
      </body>
    </html>
  );
};

const css = `
  :root {
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

  header {
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    background: var(--bg-secondary);
  }

  header nav { display: flex; align-items: center; gap: 20px; max-width: 1200px; margin: 0 auto; }
  .logo { font-size: 20px; font-weight: 700; color: var(--text); }
  .logo:hover { text-decoration: none; color: var(--text-link); }

  main { max-width: 1200px; margin: 0 auto; padding: 24px; flex: 1; width: 100%; }

  footer {
    border-top: 1px solid var(--border);
    padding: 16px 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

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
  }

  .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    background: var(--bg-secondary);
  }
  .card h3 { font-size: 16px; margin-bottom: 4px; }
  .card p { font-size: 13px; color: var(--text-muted); }
`;
