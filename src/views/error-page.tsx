/**
 * BLOCK O2 — Shared error page surface (404/500/403).
 *
 * One JSX component renders all three error surfaces consistently.
 * Used from app.notFound, app.onError, and the requireAdmin middleware.
 *
 * - NO database access (must render when DB is down).
 * - Reuses existing CSS tokens via Layout.
 * - Dark + light theme both via the same gradient-text utility.
 * - Accessible: role="main", aria-labelledby, polite live region.
 */

import type { FC } from "hono/jsx";
import type { User } from "../db/schema";
import { Layout } from "./layout";

export interface ErrorPageSuggestion { href: string; label: string }
export interface ErrorPageProps {
  code: string;
  eyebrow: string;
  title: string;
  body: string;
  requestId?: string;
  user?: User | null;
  suggestions?: ErrorPageSuggestion[];
  primaryCta?: { href: string; label: string };
  secondaryCta?: { href: string; label: string };
  meta?: string;
  trace?: string;
  layoutTitle?: string;
}

export const ErrorPage: FC<ErrorPageProps> = ({
  code, eyebrow, title, body, requestId, user, suggestions,
  primaryCta, secondaryCta, meta, trace, layoutTitle,
}) => {
  const primary = primaryCta ?? { href: "/", label: "Go home" };
  const secondary = secondaryCta ?? { href: "/status", label: "Status page" };
  return (
    <Layout title={layoutTitle ?? `${code} ${eyebrow}`} user={user ?? null}>
      <main class="error-page" role="main" aria-labelledby="error-page-title" data-error-code={code}>
        <div class="error-page-code gradient-text" aria-hidden="true">{code}</div>
        <div class="error-page-eyebrow">{eyebrow}</div>
        <h1 id="error-page-title" class="error-page-title">{title}</h1>
        <p class="error-page-body">{body}</p>
        <div class="error-page-actions">
          <a href={primary.href} class="btn btn-primary btn-lg" data-error-cta="primary">{primary.label}</a>
          <a href={secondary.href} class="btn btn-ghost btn-lg" data-error-cta="secondary">{secondary.label}</a>
        </div>
        {suggestions && suggestions.length > 0 && (
          <ul class="error-page-suggestions" aria-label="Try one of these">
            {suggestions.map((s) => (<li><a href={s.href}>{s.label} &rarr;</a></li>))}
          </ul>
        )}
        {requestId && (
          <div class="error-page-meta" aria-live="polite">
            <span class="error-page-meta-label">Request ID:</span>{" "}
            <span class="meta-mono">{requestId}</span>
          </div>
        )}
        {meta && (<div class="error-page-meta"><span class="meta-mono">{meta}</span></div>)}
        {trace && (<pre class="error-page-trace" aria-label="Stack trace">{trace}</pre>)}
      </main>
      <style dangerouslySetInnerHTML={{ __html: errorPageCss }} />
    </Layout>
  );
};

export const NotFoundPage: FC<{ user?: User | null; method?: string; path?: string }> = ({ user, method, path }) => (
  <ErrorPage
    code="404"
    eyebrow="Not found"
    title="We can't find that page."
    body="The URL might be wrong, the resource might have moved, or you might not have permission to see it."
    user={user}
    primaryCta={{ href: "/", label: "Go home" }}
    secondaryCta={{ href: "/status", label: "Status page" }}
    suggestions={[
      { href: "/explore", label: "Explore public repositories" },
      { href: "/help", label: "Read the quickstart guide" },
    ]}
    meta={method && path ? `${method} ${path}` : undefined}
    layoutTitle="Not Found"
  />
);

export const ServerErrorPage: FC<{ user?: User | null; requestId?: string; trace?: string }> = ({ user, requestId, trace }) => (
  <ErrorPage
    code="500"
    eyebrow="Server error"
    title="Something went wrong on our end."
    body="The error has been reported. Try again in a moment — if it persists, include the Request ID below when you file an issue."
    user={user}
    primaryCta={{ href: "/", label: "Go home" }}
    secondaryCta={{ href: "/status", label: "Status page" }}
    requestId={requestId}
    trace={trace}
    layoutTitle="Error"
  />
);

export const ForbiddenPage: FC<{ user?: User | null; message?: string }> = ({ user, message }) => {
  const suggestions: ErrorPageSuggestion[] = user
    ? [{ href: "/logout", label: "Sign in as a different user" }, { href: "/help", label: "Read the access docs" }]
    : [{ href: "/login", label: "Sign in" }, { href: "/help", label: "Read the access docs" }];
  return (
    <ErrorPage
      code="403"
      eyebrow="Forbidden"
      title={message ?? "Admin access required."}
      body="You're signed in, but this resource is restricted. If you think this is a mistake, contact a site admin."
      user={user}
      primaryCta={{ href: "/", label: "Go home" }}
      secondaryCta={{ href: "/status", label: "Status page" }}
      suggestions={suggestions}
      layoutTitle="Forbidden"
    />
  );
};

