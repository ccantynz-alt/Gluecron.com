/**
 * API Documentation — interactive docs page.
 *
 * 2026 polish: scoped `.apidocs-*` class system gives every endpoint group
 * its own card, every endpoint its own row with a color-coded method pill,
 * and every code example a solid-white spec block with a Copy button
 * (recipe lifted from `build-agent-spec.tsx`). Nothing outside `.apidocs-*`
 * is touched and the route surface is unchanged.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const apiDocs = new Hono<AuthEnv>();

// ─── Scoped CSS (.apidocs-*) ────────────────────────────────────────────────
const apiDocsStyles = `
  .apidocs-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  /* ─── Header ─── */
  .apidocs-head { margin-bottom: var(--space-5); }
  .apidocs-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .apidocs-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .apidocs-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 3.6vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .apidocs-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .apidocs-sub {
    margin: 0;
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 720px;
  }
  .apidocs-sub a { color: var(--accent); text-decoration: none; }
  .apidocs-sub a:hover { text-decoration: underline; }

  /* ─── Section card per endpoint group ─── */
  .apidocs-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .apidocs-section::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .apidocs-section-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  .apidocs-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .apidocs-section-sub {
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .apidocs-section-sub code,
  .apidocs-sub code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: rgba(255,255,255,0.04);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .apidocs-section-body {
    padding: var(--space-3) var(--space-5) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* ─── Per-endpoint card ─── */
  .apidocs-endpoint {
    display: grid;
    grid-template-columns: 64px 1fr auto;
    column-gap: 14px;
    row-gap: 6px;
    align-items: start;
    padding: 12px 14px;
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 11px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .apidocs-endpoint:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
  }
  @media (max-width: 720px) {
    .apidocs-endpoint {
      grid-template-columns: 1fr;
      grid-template-areas: "method" "path" "desc" "badges";
    }
    .apidocs-method { grid-area: method; justify-self: start; }
    .apidocs-path { grid-area: path; }
    .apidocs-desc { grid-area: desc; }
    .apidocs-badges { grid-area: badges; justify-self: start; }
  }
  .apidocs-method {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px 8px;
    min-width: 56px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    border-radius: 6px;
    text-align: center;
    text-transform: uppercase;
    line-height: 1.4;
  }
  .apidocs-method.m-get {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .apidocs-method.m-post {
    background: rgba(140,109,255,0.16);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }
  .apidocs-method.m-put,
  .apidocs-method.m-patch {
    background: rgba(251,191,36,0.14);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .apidocs-method.m-delete {
    background: rgba(248,113,113,0.14);
    color: #fecaca;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .apidocs-path {
    font-family: var(--font-mono);
    font-size: 13px;
    color: #e9e2ff;
    word-break: break-all;
    line-height: 1.5;
  }
  .apidocs-desc {
    grid-column: 2 / 3;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .apidocs-desc code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: rgba(255,255,255,0.04);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .apidocs-params {
    display: block;
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .apidocs-badges {
    display: inline-flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-end;
  }
  @media (max-width: 720px) {
    .apidocs-badges { flex-direction: row; flex-wrap: wrap; }
  }
  .apidocs-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    line-height: 1.4;
  }
  .apidocs-badge.is-auth {
    background: rgba(54,197,214,0.14);
    color: #67e8f9;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.32);
  }
  .apidocs-badge.is-scope {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .apidocs-badge .dot { width: 5px; height: 5px; border-radius: 9999px; background: currentColor; }

  /* ─── Rate-limit table ─── */
  .apidocs-table-wrap {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: 11px;
    overflow: hidden;
  }
  .apidocs-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .apidocs-table th {
    text-align: left;
    padding: 10px 14px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    background: rgba(255,255,255,0.025);
    border-bottom: 1px solid var(--border);
  }
  .apidocs-table td {
    padding: 10px 14px;
    color: var(--text);
    border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
  }
  .apidocs-table tr:last-child td { border-bottom: none; }

  /* ─── Solid-white spec block for examples (build-agent-spec recipe) ─── */
  .apidocs-spec {
    background: #ffffff;
    color: #0a0a0a;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 6px 20px rgba(0,0,0,0.16);
  }
  .apidocs-spec-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    flex-wrap: wrap;
  }
  .apidocs-spec-title {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0;
    font-family: var(--font-display, system-ui, sans-serif);
    font-size: 13px;
    font-weight: 700;
    color: #111827;
    letter-spacing: -0.005em;
  }
  .apidocs-spec-dot {
    width: 7px; height: 7px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .apidocs-spec-copy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    font-size: 12px;
    font-weight: 600;
    color: #111827;
    background: #ffffff;
    border: 1px solid #d1d5db;
    border-radius: 7px;
    cursor: pointer;
    font-family: inherit;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .apidocs-spec-copy:hover {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
  .apidocs-spec-copy.is-copied {
    background: #ecfdf5;
    border-color: #6ee7b7;
    color: #047857;
  }
  .apidocs-spec-copy svg { display: block; }
  .apidocs-spec-pre {
    margin: 0;
    padding: 16px 18px;
    font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
    font-size: 12.5px;
    line-height: 1.65;
    color: #0a0a0a;
    background: #ffffff;
    white-space: pre;
    overflow-x: auto;
    tab-size: 2;
  }

  /* ─── Footer / kbd ─── */
  .apidocs-foot {
    margin-top: var(--space-5);
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    border: 1px dashed var(--border);
    border-radius: 12px;
  }
  .apidocs-foot code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: rgba(255,255,255,0.04);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--text-strong);
  }
  .apidocs-kbd {
    display: inline-block;
    padding: 2px 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: 4px;
  }
`;

apiDocs.get("/api/docs", softAuth, (c) => {
  const user = c.get("user");

  return c.html(
    <Layout title="API Documentation" user={user}>
      <div class="apidocs-wrap">
        <header class="apidocs-head">
          <div class="apidocs-eyebrow">
            <span class="apidocs-eyebrow-dot" aria-hidden="true" />
            REST API · v2 · Public reference
          </div>
          <h1 class="apidocs-title">
            <span class="apidocs-title-grad">gluecron API.</span>
          </h1>
          <p class="apidocs-sub">
            Complete REST surface for programmatic access to repositories,
            issues, pull requests, and more. Shapes match GitHub REST v3 — a
            base-URL swap reuses most existing integrations. Build a token at{" "}
            <a href="/settings/tokens">/settings/tokens</a>.
          </p>
        </header>

        <ApiSection
          title="Authentication"
          description="All API requests require authentication via a personal access token."
        >
          <CodeExample
            id="auth"
            title="Using a Bearer token"
            code={`curl -H "Authorization: Bearer glue_your_token_here" \\
  https://gluecron.com/api/v2/user`}
          />
          <p class="apidocs-section-sub">
            Create a token at <a href="/settings/tokens" style="color:var(--accent);text-decoration:none">/settings/tokens</a>. Tokens support scopes: <code>repo</code>, <code>user</code>, <code>admin</code>.
          </p>
        </ApiSection>

        <ApiSection title="Rate Limits" description="Rate limits are applied per IP address.">
          <EndpointTable
            rows={[
              ["API routes", "100 req/min"],
              ["Search", "30 req/min"],
              ["Authentication", "10 req/min"],
              ["Git operations", "60 req/min"],
            ]}
            headers={["Scope", "Limit"]}
          />
          <p class="apidocs-section-sub" style="margin-top:10px">
            Rate-limit info is included in response headers: <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code>, <code>X-RateLimit-Reset</code>.
          </p>
        </ApiSection>

        <ApiSection title="Users">
          <Endpoint method="GET" path="/api/v2/user" description="Get authenticated user" auth />
          <Endpoint method="GET" path="/api/v2/users/:username" description="Get user by username" />
          <Endpoint method="PATCH" path="/api/v2/user" description="Update profile (displayName, bio, avatarUrl)" auth scope="user" />
        </ApiSection>

        <ApiSection title="Repositories">
          <Endpoint method="GET" path="/api/v2/users/:username/repos" description="List user repositories" params="sort=updated|stars|name" />
          <Endpoint method="POST" path="/api/v2/repos" description="Create repository" auth scope="repo" />
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo" description="Get repository details" />
          <Endpoint method="PATCH" path="/api/v2/repos/:owner/:repo" description="Update repository (description, visibility)" auth scope="repo" />
          <Endpoint method="DELETE" path="/api/v2/repos/:owner/:repo" description="Delete repository" auth scope="admin" />
        </ApiSection>

        <ApiSection title="Branches">
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/branches" description="List all branches" />
        </ApiSection>

        <ApiSection title="Commits">
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/commits" description="List commits" params="ref, limit, offset" />
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/commits/:sha" description="Get commit with diff" />
        </ApiSection>

        <ApiSection title="File Contents">
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/tree/:ref" description="Get file tree at ref" params="path" />
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/contents/:path" description="Get file contents" params="ref" />
        </ApiSection>

        <ApiSection title="Issues">
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/issues" description="List issues" params="state=open|closed, limit" />
          <Endpoint method="POST" path="/api/v2/repos/:owner/:repo/issues" description="Create issue" auth scope="repo" />
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/issues/:number" description="Get issue with comments" />
          <Endpoint method="PATCH" path="/api/v2/repos/:owner/:repo/issues/:number" description="Update issue (title, body, state)" auth scope="repo" />
          <Endpoint method="POST" path="/api/v2/repos/:owner/:repo/issues/:number/comments" description="Add comment to issue" auth scope="repo" />
        </ApiSection>

        <ApiSection title="Pull Requests">
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/pulls" description="List pull requests" params="state=open|closed|merged" />
          <Endpoint method="POST" path="/api/v2/repos/:owner/:repo/pulls" description="Create pull request" auth scope="repo" />
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/pulls/:number" description="Get PR with comments" />
        </ApiSection>

        <ApiSection title="Stars">
          <Endpoint method="PUT" path="/api/v2/repos/:owner/:repo/star" description="Star a repository" auth />
          <Endpoint method="DELETE" path="/api/v2/repos/:owner/:repo/star" description="Unstar a repository" auth />
        </ApiSection>

        <ApiSection title="Labels">
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/labels" description="List labels" />
          <Endpoint method="POST" path="/api/v2/repos/:owner/:repo/labels" description="Create label" auth scope="repo" />
        </ApiSection>

        <ApiSection title="Search">
          <Endpoint method="GET" path="/api/v2/search/repos" description="Search repositories" params="q (required), sort, limit" />
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/search/code" description="Search code in repository" params="q (required)" />
        </ApiSection>

        <ApiSection title="Topics">
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/topics" description="Get repository topics" />
          <Endpoint method="PUT" path="/api/v2/repos/:owner/:repo/topics" description="Set repository topics" auth scope="repo" />
        </ApiSection>

        <ApiSection title="Webhooks">
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/webhooks" description="List webhooks" auth scope="repo" />
          <Endpoint method="POST" path="/api/v2/repos/:owner/:repo/webhooks" description="Create webhook" auth scope="admin" />
        </ApiSection>

        <ApiSection title="Activity Feed">
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/activity" description="Get activity feed" params="limit" />
        </ApiSection>

        <ApiSection title="Status Checks (CI Integration)">
          <Endpoint method="POST" path="/api/v2/repos/:owner/:repo/statuses/:sha" description="Create status check" auth scope="repo" />
          <Endpoint method="GET" path="/api/v2/repos/:owner/:repo/statuses/:sha" description="Get status checks for commit" />
          <CodeExample
            id="status-ci"
            title="Report CI status"
            code={`curl -X POST -H "Authorization: Bearer glue_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"context":"ci/build","state":"success","targetUrl":"https://ci.example.com/build/123"}' \\
  https://gluecron.com/api/v2/repos/user/repo/statuses/abc123`}
          />
        </ApiSection>

        <div class="apidocs-foot">
          API index: <code>GET /api/v2</code> returns a machine-readable endpoint listing.
          Press <span class="apidocs-kbd">?</span> for keyboard shortcuts.
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: apiDocsStyles }} />
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function(){
              var btns = document.querySelectorAll('[data-apidocs-copy]');
              btns.forEach(function(btn){
                var pre = btn.parentNode && btn.parentNode.parentNode
                  ? btn.parentNode.parentNode.querySelector('[data-apidocs-pre]')
                  : null;
                var label = btn.querySelector('[data-apidocs-copy-label]');
                if (!pre || !label) return;
                btn.addEventListener('click', function(){
                  var text = pre.textContent || '';
                  var done = function(){
                    btn.classList.add('is-copied');
                    label.textContent = 'Copied';
                    setTimeout(function(){
                      btn.classList.remove('is-copied');
                      label.textContent = 'Copy';
                    }, 1800);
                  };
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(done).catch(function(){
                      var ta = document.createElement('textarea');
                      ta.value = text; ta.style.position='fixed'; ta.style.left='-9999px';
                      document.body.appendChild(ta); ta.select();
                      try { document.execCommand('copy'); done(); } catch(e){}
                      document.body.removeChild(ta);
                    });
                  } else {
                    var ta = document.createElement('textarea');
                    ta.value = text; ta.style.position='fixed'; ta.style.left='-9999px';
                    document.body.appendChild(ta); ta.select();
                    try { document.execCommand('copy'); done(); } catch(e){}
                    document.body.removeChild(ta);
                  }
                });
              });
            })();
          `,
        }}
      />
    </Layout>
  );
});

// ─── Documentation Components ────────────────────────────────────────────

const ApiSection = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: any;
}) => (
  <section class="apidocs-section">
    <header class="apidocs-section-head">
      <h2 class="apidocs-section-title">{title}</h2>
      {description && (
        <p class="apidocs-section-sub">{description}</p>
      )}
    </header>
    <div class="apidocs-section-body">{children}</div>
  </section>
);

const Endpoint = ({
  method,
  path,
  description,
  params,
  auth,
  scope,
}: {
  method: string;
  path: string;
  description: string;
  params?: string;
  auth?: boolean;
  scope?: string;
}) => {
  const methodClass =
    method === "GET" ? "m-get" :
    method === "POST" ? "m-post" :
    method === "PUT" ? "m-put" :
    method === "PATCH" ? "m-patch" :
    method === "DELETE" ? "m-delete" : "m-get";

  return (
    <div class="apidocs-endpoint">
      <span class={`apidocs-method ${methodClass}`}>{method}</span>
      <code class="apidocs-path">{path}</code>
      <span class="apidocs-badges">
        {auth && (
          <span class="apidocs-badge is-auth">
            <span class="dot" aria-hidden="true" />
            Auth
          </span>
        )}
        {scope && (
          <span class="apidocs-badge is-scope">
            <span class="dot" aria-hidden="true" />
            {scope}
          </span>
        )}
      </span>
      <span class="apidocs-desc">
        {description}
        {params && (
          <span class="apidocs-params">
            Params: <code>{params}</code>
          </span>
        )}
      </span>
    </div>
  );
};

const CodeExample = ({
  id,
  title,
  code,
}: {
  id?: string;
  title: string;
  code: string;
}) => (
  <div class="apidocs-spec" aria-labelledby={id ? `apidocs-spec-${id}` : undefined}>
    <header class="apidocs-spec-head">
      <p class="apidocs-spec-title" id={id ? `apidocs-spec-${id}` : undefined}>
        <span class="apidocs-spec-dot" aria-hidden="true" />
        {title}
      </p>
      <button
        type="button"
        class="apidocs-spec-copy"
        data-apidocs-copy
        aria-label={`Copy ${title} example to clipboard`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span data-apidocs-copy-label>Copy</span>
      </button>
    </header>
    <pre class="apidocs-spec-pre" data-apidocs-pre>{code}</pre>
  </div>
);

const EndpointTable = ({
  headers,
  rows,
}: {
  headers: string[];
  rows: string[][];
}) => (
  <div class="apidocs-table-wrap">
    <table class="apidocs-table">
      <thead>
        <tr>
          {headers.map((h) => (
            <th>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr>
            {row.map((cell) => (
              <td>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default apiDocs;
