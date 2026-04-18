/**
 * API Documentation — interactive docs page.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const apiDocs = new Hono<AuthEnv>();

apiDocs.get("/api/docs", softAuth, (c) => {
  const user = c.get("user");

  return c.html(
    <Layout title="API Documentation" user={user}>
      <div style="max-width:900px">
        <h1 style="margin-bottom:8px">gluecron API</h1>
        <p style="color:var(--text-muted);margin-bottom:32px">
          Complete REST API for programmatic access to repositories, issues, pull requests, and more.
        </p>

        <ApiSection
          title="Authentication"
          description="All API requests require authentication via a personal access token."
        >
          <CodeExample
            title="Using a Bearer token"
            code={`curl -H "Authorization: Bearer glue_your_token_here" \\
  https://gluecron.com/api/v2/user`}
          />
          <p style="font-size:14px;color:var(--text-muted);margin-top:12px">
            Create a token at <a href="/settings/tokens">/settings/tokens</a>. Tokens support scopes: <code>repo</code>, <code>user</code>, <code>admin</code>.
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
          <p style="font-size:13px;color:var(--text-muted);margin-top:8px">
            Rate limit info is included in response headers: <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code>, <code>X-RateLimit-Reset</code>.
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
            title="Report CI status"
            code={`curl -X POST -H "Authorization: Bearer glue_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"context":"ci/build","state":"success","targetUrl":"https://ci.example.com/build/123"}' \\
  https://gluecron.com/api/v2/repos/user/repo/statuses/abc123`}
          />
        </ApiSection>

        <div style="text-align:center;padding:40px 0;color:var(--text-muted)">
          <p>API index: <code>GET /api/v2</code> returns machine-readable endpoint listing</p>
          <p style="margin-top:8px;font-size:13px">Press <kbd class="kbd">?</kbd> for keyboard shortcuts</p>
        </div>
      </div>
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
  <div style="margin-bottom:32px">
    <h2 style="font-size:20px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--border)">
      {title}
    </h2>
    {description && (
      <p style="color:var(--text-muted);font-size:14px;margin-bottom:16px">{description}</p>
    )}
    {children}
  </div>
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
  const methodColor =
    method === "GET" ? "var(--green)" :
    method === "POST" ? "var(--accent)" :
    method === "PUT" || method === "PATCH" ? "var(--yellow)" :
    method === "DELETE" ? "var(--red)" : "var(--text)";

  return (
    <div style="padding:10px 0;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <span style={`font-family:var(--font-mono);font-size:12px;font-weight:700;color:${methodColor};min-width:60px`}>
        {method}
      </span>
      <code style="font-size:13px;color:var(--text-link);flex:1;min-width:200px">{path}</code>
      <span style="font-size:13px;color:var(--text-muted);flex:2;min-width:200px">
        {description}
        {params && (
          <span style="display:block;font-size:12px;margin-top:2px">
            Params: <code>{params}</code>
          </span>
        )}
      </span>
      <span style="display:flex;gap:4px;flex-shrink:0">
        {auth && (
          <span style="font-size:11px;padding:2px 6px;border-radius:3px;background:rgba(31,111,235,0.15);color:var(--accent)">
            AUTH
          </span>
        )}
        {scope && (
          <span style="font-size:11px;padding:2px 6px;border-radius:3px;background:rgba(63,185,80,0.15);color:var(--green)">
            {scope}
          </span>
        )}
      </span>
    </div>
  );
};

const CodeExample = ({ title, code }: { title: string; code: string }) => (
  <div style="margin:12px 0">
    {title && (
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">{title}</div>
    )}
    <div style="position:relative">
      <pre style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;font-family:var(--font-mono);font-size:13px;overflow-x:auto;line-height:1.6">
        {code}
      </pre>
      <button
        type="button"
        class="btn btn-sm"
        data-clipboard={code}
        style="position:absolute;top:8px;right:8px;font-size:11px"
      >
        Copy
      </button>
    </div>
  </div>
);

const EndpointTable = ({
  headers,
  rows,
}: {
  headers: string[];
  rows: string[][];
}) => (
  <table class="file-table" style="margin:8px 0">
    <thead>
      <tr>
        {headers.map((h) => (
          <th style="padding:8px 16px;text-align:left;font-size:13px;color:var(--text-muted);border-bottom:1px solid var(--border)">
            {h}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => (
        <tr>
          {row.map((cell) => (
            <td style="padding:8px 16px;font-size:14px">{cell}</td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

export default apiDocs;