export const errorPageCss = `
.error-page { max-width: 720px; margin: 64px auto 96px; padding: 0 24px; text-align: center; }
.error-page-code { font-size: clamp(96px, 22vw, 192px); line-height: 1; font-weight: 800; letter-spacing: -0.04em; margin-bottom: 8px; }
.error-page-eyebrow { text-transform: uppercase; font-size: 12px; letter-spacing: 0.18em; color: var(--text-muted); font-weight: 600; margin-bottom: 12px; }
.error-page-title { font-size: clamp(24px, 4vw, 36px); font-weight: 700; letter-spacing: -0.02em; margin: 0 0 12px; color: var(--text); }
.error-page-body { font-size: 16px; line-height: 1.6; color: var(--text-muted); max-width: 520px; margin: 0 auto 28px; }
.error-page-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-bottom: 24px; }
.error-page-suggestions { list-style: none; padding: 0; margin: 0 auto 24px; max-width: 480px; display: flex; flex-direction: column; gap: 4px; }
.error-page-suggestions li { font-size: 14px; }
.error-page-suggestions a { color: var(--accent); text-decoration: none; }
.error-page-suggestions a:hover { text-decoration: underline; }
.error-page-meta { font-size: 13px; color: var(--text-muted); margin-top: 12px; }
.error-page-meta-label { text-transform: uppercase; letter-spacing: 0.12em; font-size: 11px; font-weight: 600; }
.error-page .meta-mono { font-family: var(--font-mono); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; font-size: 12px; color: var(--text); }
.error-page-trace { text-align: left; margin: 24px auto 0; padding: 16px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); overflow-x: auto; max-width: 100%; white-space: pre-wrap; }
`;

export function renderStandaloneErrorPage(opts: {
  code: string; eyebrow: string; title: string; body: string;
  requestId?: string; signedIn?: boolean;
}): string {
  const { code, eyebrow, title, body, requestId, signedIn } = opts;
  const suggestionsHtml = signedIn
    ? `<li><a href="/logout">Sign in as a different user &rarr;</a></li><li><a href="/help">Read the access docs &rarr;</a></li>`
    : `<li><a href="/login">Sign in &rarr;</a></li><li><a href="/help">Read the access docs &rarr;</a></li>`;
  const requestIdHtml = requestId
    ? `<div class="error-page-meta" aria-live="polite"><span class="error-page-meta-label">Request ID:</span> <span class="meta-mono">${escapeHtml(requestId)}</span></div>`
    : "";
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(code)} ${escapeHtml(eyebrow)}</title>
<style>
:root { --bg:#0d1117; --bg-elevated:#161b22; --text:#e6edf3; --text-muted:#8b949e; --border:#30363d; --accent:#8c6dff; --accent-gradient:linear-gradient(135deg,#8c6dff 0%,#36c5d6 100%); --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
:root[data-theme='light'] { --bg:#fff; --bg-elevated:#f6f8fa; --text:#1f2328; --text-muted:#57606a; --border:#d1d9e0; --accent:#6d4dff; }
html, body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin:0; padding:0; }
.error-page { max-width: 720px; margin: 96px auto; padding: 0 24px; text-align: center; }
.error-page-code { font-size: clamp(96px,22vw,192px); line-height:1; font-weight:800; letter-spacing:-0.04em; margin-bottom:8px; background: var(--accent-gradient); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color: transparent; }
.error-page-eyebrow { text-transform:uppercase; font-size:12px; letter-spacing:0.18em; color: var(--text-muted); font-weight:600; margin-bottom:12px; }
.error-page-title { font-size: clamp(24px,4vw,36px); font-weight:700; letter-spacing:-0.02em; margin:0 0 12px; color: var(--text); }
.error-page-body { font-size:16px; line-height:1.6; color: var(--text-muted); max-width: 520px; margin: 0 auto 28px; }
.error-page-actions { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; margin-bottom:24px; }
.btn { display:inline-flex; align-items:center; padding:10px 18px; border-radius:8px; border:1px solid var(--border); text-decoration:none; color: var(--text); background: var(--bg-elevated); font-size:14px; font-weight:500; }
.btn-primary { background: var(--accent); color: white; border-color: var(--accent); }
.btn-lg { padding:12px 22px; font-size:15px; }
.error-page-suggestions { list-style:none; padding:0; margin: 0 auto 24px; max-width: 480px; display:flex; flex-direction:column; gap:4px; font-size:14px; }
.error-page-suggestions a { color: var(--accent); text-decoration:none; }
.error-page-meta { font-size:13px; color: var(--text-muted); margin-top:12px; }
.error-page-meta-label { text-transform:uppercase; letter-spacing:0.12em; font-size:11px; font-weight:600; }
.meta-mono { font-family: var(--font-mono); background: var(--bg-elevated); border:1px solid var(--border); border-radius:6px; padding:2px 8px; font-size:12px; color: var(--text); }
</style>
</head>
<body>
<main class="error-page" role="main" aria-labelledby="error-page-title" data-error-code="${escapeHtml(code)}">
  <div class="error-page-code" aria-hidden="true">${escapeHtml(code)}</div>
  <div class="error-page-eyebrow">${escapeHtml(eyebrow)}</div>
  <h1 id="error-page-title" class="error-page-title">${escapeHtml(title)}</h1>
  <p class="error-page-body">${escapeHtml(body)}</p>
  <div class="error-page-actions">
    <a href="/" class="btn btn-primary btn-lg" data-error-cta="primary">Go home</a>
    <a href="/status" class="btn btn-lg" data-error-cta="secondary">Status page</a>
  </div>
  <ul class="error-page-suggestions" aria-label="Try one of these">${suggestionsHtml}</ul>
  ${requestIdHtml}
</main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
