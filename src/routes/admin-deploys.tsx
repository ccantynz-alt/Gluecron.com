/**
 * Block N4 — Admin deploy trigger.
 *
 *   POST /admin/deploys/trigger         — kick off the hetzner-deploy.yml
 *                                         workflow via GitHub workflow_dispatch.
 *
 * Reads `GITHUB_TOKEN` (operator-provided, repo+workflow scopes) from the
 * server environment. The CLI talks to GitHub directly; this route is the
 * "click a button on the admin page" equivalent so the operator never has to
 * leave Gluecron to ship a hot-fix.
 *
 * NOTE: The companion `/admin/deploys` page (Block N3) has not landed yet on
 * this branch. We ship the trigger endpoint now so the CLI + tests can land
 * cleanly; once N3 adds the page, its "Trigger deploy" button posts here.
 */

import { Hono } from "hono";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { audit } from "../lib/notify";

const GH_API = "https://api.github.com";

/**
 * Dependency-injected fetcher so tests can drive the route without hitting
 * the real api.github.com.
 */
export type GithubFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

let _githubFetch: GithubFetch | null = null;
let _envOverride: { GITHUB_TOKEN?: string } | null = null;

/** Test-only: override the github fetcher. Pass `null` to restore default. */
export function __setGithubFetchForTests(f: GithubFetch | null): void {
  _githubFetch = f;
}

/** Test-only: override env reads. Pass `null` to fall back to process.env. */
export function __setEnvForTests(e: { GITHUB_TOKEN?: string } | null): void {
  _envOverride = e;
}

function ghToken(): string | undefined {
  if (_envOverride) return _envOverride.GITHUB_TOKEN;
  return process.env.GITHUB_TOKEN;
}

function ghFetch(): GithubFetch {
  return _githubFetch ?? ((fetch as unknown) as GithubFetch);
}

const admin = new Hono<AuthEnv>();
admin.use("*", softAuth);

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.json({ error: "auth required" }, 401);
  if (!(await isSiteAdmin(user.id))) {
    return c.json({ error: "site admin required" }, 403);
  }
  return { user };
}

admin.post("/admin/deploys/trigger", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const token = ghToken();
  if (!token) {
    return c.json(
      {
        error:
          "GITHUB_TOKEN is not set on the server — configure GITHUB_TOKEN on the box first (e.g. /etc/gluecron.env).",
      },
      400
    );
  }

  // Body is optional — defaults are the hetzner deploy on main of this repo.
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  // GitHub repo for the deploy workflow. NOT the same as Gluecron's
  // canonical name (`ccantynz/Gluecron.com`) — GitHub knows the mirror
  // as `ccantynz-alt/Gluecron.com`. Default to the GitHub-side path so
  // the "Deploy" button doesn't 404. Override via the request body if
  // the mirror ever moves. (Env override available via GITHUB_DEPLOY_REPO.)
  const repo = String(
    body.repo || process.env.GITHUB_DEPLOY_REPO || "ccantynz-alt/Gluecron.com"
  );
  const workflow = String(body.workflow || "hetzner-deploy.yml");
  const ref = String(body.ref || "main");
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    return c.json({ error: "expected repo as owner/name" }, 400);
  }

  const url = `${GH_API}/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const res = await ghFetch()(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "gluecron-admin",
    },
    body: JSON.stringify({ ref }),
  });

  if (res.status !== 204) {
    const raw = await res.text();
    let msg = raw;
    try {
      const j = JSON.parse(raw);
      msg = j?.message || raw;
    } catch {
      // raw it is
    }
    return c.json(
      { error: `github responded ${res.status}: ${msg || "request failed"}` },
      502
    );
  }

  await audit({
    userId: user.id,
    action: "admin.deploy.triggered",
    targetType: "workflow",
    targetId: `${repo}:${workflow}@${ref}`,
    metadata: { repo, workflow, ref },
  });

  return c.json({ ok: true, repo, workflow, ref });
});

export default admin;
