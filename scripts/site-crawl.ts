#!/usr/bin/env bun
/**
 * One-shot site crawler.
 *
 * Hits every known public + admin route and reports any URL that:
 *   - returned 4xx or 5xx
 *   - took > SLOW_MS to respond
 *   - bounced an admin route to /login (auth not seen)
 *
 * Public routes are crawled anonymously. Admin/settings/billing routes
 * are only crawled if you pass GLUECRON_SESSION=<sid cookie value>.
 *
 * Usage (from the box, or anywhere with internet):
 *
 *   GLUECRON_HOST=https://gluecron.com \
 *   GLUECRON_SESSION=$(psql "$DATABASE_URL" -tAc \
 *     "select token from sessions \
 *      where user_id=(select id from users where username='admin') \
 *        and expires_at > now() and requires_2fa = false \
 *      order by created_at desc limit 1" | tr -d ' ') \
 *   bun scripts/site-crawl.ts
 *
 * If you skip GLUECRON_SESSION the script still runs — it will just mark
 * every admin route as "auth-required (skipped)".
 *
 * Output: a single markdown table sorted FAIL → SLOW → OK, plus a
 * one-line summary at the bottom you can paste back.
 */

const HOST = (process.env.GLUECRON_HOST || "https://gluecron.com").replace(
  /\/$/,
  ""
);
const SESSION = process.env.GLUECRON_SESSION || "";
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY || 6);
const TIMEOUT_MS = Number(process.env.CRAWL_TIMEOUT_MS || 8000);
const SLOW_MS = Number(process.env.CRAWL_SLOW_MS || 2000);

// ─── Route inventory ─────────────────────────────────────────────────
//
// Curated subset of the 307 routes: every static page, plus parameterised
// pages instantiated with `ccantynz/Gluecron.com` (the canonical self-
// hosted repo) and `admin` (the bootstrap operator). Anything that needs
// real session state (issue numbers, gist slugs, etc.) is skipped.
//
// `auth` = "anon" public; "admin" needs site-admin cookie; "user" needs
// any logged-in cookie. The crawler treats both admin+user as "skip if
// no session cookie is set".

type AuthLevel = "anon" | "user" | "admin";
type Route = { path: string; auth: AuthLevel; method?: "GET" | "POST" };

const ROUTES: Route[] = [
  // Public landing + marketing
  { path: "/", auth: "anon" },
  { path: "/about", auth: "anon" },
  { path: "/features", auth: "anon" },
  { path: "/pricing", auth: "anon" },
  { path: "/explore", auth: "anon" },
  { path: "/demo", auth: "anon" },
  { path: "/help", auth: "anon" },
  { path: "/getting-started", auth: "anon" },
  { path: "/install", auth: "anon" },
  { path: "/vs-github", auth: "anon" },
  { path: "/marketplace", auth: "anon" },
  { path: "/shortcuts", auth: "anon" },
  { path: "/sleep-mode", auth: "anon" },
  { path: "/setup", auth: "anon" },

  // Legal
  { path: "/terms", auth: "anon" },
  { path: "/privacy", auth: "anon" },
  { path: "/acceptable-use", auth: "anon" },
  { path: "/legal/terms", auth: "anon" },
  { path: "/legal/privacy", auth: "anon" },
  { path: "/legal/acceptable-use", auth: "anon" },
  { path: "/legal/dmca", auth: "anon" },

  // Auth flows (anon GET should render the form)
  { path: "/login", auth: "anon" },
  { path: "/register", auth: "anon" },
  { path: "/forgot-password", auth: "anon" },
  { path: "/reset-password", auth: "anon" },
  { path: "/login/magic", auth: "anon" },
  { path: "/verify-email", auth: "anon" },
  { path: "/play", auth: "anon" },

  // Health + version + manifests
  { path: "/health", auth: "anon" },
  { path: "/healthz", auth: "anon" },
  { path: "/readyz", auth: "anon" },
  { path: "/version", auth: "anon" },
  { path: "/api/version", auth: "anon" },
  { path: "/api/docs", auth: "anon" },
  { path: "/status", auth: "anon" },
  { path: "/status.svg", auth: "anon" },
  { path: "/robots.txt", auth: "anon" },
  { path: "/sitemap.xml", auth: "anon" },
  { path: "/manifest.webmanifest", auth: "anon" },
  { path: "/icon.svg", auth: "anon" },
  { path: "/sw.js", auth: "anon" },
  { path: "/sw-push.js", auth: "anon" },
  { path: "/pwa/vapid-public-key", auth: "anon" },
  { path: "/gluecron.dxt", auth: "anon" },

  // Public repo browsing (canonical self-host repo)
  { path: "/ccantynz", auth: "anon" },
  { path: "/ccantynz/Gluecron.com", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/commits", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/branches", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/contributors", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/issues", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/pulls", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/releases", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/wiki", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/discussions", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/security", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/security/advisories", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/actions", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/deployments", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/dependencies", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/contributors", auth: "anon" },
  { path: "/ccantynz/Gluecron.com/traffic", auth: "anon" },

  // Authed user pages
  { path: "/dashboard", auth: "user" },
  { path: "/feed", auth: "user" },
  { path: "/notifications", auth: "user" },
  { path: "/me/ai-savings", auth: "user" },
  { path: "/new", auth: "user" },
  { path: "/import", auth: "user" },
  { path: "/gists", auth: "user" },
  { path: "/gists/new", auth: "user" },
  { path: "/todos", auth: "user" },
  { path: "/ask", auth: "user" },
  { path: "/billing/manage", auth: "user" },

  // User settings
  { path: "/settings", auth: "user" },
  { path: "/settings/profile", auth: "user" },
  { path: "/settings/notifications", auth: "user" },
  { path: "/settings/billing", auth: "user" },
  { path: "/settings/keys", auth: "user" },
  { path: "/settings/tokens", auth: "user" },
  { path: "/settings/passkeys", auth: "user" },
  { path: "/settings/2fa", auth: "user" },
  { path: "/settings/applications", auth: "user" },
  { path: "/settings/authorizations", auth: "user" },
  { path: "/settings/audit", auth: "user" },
  { path: "/settings/delete-account", auth: "user" },
  { path: "/settings/signing-keys", auth: "user" },
  { path: "/settings/replies", auth: "user" },
  { path: "/settings/sponsors", auth: "user" },
  { path: "/settings/apps", auth: "user" },

  // Admin
  { path: "/admin", auth: "admin" },
  { path: "/admin/ops", auth: "admin" },
  { path: "/admin/autopilot", auth: "admin" },
  { path: "/admin/billing", auth: "admin" },
  { path: "/admin/deploys", auth: "admin" },
  { path: "/admin/deploys/latest.json", auth: "admin" },
  { path: "/admin/digests", auth: "admin" },
  { path: "/admin/flags", auth: "admin" },
  { path: "/admin/github-oauth", auth: "admin" },
  { path: "/admin/repos", auth: "admin" },
  { path: "/admin/self-host", auth: "admin" },
  { path: "/admin/sso", auth: "admin" },
  { path: "/admin/status", auth: "admin" },
  { path: "/admin/users", auth: "admin" },
];

// ─── Crawl machinery ─────────────────────────────────────────────────

type Result = {
  path: string;
  auth: AuthLevel;
  status: number;
  ms: number;
  verdict: "OK" | "FAIL" | "SLOW" | "SKIP" | "REDIR";
  note: string;
};

async function check(route: Route): Promise<Result> {
  const url = `${HOST}${route.path}`;
  const needsAuth = route.auth !== "anon";

  if (needsAuth && !SESSION) {
    return {
      path: route.path,
      auth: route.auth,
      status: 0,
      ms: 0,
      verdict: "SKIP",
      note: "no session cookie",
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = {
    "user-agent": "gluecron-site-crawl/1.0",
    accept: "text/html,application/json,*/*",
  };
  if (needsAuth) headers["cookie"] = `session=${SESSION}`;

  const t0 = performance.now();
  let res: Response | null = null;
  let err: unknown = null;
  try {
    res = await fetch(url, {
      method: route.method || "GET",
      headers,
      signal: ctrl.signal,
      redirect: "manual",
    });
  } catch (e) {
    err = e;
  } finally {
    clearTimeout(timer);
  }
  const ms = Math.round(performance.now() - t0);

  if (err || !res) {
    return {
      path: route.path,
      auth: route.auth,
      status: 0,
      ms,
      verdict: "FAIL",
      note: (err as Error)?.message?.slice(0, 60) || "network error",
    };
  }

  const status = res.status;

  // 3xx → look at Location. If admin/user route bounced to /login, flag.
  if (status >= 300 && status < 400) {
    const loc = res.headers.get("location") || "";
    if (needsAuth && /\/login(\?|$)/.test(loc)) {
      return {
        path: route.path,
        auth: route.auth,
        status,
        ms,
        verdict: "FAIL",
        note: "redirected to /login (session invalid?)",
      };
    }
    return {
      path: route.path,
      auth: route.auth,
      status,
      ms,
      verdict: "REDIR",
      note: `→ ${loc.replace(HOST, "")}`.slice(0, 60),
    };
  }

  if (status >= 400) {
    return {
      path: route.path,
      auth: route.auth,
      status,
      ms,
      verdict: "FAIL",
      note: status >= 500 ? "server error" : "client error",
    };
  }

  if (ms > SLOW_MS) {
    return {
      path: route.path,
      auth: route.auth,
      status,
      ms,
      verdict: "SLOW",
      note: `> ${SLOW_MS}ms`,
    };
  }

  return {
    path: route.path,
    auth: route.auth,
    status,
    ms,
    verdict: "OK",
    note: "",
  };
}

async function crawl(): Promise<Result[]> {
  const results: Result[] = [];
  const queue = [...ROUTES];
  const workers = new Array(Math.min(CONCURRENCY, queue.length))
    .fill(0)
    .map(async () => {
      while (queue.length) {
        const route = queue.shift();
        if (!route) break;
        const r = await check(route);
        results.push(r);
        const tag =
          r.verdict === "OK"
            ? "·"
            : r.verdict === "SLOW"
              ? "~"
              : r.verdict === "REDIR"
                ? ">"
                : r.verdict === "SKIP"
                  ? "?"
                  : "X";
        process.stderr.write(`${tag} ${r.status || "---"} ${r.path}\n`);
      }
    });
  await Promise.all(workers);
  return results;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function formatTable(rows: Result[]): string {
  const rank: Record<Result["verdict"], number> = {
    FAIL: 0,
    SLOW: 1,
    REDIR: 2,
    SKIP: 3,
    OK: 4,
  };
  rows.sort((a, b) => {
    if (rank[a.verdict] !== rank[b.verdict]) return rank[a.verdict] - rank[b.verdict];
    return a.path.localeCompare(b.path);
  });
  const lines = [
    `| verdict | status |  ms  | auth  | path                                                     | note`,
    `| ------- | ------ | ---- | ----- | -------------------------------------------------------- | ----`,
  ];
  for (const r of rows) {
    lines.push(
      `| ${pad(r.verdict, 7)} | ${pad(String(r.status || "---"), 6)} | ${pad(String(r.ms), 4)} | ${pad(r.auth, 5)} | ${pad(r.path, 56)} | ${r.note}`
    );
  }
  return lines.join("\n");
}

async function main() {
  console.error(`[crawl] target: ${HOST}`);
  console.error(`[crawl] session: ${SESSION ? "yes" : "no (admin routes will skip)"}`);
  console.error(`[crawl] routes:  ${ROUTES.length}`);
  console.error("");

  const results = await crawl();

  const counts = {
    FAIL: results.filter((r) => r.verdict === "FAIL").length,
    SLOW: results.filter((r) => r.verdict === "SLOW").length,
    REDIR: results.filter((r) => r.verdict === "REDIR").length,
    SKIP: results.filter((r) => r.verdict === "SKIP").length,
    OK: results.filter((r) => r.verdict === "OK").length,
  };

  console.log("");
  console.log(formatTable(results));
  console.log("");
  console.log(
    `[crawl] ${counts.OK} ok · ${counts.FAIL} fail · ${counts.SLOW} slow · ${counts.REDIR} redir · ${counts.SKIP} skip (no cookie)`
  );

  if (counts.FAIL > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("[crawl] crashed:", err);
  process.exit(2);
});
